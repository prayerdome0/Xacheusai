/**
 * System tools — the Control Center's own verbs.
 *
 * These are how "Xacheus, open my dashboard" and "Xacheus, what can you do?"
 * resolve, and how the owner inspects the platform's real state (models,
 * connectors, devices, audit) without leaving the conversation.
 */
import type { Tool } from './types.js';
import { AGENTS } from '../agents/descriptors.js';
import { ALL_SCOPES } from '../security/permissions.js';

export const systemTools: Tool[] = [
  {
    id: 'system.status',
    name: 'Platform status',
    description:
      'Reports the real state of the platform: active model, storage driver, connectors in live vs sandbox mode, connected Android devices and permission grants.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [],
    owners: ['master', 'code'],
    async run(_input, ctx) {
      const { services } = ctx;
      const [storage, connectors, devices, models] = await Promise.all([
        services.storage.healthy(),
        Promise.resolve(services.connectors.statuses()),
        Promise.resolve(services.devices.sessions()),
        Promise.resolve(services.models),
      ]);
      const live = connectors.filter((connector) => connector.mode === 'live');

      const lines = [
        `Model: ${models.active.label} (${models.active.locality}).`,
        `Storage: ${services.storage.id} — ${storage.ok ? 'healthy' : 'problem'} (${storage.detail}).`,
        `Connectors: ${live.length}/${connectors.length} live, ${connectors.length - live.length} in sandbox.`,
        `Android devices connected: ${devices.length}.`,
        `Permissions granted: ${services.permissions.grantedScopes.length}/${ALL_SCOPES.length} scopes.`,
      ];
      if (models.notes.length) lines.push(...models.notes);

      return {
        ok: true,
        mode: 'live',
        summary: lines.join('\n'),
        data: { storage, connectors, devices, models: models.all.map((entry) => ({ id: entry.provider.id, label: entry.provider.label, selected: entry.selected })) },
      };
    },
  },
  {
    id: 'system.capabilities',
    name: 'What Xacheus can do',
    description: 'Lists the agents, the tools they can use and the connectors available, marking which are live versus sandbox.',
    category: 'system',
    scopes: [],
    risk: 'low',
    parameters: [],
    owners: ['*'],
    async run(_input, ctx) {
      const tools = ctx.services.tools.list();
      const statuses = ctx.services.connectors.statuses();
      const lines: string[] = [];
      lines.push('Agents:');
      for (const agent of AGENTS) lines.push(`- ${agent.icon} ${agent.name}: ${agent.tagline}`);
      lines.push('', `Tools: ${tools.length} registered across ${Object.keys(ctx.services.tools.byCategory()).length} categories.`);
      lines.push('', 'Connectors:');
      for (const status of statuses) {
        lines.push(`- ${status.id}: ${status.mode === 'live' ? 'live' : `sandbox${status.missingFields.length ? ` (needs ${status.missingFields.join(', ')})` : ''}`}`);
      }
      return {
        ok: true,
        mode: 'live',
        summary: lines.join('\n'),
        data: { agents: AGENTS, tools: tools.map((tool) => ({ id: tool.id, category: tool.category, risk: tool.risk })), connectors: statuses },
      };
    },
  },
  {
    id: 'system.navigate',
    name: 'Open a console view',
    description: 'Navigates the Xacheus console to a view: dashboard, chat, memory, knowledge, automations, connectors, devices, audit, settings, code.',
    category: 'system',
    scopes: [],
    risk: 'low',
    parameters: [
      {
        name: 'view',
        type: 'string',
        description: 'Which view to open.',
        required: true,
        enum: ['dashboard', 'chat', 'memory', 'knowledge', 'automations', 'connectors', 'devices', 'audit', 'settings', 'code', 'business'],
      },
    ],
    owners: ['*'],
    async run(input) {
      const view = String(input.view ?? 'dashboard');
      return {
        ok: true,
        mode: 'live',
        summary: `Opening ${view}.`,
        data: { view },
        ui: [{ type: 'navigate', target: view, label: `Open ${view}` }],
      };
    },
  },
  {
    id: 'system.notify',
    name: 'Send a notification',
    description: 'Records a notification in the console and pushes it to connected Android devices.',
    category: 'system',
    scopes: ['device:control'],
    risk: 'low',
    parameters: [
      { name: 'title', type: 'string', description: 'Notification title.', required: true },
      { name: 'body', type: 'string', description: 'Notification body.', required: true },
      { name: 'level', type: 'string', description: 'info | success | warning | critical', required: false, enum: ['info', 'success', 'warning', 'critical'] },
    ],
    owners: ['*'],
    async run(input, ctx) {
      const notification = await ctx.services.notifications.create({
        title: String(input.title ?? 'Xacheus'),
        body: String(input.body ?? ''),
        level: (String(input.level ?? 'info') as any) || 'info',
        source: 'agent',
        runId: ctx.runId,
      });
      return { ok: true, mode: 'live', summary: `Notification sent: ${notification.title}.`, data: { notification } };
    },
  },
  {
    id: 'system.setModel',
    name: 'Change the AI model',
    description:
      'Switches the active model provider (heuristic | ollama | openai | anthropic) and reloads the model layer immediately.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'medium',
    parameters: [
      { name: 'model', type: 'string', description: 'Provider id.', required: true, enum: ['heuristic', 'ollama', 'openai-compatible', 'anthropic'] },
    ],
    owners: ['master', 'code'],
    async run(input, ctx) {
      const model = String(input.model ?? '').trim();
      await ctx.services.config.set({ XACHEUS_MODEL: model });
      await ctx.services.reloadModels?.();
      const active = ctx.services.models.active;
      return {
        ok: true,
        mode: 'live',
        summary: `Model layer switched to ${active.label} (${active.locality}).`,
        data: { active: active.id, available: ctx.services.models.all.map((entry) => entry.provider.id), notes: ctx.services.models.notes },
      };
    },
  },
  {
    id: 'connectors.list',
    name: 'Connector status',
    description: 'Lists every connector, whether it is live or in sandbox mode, and exactly which credentials are missing.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [],
    owners: ['master', 'business', 'social', 'messaging', 'mail', 'home', 'code'],
    async run(_input, ctx) {
      const statuses = ctx.services.connectors.statuses();
      const lines = statuses.map((status) =>
        `${status.id}: ${status.mode === 'live' ? 'live' : `sandbox${status.missingFields.length ? ` (missing ${status.missingFields.join(', ')})` : ''}`}`,
      );
      return {
        ok: true,
        mode: 'live',
        summary: lines.join('\n'),
        data: { connectors: statuses },
      };
    },
  },
  {
    id: 'connectors.verify',
    name: 'Verify a connector',
    description: 'Performs a real connectivity check against a connector using your stored credentials.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [{ name: 'connectorId', type: 'string', description: 'Connector id, e.g. whatsapp, home, cloudinary.', required: true }],
    owners: ['*'],
    async run(input, ctx) {
      const id = String(input.connectorId ?? '').trim();
      const result = await ctx.services.connectors.verify(id);
      return {
        ok: result.ok,
        mode: result.ok ? 'live' : 'sandbox',
        summary: `${id}: ${result.detail}`,
        data: result,
      };
    },
  },
  {
    id: 'audit.recent',
    name: 'Recent activity',
    description: 'Shows the most recent audit entries: what was allowed, denied, confirmed or executed.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'low',
    parameters: [
      { name: 'limit', type: 'number', description: 'How many entries (default 20).', required: false },
      { name: 'decision', type: 'string', description: 'Filter: allowed | denied | executed | failed | pending', required: false, enum: ['allowed', 'denied', 'executed', 'failed', 'pending'] },
    ],
    owners: ['master', 'code'],
    async run(input, ctx) {
      const entries = ctx.services.audit.query({ limit: Number(input.limit ?? 20), decision: input.decision as any });
      return {
        ok: true,
        mode: 'live',
        summary: entries.length
          ? `${entries.length} recent entr(ies): ${entries.slice(0, 5).map((entry) => `${entry.decision} ${entry.action}`).join('; ')}`
          : 'No audit entries yet.',
        data: { entries },
      };
    },
  },
  {
    id: 'permissions.set',
    name: 'Grant or revoke a permission',
    description:
      'Grants or revokes permission scopes. Revoking blocks the matching tools instantly — Xacheus will tell you it is not allowed instead of failing silently.',
    category: 'system',
    scopes: ['admin:control'],
    risk: 'high',
    requiresConfirmation: true,
    parameters: [
      { name: 'scopes', type: 'array', description: 'Scopes to change.', required: true },
      { name: 'grant', type: 'boolean', description: 'true to grant, false to revoke.', required: true },
    ],
    owners: ['master'],
    async run(input, ctx) {
      const scopes = (Array.isArray(input.scopes) ? (input.scopes as string[]) : []).filter((scope) => ALL_SCOPES.includes(scope as any));
      if (!scopes.length) return { ok: false, mode: 'live', summary: 'No valid scopes supplied.', error: 'invalid scopes' };
      const grant = input.grant !== false;
      const granted = await ctx.services.permissions.grantScopes(scopes as any, grant);
      return {
        ok: true,
        mode: 'live',
        summary: `${grant ? 'Granted' : 'Revoked'} ${scopes.length} scope(s). ${granted.length} scope(s) now active.`,
        data: { granted },
      };
    },
  },
];
