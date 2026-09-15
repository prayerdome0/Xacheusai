/**
 * The Master Agent runtime.
 *
 * One request flows through exactly one pipeline:
 *
 *   request → context → plan → permission check → confirmation gate → execute
 *           → verify → respond → audit
 *
 * Nothing bypasses it: interactions from the console, the phone, a webhook or an
 * automation all arrive here (automations enter at the tool layer with a service
 * principal). The confirmation gate is the reason a private agent can be left
 * running: anything that reaches other people or changes your world stops and
 * asks first, and the ask is recorded.
 */
import type { AgentRun, ChatMessage, PlanStep, Principal, ToolResult } from '../types.js';
import type { Services } from '../services.js';
import { buildPlan, type Plan } from './planner.js';
import { AGENTS, agentDescriptor } from './descriptors.js';
import { newId, nowIso, truncate } from '../util.js';

export interface RunOptions {
  request: string;
  principal: Principal;
  sessionId?: string;
  /** Payload from a webhook/event that triggered this run. */
  payload?: unknown;
  /** Skip the interactive confirmation gate (automations only, and even then
   *  the permission engine still decides whether the tool may run at all). */
  unattended?: boolean;
}

export interface RunResult {
  run: AgentRun;
  messages: ChatMessage[];
}

const MAX_STEPS = 8;

export class Orchestrator {
  constructor(private readonly services: Services) {}

  /** ------------------------------------------------------------- entry point */

  async handle(options: RunOptions): Promise<RunResult> {
    const sessionId = options.sessionId ?? newId('ses');
    const startedAt = Date.now();

    // 1. Deterministic context first: memory + knowledge are cheap and always work.
    const context = await this.gatherContext(options.request);

    // 2. Plan (model-assisted when available, rules otherwise).
    const plan: Plan = await buildPlan({
      request: options.request,
      services: this.services,
      sessionId,
      transcript: await this.services.conversations.transcript(sessionId, 8),
      context,
      payload: options.payload,
    });

    const run: AgentRun = {
      id: newId('run'),
      sessionId,
      request: options.request,
      agent: plan.agent,
      consulted: [plan.agent],
      status: plan.steps.length ? 'executing' : 'completed',
      plan: plan.steps.slice(0, MAX_STEPS).map((step, index) => ({
        id: `${index + 1}`,
        title: step.title,
        tool: step.tool,
        input: step.input,
        status: 'pending' as const,
      })),
      response: '',
      model: plan.model,
      usedFallbackPlanner: plan.usedFallback,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      suggestions: plan.suggestions,
    };

    await this.services.audit.record({
      principalId: options.principal.id,
      actor: options.principal.displayName ?? options.principal.role,
      stage: 'auth',
      decision: 'allowed',
      action: options.request,
      runId: run.id,
      detail: `Authenticated as ${options.principal.role}. Routed to ${plan.agent}${plan.usedFallback ? ' (built-in planner)' : ''}.`,
      scopes: this.services.permissions.grantedScopes.slice(0, 40),
    });

    this.services.events.emit('run.started', { runId: run.id, request: options.request, agent: plan.agent });

    const messages: ChatMessage[] = [];
    const userMessage = await this.services.conversations.append({
      sessionId,
      role: 'owner',
      text: options.request,
      runId: run.id,
    });
    messages.push(userMessage);

    // 3. Execute (or stop at the first confirmation gate).
    const execution = await this.executeRun(run, options);

    // 4. Compose the answer.
    run.response = execution.response || (await this.composeResponse(run, plan));
    run.status = execution.awaitingConfirmation ? 'awaiting_confirmation' : run.plan.some((step) => step.status === 'failed') ? 'completed' : 'completed';
    run.error = run.plan.find((step) => step.status === 'failed')?.result?.error;
    run.updatedAt = nowIso();
    if (!execution.awaitingConfirmation) run.completedAt = nowIso();

    const assistantMessage = await this.services.conversations.append({
      sessionId,
      role: 'xacheus',
      text: run.response,
      runId: run.id,
      meta: {
        agent: run.agent,
        model: run.model,
        usedFallbackPlanner: run.usedFallbackPlanner,
        steps: run.plan.map((step) => ({ tool: step.tool, status: step.status, mode: step.result?.mode })),
        awaitingConfirmation: execution.awaitingConfirmation,
      },
    });
    messages.push(assistantMessage);

    this.services.events.emit('run.completed', {
      runId: run.id,
      agent: run.agent,
      steps: run.plan.length,
      durationMs: Date.now() - startedAt,
      awaitingConfirmation: execution.awaitingConfirmation,
    });

    await this.services.audit.record({
      principalId: options.principal.id,
      actor: options.principal.displayName ?? options.principal.role,
      stage: 'execution',
      decision: execution.awaitingConfirmation ? 'pending' : 'executed',
      action: options.request,
      runId: run.id,
      detail: truncate(run.response, 400),
      durationMs: Date.now() - startedAt,
    });

    return { run, messages };
  }

