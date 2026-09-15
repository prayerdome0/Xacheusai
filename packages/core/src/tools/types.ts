/**
 * Tool contracts.
 *
 * A tool is a single, named capability with:
 *   - the scopes it needs (enforced before it runs)
 *   - a risk level (drives the confirmation gate)
 *   - a parameter schema (shown to the model and rendered as a form in the UI)
 *
 * The planner can only ever emit steps that resolve to a registered tool, which
 * is what keeps an LLM's output from turning into an arbitrary action.
 */
import type { PermissionScope, Principal, RiskLevel, ToolResult, ToolSchema } from '../types.js';
import type { Services } from '../services.js';

export interface ToolContext {
  principal: Principal;
  sessionId: string;
  runId?: string;
  stepId?: string;
  services: Services;
  /** Structured trace line, surfaced in the run view. */
  log(message: string): void;
  /** True when the owner already approved this exact step. */
  confirmed?: boolean;
}

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description: string;
  required: boolean;
  enum?: string[];
  /** Example value used by the built-in planner and the UI. */
  example?: unknown;
}

export interface Tool {
  id: string;
  name: string;
  description: string;
  category: 'memory' | 'knowledge' | 'business' | 'personal' | 'content' | 'research' | 'code' | 'system' | 'automation' | 'social' | 'messaging' | 'mail' | 'home' | 'device' | 'storage';
  scopes: PermissionScope[];
  risk: RiskLevel;
  requiresConfirmation?: boolean;
  parameters: ToolParameter[];
  /** The agent(s) this tool belongs to — used to build each agent's toolset. */
  owners: string[];
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

export interface ToolResolution {
  tool?: Tool;
  error?: string;
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();

  register(tool: Tool): void {
    this.tools.set(tool.id, tool);
  }

  registerAll(tools: Tool[]): void {
    for (const tool of tools) this.register(tool);
  }

  get(id: string): Tool | undefined {
    return this.tools.get(id);
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  list(): Tool[] {
    return [...this.tools.values()].sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
  }

  byCategory(): Record<string, Tool[]> {
    const grouped: Record<string, Tool[]> = {};
    for (const tool of this.list()) {
      grouped[tool.category] ??= [];
      grouped[tool.category]!.push(tool);
    }
    return grouped;
  }

  forAgent(agentId: string, extra: string[] = []): Tool[] {
    const allowed = new Set([agentId, ...extra]);
    return this.list().filter((tool) => tool.owners.some((owner) => allowed.has(owner)));
  }

  /** Compact schema handed to a language model. */
  schemas(tools: Tool[]): ToolSchema[] {
    return tools.map((tool) => ({
      name: tool.id,
      description: `${tool.description} [risk: ${tool.risk}${tool.requiresConfirmation ? ', requires confirmation' : ''}]`,
      parameters: tool.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        description: `${parameter.description}${parameter.enum ? ` (one of: ${parameter.enum.join(', ')})` : ''}${parameter.required ? '' : ' (optional)'}`,
        required: parameter.required,
        enum: parameter.enum,
      })),
    }));
  }

  /** Human/LLM-readable catalogue used in prompts. */
  catalogue(tools: Tool[]): string {
    return tools
      .map((tool) => {
        const params = tool.parameters
          .map((parameter) => `${parameter.name}:${parameter.type}${parameter.required ? '' : '?'}`)
          .join(', ');
        return `- ${tool.id} — ${tool.description} (args: ${params || 'none'}) [risk ${tool.risk}${tool.requiresConfirmation ? ', confirmation required' : ''}]`;
      })
      .join('\n');
  }
}
