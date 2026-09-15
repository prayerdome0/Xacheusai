/**
 * Permission engine.
 *
 * The owner is powerful, not unconstrained. Every tool declares the scopes it
 * needs and how risky it is; this engine answers three questions before a tool
 * may run:
 *
 *   1. Is the tool enabled at all?
 *   2. Has the owner granted every scope the tool requires?
 *   3. Does this particular action need explicit, interactive confirmation?
 *
 * Answers are persisted so the Control Center can show (and change) the policy.
 */
import type { PermissionScope, Principal, RiskLevel } from '../types.js';
import { readJson, writeJson, ensureDir, unique } from '../util.js';
import { join } from 'node:path';

export type ConfirmationMode = 'always' | 'risk-based' | 'never';

export interface ToolPolicy {
  enabled: boolean;
  /** Scopes the owner has granted for this tool. */
  scopes: PermissionScope[];
  confirmation: ConfirmationMode;
}

export interface AgentPolicy {
  enabled: boolean;
  /** Extra restriction: scopes this agent may use inside its own toolset. */
  allowedScopes: PermissionScope[];
}

export interface PolicyState {
  version: number;
  /** Scopes granted globally to the owner session. */
  grantedScopes: PermissionScope[];
  tools: Record<string, ToolPolicy>;
  agents: Record<string, AgentPolicy>;
  /** Trusted Android device ids. */
  devices: { id: string; name: string; pairedAt: string; lastSeenAt?: string }[];
  updatedAt: string;
}

export interface PermissionDecision {
  allowed: boolean;
  missingScopes: PermissionScope[];
  requiresConfirmation: boolean;
  reason: string;
}

export const ALL_SCOPES: PermissionScope[] = [
  'memory:read', 'memory:write',
  'knowledge:read', 'knowledge:write',
  'web:read',
  'business:read', 'business:write',
  'social:read', 'social:draft', 'social:publish',
  'messaging:read', 'messaging:draft', 'messaging:send',
  'mail:read', 'mail:draft', 'mail:send',
  'calendar:read', 'calendar:write',
  'home:read', 'home:control',
  'device:read', 'device:control',
  'code:read', 'code:write', 'code:execute',
  'automation:read', 'automation:write',
  'admin:control',
];

/** Sensible starting scopes: safe/read-only plus drafting. Nothing irreversible. */
export const DEFAULT_GRANTED_SCOPES: PermissionScope[] = [
  'memory:read', 'memory:write',
  'knowledge:read', 'knowledge:write',
  'web:read',
  'business:read',
  'social:read', 'social:draft',
  'messaging:read', 'messaging:draft',
  'mail:read', 'mail:draft',
  'calendar:read', 'calendar:write',
  'home:read',
  'device:read',
  'code:read',
  'automation:read', 'automation:write',
  'admin:control',
];

export interface ToolPermissionInput {
  id: string;
  scopes: PermissionScope[];
  risk: RiskLevel;
  /** Tool's own hard requirement for confirmation, regardless of policy. */
  requiresConfirmation?: boolean;
}

export function defaultPolicyFor(tool: ToolPermissionInput): ToolPolicy {
  return {
    enabled: true,
    scopes: [...tool.scopes],
    confirmation: tool.risk === 'low' ? 'never' : 'risk-based',
  };
}

export function defaultState(): PolicyState {
  return {
    version: 1,
    grantedScopes: [...DEFAULT_GRANTED_SCOPES],
    tools: {},
    agents: {},
    devices: [],
    updatedAt: new Date().toISOString(),
  };
}

export class PermissionEngine {
  private state: PolicyState = defaultState();
  private readonly file: string;
  private registry: Map<string, ToolPermissionInput> = new Map();
  private agentProfiles: Map<string, { scopes: PermissionScope[] }> = new Map();

  constructor(private readonly dataDir: string) {
    this.file = join(dataDir, 'policy.json');
  }

  async load(): Promise<void> {
    await ensureDir(this.dataDir);
    const stored = await readJson<PolicyState | null>(this.file, null);
    this.state = stored ?? defaultState();
  }

  /** Wire in the tool catalogue so `ensure()` can fill in new tools automatically. */
  registerTools(tools: ToolPermissionInput[]): void {
    for (const tool of tools) {
      this.registry.set(tool.id, tool);
      if (!this.state.tools[tool.id]) {
        this.state.tools[tool.id] = defaultPolicyFor(tool);
      }
    }
  }

  registerAgents(agents: { id: string; scopes: PermissionScope[]; enabled: boolean }[]): void {
    for (const agent of agents) {
      if (!this.state.agents[agent.id]) {
        this.state.agents[agent.id] = { enabled: agent.enabled, allowedScopes: [...agent.scopes] };
      }
    }
  }

