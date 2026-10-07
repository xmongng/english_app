import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(root, '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
const { default: chat } = await import('./api/chat.js');
const { default: tts } = await import('./api/tts.js');
const { default: vault } = await import('./api/vault.js');
const port = Number(process.env.PORT || 3000);
const publicFiles = new Map([
  ['/index.html', 'text/html'], ['/ielts_vocab_master.html', 'text/html'],
  ['/chat_companion.html', 'text/html'], ['/learning-core.js', 'text/javascript'], ['/learning-theme.css', 'text/css'],
  ['/vault-sync.js', 'text/javascript'],
]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/api/chat' || url.pathname === '/api/tts' || url.pathname === '/api/vault') {
    try {
      let size = 0; const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > (url.pathname === '/api/vault' ? 3200 * 1024 : 128 * 1024)) { res.writeHead(413); res.end('Request too large'); return; }
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString();
      try { req.body = raw ? JSON.parse(raw) : {}; }
      catch { res.writeHead(400); res.end('Invalid JSON'); return; }
      req.query = Object.fromEntries(url.searchParams);
      res.status = code => { res.statusCode = code; return res; };
      res.json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
      res.send = data => res.end(data);
      await (url.pathname === '/api/chat' ? chat : url.pathname === '/api/tts' ? tts : vault)(req, res);
    } catch { if (!res.headersSent) res.writeHead(500); res.end('Request failed'); }
    return;
  }
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  if (!['GET', 'HEAD'].includes(req.method) || !publicFiles.has(pathname)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  res.setHeader('Content-Type', publicFiles.get(pathname) + '; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.method === 'HEAD') { res.end(); return; }
  fs.createReadStream(path.join(root, pathname)).pipe(res);
});
server.listen(port, '127.0.0.1', () => console.log(`Learning English: http://127.0.0.1:${port}`));
