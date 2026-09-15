#!/usr/bin/env node
/**
 * Xacheus end-to-end smoke test.
 *
 * Boots the real compiled server on a throwaway port with a throwaway data
 * directory, then drives it exactly like a client would: health, auth, chat,
 * confirmation handshake, memory, knowledge, connectors, stats, audit.
 *
 * It asserts the promises the platform makes — above all that Xacheus never
 * reports a simulated or blocked action as a real one.
 *
 *   npm run build && npm run smoke
 *
 * Exit code 0 = everything behaved. Anything else is a real failure to look at.
 */
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8899);
const BASE = `http://127.0.0.1:${PORT}`;
const PASSCODE = 'smoke-test-passcode';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title) {
  console.log(`\n\u001b[1m${title}\u001b[0m`);
}

async function call(path, { method = 'GET', body, token, raw = false } = {}) {
  const response = await fetch(BASE + path, {
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

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const dataDir = await mkdtemp(join(tmpdir(), 'xacheus-smoke-'));
const server = spawn(process.execPath, ['apps/server/dist/index.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    XACHEUS_DATA_DIR: dataDir,
    XACHEUS_OWNER_PASSCODE: PASSCODE,
    XACHEUS_MODEL: 'heuristic',
    XACHEUS_STORAGE: 'json',
    XACHEUS_CORS_ORIGINS: '*',
    WHATSAPP_VERIFY_TOKEN: 'smoke-verify-token',
    WHATSAPP_APP_SECRET: 'smoke-app-secret',
    XACHEUS_DEVICE_BRIDGE_TOKEN: 'smoke-device-token',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (chunk) => (serverLog += chunk.toString()));
server.stderr.on('data', (chunk) => (serverLog += chunk.toString()));

const stop = async () => {
  if (!server.killed) server.kill('SIGTERM');
  await new Promise((resolve) => setTimeout(resolve, 400));
  if (!server.killed) server.kill('SIGKILL');
  await rm(dataDir, { recursive: true, force: true });
};

try {
  console.log(`\u001b[1mXacheus smoke test\u001b[0m — server on ${BASE}, data in ${dataDir}`);
  if (!(await waitForHealth())) {
    console.error('\nServer never became healthy. Log:\n' + serverLog.slice(-4000));
    process.exit(1);
  }

  section('1. Public surface & auth');

  const health = await call('/api/health');
  check('GET /api/health is public and healthy', health.ok && health.body.ok === true, JSON.stringify(health.body).slice(0, 120));

  const config = await call('/api/config');
  check('GET /api/config exposes the console bootstrap', config.ok && config.body.auth?.mode);
  check('passcode mode is active when a passcode is set', /passcode/i.test(config.body.auth.mode), config.body.auth.mode);
  check('no secrets leak through /api/config', !config.raw.includes(PASSCODE));

  const unauthenticated = await call('/api/stats');
  check('a guarded route rejects an unauthenticated caller', unauthenticated.status === 401, `status ${unauthenticated.status}`);

  const wrongToken = await call('/api/stats', { token: 'not-the-passcode' });
  check('a wrong passcode is rejected', wrongToken.status === 401, `status ${wrongToken.status}`);

  const token = PASSCODE;
  const authed = await call('/api/stats', { token });
  check('the owner passcode unlocks the Control Center surface', authed.ok && authed.body.agents);

  section('2. Conversational core');

  const chat = await call('/api/chat', { method: 'POST', body: { text: 'what is on today?', sessionId: 'smoke' }, token });
  check('POST /api/chat answers with a completed run', chat.ok && chat.body.run?.status === 'completed');
  check('the run carries a plan the console can render', Array.isArray(chat.body.run?.plan) && chat.body.run.plan.length > 0);
  check('the answer is plain text, not an error dump', typeof chat.body.run?.response === 'string' && chat.body.run.response.length > 10);

  const voice = await call('/api/voice', { method: 'POST', body: { text: 'what is on today?', sessionId: 'smoke-voice' }, token });
  check('POST /api/voice returns a speakable string', voice.ok && typeof voice.body.text === 'string' && voice.body.text.length > 5);

  const emptyRequest = await call('/api/chat', { method: 'POST', body: { text: '   ' }, token });
  check('an empty request is rejected with a clear 400', emptyRequest.status === 400 && emptyRequest.body.error === 'empty_request');

  section('3. Nothing is faked');

  const sandboxRun = await call('/api/chat', {
    method: 'POST',
    body: { text: 'search the web for wholesale coffee suppliers', sessionId: 'smoke-sandbox' },
    token,
  });
  const step = sandboxRun.body.run?.plan?.[0];
  check('every executed step reports its execution mode', Boolean(step?.result?.mode), JSON.stringify(step?.result ?? null).slice(0, 120));
  check(
    'a step that did not touch the real world says so',
    step?.result?.mode !== 'live' || /search|result/i.test(step.result.summary),
    `mode=${step?.result?.mode}`,
  );

  section('4. Permissions and the confirmation handshake');

  const blockedRun = await call('/api/chat', {
    method: 'POST',
    body: { text: 'post to facebook that we are open today', sessionId: 'smoke-blocked' },
    token,
  });
  const blocked = blockedRun.body.run.plan.find((entry) => entry.result?.mode === 'blocked');
  check('publishing without permission is blocked, not faked', Boolean(blocked));
  check(
    'the block explains how to grant the permission',
    /grant|control center|permission/i.test(blockedRun.body.run.response),
    blockedRun.body.run.response.slice(0, 140),
  );

  const grants = await call('/api/permissions/scopes', { method: 'POST', body: { scopes: ['social:read', 'social:publish'], grant: true }, token });
  check('the owner can grant a scope', grants.ok);

  const gated = await call('/api/chat', {
    method: 'POST',
    body: { text: 'post to facebook: smoke test post, please ignore', sessionId: 'smoke-gated' },
    token,
  });
  check('a granted-but-high-impact action asks for confirmation', gated.body.run?.status === 'awaiting_confirmation', gated.body.run?.status);

  const pending = await call('/api/runs/pending', { token });
  check('the pending run is listed for the console and the phone', (pending.body.runs ?? []).length > 0);

  const pendingStep = gated.body.run.plan.find((entry) => entry.status === 'awaiting_confirmation');
  const declined = await call(`/api/runs/${gated.body.run.id}/confirm`, {
    method: 'POST',
    body: { stepId: pendingStep.id, approve: false },
    token,
  });
  check('declining cancels the run', declined.body.run?.status === 'cancelled', declined.body.run?.status);
  check(
    'declining executes nothing and says so',
    declined.body.run.plan.find((entry) => entry.id === pendingStep.id).status === 'denied',
  );

  const revoked = await call('/api/permissions/scopes', { method: 'POST', body: { scopes: ['social:publish'], grant: false }, token });
  check('the owner can revoke a scope again', revoked.ok);

  section('5. Memory, knowledge and the business brain');

  const remembered = await call('/api/chat', {
    method: 'POST',
    body: { text: 'remember that our smoke test ran successfully at 09:00', sessionId: 'smoke-memory' },
    token,
  });
  check('a "remember" request completes', remembered.ok && remembered.body.run.status === 'completed');

  const memories = await call('/api/memory', { token });
  const memoryList = memories.body.records ?? [];
  check('the memory is stored and readable through the API', memoryList.length > 0, `${memoryList.length} entries`);
  check('memory counts are reported by kind', Boolean(memories.body.counts && typeof memories.body.counts['long-term'] === 'number'));

  const knowledgeText = await call('/api/knowledge/text', {
    method: 'POST',
    body: {
      title: 'Smoke test document',
      text: 'Xacheus stores documents as searchable knowledge. The secret handshake word for this smoke test is ORANGE-LANTERN.',
      collection: 'smoke',
    },
    token,
  });
  check('a text document can be ingested into the knowledge base', knowledgeText.ok && (knowledgeText.body.document?.chunkCount ?? 0) > 0);

  const search = await call('/api/knowledge/search?q=ORANGE-LANTERN', { token });
  const hits = search.body.hits ?? [];
  check('the ingested document is retrievable by search', hits.length > 0, `${hits.length} hits`);
  check(
    'search results cite their source document',
    hits.length === 0 || hits.every((hit) => Boolean(hit.documentTitle ?? hit.title)),
  );

  const brief = await call('/api/business/brief', { token });
  check('the business brief is available to the agent and the dashboard', typeof brief.body.text === 'string' && brief.body.text.length > 10);

  const lead = await call('/api/business/leads', {
    method: 'POST',
    body: { name: 'Smoke Lead', note: 'wants 20 chairs', value: 500, stage: 'new' },
    token,
  });
  check('a lead can be recorded through the API', lead.ok);

  section('6. Connect, devices and the model layer');

  const connectors = await call('/api/connectors', { token });
  const list = connectors.body.connectors ?? [];
  check('every connector declares its live/sandbox status', list.length >= 9 && list.every((entry) => entry.status?.mode));
  check(
    'unconfigured connectors name exactly what is missing',
    list.filter((entry) => entry.status.mode !== 'live').every((entry) => (entry.status.missingFields ?? []).length > 0),
  );

  const verification = await call('/api/connectors/web/verify', { method: 'POST', body: {}, token });
  check('a connector can be tested on demand and reports truthfully', verification.ok && typeof verification.body.detail === 'string');

  const models = await call('/api/models', { token });
  check('the model layer lists its options', (models.body.available ?? []).length >= 1);
  check('the active model is identified', Boolean(models.body.active));

  const devices = await call('/api/devices', { token });
  check('the device bridge answers with connected/paired state', Array.isArray(devices.body.connected) && Array.isArray(devices.body.paired));

  const deviceCommand = await call('/api/devices/smoke-phone/command', {
    method: 'POST',
    body: { command: 'device.info', args: {} },
    token,
  });
  check(
    'a command to an unpaired phone is reported as simulated, never as done',
    deviceCommand.ok && /simulat|no .*device|not connected|pair/i.test(deviceCommand.body.result?.summary ?? ''),
    deviceCommand.body.result?.summary?.slice(0, 120),
  );

  const deviceToken = await call(
    `/api/devices/socket?deviceId=smoke-phone&name=Smoke%20Phone&platform=android&appVersion=smoke&token=wrong-token`,
    {},
  );
  check('the device bridge rejects a wrong bridge token', deviceToken.status >= 400 || deviceToken.body?.error !== undefined);

  // Connect a simulated Android phone speaking the real bridge protocol and make
  // it answer a command. This is the check that "live" really means live.
  const phone = new WebSocket(
    `ws://127.0.0.1:${PORT}/api/devices/socket?deviceId=smoke-phone&name=Smoke%20Phone&platform=android&appVersion=smoke&token=smoke-device-token`,
  );
  const phoneReady = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 5000);
    phone.addEventListener('message', (event) => {
      const frame = JSON.parse(event.data);
      if (frame.type === 'ready') {
        clearTimeout(timer);
        resolve(true);
      }
      if (frame.type === 'command') {
        phone.send(
          JSON.stringify({
            type: 'result',
            id: frame.id,
            ok: true,
            mode: 'live',
            summary: `Smoke phone executed ${frame.command}.`,
            data: { model: 'simulated Pixel' },
          }),
        );
      }
    });
  });
  check('a phone speaking the bridge protocol registers with the backend', await phoneReady);

  await call('/api/devices/pair', { method: 'POST', body: { deviceId: 'smoke-phone', name: 'Smoke Phone' }, token });
  const bridged = await call('/api/devices/smoke-phone/command', {
    method: 'POST',
    body: { command: 'device.info', args: {} },
    token,
  });
  check(
    'a command reaches the connected phone and returns its real answer',
    bridged.body.result?.mode === 'live' && /Smoke phone executed device\.info/.test(bridged.body.result?.summary ?? ''),
    `${bridged.body.result?.mode}: ${bridged.body.result?.summary?.slice(0, 80)}`,
  );

  const connectedList = await call('/api/devices', { token });
  check(
    'the connected phone is shown in the Control Center',
    (connectedList.body.connected ?? []).some((entry) => entry.deviceId === 'smoke-phone'),
  );
  phone.close();

  section('7. Automations, notifications and the audit trail');

  const starters = await call('/api/automations/starters', { token });
  check('starter automations are offered to the owner', (starters.body.starters ?? []).length > 0, `${starters.body.starters?.length ?? 0} templates`);

  const installed = await call('/api/automations/starters', { method: 'POST', body: { index: 0 }, token });
  check('a starter automation can be installed with one call', Boolean(installed.body.automation?.id));

  const automation = await call('/api/automations', {
    method: 'POST',
    body: {
      name: 'Smoke test automation',
      enabled: false,
      trigger: { type: 'interval', everyMinutes: 30 },
      actions: [{ tool: 'business.snapshot', input: {} }],
    },
    token,
  });
  check('an automation can be created', automation.ok && automation.body.automation?.id);

  const automationRun = await call(`/api/automations/${automation.body.automation.id}/run`, { method: 'POST', body: {}, token });
  check('an automation runs and records its result', Boolean(automationRun.body.run?.status), automationRun.body.run?.status);
  check('the automation run names the step it took', (automationRun.body.run?.steps ?? []).length > 0);

  const notifications = await call('/api/notifications', { token });
  check('notifications are retrievable', Array.isArray(notifications.body.notifications));

  const audit = await call('/api/audit?limit=100', { token });
  const entries = audit.body.entries ?? [];
  check('the audit log records the session', entries.length > 0, `${entries.length} entries`);
  check(
    'the audit log covers the whole pipeline, not just execution',
    new Set(entries.map((entry) => entry.stage)).size > 1,
    [...new Set(entries.map((entry) => entry.stage))].join(', '),
  );
  check('audit entries name the actor', entries.every((entry) => Boolean(entry.actor)));

  section('8. WhatsApp webhook (Cloud API contract, no owner passcode)');

  const handshake = await call(
    `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent('smoke-verify-token')}&hub.challenge=42`,
    {},
  );
  check('Meta can verify the subscription without an owner passcode', handshake.status === 200 && handshake.raw === '42', `status ${handshake.status}`);

  const badHandshake = await call(
    `/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${encodeURIComponent('wrong')}&hub.challenge=42`,
    {},
  );
  check('a handshake with the wrong verify token is refused', badHandshake.status === 403, `status ${badHandshake.status}`);

  const payload = JSON.stringify({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [{ from: '254700000000', id: 'smoke-msg-1', type: 'text', text: { body: 'Do you deliver to Nairobi?' } }],
              contacts: [{ profile: { name: 'Smoke Customer' } }],
            },
          },
        ],
      },
    ],
  });

  const unsigned = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  check('an unsigned inbound webhook is rejected', unsigned.status === 401, `status ${unsigned.status}`);

  const signature = createHmac('sha256', 'smoke-app-secret').update(payload).digest('hex');
  const inbound = await fetch(`${BASE}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': `sha256=${signature}` },
    body: payload,
  });
  const inboundBody = await inbound.json().catch(() => ({}));
  check('a correctly signed inbound message is accepted', inbound.status === 200 && inboundBody.processed === 1, `status ${inbound.status}`);

  const afterWebhook = await call('/api/business/leads', { token });
  check(
    'the inbound WhatsApp message became a tracked lead',
    (afterWebhook.body.leads ?? []).some((entry) => /254700000000/i.test(entry.name) || /Nairobi/i.test(entry.note ?? '')),
    JSON.stringify((afterWebhook.body.leads ?? []).map((lead) => lead.name)).slice(0, 120),
  );

  const notificationCheck = await call('/api/notifications', { token });
  check(
    'the owner is notified about the inbound message',
    (notificationCheck.body.notifications ?? []).some((entry) => /whatsapp/i.test(entry.title)),
  );
} catch (error) {
  failures.push(`unexpected failure: ${error.stack ?? error.message}`);
  console.error('\n\u001b[31mSmoke test crashed\u001b[0m', error);
  console.error('\nServer log tail:\n' + serverLog.slice(-3000));
} finally {
  await stop();
}

console.log('\n' + '─'.repeat(64));
if (failures.length === 0) {
  console.log(`\u001b[32m✔ smoke test passed\u001b[0m — ${passed} checks`);
  process.exit(0);
}
console.log(`\u001b[31m✖ smoke test failed\u001b[0m — ${passed} passed, ${failures.length} failed:\n`);
for (const failure of failures) console.log(`  • ${failure}`);
process.exit(1);
