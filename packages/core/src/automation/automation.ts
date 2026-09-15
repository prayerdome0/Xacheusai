/**
 * The Automation Engine.
 *
 *   TRIGGER → CONDITION → PLAN → TOOLS → ACTION → RESULT → NOTIFICATION
 *
 * Two safety rules make background automation trustworthy:
 *
 *   1. Automations never perform an action that requires owner confirmation.
 *      Instead they raise a pending-approval notification, and the action runs
 *      only when you press approve. An unattended agent must not be able to send
 *      a customer message on its own.
 *   2. Every step is permission-checked exactly like an interactive run, with the
 *      automation acting as a service principal.
 */
import type { Automation, AutomationAction, AutomationRun, Principal, ToolResult } from '../types.js';
import type { StorageDriver } from '../storage/driver.js';
import type { EventBus } from '../events.js';
import type { ToolRegistry } from '../tools/types.js';
import type { PermissionEngine } from '../security/permissions.js';
import type { AuditLog } from '../security/audit.js';
import type { NotificationService } from '../notifications.js';
import type { Services } from '../services.js';
import { newId, nowIso, terms } from '../util.js';

const COLLECTION = 'automations';
const RUNS = 'automation_runs';
const SERVICE_PRINCIPAL: Principal = { id: 'automation-engine', role: 'service', displayName: 'Automation Engine' };

export interface AutomationServiceDeps {
  storage: StorageDriver;
  events: EventBus;
  tools: ToolRegistry;
  permissions: PermissionEngine;
  audit: AuditLog;
  notifications: NotificationService;
  services: () => Services;
}

export class AutomationService {
  private timer?: NodeJS.Timeout;
  private readonly unsubscribers: (() => void)[] = [];

  constructor(private readonly deps: AutomationServiceDeps) {}

