/**
 * Document pipeline:  upload → store (Cloudinary or local) → extract → index → learn
 *
 * This is the "Knowledge Brain" plumbing from the architecture diagram. It also
 * feeds company memory automatically when a document contains clear
 * "key: value" facts, so the business agents get smarter just by you dropping
 * files in.
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Attachment, KnowledgeDocument } from '../types.js';
import type { ConfigStore } from '../config.js';
import type { StorageDriver } from '../storage/driver.js';
import type { KnowledgeService } from '../knowledge/knowledge.js';
import type { MemoryService } from '../memory/memory.js';
import type { EventBus } from '../events.js';
import { isCloudinaryReady, uploadToCloudinary } from '../connectors/cloudinary.js';
import { extractText } from './extract.js';
import { newId, nowIso, sha1 } from '../util.js';

export interface IngestDocumentInput {
  filename: string;
  mimeType: string;
  data: Buffer;
  title?: string;
  tags?: string[];
  collection?: string;
  /** Upload to Cloudinary when configured (otherwise a local file is written). */
  store?: boolean;
}

export interface IngestResult {
  attachment: Attachment;
  document: KnowledgeDocument;
  extraction: { method: string; characters: number; warning?: string };
  /** Facts lifted into company memory. */
  learned: { key: string; value: string }[];
}

export interface DocumentServiceDeps {
  config: ConfigStore;
  storage: StorageDriver;
  knowledge: KnowledgeService;
  memory: MemoryService;
  events: EventBus;
  uploadsDir: string;
}

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  /** Ingest raw bytes (from an upload, the API, or the web agent). */
  async ingest(input: IngestDocumentInput): Promise<IngestResult> {
    const { config, knowledge, memory, events, uploadsDir } = this.deps;
    const checksum = sha1(`${input.filename}:${input.data.length}:${input.data.subarray(0, 512).toString('latin1')}`);

    const extraction = extractText(input.data, input.mimeType, input.filename);
    const attachment = await this.storeFile(input, checksum);

    const { document } = await knowledge.ingest({
      title: input.title ?? input.filename,
      text: extraction.text || `${input.filename} (no extractable text)\n${extraction.warning ?? ''}`,
      source: attachment.provider === 'cloudinary' ? attachment.url : `local:${attachment.id}`,
      mimeType: input.mimeType,
      bytes: input.data.length,
      url: attachment.url,
      provider: attachment.provider,
      tags: input.tags ?? [guessCategory(input.filename)],
      collection: input.collection ?? 'general',
    });

    const learned = await this.learnFacts(document, extraction.text);

    events.emit('document.ingested', {
      documentId: document.id,
      title: document.title,
      method: extraction.method,
      characters: extraction.text.length,
      learned: learned.length,
    });

    return {
      attachment,
      document,
      extraction: { method: extraction.method, characters: extraction.text.length, warning: extraction.warning },
      learned,
    };
  }

  /** Ingest text directly (web pages, notes, pasted content). */
  async ingestText(input: {
    title: string;
    text: string;
    source?: string;
    tags?: string[];
    collection?: string;
    url?: string;
  }): Promise<{ document: KnowledgeDocument; learned: { key: string; value: string }[] }> {
    const { knowledge } = this.deps;
    const { document } = await knowledge.ingest({
      title: input.title,
      text: input.text,
      source: input.source ?? 'text',
      mimeType: 'text/plain',
      bytes: Buffer.byteLength(input.text, 'utf8'),
      url: input.url,
      provider: input.url ? 'cloudinary' : 'inline',
      tags: input.tags ?? [],
      collection: input.collection ?? 'general',
    });
    const learned = await this.learnFacts(document, input.text);
    this.deps.events.emit('document.ingested', { documentId: document.id, title: document.title, method: 'text', characters: input.text.length });
    return { document, learned };
  }

  /**
   * Lift obvious "key: value" facts into company memory. Silent when a document
   * has no such structure — we never invent facts from prose.
   */
  private async learnFacts(document: KnowledgeDocument, text: string): Promise<{ key: string; value: string }[]> {
    if (!text) return [];
    const { memory } = this.deps;
    const candidates = text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Za-z][A-Za-z0-9 /_-]{2,38})\s*[:=]\s*(.{3,200})$/))
      .filter((match): match is RegExpMatchArray => Boolean(match?.[1] && match[2]))
      .slice(0, 12)
      .map((match) => ({ key: match[1]!.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'), value: match[2]!.trim() }))
      .filter((fact) => !/^(http|https)$/.test(fact.key));

    const learned: { key: string; value: string }[] = [];
    for (const fact of candidates) {
      await memory.remember({
        kind: 'company',
        key: fact.key,
        value: fact.value,
        tags: ['from-document', document.collection],
        source: `document:${document.id}`,
        confidence: 0.7,
      });
      learned.push(fact);
    }
    return learned;
  }

  private async storeFile(input: IngestDocumentInput, checksum: string): Promise<Attachment> {
    const { config, uploadsDir } = this.deps;
    const store = input.store ?? true;

    if (store && isCloudinaryReady(config)) {
      try {
        const uploaded = await uploadToCloudinary(config, {
          data: input.data,
          name: input.filename,
          resourceType: guessResourceType(input.mimeType),
        });
        if (uploaded) return uploaded;
      } catch (error) {
        // Fall through to local storage, but keep the reason visible in logs.
        this.deps.events.emit('connector.updated', {
          connector: 'cloudinary',
          note: `Upload failed, stored locally instead: ${(error as Error).message}`,
        });
      }
    }

    const id = newId('file');
    const dir = join(uploadsDir, checksum.slice(0, 2));
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${id}-${sanitise(input.filename)}`);
    await writeFile(path, input.data);
    await this.deps.storage.set('attachments', {
      id,
      name: input.filename,
      mimeType: input.mimeType,
      bytes: input.data.length,
      url: `/api/files/${id}`,
      provider: 'local',
      createdAt: nowIso(),
      path,
    } as Attachment & { id: string; path: string });

    return {
      id,
      name: input.filename,
      mimeType: input.mimeType,
      bytes: input.data.length,
      url: `/api/files/${id}`,
      provider: 'local',
      createdAt: nowIso(),
    };
  }

  async readLocalFile(id: string): Promise<{ path: string; record: Attachment } | null> {
    const record = await this.deps.storage.get<Attachment & { path: string }>('attachments', id);
    if (!record) return null;
    try {
      await readFile(record.path);
      return { path: record.path, record };
    } catch {
      return null;
    }
  }
}

function sanitise(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(-60);
}

function guessResourceType(mimeType: string): 'image' | 'video' | 'raw' | 'auto' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.includes('pdf') || mimeType.includes('word') || mimeType.includes('sheet') || mimeType.includes('csv')) return 'raw';
  return 'auto';
}

export function guessCategory(filename: string): string {
  const lower = filename.toLowerCase();
  if (/invoice|receipt|bill/.test(lower)) return 'finance';
  if (/catalog|price|product/.test(lower)) return 'products';
  if (/policy|contract|terms/.test(lower)) return 'policy';
  if (/report|analysis/.test(lower)) return 'reports';
  if (/marketing|flyer|poster|campaign/.test(lower)) return 'marketing';
  return 'general';
}
