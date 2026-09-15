/**
 * Automation tools — create and manage TRIGGER → ACTION rules by talking to
 * Xacheus ("every morning brief me", "when an inquiry arrives, draft a reply").
 */
import type { Automation } from '../types.js';
import type { Tool } from './types.js';
import { starterAutomations } from '../automation/automation.js';

export const automationTools: Tool[] = [
  {
    id: 'automation.create',
    name: 'Create an automation',
    description:
      'Creates a TRIGGER → CONDITION → ACTION rule. Triggers: schedule (at HH:MM), interval (every N minutes), event (inquiry.received, message.received, document.ingested, notification.created…) or manual.',
    category: 'automation',
    scopes: ['automation:write'],
    risk: 'medium',
    parameters: [
      { name: 'name', type: 'string', description: 'Human name for the automation.', required: true },
      { name: 'triggerType', type: 'string', description: 'schedule | interval | event | manual', required: true, enum: ['schedule', 'interval', 'event', 'manual'] },
      { name: 'at', type: 'string', description: 'For schedule triggers: HH:MM local time.', required: false, example: '07:30' },
      { name: 'everyMinutes', type: 'number', description: 'For interval triggers: minutes between runs.', required: false },
      { name: 'event', type: 'string', description: 'For event triggers: the event name.', required: false, example: 'inquiry.received' },
      { name: 'conditionKeyword', type: 'string', description: 'Only run when the payload contains one of these words (comma-separated).', required: false },
      { name: 'actionTool', type: 'string', description: 'Tool id to run.', required: true, example: 'business.todayBrief' },
      { name: 'actionInput', type: 'object', description: 'Arguments for the tool.', required: false },
      { name: 'notify', type: 'boolean', description: 'Tell me when it runs (default true).', required: false },
      { name: 'enabled', type: 'boolean', description: 'Start it immediately (default true).', required: false },
    ],
    owners: ['automation', 'master'],
    async run(input, ctx) {
      const name = String(input.name ?? '').trim();
      const triggerType = String(input.triggerType ?? '').trim() as Automation['trigger']['type'];
      const actionTool = String(input.actionTool ?? '').trim();
      if (!name) return { ok: false, mode: 'live', summary: 'The automation needs a name.', error: 'missing name' };
      if (!['schedule', 'interval', 'event', 'manual'].includes(triggerType)) {
        return { ok: false, mode: 'live', summary: 'Trigger type must be schedule, interval, event or manual.', error: 'bad trigger' };
      }
      if (!ctx.services.tools.has(actionTool)) {
        return {
          ok: false,
          mode: 'live',
          summary: `"${actionTool}" is not a registered tool, so the automation could never run.`,
          error: 'unknown tool',
        };
      }

      const tools = ctx.services.tools.get(actionTool)!;
      if (tools.requiresConfirmation || tools.risk === 'critical') {
        return {
          ok: false,
          mode: 'live',
          summary: `"${tools.name}" always needs your approval, so it cannot run unattended. Create the automation with a drafting tool instead (e.g. content.draftReply) — Xacheus will raise an approval request when the action is ready.`,
          error: 'tool needs confirmation',
        };
      }

      const automation = await ctx.services.automations.create({
        name,
        description: `Created from the console: ${triggerType} → ${actionTool}`,
        trigger: {
          type: triggerType,
          at: input.at ? String(input.at) : undefined,
          everyMinutes: input.everyMinutes === undefined ? undefined : Number(input.everyMinutes),
          event: input.event ? String(input.event) : undefined,
        },
        condition: input.conditionKeyword
          ? { type: 'keyword', value: String(input.conditionKeyword) }
          : { type: 'always' },
        actions: [{ tool: actionTool, input: (input.actionInput as Record<string, unknown>) ?? {} }],
        notify: input.notify !== false,
        enabled: input.enabled !== false,
      });

      return {
        ok: true,
        mode: 'live',
        summary: `Automation "${automation.name}" created (${triggerType}${input.at ? ` at ${input.at}` : ''}${input.everyMinutes ? ` every ${input.everyMinutes} min` : ''}${input.event ? ` on ${input.event}` : ''}) → ${tools.name}.`,
        data: { automation },
        suggestions: ['Run it once now', 'Show me all automations'],
      };
    },
  },
  {
    id: 'automation.list',
    name: 'List automations',
    description: 'Lists your automations with their triggers, status and last run.',
    category: 'automation',
    scopes: ['automation:read'],
    risk: 'low',
    parameters: [],
    owners: ['automation', 'master'],
    async run(_input, ctx) {
      const automations = await ctx.services.automations.list();
      const starters = automations.length ? [] : starterAutomations();
      const lines = automations.map(
        (automation) =>
          `${automation.enabled ? '●' : '○'} ${automation.name} — ${automation.trigger.type}${
            automation.trigger.at ? ` ${automation.trigger.at}` : ''
          }${automation.trigger.event ? ` ${automation.trigger.event}` : ''}${automation.trigger.everyMinutes ? ` every ${automation.trigger.everyMinutes}m` : ''}${automation.lastStatus ? `, last: ${automation.lastStatus}` : ''}`,
      );
      return {
        ok: true,
        mode: 'live',
        summary: automations.length
          ? `${automations.length} automation(s):\n${lines.join('\n')}`
          : 'No automations yet. Xacheus ships four starters (inquiry handling, daily brief, page watcher, stale-lead sweep) ready to enable.',
        data: { automations, starters: starters.map((starter) => starter.name) },
      };
    },
  },
  {
    id: 'automation.setEnabled',
    name: 'Enable or disable an automation',
    description: 'Turns an automation on or off by name or id.',
    category: 'automation',
    scopes: ['automation:write'],
    risk: 'low',
    parameters: [
      { name: 'id', type: 'string', description: 'Automation id (or part of its name).', required: true },
      { name: 'enabled', type: 'boolean', description: 'true to enable, false to disable.', required: true },
    ],
    owners: ['automation', 'master'],
    async run(input, ctx) {
      const selector = String(input.id ?? '').trim();
      const automations = await ctx.services.automations.list();
      const automation = automations.find((item) => item.id === selector) ?? automations.find((item) => item.name.toLowerCase().includes(selector.toLowerCase()));
      if (!automation) return { ok: false, mode: 'live', summary: `No automation matched "${selector}".`, error: 'not found' };
      const enabled = input.enabled !== false;
      await ctx.services.automations.update(automation.id, { enabled });
      return { ok: true, mode: 'live', summary: `"${automation.name}" is now ${enabled ? 'enabled' : 'disabled'}.`, data: { automation: { ...automation, enabled } } };
    },
  },
  {
    id: 'automation.runNow',
    name: 'Run an automation now',
    description: 'Triggers an automation immediately and reports what each step did.',
    category: 'automation',
    scopes: ['automation:write'],
    risk: 'medium',
    parameters: [{ name: 'id', type: 'string', description: 'Automation id or part of its name.', required: true }],
    owners: ['automation', 'master'],
    async run(input, ctx) {
      const selector = String(input.id ?? '').trim();
      const automations = await ctx.services.automations.list();
      const automation = automations.find((item) => item.id === selector) ?? automations.find((item) => item.name.toLowerCase().includes(selector.toLowerCase()));
      if (!automation) return { ok: false, mode: 'live', summary: `No automation matched "${selector}".`, error: 'not found' };
      const run = await ctx.services.automations.run(automation, 'manual');
      return {
        ok: run.status !== 'failed',
        mode: 'live',
        summary: `${automation.name}: ${run.status}. ${run.detail}`,
        data: { run },
      };
    },
  },
  {
    id: 'automation.remove',
    name: 'Delete an automation',
    description: 'Deletes an automation by id or name.',
    category: 'automation',
    scopes: ['automation:write'],
    risk: 'medium',
    parameters: [{ name: 'id', type: 'string', description: 'Automation id or part of its name.', required: true }],
    owners: ['automation', 'master'],
    async run(input, ctx) {
      const selector = String(input.id ?? '').trim();
      const automations = await ctx.services.automations.list();
      const automation = automations.find((item) => item.id === selector) ?? automations.find((item) => item.name.toLowerCase().includes(selector.toLowerCase()));
      if (!automation) return { ok: false, mode: 'live', summary: `No automation matched "${selector}".`, error: 'not found' };
      await ctx.services.automations.remove(automation.id);
      return { ok: true, mode: 'live', summary: `Deleted automation "${automation.name}".` };
    },
  },
];
