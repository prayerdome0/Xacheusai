/**
 * Memory and knowledge tools — the parts of Xacheus that make it *yours*.
 *
 * Every write records where the fact came from, so the Control Center can show
 * provenance and you can correct or forget anything.
 */
import type { MemoryKind } from '../types.js';
import type { Tool } from './types.js';
import { extractFact } from '../memory/memory.js';

const KINDS: MemoryKind[] = ['conversation', 'long-term', 'company', 'task', 'knowledge'];

export const memoryTools: Tool[] = [
  {
    id: 'memory.remember',
    name: 'Remember something',
    description:
      'Stores a durable fact about you, your company or your preferences. Use for things the owner explicitly wants retained.',
    category: 'memory',
    scopes: ['memory:write'],
    risk: 'low',
    parameters: [
      { name: 'value', type: 'string', description: 'The fact to remember, written plainly.', required: true, example: 'Preferred tone is friendly and concise' },
      { name: 'key', type: 'string', description: 'Short lookup key, e.g. preferred_tone.', required: false },
      { name: 'kind', type: 'string', description: 'long-term | company | task | knowledge', required: false, enum: KINDS },
      { name: 'tags', type: 'array', description: 'Tags for retrieval.', required: false },
      { name: 'pinned', type: 'boolean', description: 'Always include this in context.', required: false },
    ],
    owners: ['*'],
    async run(input, ctx) {
      const value = String(input.value ?? '').trim();
      if (!value) return { ok: false, mode: 'live', summary: 'Nothing to remember — the value was empty.', error: 'empty value' };
      const extracted = extractFact(value);
      const kind = (input.kind as MemoryKind) ?? 'long-term';
      const record = await ctx.services.memory.remember({
        kind: KINDS.includes(kind) ? kind : 'long-term',
        key: input.key ? String(input.key) : extracted.key,
        value: extracted.value,
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        pinned: input.pinned === true,
        source: 'owner',
      });
      ctx.services.events.emit('memory.updated', { id: record.id, kind: record.kind, key: record.key });
      return {
        ok: true,
        mode: 'live',
        summary: `Remembered (${record.kind}) "${record.key}": ${record.value}`,
        data: { memory: record },
      };
    },
  },
  {
    id: 'memory.recall',
    name: 'Recall memories',
    description: 'Searches stored memories for anything relevant to a topic.',
    category: 'memory',
    scopes: ['memory:read'],
    risk: 'low',
    parameters: [
      { name: 'query', type: 'string', description: 'What to look for.', required: true },
      { name: 'limit', type: 'number', description: 'Max results (default 8).', required: false },
    ],
    owners: ['*'],
    async run(input, ctx) {
      const query = String(input.query ?? '').trim();
      const hits = await ctx.services.memory.recall(query, { limit: Number(input.limit ?? 8) });
      return {
        ok: true,
        mode: 'live',
        summary: hits.length
          ? `Found ${hits.length} relevant memory item(s).`
          : `Nothing stored yet about "${query}".`,
        data: { hits },
      };
    },
  },
  {
    id: 'memory.list',
    name: 'List memories',
    description: 'Lists what Xacheus currently remembers, optionally filtered by kind.',
    category: 'memory',
    scopes: ['memory:read'],
    risk: 'low',
    parameters: [{ name: 'kind', type: 'string', description: 'Filter by memory kind.', required: false, enum: KINDS }],
    owners: ['*'],
    async run(input, ctx) {
      const kind = input.kind as MemoryKind | undefined;
      const records = await ctx.services.memory.list({ kinds: kind ? [kind] : undefined });
      return {
        ok: true,
        mode: 'live',
        summary: `${records.length} memory item(s)${kind ? ` of kind ${kind}` : ''}.`,
        data: { records },
      };
    },
  },
  {
    id: 'memory.forget',
    name: 'Forget something',
    description: 'Removes a memory item by id or by matching its text. Soft-deletes by default so it can be recovered.',
    category: 'memory',
    scopes: ['memory:write'],
    risk: 'medium',
    parameters: [
      { name: 'id', type: 'string', description: 'Memory id to remove.', required: false },
      { name: 'query', type: 'string', description: 'Or match by text.', required: false },
      { name: 'hard', type: 'boolean', description: 'Permanently delete instead of soft-delete.', required: false },
    ],
    owners: ['*'],
    async run(input, ctx) {
      const hard = input.hard === true;
      if (input.id) {
        const removed = await ctx.services.memory.forget(String(input.id), hard);
        return {
          ok: removed,
          mode: 'live',
          summary: removed ? `Memory ${input.id} ${hard ? 'permanently deleted' : 'forgotten'}.` : `No memory with id ${input.id}.`,
        };
      }
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, mode: 'live', summary: 'Provide an id or a query to forget.', error: 'missing selector' };
      const hits = await ctx.services.memory.recall(query, { limit: 5 });
      if (!hits.length) return { ok: false, mode: 'live', summary: `Nothing matched "${query}".`, error: 'no match' };
      for (const hit of hits) await ctx.services.memory.forget(hit.id, hard);
      ctx.services.events.emit('memory.updated', { count: hits.length, action: 'forget' });
      return {
        ok: true,
        mode: 'live',
        summary: `Forgot ${hits.length} item(s) matching "${query}": ${hits.map((hit) => hit.key).join(', ')}.`,
        data: { forgotten: hits.map((hit) => ({ id: hit.id, key: hit.key })) },
      };
    },
  },
  {
    id: 'knowledge.search',
    name: 'Search your documents',
    description: 'Searches the knowledge index built from your uploaded files, notes and researched pages.',
    category: 'knowledge',
    scopes: ['knowledge:read'],
    risk: 'low',
    parameters: [
      { name: 'query', type: 'string', description: 'What to look for.', required: true },
      { name: 'limit', type: 'number', description: 'Max passages (default 6).', required: false },
      { name: 'collection', type: 'string', description: 'Restrict to a collection.', required: false },
    ],
    owners: ['*'],
    async run(input, ctx) {
      const query = String(input.query ?? '').trim();
      const hits = await ctx.services.knowledge.search(query, {
        limit: Number(input.limit ?? 6),
        collection: input.collection ? String(input.collection) : undefined,
      });
      return {
        ok: true,
        mode: 'live',
        summary: hits.length
          ? `Found ${hits.length} relevant passage(s) across your documents.`
          : 'Nothing in the knowledge index matched that yet.',
        data: { hits },
      };
    },
  },
  {
    id: 'knowledge.ingestText',
    name: 'Add text to the knowledge base',
    description: 'Files a piece of text (a note, a researched page, a policy you typed) into the searchable knowledge index.',
    category: 'knowledge',
    scopes: ['knowledge:write'],
    risk: 'low',
    parameters: [
      { name: 'title', type: 'string', description: 'Title for the entry.', required: true },
      { name: 'text', type: 'string', description: 'The content to index.', required: true },
      { name: 'tags', type: 'array', description: 'Tags.', required: false },
      { name: 'collection', type: 'string', description: 'Collection, e.g. notes, research, policy.', required: false },
    ],
    owners: ['knowledge', 'research', 'personal', 'master'],
    async run(input, ctx) {
      const title = String(input.title ?? '').trim();
      const text = String(input.text ?? '').trim();
      if (!title || !text) {
        return { ok: false, mode: 'live', summary: 'Both a title and text are required.', error: 'incomplete input' };
      }
      const result = await ctx.services.documents.ingestText({
        title,
        text,
        source: 'agent',
        tags: Array.isArray(input.tags) ? (input.tags as string[]) : undefined,
        collection: input.collection ? String(input.collection) : 'notes',
      });
      return {
        ok: true,
        mode: 'live',
        summary: `Indexed "${title}" (${result.document.chunkCount} chunk(s))${result.learned.length ? `, learned ${result.learned.length} company fact(s)` : ''}.`,
        data: result,
      };
    },
  },
  {
    id: 'knowledge.stats',
    name: 'Knowledge base overview',
    description: 'Reports how many documents and passages are indexed, plus the collections in use.',
    category: 'knowledge',
    scopes: ['knowledge:read'],
    risk: 'low',
    parameters: [],
    owners: ['*'],
    async run(_input, ctx) {
      const stats = await ctx.services.knowledge.stats();
      const memoryCounts = await ctx.services.memory.counts();
      return {
        ok: true,
        mode: 'live',
        summary: `${stats.documents} document(s), ${stats.chunks} indexed passage(s), ${Object.keys(stats.collections).length || stats.collections.length} collection(s).`,
        data: { knowledge: stats, memory: memoryCounts },
      };
    },
  },
  {
    id: 'knowledge.list',
    name: 'List indexed documents',
    description: 'Lists documents in the knowledge base with their titles, tags and sizes.',
    category: 'knowledge',
    scopes: ['knowledge:read'],
    risk: 'low',
    parameters: [{ name: 'collection', type: 'string', description: 'Filter by collection.', required: false }],
    owners: ['knowledge', 'business', 'master'],
    async run(input, ctx) {
      const documents = await ctx.services.knowledge.listDocuments({
        collection: input.collection ? String(input.collection) : undefined,
      });
      return {
        ok: true,
        mode: 'live',
        summary: `${documents.length} document(s) in the knowledge base.`,
        data: { documents },
      };
    },
  },
  {
    id: 'knowledge.delete',
    name: 'Remove a document',
    description: 'Removes a document from the knowledge index (soft delete unless hard=true).',
    category: 'knowledge',
    scopes: ['knowledge:write'],
    risk: 'medium',
    parameters: [
      { name: 'documentId', type: 'string', description: 'Document id.', required: true },
      { name: 'hard', type: 'boolean', description: 'Permanently delete chunks too.', required: false },
    ],
    owners: ['knowledge', 'master'],
    async run(input, ctx) {
      const id = String(input.documentId ?? '');
      const removed = await ctx.services.knowledge.deleteDocument(id, input.hard === true);
      return {
        ok: removed,
        mode: 'live',
        summary: removed ? `Removed document ${id} from the knowledge base.` : `No document with id ${id}.`,
      };
    },
  },
];
