/**
 * Automation tick for external schedulers.
 *
 * On a long-running server the Automation Engine ticks itself every minute. On a
 * serverless platform a function is frozen between requests, so that ticker
 * would silently never fire — which is worse than not offering scheduling at
 * all, because you would trust automations that never run.
 *
 * So the tick is exposed as an endpoint any scheduler can call, and it is
 * guarded by a *secret*, not the owner passcode:
 *
 *   Vercel Cron            — set CRON_SECRET; Vercel sends `Authorization: Bearer $CRON_SECRET`
 *   systemd / cron / Tasker — curl -H "Authorization: Bearer $XACHEUS_OWNER_PASSCODE"
 *   Uptime monitors        — same, with ?token=… if headers are awkward
 *
 * This route sits outside the owner-passcode plugin because it must also work for
 * a cron runner that cannot hold a session; it authenticates every call itself
 * with a timing-safe comparison against the configured secrets.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kernel } from '@xacheus/core';

export function registerCronRoutes(app: FastifyInstance, kernel: Kernel): void {
  const { services } = kernel;

  const authorize = (headers: Record<string, unknown>, query: Record<string, string>): { ok: boolean; via?: string; reason?: string } => {
    const candidates: { value: string; via: string }[] = [];
    const cronSecret = services.config.value('CRON_SECRET');
    const passcode = services.config.value('XACHEUS_OWNER_PASSCODE');
    const deviceToken = services.config.value('XACHEUS_DEVICE_BRIDGE_TOKEN');
    if (cronSecret) candidates.push({ value: cronSecret, via: 'CRON_SECRET' });
    if (passcode) candidates.push({ value: passcode, via: 'XACHEUS_OWNER_PASSCODE' });
    if (deviceToken) candidates.push({ value: deviceToken, via: 'XACHEUS_DEVICE_BRIDGE_TOKEN' });

    if (!candidates.length) {
      return { ok: false, reason: 'No schedule secret is configured. Set CRON_SECRET (recommended) or XACHEUS_OWNER_PASSCODE.' };
    }

    const authorization = String(headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
    const provided = [authorization, String(headers['x-xacheus-token'] ?? ''), query.token ?? ''].filter(Boolean);

    for (const candidate of candidates) {
      for (const value of provided) {
        if (safeEqual(value, candidate.value)) return { ok: true, via: candidate.via };
      }
    }
    return { ok: false, reason: 'Missing or incorrect schedule secret.' };
  };

  const tick = async (request: any, reply: any) => {
    const headers = (request.headers ?? {}) as Record<string, unknown>;
    const query = (request.query ?? {}) as Record<string, string>;
    const verdict = authorize(headers, query);

    if (!verdict.ok) {
      await services.audit.record({
        principalId: 'scheduler',
        actor: 'External scheduler',
        stage: 'auth',
        decision: 'denied',
        action: 'automations.tick',
        detail: verdict.reason ?? 'Rejected',
      });
      return reply.code(401).send({ error: 'unauthorized', message: verdict.reason });
    }

    const startedAt = new Date();
    const result = await services.automations.tickExternal(startedAt);

    services.events.emit('automation.tick', {
      at: startedAt.toISOString(),
      evaluated: result.ran.length + result.skipped,
      fired: result.fired.length,
    });

    await services.audit.record({
      principalId: 'scheduler',
      actor: 'External scheduler',
      stage: 'execution',
      decision: 'executed',
      action: 'automations.tick',
      detail: `Evaluated ${result.ran.length + result.skipped} automation(s); ran ${result.ran.length}.` + (result.fired.length ? ` Fired: ${result.fired.map((entry) => entry.automation).join(', ')}.` : ''),
    });

    return reply.send({
      ok: true,
      at: startedAt.toISOString(),
      authorizedVia: verdict.via,
      enabled: (await services.automations.list()).filter((automation) => automation.enabled).length,
      ran: result.ran,
      fired: result.fired,
      skipped: result.skipped,
      note: 'Interval and schedule triggers only; event and webhook automations fire when their event arrives.',
    });
  };

  // Vercel Cron issues GET; everyone else is welcome to POST.
  app.get('/api/tasks/tick', tick);
  app.post('/api/tasks/tick', tick);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
