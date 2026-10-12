// Run with: node scripts/smoke-account.mjs <Vercel preview or production URL>
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const deployment = process.argv[2];
if (!deployment?.startsWith('https://')) throw new Error('Pass a Vercel deployment URL.');
const folder = mkdtempSync(join(tmpdir(), 'learning-account-smoke-'));
let counter = 0;
function call(path, method = 'GET', body, cookie) {
  const headerFile = join(folder, `headers-${++counter}`);
  const args = ['--yes', 'vercel@62.7.0', 'curl', path, '--deployment', deployment, '--scope', 'study-myown', '--',
    '--silent', '--show-error', '--dump-header', headerFile, '--request', method];
  if (body) args.push('--header', 'Content-Type: application/json', '--data-binary', JSON.stringify(body));
  if (cookie) args.push('--header', `Cookie: ${cookie}`);
  const result = spawnSync('npx', args, { encoding: 'utf8', timeout: 45_000 });
  if (result.status !== 0) throw new Error(`Request failed: ${result.stderr.replace(/iv_session=[^;\s]+/g, 'iv_session=[redacted]').slice(0, 400)}`);
  const headers = readFileSync(headerFile, 'utf8');
  unlinkSync(headerFile);
  const statuses = [...headers.matchAll(/^HTTP\/\S+ (\d+)/gm)];
  const status = Number(statuses.at(-1)?.[1]);
  const session = /(?:^|\r?\n)set-cookie:\s*(iv_session=[^;\r\n]+)/i.exec(headers)?.[1];
  let data;
  try { data = JSON.parse(result.stdout); } catch { throw new Error(`Invalid JSON response (${status}).`); }
  return { status, data, session };
}
try {
  const email = `smoke-${randomBytes(8).toString('hex')}@example.invalid`;
  const password = randomBytes(24).toString('base64url');
  const snapshot = { schema: 1, days: [{ id: 'smoke', words: [{ en: 'coffee', vi: 'cà phê' }] }],
    stats: { xp: 10 }, errors: [], mistakes: [], logs: [], progress: {}, customTopics: [] };
  const registration = call('/api/account', 'POST', { action: 'register', email, password, snapshot });
  if (registration.status !== 201 || !registration.session) throw new Error(`Registration failed (${registration.status}).`);
  const first = call('/api/vault', 'GET', null, registration.session);
  if (first.status !== 200 || first.data.snapshot?.days[0]?.words[0]?.en !== 'coffee') throw new Error('First device did not restore coffee.');
  const login = call('/api/account', 'POST', { action: 'login', email, password });
  if (login.status !== 200 || !login.session) throw new Error(`Second device login failed (${login.status}).`);
  const updated = { ...snapshot, days: [...snapshot.days, { id: 'second', words: [{ en: 'tea', vi: 'trà' }] }] };
  const saved = call('/api/vault', 'PUT', { snapshot: updated, etag: first.data.etag }, login.session);
  if (saved.status !== 200) throw new Error(`Second device save failed (${saved.status}).`);
  const restored = call('/api/vault', 'GET', null, registration.session);
  if (restored.status !== 200 || restored.data.snapshot?.days?.length !== 2) throw new Error('First device read a stale copy.');
  const wrong = call('/api/account', 'POST', { action: 'login', email, password: 'wrong password' });
  if (wrong.status !== 401) throw new Error('Wrong password was accepted.');
  console.log('Account registration, cross-device login, immediate sync and password rejection: passed.');
} finally {
  rmdirSync(folder);
}
