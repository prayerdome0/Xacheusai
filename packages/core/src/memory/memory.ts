/**
 * Memory service.
 *
 * Xacheus separates memory by *why* something is remembered, because each kind
 * has different retention, privacy and retrieval rules:
 *
 *   conversation — the current thread (short-lived, in ConversationStore)
 *   long-term    — things the owner explicitly chose to retain
 *   company      — business facts the agents should always know
 *   task         — what the owner asked Xacheus to accomplish
 *   knowledge    — facts extracted from ingested documents
 *
 * Everything is owner-reviewable: list, search, correct, pin, forget.
 */
import type { ChatMessage, MemoryKind, MemoryRecord } from '../types.js';
import type { StorageDriver } from '../storage/driver.js';
import { newId, nowIso, terms, tryParseJson, dayKey } from '../util.js';

const COLLECTION = 'memory';
const MESSAGES = 'messages';

export interface RememberInput {
  kind: MemoryKind;
  key?: string;
  value: string;
  tags?: string[];
  source?: string;
  confidence?: number;
  pinned?: boolean;
}

export interface RecallOptions {
  kinds?: MemoryKind[];
  limit?: number;
  minScore?: number;
}

export interface RecallHit extends MemoryRecord {
  score: number;
  matched: string[];
}

export class MemoryService {
  constructor(private readonly storage: StorageDriver) {}

  async remember(input: RememberInput): Promise<MemoryRecord> {
    const all = await this.storage.list<MemoryRecord>(COLLECTION);
    const key = (input.key ?? slugKey(input.value)).slice(0, 120);
    const existing = all.find(
      (record) => record.deletedAt === undefined && record.kind === input.kind && record.key === key,
    );
    const timestamp = nowIso();

    const record: MemoryRecord = existing
      ? {
          ...existing,
          value: input.value,
          tags: dedupe([...(existing.tags ?? []), ...(input.tags ?? [])]),
          confidence: input.confidence ?? existing.confidence,
          pinned: input.pinned ?? existing.pinned,
          updatedAt: timestamp,
        }
      : {
          id: newId('mem'),
          kind: input.kind,
          key,
          value: input.value,
          tags: input.tags ?? [],
          source: input.source ?? 'owner',
          confidence: input.confidence ?? 0.9,
          pinned: input.pinned ?? false,
          createdAt: timestamp,
          updatedAt: timestamp,
        };

    await this.storage.set(COLLECTION, record);
    return record;
  }

  async list(options: { kinds?: MemoryKind[]; includeDeleted?: boolean } = {}): Promise<MemoryRecord[]> {
    const all = await this.storage.list<MemoryRecord>(COLLECTION);
    return all
      .filter((record) => (options.includeDeleted ? true : !record.deletedAt))
      .filter((record) => (options.kinds?.length ? options.kinds.includes(record.kind) : true))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.storage.get<MemoryRecord>(COLLECTION, id);
  }

  async update(id: string, patch: Partial<Pick<MemoryRecord, 'value' | 'key' | 'tags' | 'pinned' | 'kind'>>): Promise<MemoryRecord | null> {
    const record = await this.get(id);
    if (!record) return null;
    const next: MemoryRecord = { ...record, ...patch, updatedAt: nowIso() };
    await this.storage.set(COLLECTION, next);
    return next;
  }

  /** Soft delete by default so the owner can recover an accidental forget. */
  async forget(id: string, hard = false): Promise<boolean> {
    if (hard) {
      await this.storage.delete(COLLECTION, id);
      return true;
    }
    const record = await this.get(id);
    if (!record) return false;
    await this.storage.set(COLLECTION, { ...record, deletedAt: nowIso(), updatedAt: nowIso() });
    return true;
  }

  /**
   * Local retrieval: term overlap (tf), tag matches, pinning and recency.
   * No embeddings required, which keeps the whole system runnable offline.
   */
  async recall(query: string, options: RecallOptions = {}): Promise<RecallHit[]> {
    const records = await this.list({ kinds: options.kinds });
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];

