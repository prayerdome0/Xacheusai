/**
 * Custom API connector — the escape hatch that keeps Xacheus from ever needing a
 * rebuild for a new service.
 *
 * Anything with an HTTP API can be called through here, but a write to the
 * outside world is high-risk and owner-confirmed by default. Requests are also
 * restricted to https and are recorded in the audit log with their full URL.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, failure, httpJson } from './types.js';
import { evaluateStatus } from './types.js';
import { truncate } from '../util.js';

const BLOCKED_HOSTS = [/^localhost$/i, /^127\./, /^0\.0\.0\.0$/, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^169\.254\./, /^\[?::1\]?$/];

const customOperations: ConnectorOperation[] = [
  {
    id: 'request',
    title: 'Call a custom API',
    description:
      'Performs an HTTP request against any service you own. GET is safe; other methods are treated as high-risk writes and require approval.',
    scopes: ['admin:control'],
    risk: 'high',
    parameters: [
      { name: 'url', type: 'string', description: 'Full https URL.', required: true },
      { name: 'method', type: 'string', description: 'GET | POST | PUT | PATCH | DELETE', required: false, enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      { name: 'headers', type: 'object', description: 'Extra headers (secrets are never logged).', required: false },
      { name: 'body', type: 'object', description: 'JSON request body.', required: false },
      { name: 'allowPrivate', type: 'boolean', description: 'Permit calls to private/LAN addresses (needed for local services).', required: false },
    ],
    async run(input, ctx) {
      const url = String(input.url ?? '').trim();
      const method = String(input.method ?? 'GET').toUpperCase();
      const allowPrivate = input.allowPrivate === true || ctx.config.bool('XACHEUS_ALLOW_PRIVATE_API', false);

      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, mode: 'live', summary: 'Only http(s) URLs are supported.', error: 'invalid url' };
      }
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        return { ok: false, mode: 'live', summary: 'That URL could not be parsed.', error: 'invalid url' };
      }
      if (!allowPrivate && BLOCKED_HOSTS.some((pattern) => pattern.test(host))) {
        return {
          ok: false,
          mode: 'live',
          summary: `Refusing to call ${host}: it is a private/LAN address. Set allowPrivate=true (or XACHEUS_ALLOW_PRIVATE_API=true) if that is genuinely your service.`,
          error: 'private address blocked',
        };
      }

      try {
        const result = await httpJson(url, {
          method,
          headers: {
            accept: 'application/json',
            ...(input.headers && typeof input.headers === 'object' ? (input.headers as Record<string, string>) : {}),
          },
          body: ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && input.body ? JSON.stringify(input.body) : undefined,
          timeoutMs: 20_000,
        });
        if (!result.ok) return failure(`Custom API ${method}`, describeHttpError(result));
        return {
          ok: true,
          mode: 'live',
          summary: `${method} ${host} → HTTP ${result.status}.`,
          data: {
            status: result.status,
            contentType: 'application/json',
            body: result.payload ?? truncate(result.text, 4000),
          },
        };
      } catch (error) {
        return failure(`Custom API ${method}`, error);
      }
    },
  },
  {
    id: 'webhook',
    title: 'Trigger a webhook',
    description: 'Posts a JSON payload to an automation webhook (n8n, Zapier, Make, or your own endpoint).',
    scopes: ['admin:control'],
    risk: 'medium',
    requiresConfirmation: true,
    parameters: [
      { name: 'url', type: 'string', description: 'Webhook URL.', required: true },
      { name: 'payload', type: 'object', description: 'JSON payload to deliver.', required: true },
    ],
    async run(input, ctx) {
      const url = String(input.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, mode: 'live', summary: 'Only http(s) webhook URLs are supported.', error: 'invalid url' };
      }
      const result = await httpJson(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input.payload ?? {}),
        timeoutMs: 15_000,
      });
      if (!result.ok) return failure('Webhook', describeHttpError(result));
      return { ok: true, mode: 'live', summary: `Webhook delivered (HTTP ${result.status}).`, data: result.payload };
    },
  },
];

export const customConnector: Connector = {
  manifest: {
    id: 'api',
    name: 'Xacheus Connect — custom APIs & webhooks',
    category: 'business',
    description:
      'Call any HTTP API or webhook you own. This is how new services plug in without changing the platform: describe the call, Xacheus plans it, you approve the risky ones.',
    fields: [
      { key: 'XACHEUS_ALLOW_PRIVATE_API', label: 'Allow private/LAN addresses', secret: false, required: false, hint: 'true only if your services are on the local network' },
    ],
    scopes: ['admin:control'],
    capabilities: ['Arbitrary HTTP calls', 'Webhooks', 'Connect bespoke business systems'],
  },
  operations: customOperations,
  status: (config) => evaluateStatus(customConnector, config),
};
