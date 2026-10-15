import { createHash } from 'node:crypto';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { authenticate } from './account.js';

const MAX_BYTES = 3 * 1024 * 1024;

export function vaultPath(authorization) {
  const match = /^Vault\s+([a-f0-9]{64})$/i.exec(String(authorization || ''));
  if (!match) return null;
  const secret = Buffer.from(match[1], 'hex');
  return `vaults/v1/${createHash('sha256').update(secret).digest('hex')}.json`;
}

export function validSnapshot(value) {
  return value && typeof value === 'object' && value.schema === 1 &&
    Array.isArray(value.days) && Array.isArray(value.errors) &&
    Array.isArray(value.mistakes) && Array.isArray(value.logs) &&
    Array.isArray(value.customTopics) &&
    value.stats && typeof value.stats === 'object' && !Array.isArray(value.stats) &&
    value.progress && typeof value.progress === 'object' && !Array.isArray(value.progress);
}

export function createVaultHandler(storage = { get, put }) {
  return async function handler(req, res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!['GET', 'PUT'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' });
    try {
      const session = await authenticate(req, storage);
      const path = session ? vaultPath(`Vault ${session.record.vaultKey}`) : vaultPath(req.headers?.authorization);
      if (!path) return res.status(401).json({ error: 'Sign in to sync your study data.' });
      if (!process.env.BLOB_STORE_ID && !process.env.BLOB_READ_WRITE_TOKEN) {
        return res.status(503).json({ error: 'Cloud storage is not configured.' });
      }
      if(req.method==='PUT'&&req.body?.accountId&&req.body.accountId!==session?.id)return res.status(401).json({error:'The signed-in account changed. Sign in again before saving.'});
      if (req.method === 'PUT' && session && req.headers?.origin) {
        let originHost;
        try { originHost = new URL(req.headers.origin).host; } catch { originHost = null; }
        if (originHost !== req.headers.host) return res.status(403).json({ error: 'Invalid request origin.' });
      }
      if (req.method === 'GET') {
        // Preserve the storage ETag: compressed downloads can expose a weak ETag
        // which is not valid for the conditional put() used to save this snapshot.
        const result = await storage.get(path, { access: 'private', useCache: false, headers: { 'Accept-Encoding': 'identity' } });
        const account=session?{id:session.id,email:session.record.email}:null;
        if (!result) return res.status(200).json({ exists: false, snapshot: null, etag: null, account });
        if (result.blob?.size > MAX_BYTES) return res.status(413).json({ error: 'Saved data exceeds the supported size.' });
        const body = await new Response(result.stream).text();
        if (Buffer.byteLength(body) > MAX_BYTES) return res.status(413).json({ error: 'Saved data exceeds the supported size.' });
        const snapshot = JSON.parse(body);
        if (!validSnapshot(snapshot)) throw new Error('Invalid stored snapshot');
        return res.status(200).json({ exists: true, snapshot, etag: result.blob.etag, account });
      }
      const snapshot = req.body?.snapshot;
      if (!validSnapshot(snapshot)) return res.status(400).json({ error: 'Invalid study data.' });
      const serialized = JSON.stringify(snapshot);
      if (Buffer.byteLength(serialized) > MAX_BYTES) return res.status(413).json({ error: 'Study data exceeds 3 MB.' });
      const etag = req.body?.etag;
      if (etag !== null && (typeof etag !== 'string' || etag.length > 100)) return res.status(400).json({ error: 'Invalid revision.' });
      const options = { access: 'private', contentType: 'application/json', cacheControlMaxAge: 60 };
      if (etag) { options.allowOverwrite = true; options.ifMatch = etag; }
      const saved = await storage.put(path, serialized, options);
      return res.status(200).json({ saved: true, etag: saved.etag, updatedAt: new Date().toISOString() });
    } catch (error) {
      if (error instanceof BlobPreconditionFailedError || error?.name === 'BlobAlreadyExistsError' || error?.name === 'BlobPreconditionFailedError') {
        return res.status(409).json({ error: 'The cloud revision changed since this copy was loaded. Keep local changes and merge with the latest cloud revision before retrying.' });
      }
      console.error('Vault storage failed', error?.name || 'Error');
      return res.status(503).json({ error: 'Cloud storage is temporarily unavailable. Local data was kept.' });
    }
  };
}

export default createVaultHandler();
