import { createHash } from 'node:crypto';

const INTERVAL_MS = 15_000; // At most four calls in any rolling minute.
let nextLocalCall = 0;

export async function reserveNvidiaCall(apiKey, now = Date.now()) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url || token) {
    if (!url || !token) throw new Error('Both Upstash Redis credentials are required.');
    const key = `learning-english:nvidia:${createHash('sha256').update(apiKey).digest('hex').slice(0, 24)}`;
    const endpoint = url.replace(/\/$/, '');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const result = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify(['SET', key, String(now), 'NX', 'PX', INTERVAL_MS]),
      signal: AbortSignal.timeout(3000),
    });
    if (!result.ok) throw new Error('Shared AI rate limiter is unavailable.');
    const data = await result.json();
    if (data.error) throw new Error('Shared AI rate limiter rejected the request.');
    if (data.result === 'OK') return { allowed: true, retryAfter: 0 };
    const ttl = await fetch(endpoint, {
      method: 'POST', headers, body: JSON.stringify(['PTTL', key]),
      signal: AbortSignal.timeout(3000),
    });
    if (!ttl.ok) throw new Error('Shared AI rate limiter is unavailable.');
    const remaining = (await ttl.json()).result;
    return { allowed: false, retryAfter: Math.max(1, Math.ceil((Number(remaining) || INTERVAL_MS) / 1000)) };
  }
  if (now < nextLocalCall) return { allowed: false, retryAfter: Math.max(1, Math.ceil((nextLocalCall - now) / 1000)) };
  nextLocalCall = now + INTERVAL_MS;
  return { allowed: true, retryAfter: 0 };
}

export function resetLocalLimiterForTests() { nextLocalCall = 0; }
