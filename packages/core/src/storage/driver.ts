/**
 * Storage drivers.
 *
 * Xacheus is designed around Firebase/Firestore, but it must also run — and be
 * developed — with no cloud credentials at all. Every service therefore talks to
 * this tiny interface instead of a database SDK.
 *
 *   JsonFileDriver  — default, zero dependencies, one JSON file per collection
 *   MemoryDriver    — tests and ephemeral runs
 *   FirestoreDriver — real Firestore via the REST API + service-account JWT
 *
 * The Firestore driver is implemented with plain `fetch` and `node:crypto` so
 * the kernel stays dependency-free; it activates only when a service account is
 * configured, and falls back loudly rather than silently losing writes.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createSign } from 'node:crypto';
import { ensureDir, listJsonFiles, readJson, removeFile, writeJson } from '../util.js';

export interface StorageDriver {
  readonly id: string;
  get<T>(collection: string, id: string): Promise<T | null>;
  set<T extends { id: string }>(collection: string, value: T): Promise<T>;
  delete(collection: string, id: string): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  healthy(): Promise<{ ok: boolean; detail: string }>;
}

/** ------------------------------------------------------------------ JSON file */

export class JsonFileDriver implements StorageDriver {
  readonly id = 'json';
  /** Serialise writes per collection so we never interleave a read-modify-write. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly dataDir: string) {}

  private file(collection: string): string {
    return join(this.dataDir, 'collections', `${collection}.json`);
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    const all = await this.list<T & { id: string }>(collection);
    return (all.find((item) => item.id === id) as T | undefined) ?? null;
  }

  async set<T extends { id: string }>(collection: string, value: T): Promise<T> {
    return this.exclusive(async () => {
      const file = this.file(collection);
      const all = await readJson<T[]>(file, []);
      const index = all.findIndex((item) => item.id === value.id);
      if (index >= 0) all[index] = value;
      else all.push(value);
      await writeJson(file, all);
      return value;
    });
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.exclusive(async () => {
      const file = this.file(collection);
      const all = await readJson<{ id: string }[]>(file, []);
      await writeJson(file, all.filter((item) => item.id !== id));
    });
  }

  async list<T>(collection: string): Promise<T[]> {
    // Guard against a partially-written file by falling back to the last good read.
    return readJson<T[]>(this.file(collection), []);
  }

  async healthy(): Promise<{ ok: boolean; detail: string }> {
    try {
      await ensureDir(join(this.dataDir, 'collections'));
      const probe = join(this.dataDir, 'collections', `.probe-${process.pid}`);
      await writeFile(probe, 'ok', 'utf8');
      await removeFile(probe);
      const files = await listJsonFiles(join(this.dataDir, 'collections'));
      return { ok: true, detail: `Local JSON driver, ${files.length} collection(s) in ${this.dataDir}` };
    } catch (error) {
      return { ok: false, detail: `Local storage failed: ${(error as Error).message}` };
    }
  }
}

/** ------------------------------------------------------------------- memory */

export class MemoryDriver implements StorageDriver {
  readonly id = 'memory';
  private readonly data = new Map<string, Map<string, { id: string }>>();

  private bucket(collection: string): Map<string, { id: string }> {
    let bucket = this.data.get(collection);
    if (!bucket) {
      bucket = new Map();
      this.data.set(collection, bucket);
    }
    return bucket;
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    return (this.bucket(collection).get(id) as T | undefined) ?? null;
  }

  async set<T extends { id: string }>(collection: string, value: T): Promise<T> {
    this.bucket(collection).set(value.id, value);
    return value;
  }

  async delete(collection: string, id: string): Promise<void> {
    this.bucket(collection).delete(id);
  }

  async list<T>(collection: string): Promise<T[]> {
    return [...this.bucket(collection).values()] as T[];
  }

  async healthy(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'In-memory driver (data is not persisted)' };
  }
}

/** ---------------------------------------------------------------- Firestore */

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
}

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
  doubleValue?: number;
  booleanValue?: boolean;
  nullValue?: null;
  arrayValue?: { values?: FirestoreValue[] };
  mapValue?: { fields?: Record<string, FirestoreValue> };
}

function toFirestoreValue(value: unknown): FirestoreValue {
  if (value === null || value === undefined) return { nullValue: null };
  if (typeof value === 'string') return { stringValue: value };
  if (typeof value === 'boolean') return { booleanValue: value };
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (typeof value === 'object') {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      fields[k] = toFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value: FirestoreValue): unknown {
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.nullValue !== undefined) return null;
  if (value.arrayValue) return (value.arrayValue.values ?? []).map(fromFirestoreValue);
  if (value.mapValue) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value.mapValue.fields ?? {})) {
      out[k] = fromFirestoreValue(v);
    }
    return out;
  }
  return null;
}

/**
 * Resolve a service account from an inline JSON string or from a file path.
 * Returns null when neither is usable so callers can degrade honestly.
 */
