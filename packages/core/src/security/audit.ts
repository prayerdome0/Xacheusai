/**
 * Append-only audit log.
 *
 * Every request that reaches the agent kernel produces entries here — auth,
 * permission decisions, confirmation gates, validation and execution. This is
 * the "activity log" surface of the Control Center and the accountability layer
 * that makes a private agent safe to leave running.
 */
import type { AuditEntry } from '../types.js';
import { newId, nowIso, writeJson, readJson } from '../util.js';
import { join } from 'node:path';

export interface AuditDraft {
  principalId: string;
  actor: string;
  stage: AuditEntry['stage'];
  decision: AuditEntry['decision'];
  action: string;
  detail: string;
  tool?: string;
  scopes?: AuditEntry['scopes'];
  mode?: AuditEntry['mode'];
  runId?: string;
  stepId?: string;
  durationMs?: number;
}

export class AuditLog {
  private entries: AuditEntry[] = [];
  private readonly file: string;
  private readonly limit: number;
  private dirty = false;
  private timer?: NodeJS.Timeout;

  constructor(dataDir: string, limit = 5000) {
    this.file = join(dataDir, 'audit.json');
    this.limit = limit;
  }

  async load(): Promise<void> {
    this.entries = await readJson<AuditEntry[]>(this.file, []);
  }

  async record(draft: AuditDraft): Promise<AuditEntry> {
    const entry: AuditEntry = { id: newId('aud'), at: nowIso(), ...draft };
    this.entries.unshift(entry);
    if (this.entries.length > this.limit) this.entries.length = this.limit;
    this.dirty = true;
    this.scheduleFlush();
    return entry;
  }

  query(options: {
    limit?: number;
    decision?: AuditEntry['decision'];
    stage?: AuditEntry['stage'];
    runId?: string;
    tool?: string;
    search?: string;
  } = {}): AuditEntry[] {
    const limit = options.limit ?? 200;
    const search = options.search?.toLowerCase();
    return this.entries
      .filter((e) => (options.decision ? e.decision === options.decision : true))
      .filter((e) => (options.stage ? e.stage === options.stage : true))
      .filter((e) => (options.runId ? e.runId === options.runId : true))
      .filter((e) => (options.tool ? e.tool === options.tool : true))
      .filter((e) =>
        search
          ? `${e.action} ${e.detail} ${e.tool ?? ''} ${e.actor}`.toLowerCase().includes(search)
          : true,
      )
      .slice(0, limit);
  }

  stats(): { total: number; denied: number; confirmations: number; last24h: number } {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    return {
      total: this.entries.length,
      denied: this.entries.filter((e) => e.decision === 'denied').length,
      confirmations: this.entries.filter((e) => e.stage === 'confirmation').length,
      last24h: this.entries.filter((e) => Date.parse(e.at) >= since).length,
    };
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await writeJson(this.file, this.entries);
  }

  private scheduleFlush(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, 750);
    this.timer.unref?.();
  }

  async close(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }
}
