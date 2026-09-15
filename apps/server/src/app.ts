/**
 * Fastify application assembly.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_OWNER, createKernel, type Kernel } from '@xacheus/core';
import { describeAuth, requirePrincipal, type GuardOptions } from './guard.js';
import { RunStore } from './run-store.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerDataRoutes } from './routes/data.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerRealtime } from './realtime.js';

export interface BuildOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  workspaceRoot?: string;
  logger?: boolean;
}

export interface BuiltServer {
  app: FastifyInstance;
  kernel: Kernel;
  guard: GuardOptions;
  auth: { mode: string; warning?: string };
}

export async function buildServer(options: BuildOptions = {}): Promise<BuiltServer> {
  const env = options.env ?? process.env;
  const kernel = await createKernel({
    env,
    dataDir: options.dataDir,
    workspaceRoot: options.workspaceRoot,
  });

  const guard: GuardOptions = {
    ownerPasscode: kernel.services.config.value('XACHEUS_OWNER_PASSCODE'),
    deviceToken: kernel.services.config.value('XACHEUS_DEVICE_BRIDGE_TOKEN'),
    exposed: kernel.services.config.value('HOST', '0.0.0.0') !== '127.0.0.1',
    firebaseProjectId: kernel.services.config.value('FIREBASE_PROJECT_ID'),
    ownerEmail: kernel.services.config.value('XACHEUS_OWNER_EMAIL'),
  };
  const auth = describeAuth(guard);

  const app = Fastify({
    logger: options.logger === false ? false : { level: env.LOG_LEVEL ?? 'info', transport: undefined },
    bodyLimit: 25 * 1024 * 1024,
    trustProxy: true,
  });

  /**
   * Keep the exact bytes of JSON bodies alongside the parsed object.
   *
   * Provider webhooks (Meta and friends) sign the payload with an HMAC over the
   * raw bytes, so re-serialising the parsed object would break verification.
   * Fastify's default JSON parser throws the bytes away, hence the replacement.
   */
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (request, body, done) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body ?? ''), 'utf8');
    (request as unknown as { rawBody?: Buffer }).rawBody = buffer;
    if (buffer.length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse(buffer.toString('utf8')));
    } catch (error) {
      done(error as Error, undefined);
    }
  });

  const origins = kernel.services.config.value('XACHEUS_CORS_ORIGINS', '*');
  await app.register(cors, {
    origin: origins === '*' ? true : origins.split(',').map((origin) => origin.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  });
  await app.register(multipart, { limits: { fileSize: 40 * 1024 * 1024 } });
  await app.register(websocket);

  // Health is public so a load balancer or your own monitoring can reach it.
  app.get('/api/health', async () => ({
    ok: true,
    service: 'xacheus-server',
    version: '0.1.0',
    auth: auth.mode,
  }));

  /**
   * Public client configuration. Firebase's web apiKey is public by design — it
   * ships in every browser bundle — so this is safe to expose; the real
   * protection is Firestore rules plus the owner check on the API itself.
   */
  app.get('/api/config', async () => {
    const { config } = kernel.services;
    const firebase = {
      apiKey: config.value('FIREBASE_API_KEY'),
      authDomain: config.value('FIREBASE_AUTH_DOMAIN'),
      projectId: config.value('FIREBASE_PROJECT_ID'),
      storageBucket: config.value('FIREBASE_STORAGE_BUCKET'),
      messagingSenderId: config.value('FIREBASE_MESSAGING_SENDER_ID'),
      appId: config.value('FIREBASE_APP_ID'),
    };
    return {
      auth: {
        mode: auth.mode,
        requiresPasscode: Boolean(guard.ownerPasscode),
        firebaseEnabled: Boolean(firebase.apiKey && firebase.authDomain && firebase.projectId),
      },
      firebase,
      features: {
        model: kernel.services.models.active.label,
        modelBuiltin: kernel.services.models.builtin,
        storage: kernel.services.storage.id,
        tools: kernel.services.tools.list().length,
      },
    };
  });

  // WebSocket channels register their own auth (devices use a query token).
  registerRealtime(app, kernel, guard.deviceToken.length > 0);

  // Provider webhooks authenticate the caller (verify token / HMAC signature)
  // rather than the owner, so they deliberately sit outside the passcode guard.
  registerWebhookRoutes(app, kernel);

  const runs = new RunStore(kernel);
  await app.register(async (guarded) => {
    guarded.addHook('preHandler', requirePrincipal(guard));
    registerChatRoutes(guarded, kernel, runs);
    registerDataRoutes(guarded, kernel);
    registerAdminRoutes(guarded, kernel, runs);
  });

  /** Serve the built console when it exists (single-origin deployments). */
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = resolve(here, '../../web/dist');
  if (existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', url: request.url });
      }
      return reply.sendFile('index.html');
    });
  }

  app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
    request.log?.error?.(error);
    const status = error.statusCode ?? 500;
    reply.code(status).send({
      error: status === 500 ? 'internal_error' : 'request_error',
      message: error.message,
    });
  });

  return { app, kernel, guard, auth };
}

export { DEFAULT_OWNER };
export function webDistPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, '../../web/dist');
}
