/**
 * Business data service.
 *
 * The Business Agent needs real numbers to be useful, but a private system has
 * to work before a CRM is connected. This service keeps a single, consistent
 * business snapshot in storage, seeds a realistic starting point, and offers the
 * mutations the agents (and the console) actually perform.
 *
 * Swap in a real ERP/CRM later by implementing `BusinessProvider` — the agents
 * only depend on `BusinessSnapshot`.
 */
import type { BusinessSnapshot } from '../types.js';
import type { StorageDriver } from '../storage/driver.js';
import { dayKey, newId, nowIso } from '../util.js';

const COLLECTION = 'business';
const SNAPSHOT_ID = 'snapshot';

export interface Inquiry {
  name: string;
  channel: 'whatsapp' | 'facebook' | 'instagram' | 'email' | 'web' | 'phone' | 'other';
  message: string;
}

export class BusinessService {
  private cache?: BusinessSnapshot;

  constructor(private readonly storage: StorageDriver) {}

  async get(): Promise<BusinessSnapshot> {
    if (this.cache) return this.cache;
    const stored = await this.storage.get<BusinessSnapshot>(COLLECTION, SNAPSHOT_ID);
    if (stored) {
      this.cache = stored;
      return stored;
    }
    const seeded = seedSnapshot();
    await this.storage.set(COLLECTION, { ...seeded, id: SNAPSHOT_ID });
    this.cache = seeded;
    return seeded;
  }

  async save(next: BusinessSnapshot): Promise<BusinessSnapshot> {
    this.cache = next;
    await this.storage.set(COLLECTION, { ...next, id: SNAPSHOT_ID });
    return next;
  }

  async patch(mutate: (snapshot: BusinessSnapshot) => void): Promise<BusinessSnapshot> {
    const snapshot = structuredClone(await this.get());
    mutate(snapshot);
    return this.save(snapshot);
  }

  async updateCompany(patch: Partial<BusinessSnapshot['company']>): Promise<BusinessSnapshot> {
    return this.patch((snapshot) => {
      snapshot.company = { ...snapshot.company, ...patch };
    });
  }

  async addTask(title: string, due?: string, owner?: string): Promise<BusinessSnapshot['tasks'][number]> {
    const task = { id: newId('task'), title, due, done: false, owner };
    await this.patch((snapshot) => {
      snapshot.tasks.unshift(task);
    });
    return task;
  }

  async completeTask(id: string, titleHint?: string): Promise<boolean> {
    let done = false;
    await this.patch((snapshot) => {
      const task = titleHint
        ? snapshot.tasks.find((t) => !t.done && t.title.toLowerCase().includes(titleHint.toLowerCase()))
        : snapshot.tasks.find((t) => t.id === id || t.id === `task_${id}`);
      if (task) {
        task.done = true;
        done = true;
      }
    });
    return done;
  }

  async addLead(
    name: string,
    options: { stage?: string; value?: number; note?: string; channel?: string } = {},
  ): Promise<BusinessSnapshot['leads'][number]> {
    const lead = {
      id: newId('lead'),
      name,
      stage: options.stage ?? 'new',
      value: options.value ?? 0,
      updatedAt: nowIso(),
      note: options.note ?? (options.channel ? `via ${options.channel}` : undefined),
    };
    await this.patch((snapshot) => {
      snapshot.leads.unshift(lead);
    });
    return lead;
  }

  /** Record an inquiry as a lead plus a follow-up task — the automation default. */
  async recordInquiry(inquiry: Inquiry): Promise<{ lead: BusinessSnapshot['leads'][number]; task: BusinessSnapshot['tasks'][number] }> {
    const lead = await this.addLead(inquiry.name, {
      stage: 'inquiry',
      channel: inquiry.channel,
      note: inquiry.message.slice(0, 200),
    });
    const task = await this.addTask(`Follow up with ${inquiry.name} (${inquiry.channel})`, nowIso());
    return { lead, task };
  }

  async expireStaleLeads(days = 14): Promise<number> {
    let changed = 0;
    await this.patch((snapshot) => {
      const cutoff = Date.now() - days * 86_400_000;
      for (const lead of snapshot.leads) {
        if (Date.parse(lead.updatedAt) < cutoff && !['won', 'lost', 'inquiry'].includes(lead.stage)) {
          lead.stage = 'stale';
          lead.updatedAt = nowIso();
          changed += 1;
        }
      }
    });
    return changed;
  }

