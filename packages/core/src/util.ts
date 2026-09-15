/**
 * Small, dependency-free helpers used across the kernel.
 */
import { randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile, readFile, rename, readdir, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const nowIso = (): string => new Date().toISOString();

export const newId = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export const sha1 = (value: string): string => createHash('sha1').update(value).digest('hex');

export const truncate = (value: string, max = 400): string =>
  value.length <= max ? value : `${value.slice(0, max - 1)}…`;

/** Local-timezone day key, e.g. 2026-09-15 */
export const dayKey = (date = new Date()): string => {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/** Atomic-ish JSON write: write to tmp then rename, so a crash can't corrupt state. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await ensureDir(dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
}

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter((f) => f.endsWith('.json')).map((f) => join(dir, f));
  } catch {
    return [];
  }
}

export async function removeFile(file: string): Promise<void> {
  try {
    await unlink(file);
  } catch {
    /* already gone */
  }
}

/** Tokenize text for the local (no-embedding) retrieval index. */
const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'then', 'than', 'that', 'this', 'these', 'those',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am', 'do', 'does', 'did', 'doing',
  'have', 'has', 'had', 'having', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her',
  'us', 'them', 'my', 'your', 'his', 'its', 'our', 'their', 'of', 'to', 'in', 'on', 'at', 'by',
  'for', 'with', 'about', 'as', 'from', 'into', 'over', 'after', 'before', 'so', 'no', 'not',
  'can', 'could', 'should', 'would', 'will', 'just', 'please', 'hey', 'ok', 'okay',
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/^['-]+|['-]+$/g, ''))
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/** Crude but dependency-free stemming so "posting" matches "post". */
export function stem(token: string): string {
  if (token.length <= 4) return token;
  for (const suffix of ['ingly', 'edly', 'ing', 'ies', 'ied', 'es', 'ed', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

export function terms(text: string): string[] {
  return tokenize(text).map(stem);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** Safe JSON parse that never throws. */
export function tryParseJson<T = unknown>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    /* fall through */
  }
  // Models sometimes wrap JSON in prose or fences — salvage the first object/array.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1]) as T;
    } catch {
      /* ignore */
    }
  }
  const start = text.search(/[[{]/);
  if (start >= 0) {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1)) as T;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