export function parseServiceAccount(inlineJson: string, path?: string): ServiceAccount | null {
  const candidates: string[] = [];
  if (inlineJson?.trim()) candidates.push(inlineJson.trim());
  if (path?.trim()) candidates.push(path.trim());
  for (const candidate of candidates) {
    try {
      const raw = candidate.startsWith('{') ? candidate : readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as ServiceAccount;
      if (parsed.client_email && parsed.private_key && parsed.project_id) {
        return { client_email: parsed.client_email, private_key: parsed.private_key, project_id: parsed.project_id };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const tokenCache = new Map<string, { value: string; expiresAt: number }>();

/**
 * Exchange a service account for a Google OAuth2 access token (JWT bearer flow).
 * Shared by the Firestore driver and the FCM connector; tokens are cached per
 * (account, scope) until a minute before expiry.
 */
export async function googleAccessToken(account: ServiceAccount, scope: string): Promise<string> {
  const cacheKey = `${account.client_email}:${account.project_id}:${scope}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.value;

  const header = { alg: 'RS256', typ: 'JWT' };
  const iat = Math.floor(Date.now() / 1000);
  const claim = {
    iss: account.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat,
    exp: iat + 3600,
  };
  const enc = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(claim)}`;
  const signer = createSign('RSA-SHA256');
  signer.update(signingInput);
  const signature = signer.sign(account.private_key.replace(/\\n/g, '\n')).toString('base64url');

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${signingInput}.${signature}`,
    }),
  });
  if (!response.ok) {
    throw new Error(`Google auth failed (${response.status}): ${await response.text()}`);
  }
  const payload = (await response.json()) as { access_token: string; expires_in: number };
  tokenCache.set(cacheKey, { value: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 });
  return payload.access_token;
}

/**
 * Firestore over REST. Requires a service account (server-side credential) —
 * the web API key alone is not enough to write server data, by design.
 */
export class FirestoreDriver implements StorageDriver {
  readonly id = 'firestore';

  constructor(
    private readonly account: ServiceAccount,
    private readonly root = 'xacheus',
  ) {}

  private base(): string {
    return `https://firestore.googleapis.com/v1/projects/${this.account.project_id}/databases/(default)/documents/${this.root}`;
  }

  private async accessToken(): Promise<string> {
    return googleAccessToken(this.account, 'https://www.googleapis.com/auth/datastore');
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const token = await this.accessToken();
    const response = await fetch(`${this.base()}/${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Firestore ${init.method ?? 'GET'} ${path} failed (${response.status}): ${await response.text()}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async get<T>(collection: string, id: string): Promise<T | null> {
    try {
      const doc = (await this.request(`${collection}/${id}`)) as {
        fields?: Record<string, FirestoreValue>;
      } | null;
      if (!doc?.fields) return null;
      const plain: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(doc.fields)) plain[k] = fromFirestoreValue(v);
      return plain as T;
    } catch {
      return null;
    }
  }

  async set<T extends { id: string }>(collection: string, value: T): Promise<T> {
    const fields: Record<string, FirestoreValue> = {};
    for (const [k, v] of Object.entries(value)) fields[k] = toFirestoreValue(v);
    await this.request(`${collection}/${encodeURIComponent(value.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ fields }),
    });
    return value;
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.request(`${collection}/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async list<T>(collection: string): Promise<T[]> {
    const out: T[] = [];
    let pageToken: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '300' });
      if (pageToken) query.set('pageToken', pageToken);
      const payload = (await this.request(`${collection}?${query.toString()}`)) as {
        documents?: { name: string; fields?: Record<string, FirestoreValue> }[];
        nextPageToken?: string;
      };
      for (const doc of payload.documents ?? []) {
        const plain: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(doc.fields ?? {})) plain[k] = fromFirestoreValue(v);
        if (plain.id === undefined) plain.id = doc.name.split('/').pop();
        out.push(plain as T);
      }
      pageToken = payload.nextPageToken;
    } while (pageToken);
    return out;
  }

  async healthy(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.accessToken();
      return { ok: true, detail: `Firestore project ${this.account.project_id} (root: ${this.root})` };
    } catch (error) {
      return { ok: false, detail: `Firestore unreachable: ${(error as Error).message}` };
    }
  }
}

/**
 * Choose a driver, degrading to local storage (with a visible reason) if the
 * requested cloud driver cannot start. Xacheus must never silently lose data,
 * so the reason is surfaced in the console.
 */
export async function createStorage(options: {
  driver: 'json' | 'firestore' | 'memory';
  dataDir: string;
  serviceAccountPath?: string;
  serviceAccountJson?: string;
}): Promise<{ driver: StorageDriver; notes: string[] }> {
  const notes: string[] = [];
  if (options.driver === 'memory') return { driver: new MemoryDriver(), notes };

  if (options.driver === 'firestore') {
    try {
      let raw = options.serviceAccountJson?.trim() ?? '';
      if (!raw && options.serviceAccountPath) raw = await readFile(options.serviceAccountPath, 'utf8');
      if (raw) {
        const account = JSON.parse(raw) as ServiceAccount;
        const driver = new FirestoreDriver(account);
        const health = await driver.healthy();
        if (health.ok) return { driver, notes: [health.detail] };
        notes.push(`Firestore requested but unusable (${health.detail}); using local JSON storage.`);
      } else {
        notes.push('XACHEUS_STORAGE=firestore but no service account was provided; using local JSON storage.');
      }
    } catch (error) {
      notes.push(`Firestore setup failed (${(error as Error).message}); using local JSON storage.`);
    }
  }

  return { driver: new JsonFileDriver(options.dataDir), notes };
}