  get snapshot(): PolicyState {
    return this.state;
  }

  get grantedScopes(): PermissionScope[] {
    return [...this.state.grantedScopes];
  }

  /**
   * Decide whether a tool call may proceed.
   *
   * `agentId` matters: a specialist agent can only ever use the intersection of
   * the owner's grant, the tool's requirement and its own profile. That stops a
   * loosely-prompted agent from reaching outside its lane.
   */
  evaluate(tool: ToolPermissionInput, principal: Principal, agentId?: string): PermissionDecision {
    const policy = this.state.tools[tool.id] ?? defaultPolicyFor(tool);

    if (!policy.enabled) {
      return {
        allowed: false,
        missingScopes: [],
        requiresConfirmation: false,
        reason: `Tool "${tool.id}" is switched off in the Control Center.`,
      };
    }

    if (principal.role === 'device') {
      const known = this.state.devices.find((d) => d.id === principal.deviceId);
      if (!known) {
        return {
          allowed: false,
          missingScopes: [],
          requiresConfirmation: false,
          reason: `Device ${principal.deviceId ?? 'unknown'} is not paired.`,
        };
      }
    }

    if (agentId) {
      const agent = this.state.agents[agentId];
      if (agent && !agent.enabled) {
        return {
          allowed: false,
          missingScopes: [],
          requiresConfirmation: false,
          reason: `Agent "${agentId}" is disabled.`,
        };
      }
      if (agent) {
        const wildcard = agent.allowedScopes.includes('*' as PermissionScope);
        const outside = wildcard ? [] : tool.scopes.filter((s) => !agent.allowedScopes.includes(s));
        if (outside.length) {
          return {
            allowed: false,
            missingScopes: outside,
            requiresConfirmation: false,
            reason: `Agent "${agentId}" is not permitted to use ${outside.join(', ')}.`,
          };
        }
      }
    }

    const required = unique([...tool.scopes, ...policy.scopes.filter((s) => tool.scopes.includes(s))]);
    const missing = required.filter((s) => !this.state.grantedScopes.includes(s));
    if (missing.length) {
      return {
        allowed: false,
        missingScopes: missing,
        requiresConfirmation: false,
        reason: `Owner has not granted ${missing.join(', ')}.`,
      };
    }

    const requiresConfirmation =
      tool.requiresConfirmation === true ||
      policy.confirmation === 'always' ||
      (policy.confirmation === 'risk-based' && (tool.risk === 'high' || tool.risk === 'critical'));

    const reason = requiresConfirmation
      ? tool.risk === 'critical'
        ? 'Critical action — irreversible or reaches other people.'
        : 'High-impact action — owner approval required.'
      : 'Permitted by current policy.';

    return { allowed: true, missingScopes: [], requiresConfirmation, reason };
  }

  async setToolPolicy(toolId: string, patch: Partial<ToolPolicy>): Promise<ToolPolicy> {
    const tool = this.registry.get(toolId);
    const current = this.state.tools[toolId] ?? (tool ? defaultPolicyFor(tool) : { enabled: false, scopes: [], confirmation: 'risk-based' });
    const next: ToolPolicy = { ...current, ...patch };
    this.state.tools[toolId] = next;
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return next;
  }

  async setAgentPolicy(agentId: string, patch: Partial<AgentPolicy>): Promise<AgentPolicy> {
    const current = this.state.agents[agentId] ?? { enabled: true, allowedScopes: [...ALL_SCOPES] };
    const next = { ...current, ...patch };
    this.state.agents[agentId] = next;
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return next;
  }

  async grantScopes(scopes: PermissionScope[], grant: boolean): Promise<PermissionScope[]> {
    const set = new Set(this.state.grantedScopes);
    for (const scope of scopes) {
      if (grant) set.add(scope);
      else set.delete(scope);
    }
    this.state.grantedScopes = [...set];
    this.state.updatedAt = new Date().toISOString();
    await this.persist();
    return [...set];
  }

  async pairDevice(device: { id: string; name: string }): Promise<void> {
    if (!this.state.devices.some((d) => d.id === device.id)) {
      this.state.devices.push({ ...device, pairedAt: new Date().toISOString() });
      await this.persist();
    }
  }

  async unpairDevice(id: string): Promise<void> {
    this.state.devices = this.state.devices.filter((d) => d.id !== id);
    await this.persist();
  }

  async touchDevice(id: string): Promise<void> {
    const device = this.state.devices.find((d) => d.id === id);
    if (device) {
      device.lastSeenAt = new Date().toISOString();
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    await writeJson(this.file, this.state);
  }
}
