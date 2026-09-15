/**
 * Run store — persists agent runs so a confirmation can be approved minutes or
 * hours later, from the console or the phone.
 */
import type { AgentRun, Kernel } from '@xacheus/core';

const COLLECTION = 'runs';
const LIMIT = 300;

export class RunStore {
  constructor(private readonly kernel: Kernel) {}

  async save(run: AgentRun): Promise<AgentRun> {
    await this.kernel.services.storage.set(COLLECTION, run);
    const all = await this.kernel.services.storage.list<AgentRun>(COLLECTION);
    if (all.length > LIMIT) {
      const stale = all.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(0, all.length - LIMIT);
      for (const run of stale) await this.kernel.services.storage.delete(COLLECTION, run.id);
    }
    return run;
  }

  async get(id: string): Promise<AgentRun | null> {
    return this.kernel.services.storage.get<AgentRun>(COLLECTION, id);
  }

  async list(limit = 50): Promise<AgentRun[]> {
    const all = await this.kernel.services.storage.list<AgentRun>(COLLECTION);
    return all.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, limit);
  }

  /** Runs still waiting for the owner's approval. */
  async pending(): Promise<AgentRun[]> {
    return (await this.list(LIMIT)).filter((run) => run.status === 'awaiting_confirmation');
  }
}
