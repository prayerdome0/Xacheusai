/**
 * Connector registry: holds every integration, resolves its live/sandbox status
 * and exposes a uniform address space — `connectorId.operationId`.
 */
import type { ConnectorStatus } from '../types.js';
import type { ConfigStore } from '../config.js';
import type { Connector, ConnectorContext, ConnectorOperation } from './types.js';
import { evaluateStatus } from './types.js';

export class ConnectorRegistry {
  private readonly connectors = new Map<string, Connector>();

  constructor(private readonly config: ConfigStore) {}

  register(connector: Connector): void {
    this.connectors.set(connector.manifest.id, connector);
  }

  registerAll(connectors: Connector[]): void {
    for (const connector of connectors) this.register(connector);
  }

  get(id: string): Connector | undefined {
    return this.connectors.get(id);
  }

  list(): Connector[] {
    return [...this.connectors.values()];
  }

  statuses(): ConnectorStatus[] {
    return this.list().map((connector) => this.status(connector.manifest.id));
  }

  status(id: string): ConnectorStatus {
    const connector = this.connectors.get(id);
    if (!connector) {
      return {
        id,
        configured: false,
        mode: 'sandbox',
        enabled: false,
        missingFields: [],
        display: {},
        lastError: 'Unknown connector',
      };
    }
    const status = evaluateStatus(connector, this.config);
    try {
      if (connector.status) {
        const custom = connector.status(this.config);
        return { ...status, ...custom, display: { ...status.display, ...custom.display } };
      }
    } catch (error) {
      status.lastError = (error as Error).message;
    }
    return status;
  }

  /** Every operation the planner may call, flattened with its owner. */
  operations(): { connectorId: string; connectorName: string; operation: ConnectorOperation; toolId: string }[] {
    const out: { connectorId: string; connectorName: string; operation: ConnectorOperation; toolId: string }[] = [];
    for (const connector of this.list()) {
      for (const operation of connector.operations) {
        out.push({
          connectorId: connector.manifest.id,
          connectorName: connector.manifest.name,
          operation,
          toolId: `${connector.manifest.id}.${operation.id}`,
        });
      }
    }
    return out;
  }

  findOperation(toolId: string): { connector: Connector; operation: ConnectorOperation } | null {
    const [connectorId, operationId] = toolId.split('.');
    const connector = connectorId ? this.connectors.get(connectorId) : undefined;
    if (!connector) return null;
    const operation = connector.operations.find((op) => op.id === operationId);
    if (!operation) return null;
    return { connector, operation };
  }

  context(log: (message: string) => void, runId?: string): ConnectorContext {
    return { config: this.config, log, runId };
  }

  async verify(id: string): Promise<{ ok: boolean; detail: string }> {
    const connector = this.connectors.get(id);
    if (!connector) return { ok: false, detail: 'Unknown connector.' };
    const status = this.status(id);
    if (!connector.verify) {
      return {
        ok: status.configured,
        detail: status.configured
          ? 'Credentials present. This connector has no dedicated health check; the first real call will confirm access.'
          : `Missing credentials: ${status.missingFields.join(', ') || 'none listed'} — running in sandbox mode.`,
      };
    }
    try {
      return await connector.verify(this.config);
    } catch (error) {
      return { ok: false, detail: (error as Error).message };
    }
  }
}

export function connectorFrom(manifest: Connector['manifest'], operations: ConnectorOperation[]): Connector {
  return {
    manifest,
    operations,
    status: (config) => evaluateStatus({ manifest, operations, status: () => ({}) as ConnectorStatus }, config),
  };
}
