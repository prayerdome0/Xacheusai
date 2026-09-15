/**
 * Calendar & reminders.
 *
 * Xacheus keeps its own calendar so the Personal Agent works before you connect
 * Google/Outlook. Events can also be mirrored to the phone's calendar through
 * the Android connector. A provider adapter (Google Calendar, CalDAV) can be
 * added later behind `listRange`, and nothing above it changes.
 */
import type { StorageDriver } from '../storage/driver.js';
import { newId, nowIso } from '../util.js';

const COLLECTION = 'calendar';

export interface CalendarEvent {
  id: string;
  title: string;
  /** ISO start; for all-day events this is 00:00 local. */
  start: string;
  end?: string;
  allDay?: boolean;
  kind: 'event' | 'reminder' | 'task-block';
  location?: string;
  notes?: string;
  /** 'xacheus' | 'google' | 'outlook' | 'device' */
  source: string;
  /** Whether the phone has been asked to mirror this event. */
  mirroredToDevice?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateEventInput {
  title: string;
  start?: string;
  end?: string;
  allDay?: boolean;
  kind?: CalendarEvent['kind'];
  location?: string;
  notes?: string;
  source?: string;
}

/**
 * Very small natural-language time parser for phrases like
 * "tomorrow morning", "in 2 hours", "friday at 3pm", "next monday".
 * Returns an ISO string, or null when it cannot be understood.
 */
export function parseWhen(phrase: string, base = new Date()): string | null {
  const text = phrase.trim().toLowerCase();
  if (!text) return null;

  const relative = text.match(/in\s+(\d+)\s*(minute|min|hour|hr|day|week)s?/);
  if (relative?.[1] && relative[2]) {
    const amount = Number(relative[1]);
    const unit = relative[2];
    const ms =
      unit.startsWith('min') ? amount * 60_000 : unit.startsWith('hour') || unit === 'hr' ? amount * 3_600_000 : unit === 'day' ? amount * 86_400_000 : amount * 604_800_000;
    return new Date(base.getTime() + ms).toISOString();
  }

  const target = new Date(base.getTime());
  let matchedDate = false;

  if (/\btomorrow\b/.test(text)) {
    target.setDate(target.getDate() + 1);
    matchedDate = true;
  } else if (/\btoday\b/.test(text) || /\btonight\b/.test(text)) {
    matchedDate = true;
  } else if (/\bnext week\b/.test(text)) {
    target.setDate(target.getDate() + 7);
    matchedDate = true;
  } else {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const weekday = weekdays.findIndex((day) => text.includes(day));
    if (weekday >= 0) {
      const delta = (weekday - target.getDay() + 7) % 7 || 7;
      target.setDate(target.getDate() + (/\bnext\b/.test(text) && delta < 7 ? delta + 7 : delta));
      matchedDate = true;
    } else {
      const iso = text.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (iso) {
        target.setFullYear(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
        matchedDate = true;
      }
    }
  }

  let matchedTime = false;
  const clock = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (/\bmorning\b/.test(text)) {
    target.setHours(8, 0, 0, 0);
    matchedTime = true;
  } else if (/\bafternoon\b/.test(text)) {
    target.setHours(14, 0, 0, 0);
    matchedTime = true;
  } else if (/\bevening\b/.test(text) || /\btonight\b/.test(text)) {
    target.setHours(19, 0, 0, 0);
    matchedTime = true;
  } else if (/\bnoon\b/.test(text)) {
    target.setHours(12, 0, 0, 0);
    matchedTime = true;
  } else if (clock?.[1]) {
    let hour = Number(clock[1]);
    const minute = Number(clock[2] ?? 0);
    const meridiem = clock[3];
    if (meridiem === 'pm' && hour < 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour <= 23 && minute <= 59) {
      target.setHours(hour, minute, 0, 0);
      matchedTime = true;
    }
  }

  if (!matchedDate && !matchedTime) {
    // Bare times like "at 9" default to today if still in the future.
    if (clock?.[1] && Number(clock[1]) <= 24) {
      const hour = Number(clock[1]);
      target.setHours(hour, 0, 0, 0);
      if (target.getTime() < base.getTime()) target.setDate(target.getDate() + 1);
      return target.toISOString();
    }
    return null;
  }
  if (!matchedTime) target.setHours(9, 0, 0, 0);
  if (target.getTime() < base.getTime() && !/\b(today|tonight)\b/.test(text)) {
    // "friday" that already passed means next week's friday.
    target.setDate(target.getDate() + 7);
  }
  return target.toISOString();
}

export class CalendarService {
  constructor(private readonly storage: StorageDriver) {}

  async create(input: CreateEventInput): Promise<CalendarEvent> {
    const start = input.start ?? parseWhen('in 1 hour') ?? nowIso();
    const event: CalendarEvent = {
      id: newId('evt'),
      title: input.title,
      start,
      end: input.end,
      allDay: input.allDay,
      kind: input.kind ?? 'event',
      location: input.location,
      notes: input.notes,
      source: input.source ?? 'xacheus',
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    await this.storage.set(COLLECTION, event);
    return event;
  }

  async listRange(from: Date, to: Date): Promise<CalendarEvent[]> {
    const all = await this.storage.list<CalendarEvent>(COLLECTION);
    return all
      .filter((event) => {
        const time = Date.parse(event.start);
        return Number.isFinite(time) && time >= from.getTime() && time <= to.getTime();
      })
      .sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  }

  async today(base = new Date()): Promise<CalendarEvent[]> {
    const from = new Date(base);
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + 86_400_000 - 1);
    return this.listRange(from, to);
  }

  async upcoming(days = 7, base = new Date()): Promise<CalendarEvent[]> {
    const from = new Date(base);
    from.setHours(0, 0, 0, 0);
    return this.listRange(from, new Date(from.getTime() + days * 86_400_000));
  }

  async update(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent | null> {
    const event = await this.storage.get<CalendarEvent>(COLLECTION, id);
    if (!event) return null;
    const next = { ...event, ...patch, updatedAt: nowIso() };
    await this.storage.set(COLLECTION, next);
    return next;
  }

  async remove(id: string): Promise<boolean> {
    const event = await this.storage.get<CalendarEvent>(COLLECTION, id);
    if (!event) return false;
    await this.storage.delete(COLLECTION, id);
    return true;
  }

  /** Find an event by fuzzy title match — used by "cancel my 3pm". */
  async findByHint(hint: string): Promise<CalendarEvent | null> {
    const needle = hint.toLowerCase();
    const events = await this.upcoming(30);
    return (
      events.find((event) => event.title.toLowerCase().includes(needle)) ??
      events.find((event) => (event.notes ?? '').toLowerCase().includes(needle)) ??
      null
    );
  }
}
