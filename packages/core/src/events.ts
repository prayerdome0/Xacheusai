/**
 * Process-local event bus. Automations subscribe to named events, connectors
 * emit them, and the console mirrors them over WebSocket.
 */
import { EventEmitter } from 'node:events';
import type { RuntimeEvent } from './types.js';
import { newId, nowIso } from './util.js';

export const RUNTIME_EVENTS = [
  'run.started',
  'run.step',
  'run.awaiting_confirmation',
  'run.completed',
  'run.failed',
  'inquiry.received',
  'message.received',
  'document.ingested',
  'automation.fired',
  'notification.created',
  'connector.updated',
  'memory.updated',
] as const;

export type RuntimeEventName = (typeof RUNTIME_EVENTS)[number] | (string & {});

export class EventBus {
  private readonly emitter = new EventEmitter();
  private readonly history: RuntimeEvent[] = [];
  private readonly historyLimit: number;

  constructor(historyLimit = 200) {
    this.historyLimit = historyLimit;
    // Automations add listeners; keep the warning limit useful but not noisy.
    this.emitter.setMaxListeners(64);
  }

  emit<T>(name: RuntimeEventName, payload: T): RuntimeEvent<T> {
    const event: RuntimeEvent<T> = { id: newId('evt'), name, at: nowIso(), payload };
    this.history.unshift(event as RuntimeEvent);
    if (this.history.length > this.historyLimit) this.history.pop();
    this.emitter.emit(name, event);
    this.emitter.emit('*', event);
    return event;
  }

  on(name: RuntimeEventName, handler: (event: RuntimeEvent<any>) => void): () => void {
    this.emitter.on(name, handler);
    return () => this.emitter.off(name, handler);
  }

  onAny(handler: (event: RuntimeEvent<any>) => void): () => void {
    return this.on('*', handler);
  }

  recent(limit = 50): RuntimeEvent[] {
    return this.history.slice(0, limit);
  }
}