  async start(): Promise<void> {
    // Event-triggered automations subscribe to the bus directly.
    this.unsubscribers.push(
      this.deps.events.onAny((event) => {
        void this.handleEvent(event.name, event.payload);
      }),
    );

    // Interval/schedule triggers are polled once a minute.
    this.timer = setInterval(() => {
      void this.tick().catch(() => undefined);
    }, 60_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
  }

  /**
   * Evaluate triggers now, once.
   *
   * This is what a cron calls on a platform where an in-process interval would
   * never fire (a serverless function that is frozen between requests). It runs
   * exactly the same due-date logic as [tick], so the behaviour of a cron-driven
   * deployment matches a long-running server — and the returned counts let the
   * caller see that something actually happened.
   */
  async tickExternal(now = new Date()): Promise<{
    ran: { automationId: string; name: string; status: string; detail: string }[];
    fired: { automation: string; trigger: string; status: string; runs: number }[];
    skipped: number;
  }> {
    const automations = await this.list();
    const ran: { automationId: string; name: string; status: string; detail: string }[] = [];
    const fired: { automation: string; trigger: string; status: string; runs: number }[] = [];
    let skipped = 0;

    for (const automation of automations) {
      if (!automation.enabled) {
        skipped += 1;
        continue;
      }

      let trigger: string | null = null;
      if (automation.trigger.type === 'interval') {
        const every = Math.max(automation.trigger.everyMinutes ?? 60, 1);
        const last = automation.lastRunAt ? Date.parse(automation.lastRunAt) : 0;
        if (now.getTime() - last >= every * 60_000) trigger = `interval:${every}m`;
      } else if (automation.trigger.type === 'schedule') {
        const [hour, minute] = (automation.trigger.at ?? '').split(':').map(Number);
        if (Number.isFinite(hour) && Number.isFinite(minute)) {
          const due = new Date(now);
          due.setHours(hour!, minute!, 0, 0);
          const last = automation.lastRunAt ? Date.parse(automation.lastRunAt) : 0;
          if (now.getTime() >= due.getTime() && last < due.getTime()) trigger = `schedule:${automation.trigger.at}`;
        }
      } else {
        // Event and webhook triggers are pushed to us, never polled.
        skipped += 1;
        continue;
      }

      if (!trigger) {
        skipped += 1;
        continue;
      }

      const run = await this.run(automation, trigger);
      ran.push({ automationId: automation.id, name: automation.name, status: run.status, detail: run.detail });
      fired.push({
        automation: automation.name,
        trigger,
        status: run.status,
        runs: ((automation as Automation & { runCount?: number }).runCount ?? 0) + 1,
      });
    }

    return { ran, fired, skipped };
  }

  /** --------------------------------------------------------------- catalogue */

  async list(): Promise<Automation[]> {
    const all = await this.deps.storage.list<Automation>(COLLECTION);
    return all.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async get(id: string): Promise<Automation | null> {
    return this.deps.storage.get<Automation>(COLLECTION, id);
  }

  async create(input: {
    name: string;
    description?: string;
    trigger: Automation['trigger'];
    condition?: Automation['condition'];
    actions: AutomationAction[];
    notify?: boolean;
    enabled?: boolean;
  }): Promise<Automation> {
    const automation: Automation = {
      id: newId('aut'),
      name: input.name,
      description: input.description ?? '',
      trigger: input.trigger,
      condition: input.condition ?? { type: 'always' },
      actions: input.actions,
      enabled: input.enabled ?? true,
      notify: input.notify ?? true,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      runCount: 0,
    };
    await this.deps.storage.set(COLLECTION, automation);
    return automation;
  }

  async update(id: string, patch: Partial<Automation>): Promise<Automation | null> {
    const automation = await this.get(id);
    if (!automation) return null;
    const next = { ...automation, ...patch, updatedAt: nowIso() };
    await this.deps.storage.set(COLLECTION, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const automation = await this.get(id);
    if (!automation) return false;
    await this.deps.storage.delete(COLLECTION, id);
    return true;
  }

  async history(limit = 50): Promise<AutomationRun[]> {
    const runs = await this.deps.storage.list<AutomationRun>(RUNS);
    return runs.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, limit);
  }

  /** --------------------------------------------------------------- triggering */

  private async tick(): Promise<void> {
    const automations = await this.list();
    const now = new Date();
    for (const automation of automations) {
      if (!automation.enabled) continue;
      if (automation.trigger.type === 'interval') {
        const every = Math.max(automation.trigger.everyMinutes ?? 60, 1);
        const last = automation.lastRunAt ? Date.parse(automation.lastRunAt) : 0;
        if (Date.now() - last >= every * 60_000) {
          await this.run(automation, `interval:${every}m`);
        }
      } else if (automation.trigger.type === 'schedule') {
        const at = automation.trigger.at ?? '';
        const [hour, minute] = at.split(':').map(Number);
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
        const today = new Date(now);
        today.setHours(hour!, minute!, 0, 0);
        const last = automation.lastRunAt ? Date.parse(automation.lastRunAt) : 0;
        if (now.getTime() >= today.getTime() && last < today.getTime()) {
          await this.run(automation, `schedule:${at}`);
        }
      }
    }
  }

  private async handleEvent(name: string, payload: unknown): Promise<void> {
    const automations = await this.list();
    for (const automation of automations) {
      if (!automation.enabled || automation.trigger.type !== 'event') continue;
      if (automation.trigger.event !== name) continue;
      await this.run(automation, `event:${name}`, payload);
    }
  }

  /** --------------------------------------------------------------- execution */

  async run(automation: Automation, trigger: string, payload?: unknown): Promise<AutomationRun> {
    const startedAt = Date.now();
    const steps: AutomationRun['steps'] = [];
    let status: AutomationRun['status'] = 'ok';
    let detail = '';

    if (!this.matches(automation, payload)) {
      const run: AutomationRun = {
        id: newId('arun'),
        automationId: automation.id,
        automationName: automation.name,
        trigger,
        status: 'skipped',
        detail: 'Condition did not match.',
        steps,
        startedAt: nowIso(),
        durationMs: Date.now() - startedAt,
      };
      await this.record(automation, run);
      return run;
    }

    for (const [index, action] of automation.actions.entries()) {
      const tool = this.deps.tools.get(action.tool);
      if (!tool) {
        steps.push({ tool: action.tool, ok: false, mode: 'blocked', summary: `Unknown tool "${action.tool}".` });
        status = 'failed';
        continue;
      }

      const input = this.resolveInput(automation, action, payload);
      const decision = this.deps.permissions.evaluate(tool, SERVICE_PRINCIPAL, 'automation');

      if (!decision.allowed) {
        steps.push({ tool: action.tool, ok: false, mode: 'blocked', summary: decision.reason });
        await this.deps.audit.record({
          principalId: SERVICE_PRINCIPAL.id,
          actor: 'Automation Engine',
          stage: 'permission',
          decision: 'denied',
          action: automation.name,
          tool: action.tool,
          detail: decision.reason,
        });
        status = 'failed';
        continue;
      }

      if (decision.requiresConfirmation) {
        // Hand off to the owner instead of acting unattended.
        const notification = await this.deps.notifications.create({
          title: `Approval needed: ${automation.name}`,
          body: `The automation wants to run "${tool.name}" ${index + 1 > 1 ? `(step ${index + 1}) ` : ''}but it needs your approval. ${decision.reason}`,
          level: 'warning',
          source: `automation:${automation.id}`,
        });
        steps.push({
          tool: action.tool,
          ok: true,
          mode: 'dry-run',
          summary: `Queued for your approval (notification ${notification.id}).`,
        });
        detail = 'One or more steps need owner approval.';
        continue;
      }

      const result = await this.runTool(automation, tool.id, input);
      steps.push({ tool: action.tool, ok: result.ok, mode: result.mode, summary: result.summary });
      if (!result.ok) status = 'failed';
      else this.rememberState(automation, action, result);
    }

    const run: AutomationRun = {
      id: newId('arun'),
      automationId: automation.id,
      automationName: automation.name,
      trigger,
      status,
      detail: detail || steps.map((step) => step.summary).join(' '),
      steps,
      startedAt: nowIso(),
      durationMs: Date.now() - startedAt,
    };

    await this.record(automation, run);

    if (automation.notify) {
      await this.deps.notifications.create({
        title: `${automation.name} — ${status === 'ok' ? 'completed' : 'failed'}`,
        body: run.detail.slice(0, 300),
        level: status === 'ok' ? 'success' : 'warning',
        source: `automation:${automation.id}`,
      });
    }

    this.deps.events.emit('automation.fired', { automationId: automation.id, name: automation.name, status, trigger });
    return run;
  }

  private async runTool(automation: Automation, toolId: string, input: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.deps.tools.get(toolId)!;
    const services = this.deps.services();
    const startedAt = Date.now();
    let result: ToolResult;
    try {
      result = await tool.run(input, {
        principal: SERVICE_PRINCIPAL,
        sessionId: `automation:${automation.id}`,
        runId: automation.id,
        services,
        log: (message) => services.events.emit('run.step', { automation: automation.name, message }),
      });
    } catch (error) {
      result = { ok: false, mode: 'live', summary: `${tool.name} threw an error.`, error: (error as Error).message };
    }
    await this.deps.audit.record({
      principalId: SERVICE_PRINCIPAL.id,
      actor: 'Automation Engine',
      stage: 'execution',
      decision: result.ok ? 'executed' : 'failed',
      action: automation.name,
      tool: toolId,
      mode: result.mode,
      detail: result.summary,
      durationMs: Date.now() - startedAt,
    });
    return result;
  }

  private matches(automation: Automation, payload: unknown): boolean {
    const condition = automation.condition;
    if (!condition || condition.type === 'always') return true;
    const haystack = typeof payload === 'string' ? payload : JSON.stringify(payload ?? {});
    if (condition.type === 'keyword') {
      const keywords = (condition.value ?? '').split(',').map((keyword) => keyword.trim().toLowerCase()).filter(Boolean);
      if (!keywords.length) return true;
      const body = haystack.toLowerCase();
      return keywords.some((keyword) => body.includes(keyword));
    }
    if (condition.type === 'field') {
      const [path, expected] = (condition.value ?? '').split('=');
      if (!path) return true;
      const actual = path.split('.').reduce<any>((acc, key) => (acc == null ? acc : acc[key]), payload as any);
      return expected === undefined ? Boolean(actual) : String(actual) === expected.trim();
    }
    return true;
  }

  /** Merge the event payload into the action input, and carry over monitor hashes. */
  private resolveInput(automation: Automation, action: AutomationAction, payload?: unknown): Record<string, unknown> {
    const input: Record<string, unknown> = { ...action.input };

    if (payload && typeof payload === 'object') {
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (input[key] === undefined) input[key] = value;
      }
      // Common event shapes get sensible aliases.
      const event = payload as Record<string, any>;
      if (event.message !== undefined) input.text ??= event.message;
      if (event.body !== undefined) input.text ??= event.body;
      if (event.from !== undefined) input.sender ??= event.from;
    }

    const state = (automation as Automation & { state?: Record<string, string> }).state ?? {};
    const stateKey = this.stateKey(action);
    if (stateKey && input.previousHash === undefined && state[stateKey]) {
      input.previousHash = state[stateKey];
    }
    return input;
  }

  private stateKey(action: AutomationAction): string | null {
    const url = action.input?.url;
    return typeof url === 'string' ? `${action.tool}:${url}` : null;
  }

  private rememberState(automation: Automation, action: AutomationAction, result: ToolResult): void {
    const key = this.stateKey(action);
    const hash = (result.data as Record<string, unknown> | undefined)?.hash;
    if (!key || typeof hash !== 'string') return;
    const record = automation as Automation & { state?: Record<string, string> };
    record.state ??= {};
    record.state[key] = hash;
    void this.deps.storage.set(COLLECTION, record);
  }

  private async record(automation: Automation, run: AutomationRun): Promise<void> {
    await this.deps.storage.set(RUNS, run as AutomationRun & { id: string });
    await this.update(automation.id, {
      lastRunAt: run.startedAt,
      lastStatus: run.status,
      runCount: (automation.runCount ?? 0) + 1,
    });
    const runs = await this.deps.storage.list<AutomationRun>(RUNS);
    if (runs.length > 500) {
      const stale = runs.sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt)).slice(0, runs.length - 500);
      for (const entry of stale) await this.deps.storage.delete(RUNS, entry.id);
    }
  }
}

