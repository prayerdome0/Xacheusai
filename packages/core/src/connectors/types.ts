/**
 * Xacheus Connect — the universal connector contract.
 *
 * Adding a new integration must never mean touching the agent kernel. A
 * connector declares:
 *   - a manifest (what credentials it needs, what scopes and capabilities it has)
 *   - a set of operations (the actual calls)
 *
 * The registry turns each operation into a first-class tool that the planner can
 * select, the permission engine can gate, and the audit log records. Connectors
 * run in `live` mode when their credentials are present and `sandbox` mode when
 * they are not — always labelled, never faked.
 */
import type {
  ConnectorManifest,
  ConnectorStatus,
  PermissionScope,
  RiskLevel,
  ToolResult,
} from '../types.js';
import type { ConfigStore } from '../config.js';

export interface ConnectorContext {
  config: ConfigStore;
  /** Structured log line for the run trace. */
  log(message: string): void;
  /** Extra services a connector may need (storage, events, device bridge…). */
  services?: unknown;
  /** Correlation id for audit/trace. */
  runId?: string;
}

export interface ConnectorOperation {
  id: string;
  title: string;
  description: string;
  scopes: PermissionScope[];
  risk: RiskLevel;
  requiresConfirmation?: boolean;
  /** Named parameters, used to build the model-facing tool schema. */
  parameters: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required: boolean;
    enum?: string[];
    example?: unknown;
  }[];
  run(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ToolResult>;
}

export interface Connector {
  manifest: ConnectorManifest;
  operations: ConnectorOperation[];
  /** Live when credentials are complete, sandbox otherwise. */
  status(config: ConfigStore): ConnectorStatus;
  /** Optional connectivity check the Control Center can trigger. */
  verify?(config: ConfigStore): Promise<{ ok: boolean; detail: string }>;
}

/** Build a ConnectorStatus from a manifest + config, without repeating logic. */
export function evaluateStatus(connector: Connector, config: ConfigStore): ConnectorStatus {
  const missing = connector.manifest.fields
    .filter((field) => field.required && !config.has(field.key))
    .map((field) => field.key);
  const configured = missing.length === 0;
  return {
    id: connector.manifest.id,
    configured,
    mode: configured ? 'live' : 'sandbox',
    enabled: config.value(`XACHEUS_CONNECTOR_${connector.manifest.id.toUpperCase()}_ENABLED`, 'true') !== 'false',
    missingFields: missing,
    display: config.publicView(connector.manifest.fields.map((field) => field.key)),
  };
}

export function sandbox(operation: string, detail = 'the connector is not configured', data?: unknown): ToolResult {
  return {
    ok: true,
    mode: 'sandbox',
    summary: `${operation} simulated — ${detail}`,
    data: { simulated: true, ...(data as object) },
  };
}

export function failure(operation: string, error: unknown): ToolResult {
  return {
    ok: false,
    mode: 'live',
    summary: `${operation} failed.`,
    error: error instanceof Error ? error.message : String(error),
  };
}

/** Shared HTTP helper with timeout + honest error messages. */
export async function httpJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ ok: boolean; status: number; payload: any; text: string }> {
  const { timeoutMs = 15_000, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...rest, signal: controller.signal });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    return { ok: response.ok, status: response.status, payload, text };
  } catch (error) {
    return { ok: false, status: 0, payload: null, text: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

export function describeHttpError(result: { status: number; payload: any; text: string }): string {
  const detail =
    result.payload?.error?.message ??
    result.payload?.message ??
    result.payload?.error_description ??
    result.text?.slice(0, 240) ??
    'no detail';
  return `HTTP ${result.status || 'network error'}: ${detail}`;
}
