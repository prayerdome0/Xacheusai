/**
 * Device transport for phones that cannot hold a socket, and the cron hook that
 * drives automations on platforms without a scheduler.
 *
 *   POST /api/devices/heartbeat  — a polling phone checks in and collects work
 *   POST /api/devices/result     — a polling phone reports what it did
 *   GET  /api/runtime            — what this deployment can actually do
 *
 * The automation tick that goes with them lives in cron.ts, because a cron runner
 * authenticates with a secret rather than an owner session.
 *
 * These exist because "run this on a serverless platform" and "hold a WebSocket
 * open" are mutually exclusive. The polling transport is not a degraded mode: a
 * command still passes the permission check, still waits for confirmation when
 * it is high-impact, and still comes back with an honest `live`/`sandbox` mode.
 * The only difference is who initiates the connection.
 */
import type { FastifyInstance } from 'fastify';
import { DEVICE_COMMANDS, type Kernel } from '@xacheus/core';

export function registerDeviceTransportRoutes(app: FastifyInstance, kernel: Kernel): void {
  const { services } = kernel;

  /**
   * A polling phone announces itself, then receives whatever is waiting.
   * The device token is checked by the guard; the body identifies the device.
   */
  app.post('/api/devices/heartbeat', async (request, reply) => {
    const body = (request.body ?? {}) as {
      deviceId?: string;
      name?: string;
      platform?: string;
      appVersion?: string;
      capabilities?: string[];
    };
    if (!body.deviceId) return reply.code(400).send({ error: 'deviceId_required' });

    const session = services.devices.registerPolling({
      deviceId: body.deviceId,
      name: body.name ?? 'Android device',
      platform: body.platform ?? 'android',
      appVersion: body.appVersion ?? 'unknown',
      capabilities: body.capabilities?.length ? body.capabilities : [...DEVICE_COMMANDS],
    });

    const commands = services.devices.drainQueue(body.deviceId);
    return reply.send({
      session,
      commands,
      serverTime: new Date().toISOString(),
      pollAfterMs: commands.length ? 1_000 : 5_000,
    });
  });

  /** A polling phone reports the outcome of a collected command. */
  app.post('/api/devices/result', async (request, reply) => {
    const body = (request.body ?? {}) as {
      id?: string;
      ok?: boolean;
      mode?: 'live' | 'sandbox' | 'dry-run' | 'blocked';
      summary?: string;
      data?: unknown;
      error?: string;
    };
    if (!body.id) return reply.code(400).send({ error: 'id_required' });
    const settled = services.devices.settleQueued({
      id: body.id,
      ok: Boolean(body.ok),
      mode: body.mode,
      summary: body.summary,
      data: body.data,
      error: body.error,
    });
    if (!settled) {
      // Late or unknown id: the command may have timed out, or a previous
      // instance (on a serverless host) owned it. Say so rather than 500.
      return reply.code(202).send({
        accepted: false,
        detail: 'That command id is not waiting for a result — it may have already completed, timed out, or been issued by another instance.',
      });
    }
    return reply.send({ accepted: true });
  });

  /** Plain-language view of what this deployment can and cannot do. */
  app.get('/api/runtime', async () => {
    const health = await services.storage.healthy();
    const sessions = services.devices.sessions();
    return {
      runtime: services.runtime,
      storage: { driver: services.storage.id, health },
      devices: {
        connected: sessions.length,
        transports: sessions.map((session) => ({ deviceId: session.deviceId, transport: session.transport ?? 'websocket' })),
      },
      automations: {
        schedulerInProcess: services.runtime !== 'serverless',
        cronHint: 'POST /api/tasks/tick with the owner passcode as a bearer token',
      },
      websockets: {
        supported: services.runtime !== 'serverless',
        hint: 'On serverless hosting, point the console at a long-running deployment for live streaming, or rely on polling.',
      },
      warnings: [
        ...(services.runtime === 'serverless'
          ? [
              'WebSockets are unavailable on this host: the console polls, and the Android app uses the polling device transport.',
              'Interval and schedule automations only run when POST /api/tasks/tick is called — configure a cron.',
            ]
          : []),
        ...(health.ok ? [] : [`Storage is unhealthy: ${health.detail}`]),
      ],
    };
  });
}
