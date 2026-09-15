/**
 * Business Agent tools — the numbers, leads, tasks and products behind the
 * "Xacheus, what do I have today?" flow.
 */
import type { Tool } from './types.js';

export const businessTools: Tool[] = [
  {
    id: 'business.todayBrief',
    name: 'Business brief',
    description:
      'Builds today\'s business brief from your live data: sales, pipeline, open tasks, margin and the priorities Xacheus thinks matter most.',
    category: 'business',
    scopes: ['business:read'],
    risk: 'low',
    parameters: [],
    owners: ['business', 'master', 'personal'],
    async run(_input, ctx) {
      const { text, priorities } = await ctx.services.business.todayBrief();
      return {
        ok: true,
        mode: 'live',
        summary: text,
        data: { brief: text, priorities },
        suggestions: [
          'Show me the pipeline in detail',
          'Draft a follow-up for the top lead',
          'What did I sell this month?',
        ],
      };
    },
  },
  {
    id: 'business.snapshot',
    name: 'Business data',
    description: 'Returns the full business snapshot: company, products, customers, leads, sales, expenses and tasks.',
    category: 'business',
    scopes: ['business:read'],
    risk: 'low',
    parameters: [],
    owners: ['business', 'master'],
    async run(_input, ctx) {
      const snapshot = await ctx.services.business.get();
      const activeLeads = snapshot.leads.filter((lead) => !['won', 'lost'].includes(lead.stage));
      return {
        ok: true,
        mode: 'live',
        summary: `${snapshot.company.name}: ${activeLeads.length} active lead(s), ${snapshot.tasks.filter((task) => !task.done).length} open task(s), ${snapshot.products.length} product(s), ${snapshot.customers.length} customer(s).`,
        data: { snapshot },
      };
    },
  },
  {
    id: 'business.updateCompany',
    name: 'Update company details',
    description: 'Sets your company name, industry or currency — the context every other answer builds on.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'medium',
    parameters: [
      { name: 'name', type: 'string', description: 'Company name.', required: false },
      { name: 'industry', type: 'string', description: 'Industry or sector.', required: false },
      { name: 'currency', type: 'string', description: 'Currency code, e.g. USD, EUR, NGN.', required: false },
    ],
    owners: ['business', 'master'],
    async run(input, ctx) {
      const patch: Record<string, string> = {};
      for (const key of ['name', 'industry', 'currency']) {
        if (input[key] !== undefined && String(input[key]).trim()) patch[key] = String(input[key]).trim();
      }
      if (!Object.keys(patch).length) return { ok: false, mode: 'live', summary: 'Nothing to update.', error: 'empty patch' };
      const snapshot = await ctx.services.business.updateCompany(patch);
      return {
        ok: true,
        mode: 'live',
        summary: `Company updated: ${Object.entries(patch).map(([key, value]) => `${key} → ${value}`).join(', ')}.`,
        data: { company: snapshot.company },
      };
    },
  },
  {
    id: 'business.addLead',
    name: 'Add a lead',
    description: 'Records a new lead or prospect with an optional value and note.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'low',
    parameters: [
      { name: 'name', type: 'string', description: 'Lead or company name.', required: true },
      { name: 'value', type: 'number', description: 'Estimated deal value.', required: false },
      { name: 'stage', type: 'string', description: 'Pipeline stage.', required: false, enum: ['new', 'inquiry', 'negotiation', 'won', 'lost', 'stale'] },
      { name: 'note', type: 'string', description: 'Context.', required: false },
    ],
    owners: ['business', 'social', 'messaging', 'mail', 'master'],
    async run(input, ctx) {
      const name = String(input.name ?? '').trim();
      if (!name) return { ok: false, mode: 'live', summary: 'A lead needs a name.', error: 'missing name' };
      const lead = await ctx.services.business.addLead(name, {
        value: input.value === undefined ? undefined : Number(input.value),
        stage: input.stage ? String(input.stage) : undefined,
        note: input.note ? String(input.note) : undefined,
      });
      return { ok: true, mode: 'live', summary: `Added lead ${lead.name} (${lead.stage}).`, data: { lead } };
    },
  },
  {
    id: 'business.addTask',
    name: 'Add a task',
    description: 'Adds a task to the business task list.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'low',
    parameters: [
      { name: 'title', type: 'string', description: 'Task description.', required: true },
      { name: 'due', type: 'string', description: 'Due date/ISO time.', required: false },
      { name: 'owner', type: 'string', description: 'Who owns it.', required: false },
    ],
    owners: ['business', 'personal', 'master', 'automation'],
    async run(input, ctx) {
      const title = String(input.title ?? '').trim();
      if (!title) return { ok: false, mode: 'live', summary: 'A task needs a title.', error: 'missing title' };
      const task = await ctx.services.business.addTask(title, input.due ? String(input.due) : undefined, input.owner ? String(input.owner) : undefined);
      return { ok: true, mode: 'live', summary: `Task added: ${task.title}.`, data: { task } };
    },
  },
  {
    id: 'business.completeTask',
    name: 'Complete a task',
    description: 'Marks a task done, matched by id or by part of its title.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'low',
    parameters: [
      { name: 'id', type: 'string', description: 'Task id.', required: false },
      { name: 'title', type: 'string', description: 'Or part of the task title.', required: false },
    ],
    owners: ['business', 'personal', 'master'],
    async run(input, ctx) {
      const id = input.id ? String(input.id) : '';
      const title = input.title ? String(input.title) : '';
      if (!id && !title) return { ok: false, mode: 'live', summary: 'Which task should I complete?', error: 'missing selector' };
      const done = await ctx.services.business.completeTask(id, title || undefined);
      return {
        ok: done,
        mode: 'live',
        summary: done ? `Completed "${title || id}".` : `No open task matched "${title || id}".`,
      };
    },
  },
  {
    id: 'business.recordInquiry',
    name: 'Record a customer inquiry',
    description: 'Logs an incoming inquiry as a lead and creates a follow-up task — the core of the inquiry automation.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'low',
    parameters: [
      { name: 'name', type: 'string', description: 'Who is asking.', required: true },
      { name: 'channel', type: 'string', description: 'whatsapp | facebook | instagram | email | web | phone | other', required: true, enum: ['whatsapp', 'facebook', 'instagram', 'email', 'web', 'phone', 'other'] },
      { name: 'message', type: 'string', description: 'What they asked.', required: true },
    ],
    owners: ['business', 'messaging', 'social', 'mail', 'master', 'automation'],
    async run(input, ctx) {
      const name = String(input.name ?? '').trim();
      const message = String(input.message ?? '').trim();
      if (!name) return { ok: false, mode: 'live', summary: 'I need to know who the inquiry is from.', error: 'missing name' };
      const channel = String(input.channel ?? 'other') as any;
      const { lead, task } = await ctx.services.business.recordInquiry({ name, channel, message });
      return {
        ok: true,
        mode: 'live',
        summary: `Recorded inquiry from ${name} (${channel}); follow-up task created.`,
        data: { lead, task },
      };
    },
  },
  {
    id: 'business.expireStaleLeads',
    name: 'Sweep stale leads',
    description: 'Marks leads with no activity for a number of days as stale so they surface for follow-up.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'low',
    parameters: [{ name: 'days', type: 'number', description: 'Inactivity threshold (default 14).', required: false }],
    owners: ['business', 'automation', 'master'],
    async run(input, ctx) {
      const days = Number(input.days ?? 14);
      const changed = await ctx.services.business.expireStaleLeads(days);
      return {
        ok: true,
        mode: 'live',
        summary: changed ? `Marked ${changed} lead(s) as stale after ${days} days of silence.` : `No leads have been quiet for ${days} days.`,
        data: { changed },
      };
    },
  },
  {
    id: 'business.importCsv',
    name: 'Import business data from CSV',
    description:
      'Imports products, customers or leads from CSV text. Expected header row: type,name,price,stage,value,note,tags.',
    category: 'business',
    scopes: ['business:write'],
    risk: 'medium',
    parameters: [{ name: 'csv', type: 'string', description: 'CSV content with a header row.', required: true }],
    owners: ['business', 'master'],
    async run(input, ctx) {
      const csv = String(input.csv ?? '').trim();
      if (!csv) return { ok: false, mode: 'live', summary: 'Paste some CSV first.', error: 'empty csv' };
      const rows = parseCsv(csv);
      if (rows.length < 2) return { ok: false, mode: 'live', summary: 'Need a header row plus at least one data row.', error: 'no data' };
      const header = rows[0]!.map((cell) => cell.trim().toLowerCase());
      const imported = { products: 0, customers: 0, leads: 0, skipped: 0 };

      for (const row of rows.slice(1)) {
        const record: Record<string, string> = {};
        header.forEach((key, index) => {
          record[key] = (row[index] ?? '').trim();
        });
        const type = (record.type ?? 'product').toLowerCase();
        const name = record.name ?? record.title ?? '';
        if (!name) {
          imported.skipped += 1;
          continue;
        }
        if (type.startsWith('prod')) {
          await ctx.services.business.patch((snapshot) => {
            snapshot.products.push({
              id: `prod_${snapshot.products.length + 1}_${Math.random().toString(36).slice(2, 7)}`,
              name,
              price: Number(record.price ?? 0) || 0,
              tags: (record.tags ?? '').split(',').map((tag) => tag.trim()).filter(Boolean),
              blurb: record.note ?? record.description ?? '',
            });
          });
          imported.products += 1;
        } else if (type.startsWith('cust')) {
          await ctx.services.business.patch((snapshot) => {
            snapshot.customers.push({
              id: `cust_${snapshot.customers.length + 1}_${Math.random().toString(36).slice(2, 7)}`,
              name,
              since: new Date().toISOString(),
              lifetimeValue: Number(record.value ?? 0) || 0,
            });
          });
          imported.customers += 1;
        } else if (type.startsWith('lead') || type.startsWith('inquir')) {
          await ctx.services.business.addLead(name, {
            stage: record.stage || 'new',
            value: Number(record.value ?? 0) || 0,
            note: record.note,
          });
          imported.leads += 1;
        } else {
          imported.skipped += 1;
        }
      }

      return {
        ok: true,
        mode: 'live',
        summary: `Imported ${imported.products} product(s), ${imported.customers} customer(s), ${imported.leads} lead(s)${imported.skipped ? `; skipped ${imported.skipped} row(s)` : ''}.`,
        data: { imported },
      };
    },
  },
];

/** Tolerant CSV parser (handles quoted fields and embedded commas). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.some((cell) => cell.trim() !== ''));
}