/** Starter automations offered by the Control Center. */
export function starterAutomations(): Omit<Automation, 'id' | 'createdAt' | 'updatedAt' | 'runCount'>[] {
  return [
    {
      name: 'New inquiry → reply draft + lead + follow-up',
      description:
        'When a WhatsApp/Facebook inquiry arrives: draft a reply from your knowledge base, record the lead, and create a follow-up task. The reply is queued for your approval.',
      trigger: { type: 'event', event: 'inquiry.received' },
      condition: { type: 'always' },
      actions: [
        { tool: 'content.draftReply', input: { channel: 'message' } },
        { tool: 'business.recordInquiry', input: {} },
      ],
      enabled: false,
      notify: true,
    },
    {
      name: 'Daily business brief at 07:30',
      description: 'Every morning: build the business brief, list the day\'s agenda, and notify you.',
      trigger: { type: 'schedule', at: '07:30' },
      condition: { type: 'always' },
      actions: [
        { tool: 'business.todayBrief', input: {} },
        { tool: 'personal.brief', input: {} },
      ],
      enabled: false,
      notify: true,
    },
    {
      name: 'Watch a competitor or supplier page',
      description: 'Checks a page every 6 hours and only notifies you when the content actually changes.',
      trigger: { type: 'interval', everyMinutes: 360 },
      condition: { type: 'always' },
      actions: [{ tool: 'web.checkChanged', input: { url: 'https://example.com' } }],
      enabled: false,
      notify: true,
    },
    {
      name: 'Stale lead sweep',
      description: 'Marks leads that have gone quiet for 14 days so nothing rots in the pipeline.',
      trigger: { type: 'schedule', at: '18:00' },
      condition: { type: 'always' },
      actions: [{ tool: 'business.expireStaleLeads', input: { days: 14 } }],
      enabled: false,
      notify: false,
    },
  ];
}

export { terms };
