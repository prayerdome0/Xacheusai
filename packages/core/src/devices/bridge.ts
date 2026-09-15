/**
 * Android device bridge.
 *
 * The phone is a first-class citizen: it dials *out* to the backend over a
 * WebSocket and holds one persistent connection. The server never tries to reach
 * the handset directly — that keeps the phone behind NAT, means no inbound ports
 * and no always-open listener on the device, and lets Android apply its own
 * battery/privacy rules to the socket.
 *
 * Protocol (JSON frames):
 *   device → server  { type: 'hello',      deviceId, name, platform, appVersion, capabilities }
 *   server → device  { type: 'command',    id, command, args, runId? }
 *   device → server  { type: 'result',     id, ok, mode, summary, data? }
 *   server → device  { type: 'notify',     notification }
 *   either           { type: 'ping' | 'pong' }
 *
 * Commands map 1:1 to Android-side handlers the owner has explicitly enabled.
 */
import type { Notification, ToolResult } from '../types.js';
import { newId, nowIso } from '../util.js';

/** How a device reaches the server. */
export type DeviceTransport = 'websocket' | 'poll';

export const DEVICE_COMMANDS = [
  'device.info',
  'device.openApp',
  'device.openUrl',
  'device.navigate',
  'device.createReminder',
  'device.createCalendarEvent',
  'device.listNotifications',
  'device.dismissNotifications',
  'device.mediaControl',
  'device.setSetting',
  'device.call',
  'device.sendSms',
  'device.shareText',
  'device.takePhoto',
  'device.recordVoiceNote',
  'device.readClipboard',
  'device.writeClipboard',
  'device.batteryStatus',
  'device.location',
  'device.speak',
  'device.vibrate',
  'device.torch',
  'device.launchIntent',
] as const;

export type DeviceCommand = (typeof DEVICE_COMMANDS)[number];

export interface DeviceSession {
  deviceId: string;
  name: string;
  platform: string;
  appVersion: string;
  capabilities: DeviceCommand[] | string[];
  connectedAt: string;
  lastSeenAt: string;
  socketId: string;
  /** Push socket, or a device that talks over HTTP because it cannot hold one. */
  transport?: DeviceTransport;
}

interface PendingCommand {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
  command: string;
  sentAt: number;
}

/** A command waiting to be collected by a polling device. */
export interface QueuedCommand {
  id: string;
  command: string;
  args: Record<string, unknown>;
  runId?: string;
  issuedAt: string;
}

/** Transport-agnostic socket handle so the kernel doesn't depend on Fastify. */
export interface DeviceSocket {
  id: string;
  send(payload: string): void;
  close(): void;
}

export class DeviceBridge {
  private readonly sockets = new Map<string, { socket: DeviceSocket | null; session: DeviceSession }>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly history: ToolResult[] = [];
  private commandTimeoutMs = 20_000;

  /**
   * Commands addressed to devices that poll instead of holding a socket.
   *
   * This exists because some hosting environments terminate WebSockets (Vercel's
   * serverless functions cannot hold one at all). A phone that is told to poll
   * still gets its work done — with the same permission checks, the same
   * confirmation gate and the same honest result modes.
   */
  private readonly queues = new Map<string, QueuedCommand[]>();

  /**
   * How long a queued command waits for its answer before we stop expecting one.
   * Long, because a phone that polls every few seconds will pick it up quickly,
   * but a phone that was asleep may take a while to wake and check in.
   */
  private queueTtlMs = 15 * 60_000;

  constructor(private readonly onEvent?: (name: string, payload: unknown) => void) {}

  /** Register a polling device (HTTP transport) without a socket. */
  registerPolling(hello: Omit<DeviceSession, 'socketId' | 'connectedAt' | 'lastSeenAt'>): DeviceSession {
    const existing = this.sockets.get(hello.deviceId);
    const session: DeviceSession = {
      ...hello,
      transport: 'poll',
      socketId: `poll:${hello.deviceId}`,
      connectedAt: existing?.session.connectedAt ?? nowIso(),
      lastSeenAt: nowIso(),
    };
    // A socketMap entry with a null socket keeps `sessions()` and `isConnected()`
    // truthful for polling devices too.
    this.sockets.set(hello.deviceId, { socket: null, session });
    this.onEvent?.('device.connected', session);
    return session;
  }

