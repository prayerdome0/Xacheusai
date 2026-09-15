/**
 * Configuration resolution.
 *
 * Two layers:
 *   1. process.env        — set once at deploy time (.env / host env)
 *   2. dataDir/config.json — written by the Control Center when the owner pastes
 *                            credentials into the UI. Overrides layer 1.
 *
 * Secrets live in exactly one place and are never sent back to a client: the
 * `publicView()` method is the only shape the API will serialise.
 */
import { readJson, writeJson, ensureDir } from './util.js';
import { join } from 'node:path';

export interface ConfigOverlay {
  [envKey: string]: string;
}

const SECRET_HINTS = ['KEY', 'SECRET', 'TOKEN', 'PASSWORD', 'CREDENTIALS', 'JSON'];

export function looksSecret(key: string): boolean {
  const upper = key.toUpperCase();
  return SECRET_HINTS.some((hint) => upper.includes(hint)) && !upper.includes('VERIFY_TOKEN');
}

export class ConfigStore {
  private overlay: ConfigOverlay = {};
  private readonly file: string;
  private loaded = false;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    private readonly dataDir: string,
  ) {
    this.file = join(dataDir, 'config.json');
  }

  async load(): Promise<void> {
    await ensureDir(this.dataDir);
    this.overlay = await readJson<ConfigOverlay>(this.file, {});
    this.loaded = true;
  }

  async flush(): Promise<void> {
    await writeJson(this.file, this.overlay);
  }

  /** Resolve a config key: Control Center override first, then environment. */
  value(key: string, fallback = ''): string {
    const fromOverlay = this.overlay[key];
    if (fromOverlay !== undefined && fromOverlay !== '') return fromOverlay;
    const fromEnv = this.env[key];
    return fromEnv !== undefined && fromEnv !== '' ? fromEnv : fallback;
  }

  has(key: string): boolean {
    return this.value(key) !== '';
  }

  number(key: string, fallback: number): number {
    const raw = this.value(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  bool(key: string, fallback = false): boolean {
    const raw = this.value(key).toLowerCase();
    if (raw === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw);
  }

  json<T>(key: string, fallback: T): T {
    const raw = this.value(key);
    if (!raw) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  /** Write (or clear) a set of keys in the overlay layer. */
  async set(values: Record<string, string | undefined>): Promise<void> {
    for (const [key, raw] of Object.entries(values)) {
      if (raw === undefined) continue;
      if (raw === '') delete this.overlay[key];
      else this.overlay[key] = raw;
    }
    await this.flush();
  }

  /** Which keys have been set, and whether they came from the UI overlay. */
  presence(keys: string[]): Record<string, { set: boolean; source: 'control-center' | 'env' | 'unset' }> {
    const out: Record<string, { set: boolean; source: 'control-center' | 'env' | 'unset' }> = {};
    for (const key of keys) {
      if (this.overlay[key]) out[key] = { set: true, source: 'control-center' };
      else if (this.env[key]) out[key] = { set: true, source: 'env' };
      else out[key] = { set: false, source: 'unset' };
    }
    return out;
  }

  /** NEVER send secrets to a client. Non-secret values are returned as-is. */
  publicView(keys: string[]): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = this.value(key);
      if (value === '') continue;
      out[key] = looksSecret(key) ? (value.length > 6 ? `••••••${value.slice(-4)}` : '••••••') : value;
    }
    return out;
  }

  get isLoaded(): boolean {
    return this.loaded;
  }
}
