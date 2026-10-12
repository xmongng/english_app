import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { validSnapshot, vaultPath } from './vault.js';

const scrypt = promisify(scryptCallback);
const COOKIE = 'iv_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const PASSWORD_MAX = 1024;
const SNAPSHOT_MAX = 3 * 1024 * 1024;
const options = { access: 'private', contentType: 'application/json', cacheControlMaxAge: 60 };

export function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function accountId(email) {
  return createHash('sha256').update(email).digest('hex');
}

const accountPath = id => `accounts/v1/${id}.json`;
const hashPassword = async (password, salt) => (await scrypt(password, Buffer.from(salt, 'hex'), 64)).toString('hex');
const same = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a, 'hex'), right = Buffer.from(b, 'hex');
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
};
const cookieValue = (record, id, now = Date.now()) => {
  const payload = Buffer.from(JSON.stringify({ id, exp: now + SESSION_MS })).toString('base64url');
  const signature = createHmac('sha256', Buffer.from(record.sessionSecret, 'hex')).update(payload).digest('hex');
  return `${payload}.${signature}`;
};
const cookieHeader = (value, clear = false) => `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${clear ? 0 : SESSION_MS / 1000}`;

async function loadRecord(storage, id) {
  const result = await storage.get(accountPath(id), { access: 'private', useCache: false });
  if (!result) return null;
  const record = JSON.parse(await new Response(result.stream).text());
  return { record, etag: result.blob.etag };
}

export async function authenticate(req, storage = { get, put }, now = Date.now()) {
  const match = /(?:^|;\s*)iv_session=([^;]+)/.exec(String(req.headers?.cookie || ''));
  if (!match) return null;
  const [payload, signature] = match[1].split('.');
  if (!payload || !/^[a-f0-9]{64}$/.test(signature || '')) return null;
  let data;
  try { data = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { return null; }
  if (!/^[a-f0-9]{64}$/.test(data?.id || '') || !Number.isSafeInteger(data.exp) || data.exp <= now || data.exp > now + SESSION_MS) return null;
  const found = await loadRecord(storage, data.id);
  if (!found?.record?.sessionSecret) return null;
  const expected = createHmac('sha256', Buffer.from(found.record.sessionSecret, 'hex')).update(payload).digest('hex');
  return same(signature, expected) ? { id: data.id, ...found } : null;
}

function sameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

async function recordFailure(storage, id, found, now) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const count = now - (found.record.firstFailureAt || 0) > 15 * 60 * 1000 ? 1 : (found.record.failedAttempts || 0) + 1;
    const updated = { ...found.record, failedAttempts: count, firstFailureAt: count === 1 ? now : found.record.firstFailureAt,
      lockedUntil: count >= 5 ? now + 15 * 60 * 1000 : 0 };
    try {
      await storage.put(accountPath(id), JSON.stringify(updated), { ...options, allowOverwrite: true, ifMatch: found.etag });
      return;
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError) && error?.name !== 'BlobPreconditionFailedError') throw error;
      found = await loadRecord(storage, id);
      if (!found) return;
    }
  }
}

export function createAccountHandler(storage = { get, put }, now = () => Date.now()) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
    if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) return res.status(503).json({ error: 'Cloud storage is unavailable.' });
    if (req.method === 'POST' && !sameOrigin(req)) return res.status(403).json({ error: 'Invalid request origin.' });
    try {
      if (req.method === 'GET') {
        const session = await authenticate(req, storage, now());
        return res.status(200).json({ account: session ? { id: session.id, email: session.record.email } : null });
      }
      const action = req.body?.action;
      if (action === 'logout') {
        res.setHeader('Set-Cookie', cookieHeader('', true));
        return res.status(200).json({ account: null });
      }
      if (!['register', 'login'].includes(action)) return res.status(400).json({ error: 'Invalid account action.' });
      const email = normalizeEmail(req.body?.email), password = req.body?.password;
      if (!email || typeof password !== 'string' || password.length < 8 || password.length > PASSWORD_MAX) {
        return res.status(400).json({ error: 'Enter a valid email and a password of at least 8 characters.' });
      }
      const id = accountId(email);
      let found = await loadRecord(storage, id);
      if (action === 'register') {
        if (found) return res.status(409).json({ error: 'This email already has an account. Sign in instead.' });
        const snapshot = req.body?.snapshot;
        if (!validSnapshot(snapshot) || Buffer.byteLength(JSON.stringify(snapshot)) > SNAPSHOT_MAX) return res.status(400).json({ error: 'Study data is invalid or too large.' });
        const salt = randomBytes(32).toString('hex');
        const vaultKey = randomBytes(32).toString('hex');
        const record = { email, salt, passwordHash: await hashPassword(password, salt), vaultKey,
          sessionSecret: randomBytes(32).toString('hex'), failedAttempts: 0, firstFailureAt: 0, lockedUntil: 0 };
        await storage.put(vaultPath(`Vault ${vaultKey}`), JSON.stringify(snapshot), options);
        try { await storage.put(accountPath(id), JSON.stringify(record), options); }
        catch (error) {
          if (error?.name === 'BlobAlreadyExistsError' || error instanceof BlobPreconditionFailedError) return res.status(409).json({ error: 'This email already has an account. Sign in instead.' });
          throw error;
        }
        res.setHeader('Set-Cookie', cookieHeader(cookieValue(record, id, now())));
        return res.status(201).json({ account: { id, email } });
      }
      if (!found) {
        await hashPassword(password, '0'.repeat(64));
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      if (found.record.lockedUntil > now()) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
      const actual = await hashPassword(password, found.record.salt);
      if (!same(actual, found.record.passwordHash)) {
        await recordFailure(storage, id, found, now());
        return res.status(401).json({ error: 'Email or password is incorrect.' });
      }
      res.setHeader('Set-Cookie', cookieHeader(cookieValue(found.record, id, now())));
      return res.status(200).json({ account: { id, email } });
    } catch (error) {
      console.error('Account request failed', error?.name || 'Error');
      return res.status(503).json({ error: 'Account service is temporarily unavailable.' });
    }
  };
}

export default createAccountHandler();
