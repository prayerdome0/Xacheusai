/**
 * Inbound webhooks.
 *
 * These routes are deliberately OUTSIDE the owner-passcode guard, because the
 * services that call them (Meta, and any other provider) cannot present one.
 * They are not unauthenticated, though — they authenticate the *caller* instead:
 *
 *   GET  /api/webhooks/whatsapp  — subscription handshake, guarded by
 *                                  WHATSAPP_VERIFY_TOKEN (Meta echoes it back).
 *   POST /api/webhooks/whatsapp  — inbound messages, guarded by an
 *                                  X-Hub-Signature-256 HMAC over the raw body
 *                                  using WHATSAPP_APP_SECRET.
 *
 * If the secret is not configured we refuse POSTs with 503 and a message that
 * says exactly what to set. We never accept an unsigned webhook "because it is
 * probably fine" — an unauthenticated endpoint that writes to the business
 * database is a hole, not a feature.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Kernel } from '@xacheus/core';

interface WhatsAppMessage {
  from?: string;
  id?: string;
  type?: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
}

export function registerWebhookRoutes(app: FastifyInstance, kernel: Kernel): void {
  const { services } = kernel;

  /** Subscriptions are verified with a token we chose and gave to Meta. */
  app.get('/api/webhooks/whatsapp', async (request, reply) => {
    const query = (request.query ?? {}) as Record<string, string>;
    const verifyToken = services.config.value('WHATSAPP_VERIFY_TOKEN');
    if (!verifyToken) {
      return reply.code(503).send({
        error: 'not_configured',
        message: 'Set WHATSAPP_VERIFY_TOKEN in .env, then re-verify the subscription in the Meta app dashboard.',
      });
    }
    if (query['hub.mode'] !== 'subscribe') {
      return reply.code(400).send({ error: 'unsupported_mode', message: 'Only hub.mode=subscribe is supported.' });
    }
    if (!tokenEquals(query['hub.verify_token'] ?? '', verifyToken)) {
      services.audit.record({
        principalId: 'webhook',
        actor: 'WhatsApp webhook',
        stage: 'auth',
        decision: 'denied',
        action: 'whatsapp.verify',
        detail: 'Subscription handshake presented the wrong verify token.',
      });
      return reply.code(403).send({ error: 'verify_failed' });
    }
    // Meta expects the raw challenge back, as text.
    return reply.code(200).type('text/plain').send(query['hub.challenge'] ?? 'ok');
  });

  app.post('/api/webhooks/whatsapp', async (request, reply) => {
    const appSecret = services.config.value('WHATSAPP_APP_SECRET');
    if (!appSecret) {
      return reply.code(503).send({
        error: 'not_configured',
        message:
          'Set WHATSAPP_APP_SECRET (the Meta app secret) to accept inbound WhatsApp messages. Refusing unsigned webhooks by design.',
      });
    }

    const signature = String(request.headers['x-hub-signature-256'] ?? '');
    const raw = (request as unknown as { rawBody?: Buffer | string }).rawBody ?? '';
    const body = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), 'utf8');

    if (!signatureValid(body, signature, appSecret)) {
      await services.audit.record({
        principalId: 'webhook',
        actor: 'WhatsApp webhook',
        stage: 'auth',
        decision: 'denied',
        action: 'whatsapp.inbound',
        detail: 'Rejected an inbound webhook whose X-Hub-Signature-256 did not match.',
      });
      return reply.code(401).send({ error: 'bad_signature' });
    }

    const payload = (request.body ?? {}) as {
      entry?: { changes?: { value?: { messages?: WhatsAppMessage[]; contacts?: { profile?: { name?: string } }[] } }[] }[];
    };

    const messages: WhatsAppMessage[] = [];
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        for (const message of change.value?.messages ?? []) messages.push(message);
      }
    }

    const processed: { from: string; text: string; leadId?: string }[] = [];
    for (const message of messages) {
      const from = String(message.from ?? 'unknown');
      const text =
        message.text?.body ??
        message.button?.text ??
        message.interactive?.button_reply?.title ??
        message.interactive?.list_reply?.title ??
        '';
      if (!text) continue;

      const recorded = await services.business.recordInquiry({ name: from, channel: 'whatsapp', message: text });
      services.events.emit('message.received', { from, text, channel: 'whatsapp', leadId: recorded.lead.id });
      services.events.emit('inquiry.received', { name: from, channel: 'whatsapp', message: text });

      await services.notifications.create({
        title: `WhatsApp from ${from}`,
        body: text.slice(0, 180),
        level: 'info',
        source: 'whatsapp',
      });

      await services.audit.record({
        principalId: 'webhook',
        actor: 'WhatsApp webhook',
        stage: 'execution',
        decision: 'executed',
        action: 'whatsapp.inbound',
        detail: `Recorded inbound WhatsApp message from ${from} and linked it to lead ${recorded.lead.id}.`,
      });

      processed.push({ from, text, leadId: recorded.lead.id });
    }

    // Meta retries anything that is not a fast 2xx, so answer 200 either way.
    return reply.code(200).send({ received: true, processed: processed.length, messages: processed });
  });

  /** A small, honest status endpoint so the owner can see what is wired up. */
  app.get('/api/webhooks', async () => ({
    webhooks: [
      {
        id: 'whatsapp',
        path: '/api/webhooks/whatsapp',
        verifyTokenConfigured: Boolean(services.config.value('WHATSAPP_VERIFY_TOKEN')),
        signatureSecretConfigured: Boolean(services.config.value('WHATSAPP_APP_SECRET')),
        note: 'Inbound messages are rejected unless the X-Hub-Signature-256 HMAC matches WHATSAPP_APP_SECRET.',
      },
    ],
  }));
}

function signatureValid(body: Buffer, signature: string, secret: string): boolean {
  if (!signature.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', secret).update(body).digest('hex');
  const provided = signature.slice('sha256='.length);
  return tokenEquals(provided, expected);
}

function tokenEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