  /** Commands waiting for this device, oldest first. */
  drainQueue(deviceId: string, limit = 10): QueuedCommand[] {
    const queue = this.queues.get(deviceId) ?? [];
    const taken = queue.splice(0, limit);
    if (!queue.length) this.queues.delete(deviceId);
    return taken;
  }

  /** Deliver a result for a queued command. Reuses the normal settle path. */
  settleQueued(frame: { id: string; ok: boolean; mode?: ToolResult['mode']; summary?: string; data?: unknown; error?: string }): boolean {
    return this.settle(frame);
  }

  register(socket: DeviceSocket, hello: Omit<DeviceSession, 'socketId' | 'connectedAt' | 'lastSeenAt'>): DeviceSession {
    // One live connection per device id: replace any stale socket.
    const existing = this.sockets.get(hello.deviceId);
    if (existing?.socket) {
      try {
        existing.socket.send(JSON.stringify({ type: 'replaced' }));
        existing.socket.close();
      } catch {
        /* ignore */
      }
    }
    const session: DeviceSession = {
      ...hello,
      socketId: socket.id,
      connectedAt: nowIso(),
      lastSeenAt: nowIso(),
    };
    this.sockets.set(hello.deviceId, { socket, session });
    this.onEvent?.('device.connected', session);
    return session;
  }

  unregister(deviceId: string): void {
    const entry = this.sockets.get(deviceId);
    if (!entry) return;
    this.sockets.delete(deviceId);
    this.onEvent?.('device.disconnected', { deviceId, name: entry.session.name });
  }

  unregisterBySocket(socketId: string): void {
    for (const [deviceId, entry] of this.sockets) {
      if (entry.socket?.id === socketId) this.unregister(deviceId);
    }
  }

  touch(deviceId: string): void {
    const entry = this.sockets.get(deviceId);
    if (entry) entry.session.lastSeenAt = nowIso();
  }

  sessions(): DeviceSession[] {
    return [...this.sockets.values()].map((entry) => entry.session);
  }

  get(deviceId: string): DeviceSession | undefined {
    return this.sockets.get(deviceId)?.session;
  }

  isConnected(deviceId?: string): boolean {
    if (deviceId) return this.sockets.has(deviceId);
    return this.sockets.size > 0;
  }

  /** Deliver a device-side answer from a `command` frame. */
  settle(frame: { id: string; ok: boolean; mode?: ToolResult['mode']; summary?: string; data?: unknown; error?: string }): boolean {
    const pending = this.pending.get(frame.id);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    const result: ToolResult = {
      ok: frame.ok,
      mode: frame.mode ?? 'live',
      summary: frame.summary ?? (frame.ok ? 'Device reported success.' : 'Device reported failure.'),
      data: frame.data,
      error: frame.error,
      durationMs: Date.now() - pending.sentAt,
    };
    this.remember(result);
    pending.resolve(result);
    return true;
  }

