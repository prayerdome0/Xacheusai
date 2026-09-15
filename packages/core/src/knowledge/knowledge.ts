/**
 * Knowledge service — documents in, searchable knowledge out.
 *
 * Pipeline:  file/text → chunks → tf-idf index → retrieval
 *
 * Deliberately embedding-free so it runs with zero cloud dependencies, offline,
 * on whatever hardware you have. A vector-store backend can be added later
 * behind `KnowledgeIndex` without touching the agents that call it.
 */
import type { KnowledgeChunk, KnowledgeDocument, KnowledgeHit } from '../types.js';
import type { StorageDriver } from '../storage/driver.js';
import { newId, nowIso, terms } from '../util.js';

const DOCS = 'knowledge_documents';
const CHUNKS = 'knowledge_chunks';
const META = 'knowledge_meta';

interface IndexMeta {
  id: string;
  documentCount: number;
  chunkCount: number;
  /** term -> number of chunks containing it */
  documentFrequency: Record<string, number>;
  updatedAt: string;
}

export interface IngestInput {
  title: string;
  text: string;
  source?: string;
  mimeType?: string;
  bytes?: number;
  url?: string;
  provider?: KnowledgeDocument['provider'];
  tags?: string[];
  collection?: string;
}

export interface SearchOptions {
  limit?: number;
  collection?: string;
  minScore?: number;
}

const CHUNK_TARGET = 1100;
const CHUNK_OVERLAP = 180;

/** Split text on paragraph/sentence boundaries close to the target size. */
export function chunkText(text: string, target = CHUNK_TARGET, overlap = CHUNK_OVERLAP): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
  if (!normalized) return [];
  if (normalized.length <= target) return [normalized];

  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed) chunks.push(trimmed);
  };

  for (const paragraph of paragraphs) {
    if (paragraph.length > target * 1.6) {
      // Long single block: fall back to sentence packing.
      const sentences = paragraph.split(/(?<=[.!?])\s+/);
      for (const sentence of sentences) {
        if ((current + ' ' + sentence).length > target) {
          push(current);
          current = tail(current, overlap);
        }
        current += (current ? ' ' : '') + sentence;
      }
      continue;
    }
    if ((current + '\n\n' + paragraph).length > target) {
      push(current);
      current = tail(current, overlap);
    }
    current += (current ? '\n\n' : '') + paragraph;
  }
  push(current);
  return chunks;
}

function tail(text: string, length: number): string {
  if (text.length <= length) return text;
  const slice = text.slice(-length);
  const boundary = slice.search(/\s/);
  return boundary > 0 ? slice.slice(boundary + 1) : slice;
}

export class KnowledgeService {
  private dfCache?: IndexMeta;

  constructor(private readonly storage: StorageDriver) {}

