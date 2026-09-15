#!/usr/bin/env node
/**
 * Serverless (Vercel) readiness check.
 *
 * Simulates the deployment rather than trusting it: sets VERCEL=1, imports the
 * real `api/index.js` handler, and drives it through a plain Node HTTP server
 * the same way Vercel's Node runtime would.
 *
 * What it proves:
 *   • the function boots, serves the API and reuses its kernel on later calls
 *   • it REFUSES to start with throwaway storage until you opt in — and says why
 *   • with ephemeral storage allowed it warns instead of pretending
 *   • /api/runtime tells the truth about WebSockets, scheduling and storage
 *   • GET /api/tasks/tick is reachable by a cron and refuses a wrong secret
 *   • the polling device transport round-trips a command
 *   • the built console is served from the same function
 *
 * Run: node scripts/smoke-serverless.mjs        (needs `npm run build` first)
 */
import { createServer, request as httpRequest } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PASSCODE = 'serverless-smoke-passcode';
const DEVICE_TOKEN = 'serverless-device-token';

let passed = 0;
const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const section = (title) => console.log(`\n\u001b[1m${title}\u001b[0m`);

/** Boot the function behind a real HTTP server, exactly like the Vercel runtime. */
async function bootFunction(env) {
  Object.assign(process.env, env);
  const moduleUrl = new URL(`../api/index.js?t=${Date.now()}`, import.meta.url).href;
  const handler = (await import(moduleUrl)).default;

  const server = createServer((req, res) => Promise.resolve(handler(req, res)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function call(port, path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed, raw: text, ok: response.ok };
}

console.log('\u001b[1mXacheus serverless readiness check\u001b[0m — simulating a Vercel function\n');

/* ------------------------------------------------------------------ 1. refusal */

section('1. It refuses to lie about durability');

const refuseDir = await mkdtemp(join(tmpdir(), 'xacheus-serverless-refuse-'));
{
  const { server, port } = await bootFunction({
    VERCEL: '1',
    XACHEUS_DATA_DIR: refuseDir,
    XACHEUS_STORAGE: 'json',
    XACHEUS_OWNER_PASSCODE: PASSCODE,
    XACHEUS_ALLOW_EPHEMERAL_STORAGE: '',
    PORT: '0',
  });
  const health = await call(port, '/api/health');
  check('with throwaway storage on serverless, the function refuses with 503', health.status === 503, `status ${health.status}`);
  check('the refusal is legible, not a stack trace', /firestore|ephemeral/i.test(String(health.body?.message ?? '')), String(health.body?.message ?? '').slice(0, 120));
  check('the refusal tells you which env vars to set', /XACHEUS_STORAGE=firestore/.test(JSON.stringify(health.body?.hint ?? [])));
  await new Promise((resolve) => server.close(resolve));
  await rm(refuseDir, { recursive: true, force: true });
}

/* ------------------------------------------- 1b. misconfigured Firestore guard */

section('1b. A broken Firestore config is caught, not silently downgraded');

const brokenDir = await mkdtemp(join(tmpdir(), 'xacheus-serverless-brokenfs-'));
{
  const { server, port } = await bootFunction({
    VERCEL: '1',
    XACHEUS_DATA_DIR: brokenDir,
    XACHEUS_STORAGE: 'firestore',
    // A service account that cannot possibly work — the classic "I pasted the
    // wrong JSON" deployment. Without this check Xacheus would boot, claim
    // durable storage and quietly write to the ephemeral disk instead.
    FIREBASE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'nope@example.com', private_key: 'not-a-key', project_id: 'xacheus-ai' }),
    GOOGLE_APPLICATION_CREDENTIALS: '',
    XACHEUS_OWNER_PASSCODE: PASSCODE,
    XACHEUS_ALLOW_EPHEMERAL_STORAGE: '',
    PORT: '0',
  });
  const response = await call(port, '/api/health');
  check('an unusable Firestore credential is refused, not downgraded to disk', response.status === 503, `status ${response.status}`);
  check(
    'the refusal explains the fallback that was prevented',
    /falling back|unusable|local JSON/i.test(String(response.body?.message ?? '')),
    String(response.body?.message ?? '').slice(0, 150),
  );
  await new Promise((resolve) => server.close(resolve));
  await rm(brokenDir, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- 2. opt-in */

section('2. With the opt-in it starts, and says what that means');

const dataDir = await mkdtemp(join(tmpdir(), 'xacheus-serverless-'));
const { server, port } = await bootFunction({
  VERCEL: '1',
  XACHEUS_DATA_DIR: dataDir,
  XACHEUS_STORAGE: 'json',
  XACHEUS_ALLOW_EPHEMERAL_STORAGE: 'true',
  XACHEUS_OWNER_PASSCODE: PASSCODE,
  XACHEUS_DEVICE_BRIDGE_TOKEN: DEVICE_TOKEN,
  XACHEUS_CORS_ORIGINS: '*',
  CRON_SECRET: 'cron-secret-value',
  PORT: '0',
});

try {
  const health = await call(port, '/api/health');
  check('the function serves /api/health once allowed', health.ok && health.body.ok === true, `status ${health.status}`);

  const guarded = await call(port, '/api/stats');
  check('guarded routes still require the owner passcode', guarded.status === 401, `status ${guarded.status}`);

  const config = await call(port, '/api/config');
  check('the public config reports the runtime honestly', config.body.features?.runtime === 'serverless', String(config.body.features?.runtime));
  check('the public config warns that WebSockets are unavailable', config.body.features?.websockets === false);
  check('the public config flags non-durable storage', config.body.features?.durableStorage === false);

  const runtime = await call(port, '/api/runtime', { token: PASSCODE });
  check('GET /api/runtime answers for the owner', runtime.ok && runtime.body.runtime === 'serverless');
  check('it states that an in-process scheduler cannot run here', runtime.body.automations?.schedulerInProcess === false);
  check('it names the cron endpoint as the fix', /tasks\/tick/.test(runtime.body.automations?.cronHint ?? ''));
  check('it warns about ephemeral storage', (runtime.body.warnings ?? []).length >= 2, JSON.stringify(runtime.body.warnings ?? []).slice(0, 140));

  /* ---------------------------------------------------------------- 3. work */

  section('3. The agent still works on a function');

  const chat = await call(port, '/api/chat', { method: 'POST', body: { text: 'what is on today?', sessionId: 'serverless' }, token: PASSCODE });
  check('POST /api/chat completes', chat.ok && chat.body.run?.status === 'completed', chat.body.run?.status);
  check('the run carries a plan', (chat.body.run?.plan ?? []).length > 0, `${chat.body.run?.plan?.length ?? 0} steps`);

  const memory = await call(port, '/api/chat', {
    method: 'POST',
    body: { text: 'remember that the serverless smoke test passed', sessionId: 'serverless-memory' },
    token: PASSCODE,
  });
  const stored = await call(port, '/api/memory', { token: PASSCODE });
  check('memory written on one invocation is readable on the next', (stored.body.records ?? []).length > 0, (memory.body.run?.status ?? 'no run') + `, ${(stored.body.records ?? []).length} records`);

  /* ------------------------------------------------------------- 4. kernel reuse */

  section('4. The kernel is reused, not rebuilt per request');

  const before = await call(port, '/api/status', { token: PASSCODE });
  for (let index = 0; index < 5; index++) await call(port, '/api/health');
  const after = await call(port, '/api/status', { token: PASSCODE });
  check('the kernel instance is warm across invocations', after.body.storage?.ok === true && before.ok);
  const stored2 = await call(port, '/api/memory', { token: PASSCODE });
  check('state survives across requests in the same instance', (stored2.body.records ?? []).length === (stored.body.records ?? []).length);

  /* ------------------------------------------------------- 5. console + cron */

  section('5. The console and the cron hook come from the same function');

  const page = await call(port, '/');
  check('the built console is served', page.ok && /<title>Xacheus/.test(page.raw), `status ${page.status}`);
  check('the console bundle path is present', /\/assets\/index-/.test(page.raw));

  const sitemapish = await call(port, '/any/client/route');
  check('unknown paths fall back to the console shell', sitemapish.ok && /<title>Xacheus/.test(sitemapish.raw));

  const noAuth = await call(port, '/api/tasks/tick');
  check('the cron endpoint refuses a request with no secret', noAuth.status === 401, `status ${noAuth.status}`);

  const wrongSecret = await call(port, '/api/tasks/tick', { token: 'not-the-secret' });
  check('the cron endpoint refuses a wrong secret', wrongSecret.status === 401, `status ${wrongSecret.status}`);

  const cron = await call(port, '/api/tasks/tick', { token: 'cron-secret-value' });
  check('a GET cron call is accepted (Vercel Cron sends GET)', cron.ok && cron.body.ok === true, `status ${cron.status}`);
  check('the cron tick reports what it evaluated', typeof cron.body.skipped === 'number' && Array.isArray(cron.body.ran));
  check('the cron tick says which secret was used', cron.body.authorizedVia === 'CRON_SECRET', String(cron.body.authorizedVia));

  const passcodeCron = await call(port, '/api/tasks/tick', { token: PASSCODE });
  check('the owner passcode also drives the tick (self-hosted cron)', passcodeCron.ok && passcodeCron.body.authorizedVia === 'XACHEUS_OWNER_PASSCODE');

  /* ------------------------------------------------------- 6. device polling */

  section('6. A phone that polls still gets its work done');

  const paired = await call(port, '/api/devices/pair', { method: 'POST', body: { deviceId: 'smoke-poll-phone', name: 'Polling Phone' }, token: PASSCODE });
  check('the owner can pair a device over HTTP', paired.ok);

  const heartbeat = await call(port, '/api/devices/heartbeat', {
    method: 'POST',
    body: { deviceId: 'smoke-poll-phone', name: 'Polling Phone', platform: 'android', appVersion: 'smoke' },
    token: DEVICE_TOKEN,
  });
  check('a polling phone can check in with its device token', heartbeat.ok && heartbeat.body.session?.transport === 'poll', `status ${heartbeat.status}`);
  check('it receives an (empty) command list and a poll interval', Array.isArray(heartbeat.body.commands) && heartbeat.body.pollAfterMs > 0);

  const queued = await call(port, '/api/devices/smoke-poll-phone/command', {
    method: 'POST',
    body: { command: 'device.batteryStatus', args: {} },
    token: PASSCODE,
  });
  check('a command to a polling phone is queued, not silently dropped', queued.body.result?.data?.queued === true, queued.body.result?.summary?.slice(0, 110));
  check('the queue notice explains why it is queued', /HTTP|polling|socket/i.test(queued.body.result?.summary ?? ''));

  const collect = await call(port, '/api/devices/heartbeat', {
    method: 'POST',
    body: { deviceId: 'smoke-poll-phone', name: 'Polling Phone' },
    token: DEVICE_TOKEN,
  });
  const command = (collect.body.commands ?? [])[0];
  check('the next check-in collects the queued command', command?.command === 'device.batteryStatus', JSON.stringify(collect.body.commands ?? []).slice(0, 120));

  const reported = await call(port, '/api/devices/result', {
    method: 'POST',
    body: { id: command?.id, ok: true, mode: 'live', summary: 'Battery is at 84%.', data: { level: 84 } },
    token: DEVICE_TOKEN,
  });
  check('the phone can report its result back', reported.ok && reported.body.accepted === true, `status ${reported.status}`);

  const lateResult = await call(port, '/api/devices/result', {
    method: 'POST',
    body: { id: 'cmd_nonexistent', ok: true, summary: 'late' },
    token: DEVICE_TOKEN,
  });
  check('a late or unknown result is acknowledged without a 500', lateResult.status === 202, `status ${lateResult.status}`);

  const sessions = await call(port, '/api/devices', { token: PASSCODE });
  check(
    'the console sees the polling phone in the device list',
    (sessions.body.connected ?? []).some((entry) => entry.deviceId === 'smoke-poll-phone'),
    JSON.stringify(sessions.body.connected ?? []).slice(0, 120),
  );

  /* ---------------------------------------------------------- 7. guardrails */

  section('7. Serverless does not weaken the guardrails');

  const blocked = await call(port, '/api/chat', {
    method: 'POST',
    body: { text: 'post to facebook that we are open today', sessionId: 'serverless-blocked' },
    token: PASSCODE,
  });
  check('publishing without permission is still blocked', blocked.body.run.plan.some((step) => step.result?.mode === 'blocked'));

  await call(port, '/api/permissions/scopes', { method: 'POST', body: { scopes: ['social:read', 'social:publish'], grant: true }, token: PASSCODE });
  const gated = await call(port, '/api/chat', {
    method: 'POST',
    body: { text: 'post to facebook: serverless smoke, please ignore', sessionId: 'serverless-gated' },
    token: PASSCODE,
  });
  check('a high-impact action still waits for confirmation', gated.body.run?.status === 'awaiting_confirmation', gated.body.run?.status);

  const audit = await call(port, '/api/audit?limit=50', { token: PASSCODE });
  check('the audit log is written on a function too', (audit.body.entries ?? []).length > 0, `${(audit.body.entries ?? []).length} entries`);
} catch (error) {
  failures.push(`unexpected failure: ${error.stack ?? error.message}`);
  console.error('\n\u001b[31mServerless check crashed\u001b[0m', error);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(dataDir, { recursive: true, force: true });
}

console.log('\n' + '─'.repeat(64));
if (failures.length === 0) {
  console.log(`\u001b[32m✔ serverless readiness check passed\u001b[0m — ${passed} checks`);
  process.exit(0);
}
console.log(`\u001b[31m✖ serverless check failed\u001b[0m — ${passed} passed, ${failures.length} failed:\n`);
for (const failure of failures) console.log(`  • ${failure}`);
process.exit(1);