  /** ------------------------------------------------------------- confirmations */

  /**
   * The owner approved (or rejected) a gated step. Approving runs that exact step
   * and then continues the rest of the plan — never more than was asked.
   */
  async resolveConfirmation(run: AgentRun, stepId: string, approve: boolean, principal: Principal): Promise<AgentRun> {
    const step = run.plan.find((entry) => entry.id === stepId);
    if (!step) return run;

    if (!approve) {
      step.status = 'denied';
      step.result = {
        ok: false,
        mode: 'blocked',
        summary: `You declined "${step.title}". Nothing was sent.`,
      };
      run.status = 'cancelled';
      run.updatedAt = nowIso();
      run.completedAt = nowIso();
      run.response = `${run.response}\n\nYou declined the step: ${step.title}. Nothing was executed.`.trim();
      await this.services.audit.record({
        principalId: principal.id,
        actor: principal.displayName ?? principal.role,
        stage: 'confirmation',
        decision: 'denied',
        action: step.title,
        tool: step.tool,
        runId: run.id,
        stepId: step.id,
        detail: 'Owner declined the pending action.',
      });
      await this.services.conversations.append({
        sessionId: run.sessionId,
        role: 'xacheus',
        text: `Declined: ${step.title}. Nothing was executed.`,
        runId: run.id,
      });
      return run;
    }

    await this.services.audit.record({
      principalId: principal.id,
      actor: principal.displayName ?? principal.role,
      stage: 'confirmation',
      decision: 'allowed',
      action: step.title,
      tool: step.tool,
      runId: run.id,
      stepId: step.id,
      detail: 'Owner approved the pending action.',
    });

    const result = await this.executeStep(run, step, { principal, approved: true });
    run.response = `${run.response}\n\n${result.summary}`.trim();

    // Continue with whatever remained in the plan.
    const remaining = run.plan.filter((entry) => entry.status === 'pending');
    if (remaining.length) {
      const execution = await this.executeRun(run, { request: run.request, principal, sessionId: run.sessionId });
      run.response = execution.response || run.response;
      run.status = execution.awaitingConfirmation ? 'awaiting_confirmation' : 'completed';
    } else {
      run.status = 'completed';
      run.completedAt = nowIso();
    }

    run.updatedAt = nowIso();
    const message = await this.services.conversations.append({
      sessionId: run.sessionId,
      role: 'xacheus',
      text: run.response,
      runId: run.id,
      meta: { afterApproval: true, stepId: step.id },
    });
    void message;

    this.services.events.emit('run.completed', { runId: run.id, afterApproval: true });
    return run;
  }

  /** ---------------------------------------------------------------- execution */

