import http2 from 'node:http2';
import { reserveNvidiaCall } from './rate-limit.js';

const GRPC_HOST = 'https://grpc.nvcf.nvidia.com';
const GRPC_PATH = '/nvidia.riva.tts.RivaSpeechSynthesis/Synthesize';
const DEFAULT_FUNCTION_ID = '877104f7-e885-42b9-8de8-f6e4c6303969';
const DEFAULT_VOICE = 'Magpie-Multilingual.EN-US.Leo';
const DEFAULT_LANGUAGE = 'en-US';
const SAMPLE_RATE = 24000;

function encodeVarint(value) {
  const bytes = [];
  let n = Number(value);
  while (n > 127) {
    bytes.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  bytes.push(n);
  return Buffer.from(bytes);
}

function fieldVarint(fieldNumber, value) {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 0), encodeVarint(value)]);
}

function fieldBytes(fieldNumber, value) {
  const payload = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeSynthesizeRequest({ text, languageCode, voiceName }) {
  return Buffer.concat([
    fieldBytes(1, text),
    fieldBytes(2, languageCode || DEFAULT_LANGUAGE),
    fieldVarint(3, 1),
    fieldVarint(4, SAMPLE_RATE),
    fieldBytes(5, voiceName || DEFAULT_VOICE),
  ]);
}

function grpcFrame(message) {
  const header = Buffer.alloc(5);
  header[0] = 0;
  header.writeUInt32BE(message.length, 1);
  return Buffer.concat([header, message]);
}

function readVarint(buffer, offset) {
  let result = 0;
  let shift = 0;
  let index = offset;
  while (index < buffer.length) {
    const byte = buffer[index++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: index };
    shift += 7;
  }
  throw new Error('Invalid protobuf varint');
}

function skipField(buffer, wireType, offset) {
  if (wireType === 0) return readVarint(buffer, offset).offset;
  if (wireType === 2) {
    const length = readVarint(buffer, offset);
    return length.offset + length.value;
  }
  if (wireType === 5) return offset + 4;
  if (wireType === 1) return offset + 8;
  throw new Error(`Unsupported protobuf wire type ${wireType}`);
}

function extractAudioFromProto(message) {
  let offset = 0;
  while (offset < message.length) {
    const tag = readVarint(message, offset);
    offset = tag.offset;
    const fieldNumber = tag.value >> 3;
    const wireType = tag.value & 7;
    if (fieldNumber === 1 && wireType === 2) {
      const length = readVarint(message, offset);
      const start = length.offset;
      return message.subarray(start, start + length.value);
    }
    offset = skipField(message, wireType, offset);
  }
  return null;
}

function extractAudioFromGrpc(buffer) {
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const compressed = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (compressed !== 0) throw new Error('Compressed gRPC responses are not supported');
    if (end > buffer.length) throw new Error('Truncated gRPC response');
    const audio = extractAudioFromProto(buffer.subarray(start, end));
    if (audio?.length) return audio;
    offset = end;
  }
  return null;
}

function wavHeader(byteLength, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + byteLength, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(byteLength, 40);
  return header;
}

function asWav(audio) {
  if (audio.subarray(0, 4).toString('ascii') === 'RIFF') return audio;
  return Buffer.concat([wavHeader(audio.length), audio]);
}

function synthesizeWithNvidia({ apiKey, functionId, text, languageCode, voiceName }) {
  return new Promise((resolve, reject) => {
    const client = http2.connect(GRPC_HOST);
    const chunks = [];
    let responseHeaders = {};
    let trailers = {};

    client.on('error', reject);

    const req = client.request({
      ':method': 'POST',
      ':path': GRPC_PATH,
      'content-type': 'application/grpc',
      'te': 'trailers',
      'grpc-accept-encoding': 'identity',
      'authorization': `Bearer ${apiKey}`,
      'function-id': functionId,
    });

    req.on('response', headers => {
      responseHeaders = headers;
    });
    req.on('trailers', headers => {
      trailers = headers;
    });
    req.on('data', chunk => chunks.push(chunk));
    req.on('error', err => {
      client.close();
      reject(err);
    });
    req.on('end', () => {
      client.close();
      const grpcStatus = trailers['grpc-status'] ?? responseHeaders['grpc-status'];
      const grpcMessage = trailers['grpc-message'] ?? responseHeaders['grpc-message'];
      if (grpcStatus && grpcStatus !== '0') {
        reject(new Error(decodeURIComponent(String(grpcMessage || `gRPC status ${grpcStatus}`))));
        return;
      }

      try {
        const audio = extractAudioFromGrpc(Buffer.concat(chunks));
        if (!audio?.length) throw new Error('NVIDIA returned no audio data');
        resolve(asWav(audio));
      } catch (err) {
        reject(err);
      }
    });

    req.end(grpcFrame(encodeSynthesizeRequest({ text, languageCode, voiceName })));
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.NVIDIA_TTS_API_KEY || process.env.NVIDIA_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Server TTS API key is not configured' });

  const params = req.body;
  const text = String(params?.text || params?.input || '').replace(/\s+/g, ' ').trim();
  if (!text) return res.status(400).json({ error: 'Missing text' });
  if (text.length > 1600) return res.status(400).json({ error: 'Text is too long for one TTS request' });

  const functionId = process.env.NVIDIA_TTS_FUNCTION_ID || DEFAULT_FUNCTION_ID;
  const voiceName = String(params?.voiceName || params?.voice || DEFAULT_VOICE);
  const languageCode = String(params?.languageCode || params?.language_code || DEFAULT_LANGUAGE);

  try {
    const slot = await reserveNvidiaCall(apiKey);
    if (!slot.allowed) {
      res.setHeader('Retry-After', String(slot.retryAfter));
      return res.status(429).json({ error: 'AI is at its four-request-per-minute limit.', retryAfter: slot.retryAfter });
    }
    const wav = await synthesizeWithNvidia({ apiKey, functionId, text, languageCode, voiceName });
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).send(wav);
  } catch (err) {
    console.error('TTS proxy error:', err.name);
    return res.status(502).json({ error: 'TTS synthesis is unavailable.' });
  }
}