    const hits: RecallHit[] = [];
    const now = Date.now();
    for (const record of records) {
      const haystack = terms(`${record.key} ${record.value} ${record.tags.join(' ')} ${record.kind}`);
      const matched = queryTerms.filter((term) => haystack.includes(term));
      if (!matched.length) continue;

      const coverage = matched.length / queryTerms.length;
      const density = matched.length / Math.max(haystack.length, 1);
      const ageDays = (now - Date.parse(record.updatedAt)) / 86_400_000;
      const recency = 1 / (1 + ageDays / 30);
      const score =
        coverage * 0.62 + Math.min(density * 6, 1) * 0.13 + recency * 0.1 + (record.pinned ? 0.15 : 0) + record.confidence * 0.05;

      if (score >= (options.minScore ?? 0.12)) hits.push({ ...record, score, matched });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 8);
  }

  async counts(): Promise<Record<MemoryKind, number>> {
    const all = await this.list();
    const base: Record<MemoryKind, number> = {
      conversation: 0,
      'long-term': 0,
      company: 0,
      task: 0,
      knowledge: 0,
    };
    for (const record of all) base[record.kind] += 1;
    return base;
  }
}

/** ---------------------------------------------------------------- conversations */

export class ConversationStore {
  constructor(
    private readonly storage: StorageDriver,
    private readonly maxPerSession = 400,
  ) {}

  async append(message: Omit<ChatMessage, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<ChatMessage> {
    const record: ChatMessage = {
      id: message.id ?? newId('msg'),
      sessionId: message.sessionId,
      role: message.role,
      text: message.text,
      createdAt: message.createdAt ?? nowIso(),
      runId: message.runId,
      attachments: message.attachments,
      meta: message.meta,
    };
    await this.storage.set(MESSAGES, record);
    const all = await this.messages(message.sessionId);
    if (all.length > this.maxPerSession) {
      const excess = all
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
        .slice(0, all.length - this.maxPerSession);
      for (const stale of excess) await this.storage.delete(MESSAGES, stale.id);
    }
    return record;
  }

  async messages(sessionId: string): Promise<ChatMessage[]> {
    const all = await this.storage.list<ChatMessage>(MESSAGES);
    return all
      .filter((message) => message.sessionId === sessionId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  /** Recent turns as a compact transcript for the model prompt. */
  async transcript(sessionId: string, turns = 12): Promise<string> {
    const messages = await this.messages(sessionId);
    return messages
      .slice(-turns)
      .map((message) => `${message.role === 'owner' ? 'Owner' : 'Xacheus'}: ${message.text}`)
      .join('\n');
  }

  async sessions(): Promise<{ sessionId: string; messages: number; updatedAt: string; preview: string }[]> {
    const all = await this.storage.list<ChatMessage>(MESSAGES);
    const grouped = new Map<string, ChatMessage[]>();
    for (const message of all) {
      const list = grouped.get(message.sessionId) ?? [];
      list.push(message);
      grouped.set(message.sessionId, list);
    }
    return [...grouped.entries()]
      .map(([sessionId, messages]) => {
        const ordered = messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
        return {
          sessionId,
          messages: ordered.length,
          updatedAt: ordered.at(-1)?.createdAt ?? nowIso(),
          preview: ordered.find((m) => m.role === 'owner')?.text.slice(0, 80) ?? '(empty)',
        };
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async clear(sessionId: string): Promise<number> {
    const messages = await this.messages(sessionId);
    for (const message of messages) await this.storage.delete(MESSAGES, message.id);
    return messages.length;
  }
}

/** ---------------------------------------------------------------- helpers */

export function slugKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .slice(0, 6)
    .join('_');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

/**
 * Best-effort structured extraction of memorable facts from a free-text
 * statement ("remember that our tone is friendly"). Used by the memory tool when
 * the caller has no LLM available.
 */
export function extractFact(statement: string): { key: string; value: string } {
  const cleaned = statement.replace(/^(please\s+)?(remember|note|keep in mind)\s+(that\s+)?/i, '').trim();
  return { key: slugKey(cleaned), value: cleaned };
}

/**
 * Parse "key: value" pairs out of a document's text — a cheap way to turn
 * business files into company memory without an LLM.
 */
export function extractKeyValues(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 _-]{2,40})\s*[:=]\s*(.+)$/);
    if (match?.[1] && match[2]) out.push({ key: slugKey(match[1]), value: match[2].trim() });
  }
  return out;
}

/** Used by the business agent to render the "today" brief deterministically. */
export function todayLabel(): string {
  return dayKey();
}

export { tryParseJson };
