/**
 * Control Center routes: connectors, tools, permissions, audit, devices, models,
 * stats, permissions, devices, models and the audit trail.
 */
import type { FastifyInstance } from 'fastify';
import type { PermissionScope, RiskLevel } from '@xacheus/core';
import { ALL_SCOPES, type Kernel } from '@xacheus/core';
import { principalOf } from '../guard.js';
import type { RunStore } from '../run-store.js';

export function registerAdminRoutes(app: FastifyInstance, kernel: Kernel, runs: RunStore): void {
  const { services } = kernel;

  /** --------------------------------------------------------------- overview */
  app.get('/api/connectors', async () => ({
    connectors: services.connectors.list().map((connector) => ({
      manifest: connector.manifest,
      status: services.connectors.status(connector.manifest.id),
      operations: connector.operations.map((operation) => ({
        id: operation.id,
        toolId: `${connector.manifest.id}.${operation.id}`,
        title: operation.title,
        description: operation.description,
        risk: operation.risk,
        scopes: operation.scopes,
        requiresConfirmation: Boolean(operation.requiresConfirmation),
      })),
    })),
    config: services.config.publicView(services.connectors.list().flatMap((connector) => connector.manifest.fields.map((field) => field.key))),
  }));

  app.get('/api/connectors/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const connector = services.connectors.get(id);
    if (!connector) return reply.code(404).send({ error: 'not_found' });
    return { manifest: connector.manifest, status: services.connectors.status(id) };
  });

  app.post('/api/connectors/:id/verify', async (request) => {
    const { id } = request.params as { id: string };
    const result = await services.connectors.verify(id);
    await services.audit.record({
      principalId: principalOf(request).id,
      actor: 'Owner',
      stage: 'execution',
      decision: result.ok ? 'executed' : 'failed',
      action: `Verify connector ${id}`,
      detail: result.detail,
    });
    return { id, ...result };
  });

  /**
   * Save connector credentials. Secrets go to the server-side config overlay and
   * are never returned — reads come back masked.
   */
  app.post('/api/connectors/config', async (request, reply) => {
    const body = (request.body ?? {}) as { values?: Record<string, string> };
    if (!body.values || typeof body.values !== 'object') {
      return reply.code(400).send({ error: 'values_required', message: 'Send { "values": { "KEY": "value" } }' });
    }
    await services.config.set(body.values);
    await services.reloadModels?.();

    await services.audit.record({
      principalId: principalOf(request).id,
      actor: 'Owner',
      stage: 'execution',
      decision: 'executed',
      action: 'Update connector configuration',
      detail: `Keys updated: ${Object.keys(body.values).join(', ')}`,
    });

    return reply.send({
      ok: true,
      masked: services.config.publicView(Object.keys(body.values)),
      connectors: services.connectors.statuses(),
      model: services.models.active.label,
    });
  });

  /** ------------------------------------------------------------ tools/agents */
  app.get('/api/tools', async () => ({
    tools: services.tools.list().map((tool) => ({
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      risk: tool.risk,
      scopes: tool.scopes,
      owners: tool.owners,
      requiresConfirmation: Boolean(tool.requiresConfirmation),
      parameters: tool.parameters,
      policy: services.permissions.snapshot.tools[tool.id] ?? null,
    })),
    categories: Object.keys(services.tools.byCategory()),
  }));

  /** ------------------------------------------------------------ permissions */
  app.get('/api/permissions', async () => ({
    grantedScopes: services.permissions.grantedScopes,
    allScopes: ALL_SCOPES,
    tools: services.permissions.snapshot.tools,
    agents: services.permissions.snapshot.agents,
    devices: services.permissions.snapshot.devices,
  }));

  app.post('/api/permissions/scopes', async (request, reply) => {
    const body = (request.body ?? {}) as { scopes?: string[]; grant?: boolean };
    const scopes = (body.scopes ?? []).filter((scope): scope is PermissionScope => ALL_SCOPES.includes(scope as PermissionScope));
    if (!scopes.length) return reply.code(400).send({ error: 'no_valid_scopes', allScopes: ALL_SCOPES });
    const granted = await services.permissions.grantScopes(scopes, body.grant !== false);
    await services.audit.record({
      principalId: principalOf(request).id,
      actor: 'Owner',
      stage: 'permission',
      decision: 'allowed',
      action: `${body.grant === false ? 'Revoke' : 'Grant'} scopes`,
      scopes,
      detail: `Scopes now: ${granted.length}`,
    });
    return reply.send({ grantedScopes: granted });
  });

  app.post('/api/permissions/tools/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: boolean; confirmation?: 'always' | 'risk-based' | 'never'; scopes?: PermissionScope[] };
    if (!services.tools.has(id)) return reply.code(404).send({ error: 'unknown_tool' });
    const policy = await services.permissions.setToolPolicy(id, body);
    return reply.send({ policy });
  });

  app.post('/api/permissions/agents/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { enabled?: boolean; allowedScopes?: PermissionScope[] };
    const policy = await services.permissions.setAgentPolicy(id, body);
    return reply.send({ policy });
  });

  /** ------------------------------------------------------------------ audit */
  app.get('/api/audit', async (request) => {
    const query = (request.query ?? {}) as { limit?: string; decision?: string; stage?: string; search?: string; runId?: string };
    return {
      entries: services.audit.query({
        limit: Number(query.limit ?? 100),
        decision: query.decision as any,
        stage: query.stage as any,
        search: query.search,
        runId: query.runId,
      }),
      stats: services.audit.stats(),
    };
  });

  /** ---------------------------------------------------------------- devices */
  app.get('/api/devices', async () => ({
    connected: services.devices.sessions(),
    paired: services.permissions.snapshot.devices,
    recentCommands: services.devices.recent(25),
    commands: (await import('@xacheus/core')).DEVICE_COMMANDS,
  }));

  app.post('/api/devices/pair', async (request, reply) => {
    const body = (request.body ?? {}) as { deviceId?: string; name?: string };
    if (!body.deviceId) return reply.code(400).send({ error: 'deviceId_required' });
    await services.permissions.pairDevice({ id: body.deviceId, name: body.name ?? 'Android device' });
    return reply.send({ paired: services.permissions.snapshot.devices });
  });

  app.delete('/api/devices/:id', async (request) => {
    await services.permissions.unpairDevice((request.params as { id: string }).id);
    return { paired: services.permissions.snapshot.devices };
  });

  app.post('/api/devices/:id/command', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { command?: string; args?: Record<string, unknown> };
    if (!body.command) return reply.code(400).send({ error: 'command_required' });
    const tool = services.tools.get('device.action');
    const result = await services.devices.command(body.command as any, body.args ?? {}, { deviceId: id, runId: 'console' });
    void tool;
    return reply.send({ result });
  });

  /** ----------------------------------------------------------------- models */
  app.get('/api/models', async () => ({
    active: services.models.active.id,
    label: services.models.active.label,
    locality: services.models.active.locality,
    builtin: services.models.builtin,
    notes: services.models.notes,
    available: services.models.all.map((entry) => ({
      id: entry.provider.id,
      label: entry.provider.label,
      locality: entry.provider.locality,
      selected: entry.selected,
    })),
  }));

  app.post('/api/models/select', async (request, reply) => {
    const body = (request.body ?? {}) as { model?: string };
    if (!body.model) return reply.code(400).send({ error: 'model_required' });
    await services.config.set({ XACHEUS_MODEL: body.model });
    await services.reloadModels?.();
    return reply.send({ active: services.models.active.id, label: services.models.active.label, notes: services.models.notes });
  });

  app.get('/api/models/probe', async () => {
    const probes = await Promise.all(
      services.models.all.map(async (entry) => ({
        id: entry.provider.id,
        label: entry.provider.label,
        locality: entry.provider.locality,
        ...(await entry.provider.probe()),
      })),
    );
    return { probes };
  });

  /** ------------------------------------------------------------------ stats */
  app.get('/api/stats', async () => {
    const [storage, connectors, knowledge, memory, notifications, pending] = await Promise.all([
      services.storage.healthy(),
      Promise.resolve(services.connectors.statuses()),
      services.knowledge.stats(),
      services.memory.counts(),
      services.notifications.unreadCount(),
      runs.pending(),
    ]);
    return {
      storage: { id: services.storage.id, ...storage },
      model: { id: services.models.active.id, label: services.models.active.label, builtin: services.models.builtin },
      connectors: {
        total: connectors.length,
        live: connectors.filter((connector) => connector.mode === 'live').length,
        sandbox: connectors.filter((connector) => connector.mode === 'sandbox').length,
        needingCredentials: connectors.filter((connector) => connector.missingFields.length > 0).length,
        items: connectors,
      },
      knowledge,
      memory,
      unreadNotifications: notifications,
      pendingConfirmations: pending.length,
      devices: services.devices.sessions().length,
      tools: services.tools.list().length,
      agents: (await import('@xacheus/core')).AGENTS.length,
      recentRuns: (await runs.list(5)).map((run) => ({
        id: run.id,
        request: run.request,
        agent: run.agent,
        status: run.status,
        createdAt: run.createdAt,
      })),
      audit: services.audit.stats(),
    };
  });

  /** Detailed runtime view for the Control Center (health stays public + minimal). */
  app.get('/api/status', async () => ({
    ok: true,
    version: '0.1.0',
    storage: await services.storage.healthy(),
    model: {
      id: services.models.active.id,
      label: services.models.active.label,
      locality: services.models.active.locality,
      builtin: services.models.builtin,
      notes: services.models.notes,
    },
    devices: services.devices.sessions(),
    automations: {
      enabled: (await services.automations.list()).filter((automation) => automation.enabled).length,
      total: (await services.automations.list()).length,
    },
    workspaceRoot: services.workspaceRoot,
    dataDir: services.dataDir,
  }));
}

export type { RiskLevel };