  private async executeRun(
    run: AgentRun,
    options: RunOptions & { approved?: boolean },
  ): Promise<{ response: string; awaitingConfirmation: boolean }> {
    const outputs: string[] = [];

    for (const step of run.plan) {
      if (step.status !== 'pending') {
        if (step.result?.summary) outputs.push(step.result.summary);
        continue;
      }

      // Permission gate — evaluated for this specific owner + agent combination.
      const tool = this.services.tools.get(step.tool);
      if (!tool) {
        step.status = 'failed';
        step.result = { ok: false, mode: 'blocked', summary: `Unknown tool "${step.tool}".`, error: 'unknown tool' };
        outputs.push(step.result.summary);
        continue;
      }

      const decision = this.services.permissions.evaluate(tool, options.principal, run.agent);
      if (!decision.allowed) {
        step.status = 'denied';
        const guidance = missingScopeSuggestion(decision.missingScopes);
        step.result = {
          ok: false,
          mode: 'blocked',
          summary: `Blocked: ${decision.reason}${guidance.length ? ` ${guidance.join(' ')}` : ''}`,
          error: decision.reason,
          suggestions: guidance,
        };
        run.suggestions = [...(run.suggestions ?? []), ...guidance].slice(0, 4);
        outputs.push(step.result.summary);
        await this.services.audit.record({
          principalId: options.principal.id,
          actor: options.principal.displayName ?? options.principal.role,
          stage: 'permission',
          decision: 'denied',
          action: run.request,
          tool: step.tool,
          scopes: decision.missingScopes,
          runId: run.id,
          stepId: step.id,
          detail: decision.reason,
        });
        continue;
      }

      if (decision.requiresConfirmation && !options.unattended && !options.approved) {
        step.status = 'awaiting_confirmation';
        step.confirmationReason = decision.reason;
        run.status = 'awaiting_confirmation';
        run.updatedAt = nowIso();
        const question = await this.services.notifications.create({
          title: 'Xacheus needs your approval',
          body: `${tool.name} — ${decision.reason}`,
          level: 'warning',
          source: 'confirmation',
          runId: run.id,
        });
        await this.services.audit.record({
          principalId: options.principal.id,
          actor: options.principal.displayName ?? options.principal.role,
          stage: 'confirmation',
          decision: 'pending',
          action: run.request,
          tool: step.tool,
          runId: run.id,
          stepId: step.id,
          detail: decision.reason,
        });
        this.services.events.emit('run.awaiting_confirmation', {
          runId: run.id,
          stepId: step.id,
          tool: step.tool,
          notificationId: question.id,
        });
        outputs.push(
          `Waiting for your approval: ${tool.name}. ${decision.reason} Approve it in the console (or say "approve") and I will continue.`,
        );
        return { response: outputs.join('\n\n'), awaitingConfirmation: true };
      }

      const result = await this.executeStep(run, step, {
        principal: options.principal,
        approved: Boolean(options.approved),
      });
      outputs.push(result.summary);
    }

    return { response: outputs.join('\n\n'), awaitingConfirmation: false };
  }

  private async executeStep(
    run: AgentRun,
    step: PlanStep,
    options: { principal: Principal; approved: boolean },
  ): Promise<ToolResult> {
    const tool = this.services.tools.get(step.tool)!;
    const input = this.interpolate(step.input ?? {}, run, step);
    const startedAt = Date.now();

    step.status = 'running';
    this.services.events.emit('run.step', { runId: run.id, stepId: step.id, tool: step.tool, status: 'running' });

    const validation = validateInput(tool.parameters, input);
    if (validation) {
      step.status = 'failed';
      step.result = { ok: false, mode: 'blocked', summary: validation, error: validation };
      return step.result;
    }

    let result: ToolResult;
    try {
      result = await tool.run(input, {
        principal: options.principal,
        sessionId: run.sessionId,
        runId: run.id,
        stepId: step.id,
        services: this.services,
        confirmed: options.approved,
        log: (message) => this.services.events.emit('run.step', { runId: run.id, stepId: step.id, message }),
      });
    } catch (error) {
      result = {
        ok: false,
        mode: 'live',
        summary: `${tool.name} failed: ${(error as Error).message}`,
        error: (error as Error).message,
      };
    }

    result.durationMs ??= Date.now() - startedAt;
    step.result = result;
    step.status = result.mode === 'blocked' ? 'denied' : result.ok ? 'done' : 'failed';
    step.input = input;

    await this.services.audit.record({
      principalId: options.principal.id,
      actor: options.principal.displayName ?? options.principal.role,
      stage: 'validation',
      decision: 'allowed',
      action: step.title,
      tool: step.tool,
      scopes: tool.scopes,
      mode: result.mode,
      runId: run.id,
      stepId: step.id,
      detail: `Input keys: ${Object.keys(input).join(', ') || 'none'}`,
    });

    await this.services.audit.record({
      principalId: options.principal.id,
      actor: options.principal.displayName ?? options.principal.role,
      stage: 'execution',
      decision: result.ok ? 'executed' : 'failed',
      action: step.title,
      tool: step.tool,
      mode: result.mode,
      runId: run.id,
      stepId: step.id,
      detail: truncate(result.summary, 300),
      durationMs: result.durationMs,
    });

    this.services.events.emit('run.step', {
      runId: run.id,
      stepId: step.id,
      tool: step.tool,
      status: step.status,
      mode: result.mode,
    });

    return result;
  }