  /**
   * Send a command to a device and wait for its answer.
   *
   * If no device is connected the caller gets `mode: 'sandbox'` rather than a
   * failure, so the whole flow stays demonstrable in the console — and the
   * summary says plainly that nothing happened on a real phone.
   */
  async command(
    command: DeviceCommand | string,
    args: Record<string, unknown>,
    options: { deviceId?: string; runId?: string; timeoutMs?: number } = {},
  ): Promise<ToolResult> {
    const target = options.deviceId ? this.sockets.get(options.deviceId) : [...this.sockets.values()][0];
    if (!target) {
      return {
        ok: true,
        mode: 'sandbox',
        summary: `Simulated on the server: no Android device is connected, so "${command}" was not executed on a phone. Pair the Xacheus app to run this for real.`,
        data: { command, args, simulated: true },
      };
    }

    const id = newId('cmd');
    const startedAt = Date.now();

    // A polling device cannot be pushed to: queue the command and let it collect.
    const socket = target.socket;
    if (target.session.transport === 'poll' || !socket) {
      const queue = this.queues.get(target.session.deviceId) ?? [];
      const depth = queue.length;
      queue.push({ id, command, args, runId: options.runId, issuedAt: nowIso() });
      this.queues.set(target.session.deviceId, queue);

      // Track the id even though we answer the caller now: when the phone reports
      // back, the result is correlated, recorded in history and visible in the
      // console instead of being dropped on the floor.
      const ttl = setTimeout(() => {
        this.pending.delete(id);
        this.remember({
          ok: false,
          mode: 'live',
          summary: `The phone collected "${command}" but has not reported a result within ${Math.round(this.queueTtlMs / 60_000)} minutes.`,
          error: 'no-result',
          durationMs: Date.now() - startedAt,
        });
      }, this.queueTtlMs);
      ttl.unref?.();
      this.pending.set(id, { resolve: () => undefined, timer: ttl, command, sentAt: startedAt });

      return {
        ok: true,
        mode: 'live',
        summary:
          `Queued "${command}" for ${target.session.name}: this device collects work over HTTP rather than a ` +
          `long-lived socket (the usual reason is a serverless backend). It runs as soon as the app next checks in` +
          (depth ? ` — there are ${depth} command(s) ahead of it.` : '.'),
        data: { command, args, queued: true, queueDepth: depth + 1 },
      };
    }
    const result = await new Promise<ToolResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({
          ok: false,
          mode: 'live',
          summary: `The device did not answer "${command}" within ${(options.timeoutMs ?? this.commandTimeoutMs) / 1000}s.`,
          error: 'timeout',
          durationMs: Date.now() - startedAt,
        });
      }, options.timeoutMs ?? this.commandTimeoutMs);
      this.pending.set(id, { resolve, timer, command, sentAt: startedAt });
      try {
        socket.send(
          JSON.stringify({
            type: 'command',
            id,
            command,
            args,
            runId: options.runId,
            issuedAt: nowIso(),
          }),
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve({
          ok: false,
          mode: 'live',
          summary: `Could not reach device ${target.session.name}.`,
          error: (error as Error).message,
        });
      }
    });
    this.remember(result);
    return result;
  }

  /** Fire-and-forget push (notifications, spoken output). */
  notify(deviceId: string | undefined, notification: Notification): number {
    const targets = (deviceId ? [this.sockets.get(deviceId)].filter(Boolean) : [...this.sockets.values()]).filter(
      (entry) => entry?.socket,
    );
    let delivered = 0;
    for (const entry of targets) {
      try {
        entry!.socket!.send(JSON.stringify({ type: 'notify', notification }));
        delivered += 1;
      } catch {
        /* device will reconnect */
      }
    }
    return delivered;
  }

  recent(limit = 50): ToolResult[] {
    return this.history.slice(0, limit);
  }

  private remember(result: ToolResult): void {
    this.history.unshift(result);
    if (this.history.length > 200) this.history.pop();
  }

  /** Called on a timer: drop sockets that stopped answering pings. */
  pruneIdle(maxIdleMs = 120_000): string[] {
    const dropped: string[] = [];
    for (const [deviceId, entry] of this.sockets) {
      // Polling devices are expected to be quiet between checks; give them room.
      const budget = entry.session.transport === 'poll' ? Math.max(maxIdleMs, 24 * 60 * 60_000) : maxIdleMs;
      if (Date.now() - Date.parse(entry.session.lastSeenAt) > budget) {
        this.unregister(deviceId);
        dropped.push(deviceId);
      }
    }
    return dropped;
  }

  heartbeat(): void {
    for (const entry of [...this.sockets.values()]) {
      if (!entry.socket) continue;
      try {
        entry.socket.send(JSON.stringify({ type: 'ping', at: nowIso() }));
      } catch {
        this.unregister(entry.session.deviceId);
      }
    }
  }
}
