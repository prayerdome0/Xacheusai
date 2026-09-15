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
}

interface PendingCommand {
  resolve: (result: ToolResult) => void;
  timer: NodeJS.Timeout;
  command: string;
  sentAt: number;
}

/** Transport-agnostic socket handle so the kernel doesn't depend on Fastify. */
export interface DeviceSocket {
  id: string;
  send(payload: string): void;
  close(): void;
}

export class DeviceBridge {
  private readonly sockets = new Map<string, { socket: DeviceSocket; session: DeviceSession }>();
  private readonly pending = new Map<string, PendingCommand>();
  private readonly history: ToolResult[] = [];
  private commandTimeoutMs = 20_000;

  constructor(private readonly onEvent?: (name: string, payload: unknown) => void) {}

  register(socket: DeviceSocket, hello: Omit<DeviceSession, 'socketId' | 'connectedAt' | 'lastSeenAt'>): DeviceSession {
    // One live connection per device id: replace any stale socket.
    const existing = this.sockets.get(hello.deviceId);
    if (existing) {
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
      if (entry.socket.id === socketId) this.unregister(deviceId);
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
        target.socket.send(
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
    const targets = deviceId ? [this.sockets.get(deviceId)].filter(Boolean) : [...this.sockets.values()];
    let delivered = 0;
    for (const entry of targets) {
      try {
        entry!.socket.send(JSON.stringify({ type: 'notify', notification }));
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
      if (Date.now() - Date.parse(entry.session.lastSeenAt) > maxIdleMs) {
        this.unregister(deviceId);
        dropped.push(deviceId);
      }
    }
    return dropped;
  }

  heartbeat(): void {
    for (const entry of [...this.sockets.values()]) {
      try {
        entry.socket.send(JSON.stringify({ type: 'ping', at: nowIso() }));
      } catch {
        this.unregister(entry.session.deviceId);
      }
    }
  }
}
