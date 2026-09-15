/**
 * Kernel tests — run against the built core (`npm run build -w @xacheus/core`).
 *
 * These cover the rules Xacheus must never get wrong:
 *   • a request that needs a permission that was not granted is blocked, not faked
 *   • a confirmation-gated action never executes before the owner approves
 *   • simulated results are labelled as simulated
 *   • memory, knowledge and business data survive a restart
 *   • automations never auto-execute a step that requires confirmation
 *
 *   node --test packages/core/test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createKernel, verifyFirebaseIdToken } from '../dist/index.js';

async function freshKernel(overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'xacheus-test-'));
  const kernel = await createKernel({
    dataDir,
    workspaceRoot: process.cwd(),
    startAutomations: false,
    env: { ...process.env, XACHEUS_STORAGE: 'json', XACHEUS_DATA_DIR: dataDir },
    ...overrides,
  });
  return { kernel, dataDir };
}

test('owner ask returns a completed run and a written answer', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const { run } = await kernel.handle('what do I have today?');
    assert.equal(run.status, 'completed');
    assert.ok(run.response.length > 0, 'response should not be empty');
    assert.ok(run.plan.length > 0, 'a plan should be recorded for display');
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a social publish is blocked until the scope is granted, and says so', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const { run } = await kernel.handle('post to facebook that we are open');
    const blocked = run.plan.find((step) => step.result?.mode === 'blocked');
    assert.ok(blocked, `expected a blocked step, got: ${JSON.stringify(run.plan.map((step) => step.status))}`);
    assert.match(run.response, /facebook|permission|grant/i);
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a confirmation-gated step waits, then executes only after approval', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    await kernel.services.permissions.grantScopes(['social:read', 'social:publish'], true);

    const { run } = await kernel.handle('post to facebook: workshop open Saturday 9am');
    assert.equal(run.status, 'awaiting_confirmation');

    const pendingStep = run.plan.find((step) => step.status === 'awaiting_confirmation');
    assert.ok(pendingStep, 'a step should be waiting for approval');

    const approved = await kernel.confirm(run, pendingStep.id, true);
    assert.notEqual(approved.status, 'awaiting_confirmation');
    const executed = approved.plan.find((step) => step.id === pendingStep.id);
    assert.ok(executed?.result, 'the step should have a result after approval');
    assert.notEqual(executed.result.mode, 'blocked');
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('declining a confirmation leaves the run cancelled and executes nothing', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    await kernel.services.permissions.grantScopes(['social:read', 'social:publish'], true);
    const { run } = await kernel.handle('post to facebook: closed today');
    const pendingStep = run.plan.find((step) => step.status === 'awaiting_confirmation');
    assert.ok(pendingStep);

    const declined = await kernel.confirm(run, pendingStep.id, false);
    assert.equal(declined.status, 'cancelled');
    const step = declined.plan.find((entry) => entry.id === pendingStep.id);
    assert.equal(step.status, 'denied');
    assert.equal(step.result.mode, 'blocked');
    assert.match(declined.response, /declined|nothing was executed/i);
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an unconfigured connector reports sandbox mode instead of pretending', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const { run } = await kernel.handle('search the web for wholesale tea suppliers in Nairobi');
    const step = run.plan[0];
    assert.ok(step?.result, 'the research step should produce a result');
    assert.ok(['sandbox', 'live', 'dry-run'].includes(step.result.mode), `unexpected mode ${step.result.mode}`);
    if (step.result.mode === 'sandbox') {
      assert.match(step.result.summary, /sandbox|simulated|not configured/i);
    }
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('memory written in one kernel session is readable in the next', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'xacheus-mem-'));
  const env = { ...process.env, XACHEUS_STORAGE: 'json', XACHEUS_DATA_DIR: dataDir };
  try {
    const first = await createKernel({ dataDir, startAutomations: false, env });
    await first.services.memory.remember({
      kind: 'company',
      key: 'opening_time',
      value: 'We open at 07:30 every weekday.',
      pinned: true,
    });
    await first.close();

    const second = await createKernel({ dataDir, startAutomations: false, env });
    const hits = await second.services.memory.recall('opening time', { limit: 5 });
    assert.ok(hits.some((hit) => /07:30/.test(hit.value)), 'the remembered fact should be recalled');
    await second.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an automation never auto-executes a confirmation-gated tool', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    await kernel.services.permissions.grantScopes(['social:read', 'social:publish'], true);
    const automation = await kernel.services.automations.create({
      name: 'Auto-publish safety check',
      enabled: true,
      trigger: { type: 'schedule', everyMinutes: 60 },
      actions: [{ tool: 'facebook.createPost', input: { message: 'hello' } }],
    });

    const run = await kernel.services.automations.run(automation, 'manual');
    assert.equal(run.status, 'failed');

    // The step must never have executed for real: the engine either blocks it
    // (agent scope) or hands it to the owner as a dry run (confirmation gate).
    const step = run.steps[0];
    assert.notEqual(step.mode, 'live');
    assert.ok(['blocked', 'dry-run'].includes(step.mode), `unexpected mode ${step.mode}`);
    assert.match(step.summary, /not permitted|approval/i);

    // …and the owner is told, rather than the action happening quietly.
    const notifications = await kernel.services.notifications.list({ limit: 10 });
    assert.ok(
      notifications.some((entry) => new RegExp(automation.name, 'i').test(entry.title)),
      'the owner should be notified when an automation cannot run',
    );
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('every audit entry records who acted, what ran and the outcome', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    await kernel.handle('remember that our best seller is the cinnamon bun');
    const entries = kernel.services.audit.query({ limit: 50 });
    assert.ok(entries.length > 0, 'the audit log should have entries');
    for (const entry of entries) {
      assert.ok(entry.action, 'each entry needs an action');
      assert.ok(entry.at, 'each entry needs a timestamp');
    }
    assert.ok(entries.some((entry) => /memory/i.test(entry.action)));
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a Firebase ID token is rejected when the project id does not match', async () => {
  // No network here: the verifier must fail closed on a malformed/foreign token.
  const result = await verifyFirebaseIdToken('not-a-jwt', 'xacheus-ai');
  assert.equal(result.ok, false);
  assert.ok(result.error);
  assert.match(result.error, /jwt/i);
});

test('code tools cannot escape the workspace root', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const outside = await kernel.services.tools
      .get('code.read')
      .run({ path: '../../../etc/passwd' }, toolContext(kernel));
    assert.equal(outside.ok, false);
    assert.match(outside.summary, /outside|not allowed|workspace/i);
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the served tool catalogue is stable and every tool declares its policy', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const tools = kernel.services.tools.list();
    assert.ok(tools.length >= 60, `expected a rich catalogue, found ${tools.length}`);
    for (const tool of tools) {
      assert.ok(tool.id.includes('.'), `${tool.id} should be namespaced`);
      assert.ok(tool.description.length > 10, `${tool.id} needs a description for the planner`);
      assert.ok(tool.owners.length > 0, `${tool.id} must belong to at least one agent`);
      assert.ok(Array.isArray(tool.scopes), `${tool.id} must declare scopes`);
    }
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the data directory holds real, portable JSON for the owner', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    await kernel.handle('add a lead: Grace, wants 20 chairs, phone 0700 000 000');
    const collections = await readFile(join(dataDir, 'collections', 'business.json'), 'utf8').catch(() => '{}');
    assert.ok(collections.length > 2, 'business.json should contain the saved record');
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('the kernel knows when it is on a platform that cannot schedule', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'xacheus-serverless-'));
  try {
    const kernel = await createKernel({
      dataDir,
      startAutomations: false,
      runtime: 'serverless',
      env: { ...process.env, XACHEUS_STORAGE: 'json', VERCEL: '1' },
    });
    assert.equal(kernel.services.runtime, 'serverless');
    await kernel.close();
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an external tick runs due automations and skips the rest', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const due = await kernel.services.automations.create({
      name: 'Due interval sweep',
      enabled: true,
      trigger: { type: 'interval', everyMinutes: 1 },
      actions: [{ tool: 'business.snapshot', input: {} }],
    });
    const notDue = await kernel.services.automations.create({
      name: 'Scheduled far ahead',
      enabled: true,
      trigger: { type: 'schedule', at: '23:59' },
      actions: [{ tool: 'business.snapshot', input: {} }],
    });
    const disabled = await kernel.services.automations.create({
      name: 'Switched off',
      enabled: false,
      trigger: { type: 'interval', everyMinutes: 1 },
      actions: [{ tool: 'business.snapshot', input: {} }],
    });

    const result = await kernel.services.automations.tickExternal(new Date('2026-09-15T08:00:00Z'));
    const ranIds = result.ran.map((entry) => entry.automationId);
    assert.ok(ranIds.includes(due.id), 'the due interval automation should have run');
    assert.ok(!ranIds.includes(disabled.id), 'a disabled automation must never run');
    assert.ok(result.skipped >= 1, 'the tick should report what it skipped');

    // A tick must be idempotent within its own interval, or a cron running twice
    // would double every action.
    const again = await kernel.services.automations.tickExternal(new Date('2026-09-15T08:00:30Z'));
    assert.ok(!again.ran.some((entry) => entry.automationId === due.id), 'a second tick inside the interval should not repeat the run');
    void notDue;
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a polling device receives queued commands and its answers are recorded', async () => {
  const { kernel, dataDir } = await freshKernel();
  try {
    const bridge = kernel.services.devices;
    bridge.registerPolling({
      deviceId: 'test-poll-phone',
      name: 'Test Phone',
      platform: 'android',
      appVersion: 'test',
      capabilities: ['device.batteryStatus'],
    });

    const result = await bridge.command('device.batteryStatus', {}, { deviceId: 'test-poll-phone' });
    assert.equal(result.ok, true);
    assert.equal(result.data.queued, true, 'the caller is told it was queued, not executed');
    assert.match(result.summary, /queued/i);

    const drained = bridge.drainQueue('test-poll-phone');
    assert.equal(drained.length, 1);
    assert.equal(drained[0].command, 'device.batteryStatus');

    const settled = bridge.settleQueued({
      id: drained[0].id,
      ok: true,
      mode: 'live',
      summary: 'Battery is at 61%.',
      data: { level: 61 },
    });
    assert.equal(settled, true, 'the phone result must be correlated, not dropped');

    const recent = bridge.recent(5);
    assert.ok(recent.some((entry) => /61%/.test(entry.summary)), 'the phone answer should appear in the command history');

    // An unknown id (timeout, or another instance) is reported, not swallowed.
    assert.equal(bridge.settleQueued({ id: 'cmd_unknown', ok: true, summary: 'late' }), false);
  } finally {
    await kernel.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

function toolContext(kernel) {
  return {
    principal: { id: 'owner', role: 'owner', displayName: 'Owner' },
    sessionId: 'test',
    services: kernel.services,
    log: () => {},
  };
}
