/**
 * Personal Agent tools — calendar, reminders, notes and the daily brief.
 * Everything works locally and can additionally be mirrored onto the phone.
 */
import type { Tool, ToolContext } from './types.js';
import { parseWhen } from '../personal/calendar.js';

/** Push a reminder onto the paired Android device when one is connected. */
async function mirrorToPhone(
  ctx: ToolContext,
  event: { title: string; start: string; notes?: string },
  kind: 'reminder' | 'event',
): Promise<string> {
  const bridge = ctx.services.devices;
  if (!bridge.isConnected()) return '';
  const result = await bridge.command(
    kind === 'reminder' ? 'device.createReminder' : 'device.createCalendarEvent',
    { title: event.title, when: event.start, notes: event.notes },
    { runId: ctx.runId },
  );
  return result.mode === 'live' && result.ok ? ' Mirrored to your phone.' : '';
}

export const personalTools: Tool[] = [
  {
    id: 'calendar.agenda',
    name: 'Calendar agenda',
    description: 'Lists events and reminders for a day (today by default) or the coming days.',
    category: 'personal',
    scopes: ['calendar:read'],
    risk: 'low',
    parameters: [
      { name: 'date', type: 'string', description: 'ISO date or phrases like "tomorrow". Defaults to today.', required: false },
      { name: 'days', type: 'number', description: 'How many days ahead to include.', required: false },
    ],
    owners: ['personal', 'master', 'business'],
    async run(input, ctx) {
      if (input.days !== undefined) {
        const events = await ctx.services.calendar.upcoming(Number(input.days) || 7);
        return {
          ok: true,
          mode: 'live',
          summary: events.length ? `${events.length} item(s) in the next ${input.days} day(s).` : `Nothing scheduled in the next ${input.days} day(s).`,
          data: { events },
        };
      }
      const base = input.date ? new Date(parseWhen(String(input.date)) ?? String(input.date)) : new Date();
      if (Number.isNaN(base.getTime())) {
        return { ok: false, mode: 'live', summary: `I could not understand the date "${input.date}".`, error: 'bad date' };
      }
      const events = await ctx.services.calendar.today(base);
      return {
        ok: true,
        mode: 'live',
        summary: events.length
          ? `${events.length} item(s): ${events.map((event) => `${formatTime(event.start)} ${event.title}`).join('; ')}.`
          : 'Your calendar is clear.',
        data: { events },
      };
    },
  },
  {
    id: 'calendar.create',
    name: 'Create a calendar event',
    description: 'Adds an event, understanding phrases like "tomorrow morning" or "friday at 3pm".',
    category: 'personal',
    scopes: ['calendar:write'],
    risk: 'medium',
    parameters: [
      { name: 'title', type: 'string', description: 'Event title.', required: true },
      { name: 'when', type: 'string', description: 'When it happens ("tomorrow morning", "2026-09-20T14:00").', required: true },
      { name: 'durationMinutes', type: 'number', description: 'Length in minutes (default 60).', required: false },
      { name: 'location', type: 'string', description: 'Where.', required: false },
      { name: 'notes', type: 'string', description: 'Notes.', required: false },
      { name: 'mirrorToPhone', type: 'boolean', description: 'Also add it to the phone calendar.', required: false },
    ],
    owners: ['personal', 'master'],
    async run(input, ctx) {
      const title = String(input.title ?? '').trim();
      const when = String(input.when ?? '').trim();
      if (!title || !when) return { ok: false, mode: 'live', summary: 'An event needs a title and a time.', error: 'incomplete' };
      const start = parseWhen(when);
      if (!start) {
        return {
          ok: false,
          mode: 'live',
          summary: `I could not work out when "${when}" is. Try "tomorrow at 9am" or an ISO timestamp.`,
          error: 'unparsed time',
        };
      }
      const duration = Number(input.durationMinutes ?? 60) || 60;
      const event = await ctx.services.calendar.create({
        title,
        start,
        end: new Date(Date.parse(start) + duration * 60_000).toISOString(),
        kind: 'event',
        location: input.location ? String(input.location) : undefined,
        notes: input.notes ? String(input.notes) : undefined,
      });
      const mirrored = input.mirrorToPhone === true ? await mirrorToPhone(ctx, event, 'event') : '';
      return {
        ok: true,
        mode: 'live',
        summary: `Scheduled "${title}" for ${formatDateTime(start)}.${mirrored}`,
        data: { event },
      };
    },
  },
  {
    id: 'calendar.cancel',
    name: 'Cancel an event or reminder',
    description: 'Finds an event by part of its title and removes it.',
    category: 'personal',
    scopes: ['calendar:write'],
    risk: 'medium',
    parameters: [{ name: 'hint', type: 'string', description: 'Part of the title.', required: true }],
    owners: ['personal', 'master'],
    async run(input, ctx) {
      const hint = String(input.hint ?? '').trim();
      const event = await ctx.services.calendar.findByHint(hint);
      if (!event) return { ok: false, mode: 'live', summary: `Nothing upcoming matched "${hint}".`, error: 'not found' };
      await ctx.services.calendar.remove(event.id);
      return { ok: true, mode: 'live', summary: `Removed "${event.title}" (${formatDateTime(event.start)}).`, data: { event } };
    },
  },
  {
    id: 'reminder.create',
    name: 'Set a reminder',
    description: 'Creates a reminder and mirrors it onto the phone when one is connected.',
    category: 'personal',
    scopes: ['calendar:write'],
    risk: 'low',
    parameters: [
      { name: 'text', type: 'string', description: 'What to be reminded about.', required: true },
      { name: 'when', type: 'string', description: 'When ("tomorrow morning", "in 2 hours").', required: true },
    ],
    owners: ['personal', 'master', 'business'],
    async run(input, ctx) {
      const text = String(input.text ?? '').trim();
      const when = String(input.when ?? '').trim();
      if (!text) return { ok: false, mode: 'live', summary: 'What should I remind you about?', error: 'missing text' };
      const start = parseWhen(when || 'in 1 hour');
      if (!start) {
        return { ok: false, mode: 'live', summary: `I could not work out when "${when}" is.`, error: 'unparsed time' };
      }
      const event = await ctx.services.calendar.create({ title: text, start, kind: 'reminder' });
      const mirrored = await mirrorToPhone(ctx, event, 'reminder');
      return {
        ok: true,
        mode: 'live',
        summary: `Reminder set for ${formatDateTime(start)}: ${text}.${mirrored}`,
        data: { event },
      };
    },
  },
  {
    id: 'notes.save',
    name: 'Save a note',
    description: 'Files a note into the knowledge base so it can be found later by any agent.',
    category: 'personal',
    scopes: ['knowledge:write'],
    risk: 'low',
    parameters: [
      { name: 'title', type: 'string', description: 'Note title.', required: true },
      { name: 'text', type: 'string', description: 'Note content.', required: true },
      { name: 'tags', type: 'array', description: 'Tags.', required: false },
    ],
    owners: ['personal', 'knowledge', 'master'],
    async run(input, ctx) {
      const title = String(input.title ?? '').trim();
      const text = String(input.text ?? '').trim();
      if (!title || !text) return { ok: false, mode: 'live', summary: 'A note needs a title and content.', error: 'incomplete' };
      const result = await ctx.services.documents.ingestText({
        title,
        text,
        source: 'note',
        collection: 'notes',
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : ['note'],
      });
      return { ok: true, mode: 'live', summary: `Saved note "${title}" to your knowledge base.`, data: result };
    },
  },
  {
    id: 'personal.brief',
    name: 'Daily brief',
    description:
      'Combines your agenda, open tasks, unread notifications and business headlines into one morning brief.',
    category: 'personal',
    scopes: ['calendar:read', 'memory:read'],
    risk: 'low',
    parameters: [],
    owners: ['personal', 'master'],
    async run(_input, ctx) {
      const now = new Date();
      const [events, upcoming, business, notifications] = await Promise.all([
        ctx.services.calendar.today(now),
        ctx.services.calendar.upcoming(3, now),
        ctx.services.business.get(),
        ctx.services.notifications.list({ limit: 5 }),
      ]);

      const openTasks = business.tasks.filter((task) => !task.done);
      const lines: string[] = [];
      lines.push(`Good ${greeting(now)}, here is ${now.toDateString()}.`);
      lines.push(
        events.length
          ? `Today (${events.length}): ${events.map((event) => `${formatTime(event.start)} ${event.title}`).join('; ')}.`
          : 'Nothing on your calendar today.',
      );
      const later = upcoming.filter((event) => Date.parse(event.start) > new Date(now.getTime() + 86_400_000 - 1).getTime());
      if (later.length) {
        lines.push(`Next few days: ${later.slice(0, 5).map((event) => `${new Date(event.start).toDateString()} ${event.title}`).join('; ')}.`);
      }
      if (openTasks.length) {
        lines.push(`Open tasks (${openTasks.length}): ${openTasks.slice(0, 5).map((task) => task.title).join('; ')}.`);
      }
      const inquiries = business.leads.filter((lead) => lead.stage === 'inquiry');
      if (inquiries.length) {
        lines.push(`Unhandled inquiries: ${inquiries.slice(0, 5).map((lead) => lead.name).join('; ')}.`);
      }
      if (notifications.length) {
        lines.push(`Recent alerts: ${notifications.map((notification) => notification.title).join('; ')}.`);
      }

      return {
        ok: true,
        mode: 'live',
        summary: lines.join('\n'),
        data: { events, upcoming, openTasks, notifications },
        suggestions: ['Show my business brief too', 'Draft replies for the open inquiries', 'Clear the completed tasks'],
      };
    },
  },
];

function greeting(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return 'morning';
  if (hour < 18) return 'afternoon';
  return 'evening';
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
