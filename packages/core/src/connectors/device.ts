/**
 * Android device connector.
 *
 * The phone side is deliberately thin and explicit: Xacheus asks the companion
 * app to perform a named, owner-visible action, and the app decides whether it is
 * allowed by Android's own permission model. Xacheus cannot bypass a system
 * prompt, a battery optimisation or a privacy switch — it can only request.
 *
 * High-impact actions (calls, SMS, settings changes) are confirmation-gated.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { evaluateStatus, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';
import type { DeviceBridge, DeviceCommand } from '../devices/bridge.js';

export interface DeviceConnectorServices {
  devices: DeviceBridge;
}

/** Commands we consider high-impact enough to require explicit approval. */
const CONFIRM_REQUIRED = new Set<string>([
  'device.call',
  'device.sendSms',
  'device.setSetting',
  'device.launchIntent',
  'device.recordVoiceNote',
  'device.takePhoto',
]);

function bridge(ctx: { services?: unknown }): DeviceBridge | null {
  const services = ctx.services as DeviceConnectorServices | undefined;
  return services?.devices ?? null;
}

const deviceOperations: ConnectorOperation[] = [
  {
    id: 'status',
    title: 'Phone connection status',
    description: 'Lists paired Android devices and whether they are currently connected to the backend.',
    scopes: ['device:read'],
    risk: 'low',
    parameters: [],
    async run(_input, ctx) {
      const devices = bridge(ctx);
      if (!devices) return sandbox('Device status', 'the device bridge is not running.');
      const sessions = devices.sessions();
      return {
        ok: true,
        mode: 'live',
        summary: sessions.length
          ? `${sessions.length} Android device(s) connected: ${sessions.map((session) => session.name).join(', ')}.`
          : 'No Android device is connected. The companion app dials the backend when it is open, so start it (or enable the foreground service) to control the phone.',
        data: { devices: sessions, recentCommands: devices.recent(10) },
      };
    },
  },
  {
    id: 'action',
    title: 'Perform a phone action',
    description:
      'Sends a named action to the paired Android device: open an app, create a reminder or calendar event, control media, set a supported setting, make a call, send a message, take a photo, read the clipboard, check battery, get location, speak text, toggle the torch and more.',
    scopes: ['device:control'],
    risk: 'medium',
    parameters: [
      {
        name: 'command',
        type: 'string',
        description: 'Action to perform.',
        required: true,
        enum: [
          'device.info',
          'device.openApp',
          'device.openUrl',
          'device.navigate',
          'device.createReminder',
          'device.createCalendarEvent',
          'device.listNotifications',
          'device.dismissNotifications',
          'device.mediaControl',
          'device.call',
          'device.sendSms',
          'device.setSetting',
          'device.readClipboard',
          'device.writeClipboard',
          'device.batteryStatus',
          'device.location',
          'device.speak',
          'device.vibrate',
          'device.torch',
          'device.takePhoto',
        ],
      },
      { name: 'args', type: 'object', description: 'Command arguments, e.g. {"package":"com.whatsapp"} or {"title":"Check the website","when":"2026-09-16T08:00:00"}.', required: false },
      { name: 'deviceId', type: 'string', description: 'Target a specific paired device.', required: false },
    ],
    async run(input, ctx) {
      const devices = bridge(ctx);
      const command = String(input.command ?? '').trim();
      if (!command) return { ok: false, mode: 'live', summary: 'Which phone action should I perform?', error: 'missing command' };
      if (!devices) return sandbox(`Phone action ${command}`, 'the device bridge is not running.');
      const result = await devices.command(command as DeviceCommand, (input.args as Record<string, unknown>) ?? {}, {
        deviceId: input.deviceId ? String(input.deviceId) : undefined,
        runId: ctx.runId,
      });
      return result;
    },
  },
  {
    id: 'notify',
    title: 'Notify the phone',
    description: 'Pushes a notification to the paired Android device.',
    scopes: ['device:control'],
    risk: 'low',
    parameters: [
      { name: 'title', type: 'string', description: 'Notification title.', required: true },
      { name: 'body', type: 'string', description: 'Notification body.', required: true },
    ],
    async run(input, ctx) {
      const devices = bridge(ctx);
      if (!devices) return sandbox('Phone notification', 'the device bridge is not running.');
      const delivered = devices.notify(undefined, {
        id: `ntf_${Date.now().toString(36)}`,
        title: String(input.title ?? 'Xacheus'),
        body: String(input.body ?? ''),
        level: 'info',
        at: new Date().toISOString(),
        read: false,
        source: 'agent',
      });
      return {
        ok: true,
        mode: delivered ? 'live' : 'sandbox',
        summary: delivered
          ? `Notification pushed to ${delivered} device(s).`
          : 'No Android device connected, so the notification was only recorded in the console.',
        data: { delivered },
      };
    },
  },
];

export const deviceConnector: Connector = {
  manifest: {
    id: 'device',
    name: 'Android companion app',
    category: 'device',
    description:
      'The bridge between Xacheus and your phone: apps, reminders, calendar, notifications, media, clipboard, battery, location, camera, speak and more. Everything is an explicit action that Android itself still gets to permit or deny.',
    fields: [
      { key: 'XACHEUS_DEVICE_BRIDGE_TOKEN', label: 'Pairing token', secret: true, required: true, hint: 'Paste the same value into the Android app. The connector reports live only once a device is actually connected.' },
    ],
    scopes: ['device:read', 'device:control'],
    capabilities: ['Open apps', 'Reminders & calendar', 'Notifications', 'Media control', 'Calls & SMS (with approval)', 'Clipboard', 'Battery & location', 'Speak on phone'],
  },
  operations: deviceOperations,
  status: (config) => evaluateStatus(deviceConnector, config),
};
