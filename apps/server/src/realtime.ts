/**
 * Live channel for the console and the Android bridge, over WebSockets.
 *
 *   /api/events          — console: run progress, notifications, automations, audit
 *   /api/devices/socket  — Android companion app: receives commands, returns results
 *
 * Both share the kernel's event bus, so the console sees exactly what the agents
 * are doing as they do it.
 */
import type { FastifyInstance } from 'fastify';
import type { Kernel, RuntimeEvent } from '@xacheus/core';
import { DEVICE_COMMANDS } from '@xacheus/core';
import type { DeviceSocket } from '@xacheus/core';

interface ClientSocket extends DeviceSocket {
  readyState: number;
  on(event: string, listener: (...args: any[]) => void): void;
}

export function registerRealtime(app: FastifyInstance, kernel: Kernel, deviceTokenRequired: boolean): void {
  const { services } = kernel;
  const consoleClients = new Set<ClientSocket>();

  const broadcast = (event: RuntimeEvent): void => {
    const payload = JSON.stringify({ type: 'event', event });
    for (const client of consoleClients) {
      try {
        if (client.readyState === 1) client.send(payload);
      } catch {
        consoleClients.delete(client);
      }
    }
  };
  services.events.onAny(broadcast);

  /** ---------------------------------------------------------------- console */
  app.get('/api/events', { websocket: true }, (connection: any) => {
    const socket: ClientSocket = connection.socket ?? connection;
    consoleClients.add(socket);
    socket.send(
      JSON.stringify({
        type: 'hello',
        recent: services.events.recent(25),
        notifications: undefined,
      }),
    );
    socket.on('close', () => consoleClients.delete(socket));
  });

  /** --------------------------------------------------------------- devices */
  app.get('/api/devices/socket', { websocket: true }, async (connection: any, request) => {
    const socket: ClientSocket = connection.socket ?? connection;
    const query = (request.query ?? {}) as Record<string, string>;
    const token = query.token ?? '';
    const deviceId = query.deviceId ?? '';

    if (deviceTokenRequired && token !== services.config.value('XACHEUS_DEVICE_BRIDGE_TOKEN')) {
      socket.send(JSON.stringify({ type: 'error', message: 'Invalid device token. Check XACHEUS_DEVICE_BRIDGE_TOKEN in your .env and the app settings.' }));
      socket.close();
      return;
    }
    if (!deviceId) {
      socket.send(JSON.stringify({ type: 'error', message: 'A deviceId is required.' }));
      socket.close();
      return;
    }

    let registered = false;
    const hello = (): void => {
      const session = services.devices.register(socket, {
        deviceId,
        name: query.name ?? 'Android device',
        platform: query.platform ?? 'android',
        appVersion: query.appVersion ?? 'unknown',
        capabilities: (query.capabilities ? query.capabilities.split(',') : [...DEVICE_COMMANDS]) as string[],
      });
      registered = true;
      socket.send(
        JSON.stringify({
          type: 'ready',
          session,
          commands: DEVICE_COMMANDS,
          serverTime: new Date().toISOString(),
        }),
      );
    };
    hello();

    socket.on('message', async (raw: Buffer | string) => {
      let frame: any;
      try {
        frame = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
      } catch {
        return;
      }
      services.devices.touch(deviceId);
      switch (frame.type) {
        case 'hello':
          // The app can re-announce itself with richer capabilities.
          services.devices.register(socket, {
            deviceId,
            name: frame.name ?? query.name ?? 'Android device',
            platform: frame.platform ?? 'android',
            appVersion: frame.appVersion ?? 'unknown',
            capabilities: frame.capabilities ?? [...DEVICE_COMMANDS],
          });
          break;
        case 'result':
          services.devices.settle({
            id: String(frame.id ?? ''),
            ok: Boolean(frame.ok),
            mode: frame.mode,
            summary: frame.summary,
            data: frame.data,
            error: frame.error,
          });
          break;
        case 'log':
          services.events.emit('device.log', { deviceId, message: String(frame.message ?? '') });
          break;
        case 'ping':
          socket.send(JSON.stringify({ type: 'pong', at: new Date().toISOString() }));
          break;
        default:
          break;
      }
    });

    socket.on('close', () => {
      if (registered) services.devices.unregister(deviceId);
    });
  });

  // Heartbeat + prune so a dead phone can't hold a slot forever.
  const timer = setInterval(() => {
    services.devices.heartbeat();
    services.devices.pruneIdle();
  }, 45_000);
  timer.unref?.();
  app.addHook('onClose', async () => clearInterval(timer));
}