  /** Deterministic, honest "what matters today" brief — no LLM required. */
  async todayBrief(): Promise<{ text: string; priorities: BusinessSnapshot['priorities'] }> {
    const snapshot = await this.get();
    const today = dayKey();
    const openTasks = snapshot.tasks.filter((task) => !task.done);
    const hotLeads = snapshot.leads.filter((lead) => ['new', 'inquiry', 'negotiation'].includes(lead.stage));
    const staleDeals = snapshot.leads.filter((lead) => lead.stage === 'stale');
    const expenses = snapshot.expensesThisMonth.reduce((sum, item) => sum + item.amount, 0);
    const margin = snapshot.salesThisMonth.revenue - expenses;

    const lines: string[] = [];
    lines.push(`${snapshot.company.name} — brief for ${today}`);
    lines.push(
      `Sales today: ${snapshot.company.currency} ${snapshot.salesToday.revenue.toFixed(2)} across ${snapshot.salesToday.orders} order(s).`,
    );
    lines.push(
      `Month to date: ${snapshot.company.currency} ${snapshot.salesThisMonth.revenue.toFixed(2)} revenue, ${snapshot.company.currency} ${expenses.toFixed(2)} expenses, net ${snapshot.company.currency} ${margin.toFixed(2)}.`,
    );
    if (hotLeads.length) {
      lines.push(
        `Active pipeline (${hotLeads.length}): ${hotLeads
          .slice(0, 5)
          .map((lead) => `${lead.name} — ${lead.stage} — ${snapshot.company.currency} ${lead.value.toFixed(2)}`)
          .join('; ')}.`,
      );
    }
    if (openTasks.length) {
      lines.push(
        `Open tasks (${openTasks.length}): ${openTasks
          .slice(0, 5)
          .map((task) => task.title)
          .join('; ')}.`,
      );
    }
    if (staleDeals.length) {
      lines.push(`${staleDeals.length} lead(s) have gone quiet and need a nudge — ask me to review stale leads.`);
    }

    const priorities: BusinessSnapshot['priorities'] = [];
    if (hotLeads.length) {
      priorities.push({
        title: `Work the pipeline: ${hotLeads[0]!.name}`,
        detail: `${hotLeads.length} active lead(s); largest is worth ${snapshot.company.currency} ${Math.max(...hotLeads.map((l) => l.value)).toFixed(2)}.`,
        weight: 'high',
        source: 'pipeline',
      });
    }
    if (openTasks.length) {
      priorities.push({
        title: `Clear ${openTasks.length} open task(s)`,
        detail: openTasks[0]!.title,
        weight: 'medium',
        source: 'tasks',
      });
    }
    if (margin < 0) {
      priorities.push({
        title: 'Margin is negative this month',
        detail: `Revenue ${snapshot.company.currency} ${snapshot.salesThisMonth.revenue.toFixed(2)} vs expenses ${snapshot.company.currency} ${expenses.toFixed(2)}.`,
        weight: 'high',
        source: 'finance',
      });
    }

    return { text: lines.join('\n'), priorities: [...priorities, ...snapshot.priorities] };
  }

  async summaryForPrompt(): Promise<string> {
    const snapshot = await this.get();
    const openTasks = snapshot.tasks.filter((task) => !task.done).length;
    const hotLeads = snapshot.leads.filter((lead) => ['new', 'inquiry', 'negotiation'].includes(lead.stage));
    return [
      `Company: ${snapshot.company.name} (${snapshot.company.industry}), currency ${snapshot.company.currency}.`,
      `Products: ${snapshot.products.map((product) => `${product.name} @ ${snapshot.company.currency} ${product.price}`).join(', ')}.`,
      `Pipeline: ${hotLeads.length} active lead(s) worth ${snapshot.company.currency} ${hotLeads.reduce((sum, lead) => sum + lead.value, 0).toFixed(2)}.`,
      `Open tasks: ${openTasks}.`,
      `Sales month-to-date: ${snapshot.company.currency} ${snapshot.salesThisMonth.revenue.toFixed(2)}.`,
      `Customers: ${snapshot.customers.length}.`,
    ].join('\n');
  }
}

/** A believable starting point so the platform is demonstrably useful on day one. */
function seedSnapshot(): BusinessSnapshot {
  const today = nowIso();
  return {
    company: { name: 'Your Company', industry: 'Retail & Services', currency: 'USD' },
    priorities: [
      { title: 'Review overnight WhatsApp inquiries', detail: 'Unanswered inquiries age badly — clear them first.', weight: 'high', source: 'default' },
      { title: 'Approve today\'s social content', detail: 'Nothing publishes without your approval.', weight: 'medium', source: 'default' },
    ],
    leads: [
      { id: 'lead_seed_1', name: 'Sample prospect — Acme Ltd', stage: 'inquiry', value: 1200, updatedAt: today, note: 'Asked about bulk pricing.' },
      { id: 'lead_seed_2', name: 'Sample prospect — Delta Traders', stage: 'negotiation', value: 3400, updatedAt: today, note: 'Requested a revised quote.' },
    ],
    salesToday: { orders: 0, revenue: 0 },
    salesThisMonth: { orders: 0, revenue: 0 },
    expensesThisMonth: [{ label: 'Seed data placeholder — connect your accounting', amount: 0 }],
    tasks: [
      { id: 'task_seed_1', title: 'Add your real products in the Control Center', done: false },
      { id: 'task_seed_2', title: 'Connect WhatsApp Business or the sandbox will simulate it', done: false },
    ],
    products: [
      { id: 'prod_seed_1', name: 'Example product', price: 49.99, tags: ['example', 'seed'], blurb: 'Replace me with your real catalogue.' },
    ],
    customers: [
      { id: 'cust_seed_1', name: 'Example customer', since: today, lifetimeValue: 0 },
    ],
  };
}