  async ingest(input: IngestInput): Promise<{ document: KnowledgeDocument; chunks: number }> {
    const timestamp = nowIso();
    const documentId = newId('doc');
    const chunks = chunkText(input.text);

    const document: KnowledgeDocument = {
      id: documentId,
      title: input.title,
      source: input.source ?? 'owner upload',
      mimeType: input.mimeType ?? 'text/plain',
      bytes: input.bytes ?? Buffer.byteLength(input.text, 'utf8'),
      url: input.url,
      provider: input.provider ?? 'inline',
      tags: input.tags ?? [],
      collection: input.collection ?? 'general',
      chunkCount: chunks.length,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    await this.storage.set(DOCS, document);

    for (const [index, text] of chunks.entries()) {
      const tokenList = terms(text);
      const chunk: KnowledgeChunk = {
        id: `${documentId}::${index}`,
        documentId,
        index,
        text,
        tokens: [...new Set(tokenList)],
        vector: termFrequency(tokenList),
      };
      await this.storage.set(CHUNKS, chunk);
    }

    await this.rebuildIndex();
    return { document, chunks: chunks.length };
  }

  async listDocuments(options: { includeDeleted?: boolean; collection?: string } = {}): Promise<KnowledgeDocument[]> {
    const docs = await this.storage.list<KnowledgeDocument>(DOCS);
    return docs
      .filter((doc) => (options.includeDeleted ? true : !doc.deletedAt))
      .filter((doc) => (options.collection ? doc.collection === options.collection : true))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async getDocument(id: string): Promise<KnowledgeDocument | null> {
    return this.storage.get<KnowledgeDocument>(DOCS, id);
  }

  /** Soft delete keeps the index recoverable; hard delete removes chunks too. */
  async deleteDocument(id: string, hard = false): Promise<boolean> {
    const document = await this.getDocument(id);
    if (!document) return false;
    if (hard) {
      const chunks = await this.storage.list<KnowledgeChunk>(CHUNKS);
      for (const chunk of chunks.filter((c) => c.documentId === id)) {
        await this.storage.delete(CHUNKS, chunk.id);
      }
      await this.storage.delete(DOCS, id);
    } else {
      await this.storage.set(DOCS, { ...document, deletedAt: nowIso(), updatedAt: nowIso() });
    }
    await this.rebuildIndex();
    return true;
  }

  async search(query: string, options: SearchOptions = {}): Promise<KnowledgeHit[]> {
    const queryTerms = terms(query);
    if (!queryTerms.length) return [];

    const meta = await this.index();
    const chunks = await this.storage.list<KnowledgeChunk>(CHUNKS);
    const documents = await this.listDocuments();
    const allowed = new Set(
      documents
        .filter((doc) => (options.collection ? doc.collection === options.collection : true))
        .map((doc) => doc.id),
    );

    const queryVector = termFrequency(queryTerms);
    const queryMagnitude = magnitude(queryVector, meta.documentFrequency);

    const hits: KnowledgeHit[] = [];
    for (const chunk of chunks) {
      if (!allowed.has(chunk.documentId)) continue;
      // Fast reject: no shared term at all.
      if (!queryTerms.some((term) => chunk.tokens.includes(term))) continue;
      const dot = dotProduct(queryVector, chunk.vector, meta.documentFrequency);
      const chunkMagnitude = magnitude(chunk.vector, meta.documentFrequency);
      const cosine = dot / (queryMagnitude * chunkMagnitude || 1);
      const document = documents.find((doc) => doc.id === chunk.documentId);
      if (cosine < (options.minScore ?? 0.05)) continue;
      hits.push({
        documentId: chunk.documentId,
        documentTitle: document?.title ?? '(deleted document)',
        chunkId: chunk.id,
        text: chunk.text,
        score: cosine,
        source: document?.source ?? 'unknown',
      });
    }

    return hits.sort((a, b) => b.score - a.score).slice(0, options.limit ?? 6);
  }

  async stats(): Promise<{ documents: number; chunks: number; collections: string[]; terms: number }> {
    const [documents, meta] = await Promise.all([this.listDocuments(), this.index()]);
    return {
      documents: documents.length,
      chunks: meta.chunkCount,
      collections: [...new Set(documents.map((doc) => doc.collection))],
      terms: Object.keys(meta.documentFrequency).length,
    };
  }

  private async index(): Promise<IndexMeta> {
    if (this.dfCache) return this.dfCache;
    const stored = await this.storage.get<IndexMeta>(META, 'tfidf');
    if (stored) {
      this.dfCache = stored;
      return stored;
    }
    return this.rebuildIndex();
  }

  private async rebuildIndex(): Promise<IndexMeta> {
    const [chunks, documents] = await Promise.all([
      this.storage.list<KnowledgeChunk>(CHUNKS),
      this.listDocuments(),
    ]);
    const active = new Set(documents.map((doc) => doc.id));
    const documentFrequency: Record<string, number> = {};
    let counted = 0;
    for (const chunk of chunks) {
      if (!active.has(chunk.documentId)) continue;
      counted += 1;
      for (const term of chunk.tokens) {
        documentFrequency[term] = (documentFrequency[term] ?? 0) + 1;
      }
    }
    const meta: IndexMeta = {
      id: 'tfidf',
      documentCount: documents.length,
      chunkCount: counted,
      documentFrequency,
      updatedAt: nowIso(),
    };
    await this.storage.set(META, meta);
    this.dfCache = meta;
    return meta;
  }
}

/** -------------------------------------------------------------- tf-idf maths */

function termFrequency(tokenList: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const token of tokenList) counts[token] = (counts[token] ?? 0) + 1;
  const total = tokenList.length || 1;
  const out: Record<string, number> = {};
  for (const [term, count] of Object.entries(counts)) out[term] = count / total;
  return out;
}

function idf(term: string, df: Record<string, number>, total: number): number {
  const frequency = df[term] ?? 0;
  return Math.log((total + 1) / (frequency + 1)) + 1;
}

function dotProduct(
  a: Record<string, number>,
  b: Record<string, number>,
  df: Record<string, number>,
): number {
  const total = Math.max(Object.keys(df).length, 1);
  let sum = 0;
  for (const [term, weightA] of Object.entries(a)) {
    const weightB = b[term];
    if (!weightB) continue;
    const weight = idf(term, df, total);
    sum += weightA * weightB * weight * weight;
  }
  return sum;
}

function magnitude(vector: Record<string, number>, df: Record<string, number>): number {
  const total = Math.max(Object.keys(df).length, 1);
  let sum = 0;
  for (const [term, weight] of Object.entries(vector)) {
    const scaled = weight * idf(term, df, total);
    sum += scaled * scaled;
  }
  return Math.sqrt(sum);
}
