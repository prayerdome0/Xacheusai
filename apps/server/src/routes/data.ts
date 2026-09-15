/**
 * Data routes: memory, knowledge, documents, business, calendar, notifications
 * and automations. These are what the Control Center screens read and write.
 */
import { createReadStream } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import type { Automation, KnowledgeDocument, MemoryKind, MemoryRecord, Notification } from '@xacheus/core';
import { parseWhen, starterAutomations, type Kernel } from '@xacheus/core';
import { principalOf } from '../guard.js';

const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

export function registerDataRoutes(app: FastifyInstance, kernel: Kernel): void {
  const { services } = kernel;

  /** ------------------------------------------------------------------ memory */
  app.get('/api/memory', async (request) => {
    const query = (request.query ?? {}) as { kind?: string; includeDeleted?: string };
    const records = await services.memory.list({
      kinds: query.kind ? [query.kind as MemoryKind] : undefined,
      includeDeleted: query.includeDeleted === 'true',
    });
    return { records, counts: await services.memory.counts() };
  });

  app.post('/api/memory', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<MemoryRecord> & { value?: string };
    if (!body.value) return reply.code(400).send({ error: 'missing_value' });
    const record = await services.memory.remember({
      kind: (body.kind as MemoryKind) ?? 'long-term',
      key: body.key,
      value: body.value,
      tags: body.tags,
      pinned: body.pinned,
      source: 'control-center',
    });
    return reply.send({ record });
  });

  app.patch('/api/memory/:id', async (request, reply) => {
    const record = await services.memory.update((request.params as { id: string }).id, (request.body ?? {}) as Partial<MemoryRecord>);
    if (!record) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ record });
  });

  app.delete('/api/memory/:id', async (request) => {
    const hard = ((request.query ?? {}) as { hard?: string }).hard === 'true';
    return { removed: await services.memory.forget((request.params as { id: string }).id, hard) };
  });

  /** --------------------------------------------------------------- knowledge */
  app.get('/api/knowledge', async (request) => {
    const query = (request.query ?? {}) as { collection?: string; includeDeleted?: string };
    return {
      documents: await services.knowledge.listDocuments({
        collection: query.collection,
        includeDeleted: query.includeDeleted === 'true',
      }),
      stats: await services.knowledge.stats(),
    };
  });

  app.get('/api/knowledge/search', async (request) => {
    const query = (request.query ?? {}) as { q?: string; limit?: string };
    if (!query.q) return { hits: [] };
    return { hits: await services.knowledge.search(query.q, { limit: Number(query.limit ?? 8) }) };
  });

  app.post('/api/knowledge/text', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; text?: string; tags?: string[]; collection?: string };
    if (!body.title || !body.text) return reply.code(400).send({ error: 'title_and_text_required' });
    const result = await services.documents.ingestText({
      title: body.title,
      text: body.text,
      source: 'control-center',
      tags: body.tags,
      collection: body.collection ?? 'general',
    });
    return reply.send(result);
  });

  app.delete('/api/knowledge/:id', async (request) => {
    const hard = ((request.query ?? {}) as { hard?: string }).hard === 'true';
    return { removed: await services.knowledge.deleteDocument((request.params as { id: string }).id, hard) };
  });

  /** -------------------------------------------------------------- documents */
  app.post('/api/documents', async (request, reply) => {
    const file = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    if (!file) return reply.code(400).send({ error: 'no_file', message: 'Upload a file as multipart/form-data field "file".' });

    const buffer = await file.toBuffer();
    if (file.file.truncated) {
      return reply.code(413).send({ error: 'file_too_large', message: `Files must be under ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.` });
    }

    const fields = file.fields as Record<string, { value?: string } | undefined>;
    const result = await services.documents.ingest({
      filename: file.filename,
      mimeType: file.mimetype,
      data: buffer,
      title: fields.title?.value,
      tags: fields.tags?.value ? fields.tags.value.split(',').map((tag) => tag.trim()).filter(Boolean) : undefined,
      collection: fields.collection?.value ?? 'general',
    });

    return reply.send({
      document: result.document,
      attachment: result.attachment,
      extraction: result.extraction,
      learned: result.learned,
    });
  });

  /** Serve locally stored files when Cloudinary is not configured. */
  app.get('/api/files/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const found = await services.documents.readLocalFile(id);
    if (!found) return reply.code(404).send({ error: 'not_found', message: 'No local file with that id.' });
    reply.header('content-type', found.record.mimeType || 'application/octet-stream');
    reply.header('content-disposition', `inline; filename="${found.record.name.replace(/"/g, '')}"`);
    return reply.send(createReadStream(found.path));
  });

  /** --------------------------------------------------------------- business */
  app.get('/api/business', async () => ({ snapshot: await services.business.get() }));

  app.patch('/api/business/company', async (request) => {
    const body = (request.body ?? {}) as Record<string, string>;
    return { company: (await services.business.updateCompany(body)).company };
  });

  app.get('/api/business/brief', async () => services.business.todayBrief());

  app.post('/api/business/tasks', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; due?: string; owner?: string };
    if (!body.title) return reply.code(400).send({ error: 'title_required' });
    return { task: await services.business.addTask(body.title, body.due, body.owner) };
  });

  /** Sub-resource views for the console: leads, tasks, products, customers. */
  app.get('/api/business/leads', async (request) => {
    const query = (request.query ?? {}) as { stage?: string };
    const snapshot = await services.business.get();
    const leads = query.stage ? snapshot.leads.filter((lead) => lead.stage === query.stage) : snapshot.leads;
    return { leads, stages: [...new Set(snapshot.leads.map((lead) => lead.stage))] };
  });

  app.get('/api/business/tasks', async (request) => {
    const query = (request.query ?? {}) as { open?: string };
    const snapshot = await services.business.get();
    const tasks = query.open === 'true' ? snapshot.tasks.filter((task) => !task.done) : snapshot.tasks;
    return { tasks, open: snapshot.tasks.filter((task) => !task.done).length };
  });

  app.get('/api/business/products', async () => {
    const snapshot = await services.business.get();
    return { products: snapshot.products, customers: snapshot.customers };
  });

  app.get('/api/business/expenses', async () => {
    const snapshot = await services.business.get();
    return {
      expenses: snapshot.expensesThisMonth,
      total: snapshot.expensesThisMonth.reduce((sum, entry) => sum + entry.amount, 0),
      salesToday: snapshot.salesToday,
      salesThisMonth: snapshot.salesThisMonth,
      currency: snapshot.company.currency,
    };
  });

  app.post('/api/business/leads', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; value?: number; stage?: string; note?: string };
    if (!body.name) return reply.code(400).send({ error: 'name_required' });
    return { lead: await services.business.addLead(body.name, body) };
  });

  /**
   * Inbound inquiry webhook: forms, landing pages, or your own systems post here
   * and the automation engine reacts (draft a reply, record the lead, notify you).
   */
  app.post('/api/business/inquiry', async (request, reply) => {
    const body = (request.body ?? {}) as { name?: string; message?: string; channel?: string };
    if (!body.name || !body.message) return reply.code(400).send({ error: 'name_and_message_required' });
    const channel = (body.channel ?? 'web') as 'whatsapp' | 'facebook' | 'instagram' | 'email' | 'web' | 'phone' | 'other';
    const principal = principalOf(request);
    const record = await services.business.recordInquiry({ name: body.name, channel, message: body.message });
    services.events.emit('inquiry.received', {
      name: body.name,
      channel,
      message: body.message,
      leadId: record.lead.id,
      taskId: record.task.id,
    });
    if (principal.role === 'owner') {
      await services.notifications.create({
        title: `New ${channel} inquiry from ${body.name}`,
        body: body.message.slice(0, 200),
        level: 'info',
        source: 'inquiry',
      });
    }
    return reply.send({ recorded: true, ...record });
  });

  /** --------------------------------------------------------------- calendar */
  app.get('/api/calendar', async (request) => {
    const query = (request.query ?? {}) as { days?: string };
    const days = Number(query.days ?? 7) || 7;
    return { events: await services.calendar.upcoming(days) };
  });

  app.post('/api/calendar', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; when?: string; start?: string; durationMinutes?: number; kind?: 'event' | 'reminder'; location?: string; notes?: string; mirrorToPhone?: boolean };
    if (!body.title) return reply.code(400).send({ error: 'title_required' });
    const start = body.start ?? (body.when ? parseWhen(body.when) : null);
    if (!start) {
      return reply.code(400).send({ error: 'unparsed_time', message: `Could not understand the time "${body.when ?? ''}".` });
    }
    const event = await services.calendar.create({
      title: body.title,
      start,
      end: new Date(Date.parse(start) + (body.durationMinutes ?? 60) * 60_000).toISOString(),
      kind: body.kind ?? 'event',
      location: body.location,
      notes: body.notes,
    });
    let mirrored = false;
    if (body.mirrorToPhone !== false && services.devices.isConnected()) {
      const result = await services.devices.command('device.createCalendarEvent', { title: event.title, when: event.start, notes: event.notes });
      mirrored = result.ok && result.mode === 'live';
      await services.calendar.update(event.id, { mirroredToDevice: mirrored });
    }
    return reply.send({ event, mirroredToPhone: mirrored });
  });

  app.delete('/api/calendar/:id', async (request) => ({ removed: await services.calendar.remove((request.params as { id: string }).id) }));

  /** ---------------------------------------------------------- notifications */
  app.get('/api/notifications', async (request) => {
    const query = (request.query ?? {}) as { limit?: string; unread?: string };
    const notifications = await services.notifications.list({
      limit: Number(query.limit ?? 50),
      unreadOnly: query.unread === 'true',
    });
    return { notifications, unread: await services.notifications.unreadCount() };
  });

  app.post('/api/notifications/read', async (request) => {
    const body = (request.body ?? {}) as { id?: string; all?: boolean };
    if (body.id) await services.notifications.markRead(body.id);
    else await services.notifications.markRead();
    return { ok: true, unread: await services.notifications.unreadCount() };
  });

  app.post('/api/notifications', async (request, reply) => {
    const body = (request.body ?? {}) as { title?: string; body?: string; level?: Notification['level'] };
    if (!body.title) return reply.code(400).send({ error: 'title_required' });
    return {
      notification: await services.notifications.create({
        title: body.title,
        body: body.body ?? '',
        level: body.level ?? 'info',
        source: 'control-center',
      }),
    };
  });

  /** -------------------------------------------------------------- automations */
  app.get('/api/automations', async () => ({
    automations: await services.automations.list(),
    starters: starterAutomations(),
    runs: await services.automations.history(30),
  }));

  app.post('/api/automations', async (request, reply) => {
    const body = (request.body ?? {}) as Partial<Automation> & { name?: string; trigger?: Automation['trigger']; actions?: Automation['actions'] };
    if (!body.name || !body.trigger || !body.actions?.length) {
      return reply.code(400).send({ error: 'name_trigger_actions_required' });
    }
    const unknown = body.actions.map((action) => action.tool).filter((tool) => !services.tools.has(tool));
    if (unknown.length) {
      return reply.code(400).send({
        error: 'unknown_tools',
        message: `These tools do not exist: ${unknown.join(', ')}. GET /api/tools for the catalogue.`,
      });
    }
    const automation = await services.automations.create({
      name: body.name,
      description: body.description,
      trigger: body.trigger,
      condition: body.condition,
      actions: body.actions,
      notify: body.notify,
      enabled: body.enabled,
    });
    return reply.send({ automation });
  });

  /** The starter templates Xacheus ships with, for the console to offer. */
  app.get('/api/automations/starters', async () => ({
    starters: starterAutomations().map((starter, index) => ({ index, ...starter })),
  }));

  /** Install one of the starters by index or name. */
  app.post('/api/automations/starters', async (request, reply) => {
    const body = (request.body ?? {}) as { index?: number; name?: string };
    const starters = starterAutomations();
    const starter = body.index !== undefined ? starters[body.index] : starters.find((entry) => entry.name.includes(body.name ?? ''));
    if (!starter) return reply.code(404).send({ error: 'starter_not_found', message: `Indexes 0-${starters.length - 1} are available.` });
    const automation = await services.automations.create(starter);
    return reply.send({ automation });
  });

  app.patch('/api/automations/:id', async (request, reply) => {
    const automation = await services.automations.update((request.params as { id: string }).id, (request.body ?? {}) as Partial<Automation>);
    if (!automation) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ automation });
  });

  app.delete('/api/automations/:id', async (request) => ({
    removed: await services.automations.remove((request.params as { id: string }).id),
  }));

  app.post('/api/automations/:id/run', async (request, reply) => {
    const automation = await services.automations.get((request.params as { id: string }).id);
    if (!automation) return reply.code(404).send({ error: 'not_found' });
    return reply.send({ run: await services.automations.run(automation, 'manual') });
  });

  /** Recent runs for one automation, newest first. */
  app.get('/api/automations/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    const query = (request.query ?? {}) as { limit?: string };
    const limit = Number(query.limit ?? 25);
    const runs = (await services.automations.history(200)).filter((run) => run.automationId === id);
    return { runs: runs.slice(0, Number.isFinite(limit) ? limit : 25) };
  });
}

export type { KnowledgeDocument };
