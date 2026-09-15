/**
 * Conversational routes: chat, voice, runs and confirmations.
 *
 * These are the endpoints the console and the Android app use for the core
 * "ask Xacheus something" loop, including the approval handshake.
 */
import type { FastifyInstance } from 'fastify';
import { AGENTS, ALL_SCOPES, type Kernel } from '@xacheus/core';
import { principalOf } from '../guard.js';
import type { RunStore } from '../run-store.js';

export function registerChatRoutes(app: FastifyInstance, kernel: Kernel, runs: RunStore): void {
  const { services } = kernel;

  /** Send a request to Xacheus. */
  app.post('/api/chat', async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; sessionId?: string; message?: string };
    const text = (body.text ?? body.message ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty_request', message: 'Send { "text": "..." }' });

    const principal = principalOf(request);
    const result = await kernel.handle(text, { principal, sessionId: body.sessionId });
    await runs.save(result.run);

    return reply.send({
      run: result.run,
      messages: result.messages,
      awaitingConfirmation: result.run.status === 'awaiting_confirmation',
    });
  });

  /**
   * Voice endpoint. Kept separate from /api/chat because a voice client wants a
   * single short string to speak, plus the plan for display.
   */
  app.post('/api/voice', async (request, reply) => {
    const body = (request.body ?? {}) as { text?: string; sessionId?: string };
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: 'empty_request', message: 'Send { "text": "..." }' });

    const principal = principalOf(request);
    const result = await kernel.handle(text, { principal, sessionId: body.sessionId });
    await runs.save(result.run);

    const speakable = result.run.response
      .replace(/[*_`#>]/g, '')
      .replace(/\n{2,}/g, '. ')
      .replace(/\n/g, ', ')
      .slice(0, 900);

    return reply.send({
      text: speakable,
      run: result.run,
      awaitingConfirmation: result.run.status === 'awaiting_confirmation',
      suggestions: result.run.suggestions ?? [],
    });
  });

  /** Approve or reject a gated step. */
  app.post('/api/runs/:id/confirm', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as { stepId?: string; approve?: boolean };
    const run = await runs.get(id);
    if (!run) return reply.code(404).send({ error: 'not_found', message: `No run ${id}.` });

    const pending = run.plan.filter((step) => step.status === 'awaiting_confirmation');
    const stepId = body.stepId ?? pending[0]?.id;
    if (!stepId) {
      return reply.code(400).send({ error: 'nothing_pending', message: 'This run has no step waiting for approval.' });
    }
    if (body.approve === undefined) {
      return reply.code(400).send({ error: 'missing_decision', message: 'Send { "approve": true | false }.' });
    }

    const principal = principalOf(request);
    const resolved = await kernel.confirm(run, stepId, body.approve, principal);
    await runs.save(resolved);
    return reply.send({ run: resolved, approved: body.approve });
  });

  app.get('/api/runs', async (request) => {
    const query = (request.query ?? {}) as { limit?: string };
    return { runs: await runs.list(Number(query.limit ?? 50)) };
  });

  app.get('/api/runs/pending', async () => ({ runs: await runs.pending() }));

  app.get('/api/runs/:id', async (request, reply) => {
    const run = await runs.get((request.params as { id: string }).id);
    if (!run) return reply.code(404).send({ error: 'not_found' });
    return { run };
  });

  /** Conversation history. */
  app.get('/api/sessions', async () => ({ sessions: await services.conversations.sessions() }));

  app.get('/api/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    return { sessionId: id, messages: await services.conversations.messages(id) };
  });

  app.delete('/api/sessions/:id', async (request) => {
    const { id } = request.params as { id: string };
    const removed = await services.conversations.clear(id);
    return { removed };
  });

  /** Agent roster + permission summary, for the console's agent view. */
  app.get('/api/agents', async () => ({
    agents: AGENTS.map((agent) => ({
      ...agent,
      policy: services.permissions.snapshot.agents[agent.id] ?? null,
      tools: services.tools.forAgent(agent.id).map((tool) => ({
        id: tool.id,
        name: tool.name,
        risk: tool.risk,
        category: tool.category,
        scopes: tool.scopes,
        requiresConfirmation: Boolean(tool.requiresConfirmation),
      })),
    })),
    grantedScopes: services.permissions.grantedScopes,
    allScopes: ALL_SCOPES,
  }));
}
