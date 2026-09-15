/**
 * Notifications: the "report back" end of every automation and agent run.
 * Stored for the console, pushed to connected Android devices, and emitted on
 * the event bus so automations can chain.
 */
import type { Notification } from './types.js';
import type { StorageDriver } from './storage/driver.js';
import type { DeviceBridge } from './devices/bridge.js';
import type { EventBus } from './events.js';
import { newId, nowIso } from './util.js';

const COLLECTION = 'notifications';

export class NotificationService {
  constructor(
    private readonly storage: StorageDriver,
    private readonly devices: DeviceBridge,
    private readonly events: EventBus,
    private readonly limit = 500,
  ) {}

  async create(input: Omit<Notification, 'id' | 'at' | 'read'> & { deviceId?: string }): Promise<Notification> {
    const notification: Notification = {
      id: newId('ntf'),
      title: input.title,
      body: input.body,
      level: input.level,
      at: nowIso(),
      read: false,
      source: input.source,
      runId: input.runId,
    };
    await this.storage.set(COLLECTION, notification);

    const all = await this.storage.list<Notification>(COLLECTION);
    if (all.length > this.limit) {
      for (const stale of all.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(0, all.length - this.limit)) {
        await this.storage.delete(COLLECTION, stale.id);
      }
    }

    this.devices.notify(input.deviceId, notification);
    this.events.emit('notification.created', notification);
    return notification;
  }

  async list(options: { limit?: number; unreadOnly?: boolean } = {}): Promise<Notification[]> {
    const all = await this.storage.list<Notification>(COLLECTION);
    return all
      .filter((item) => (options.unreadOnly ? !item.read : true))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
      .slice(0, options.limit ?? 50);
  }

  async markRead(id?: string): Promise<void> {
    if (!id) {
      const all = await this.storage.list<Notification>(COLLECTION);
      for (const item of all) if (!item.read) await this.storage.set(COLLECTION, { ...item, read: true });
      return;
    }
    const item = await this.storage.get<Notification>(COLLECTION, id);
    if (item) await this.storage.set(COLLECTION, { ...item, read: true });
  }

  async unreadCount(): Promise<number> {
    return (await this.list({ unreadOnly: true })).length;
  }
}