  /**
   * Resolve `{{placeholders}}` inside step inputs from earlier steps and the
   * triggering payload — how "read this page then save it" chains together.
   */
  private interpolate(input: Record<string, unknown>, run: AgentRun, current: PlanStep): Record<string, unknown> {
    const previous = [...run.plan]
      .filter((step) => step !== current && step.result)
      .at(-1)?.result;

    const values: Record<string, string> = {
      'last-result': previous?.summary ?? '',
      last: previous?.summary ?? '',
      'last-text': String((previous?.data as Record<string, unknown> | undefined)?.text ?? previous?.summary ?? ''),
      'last-draft': String((previous?.data as Record<string, unknown> | undefined)?.draft ?? previous?.summary ?? ''),
      'last-report': String((previous?.data as Record<string, unknown> | undefined)?.report ?? previous?.summary ?? ''),
      'last-hash': String((previous?.data as Record<string, unknown> | undefined)?.hash ?? ''),
    };

    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.replace(/\{\{([\w-]+)\}\}/g, (_, key: string) => values[key] ?? '');
      }
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) out[key] = walk(entry);
        return out;
      }
      return value;
    };

    return walk(input) as Record<string, unknown>;
  }

  /** --------------------------------------------------------------- responses */

  private async composeResponse(run: AgentRun, plan: Plan): Promise<string> {
    const summaries = run.plan
      .filter((step) => step.result?.summary)
      .map((step) => step.result!.summary)
      .filter(Boolean);

    if (summaries.length) return summaries.join('\n\n');

    // Nothing was planned: answer from the owner's own data, honestly.
    const digest = this.services.tools.get('research.digestQuestion');
    if (digest) {
      const result = await digest.run(
        { question: run.request },
        {
          principal: { id: 'orchestrator', role: 'service', displayName: 'Xacheus' },
          sessionId: run.sessionId,
          runId: run.id,
          services: this.services,
          log: () => undefined,
        },
      );
      const summary = result.summary ?? '';
      const nothingFound = /Nothing in your documents/i.test(summary);
      if (!nothingFound) return summary;
    }

    const agent = agentDescriptor(run.agent);
    const lines = [
      `I could not match that to something I can do yet, and I have nothing in your memory or documents about it.`,
      '',
      agent ? `${agent.icon} ${agent.name} handles: ${agent.examples.slice(0, 2).map((example) => `"${example}"`).join(', ')}.` : '',
      '',
      'Try one of these:',
      ...AGENTS.filter((entry) => ['business', 'personal', 'research', 'messaging', 'home'].includes(entry.id))
        .slice(0, 5)
        .map((entry) => `- ${entry.icon} ${entry.examples[0]}`),
      '',
      plan.notes.length ? `Note: ${plan.notes.join(' ')}` : '',
    ].filter(Boolean);
    return lines.join('\n');
  }

  private async gatherContext(request: string): Promise<string> {
    const [memories, knowledge, business] = await Promise.all([
      this.services.memory.recall(request, { limit: 6 }),
      this.services.knowledge.search(request, { limit: 4 }),
      this.services.business.summaryForPrompt(),
    ]);

    const lines: string[] = [];
    if (memories.length) {
      lines.push('Relevant memory:');
      for (const memory of memories) lines.push(`- ${memory.key}: ${memory.value}`);
    }
    if (knowledge.length) {
      lines.push('Relevant documents:');
      for (const hit of knowledge) lines.push(`- [${hit.documentTitle}] ${truncate(hit.text, 300)}`);
    }
    lines.push('Business context:', business);
    return lines.join('\n');
  }
}

/** -------------------------------------------------------------- validation */

/** Required-parameter check — cheap, but it stops a malformed plan early. */
export function validateInput(parameters: { name: string; required: boolean; type: string }[], input: Record<string, unknown>): string | null {
  const missing = parameters
    .filter((parameter) => parameter.required)
    .filter((parameter) => {
      const value = input[parameter.name];
      if (value === undefined || value === null) return true;
      if (typeof value === 'string' && value.trim() === '') return true;
      if (Array.isArray(value) && value.length === 0) return true;
      return false;
    })
    .map((parameter) => parameter.name);
  if (missing.length) {
    return `Missing required argument(s): ${missing.join(', ')}. Nothing was executed.`;
  }
  return null;
}

function missingScopeSuggestion(scopes: string[]): string[] {
  if (!scopes.length) return [];
  return [`Grant ${scopes.join(', ')} in the Control Center → Permissions, then ask again.`];
}
