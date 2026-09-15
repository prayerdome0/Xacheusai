/**
 * Tool catalogue assembly.
 *
 * Two sources feed one registry:
 *   1. native tools  — Xacheus' own capabilities (memory, business, calendar, code…)
 *   2. connector tools — every operation of every integration, named
 *      `connectorId.operationId`, mapped to the agents that own it
 *
 * The planner can only ever emit a step naming a tool id that exists here, which
 * is the boundary that keeps an LLM's output from becoming an arbitrary action.
 */
import type { ConnectorRegistry } from '../connectors/registry.js';
import type { AgentId } from '../types.js';
import { ToolRegistry, type Tool } from './types.js';
import { memoryTools } from './memory-tools.js';
import { businessTools } from './business-tools.js';
import { personalTools } from './personal-tools.js';
import { contentTools } from './content-tools.js';
import { researchTools } from './research-tools.js';
import { codeTools } from './code-tools.js';
import { systemTools } from './system-tools.js';
import { automationTools } from './automation-tools.js';

export * from './types.js';

/** Which agents may use each connector. */
const CONNECTOR_OWNERS: Record<string, AgentId[]> = {
  facebook: ['social', 'master'],
  instagram: ['social', 'master'],
  whatsapp: ['messaging', 'business', 'master'],
  mail: ['mail', 'business', 'master'],
  home: ['home', 'personal', 'master'],
  cloudinary: ['social', 'knowledge', 'master', 'code'],
  firebase: ['master', 'code'],
  web: ['research', 'business', 'master', 'knowledge'],
  device: ['personal', 'home', 'master'],
  api: ['business', 'code', 'master'],
};

/** Wrap connector operations as first-class tools. */
export function connectorTools(connectors: ConnectorRegistry): Tool[] {
  return connectors.operations().map(({ connectorId, connectorName, operation, toolId }) => {
    const tool: Tool = {
      id: toolId,
      name: `${connectorName}: ${operation.title}`,
      description: operation.description,
      category: (connectorId === 'api' ? 'business' : connectorId === 'mail' ? 'mail' : connectorId === 'device' ? 'device' : connectorId) as Tool['category'],
      scopes: operation.scopes,
      risk: operation.risk,
      requiresConfirmation: operation.requiresConfirmation,
      parameters: operation.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        description: parameter.description,
        required: parameter.required,
        enum: parameter.enum,
      })),
      owners: CONNECTOR_OWNERS[connectorId] ?? ['master'],
      async run(input, ctx) {
        const context = connectors.context((message) => ctx.log(message), ctx.runId);
        return operation.run(input, { config: ctx.services.config, log: context.log, services: ctx.services, runId: ctx.runId });
      },
    };
    return tool;
  });
}

export function createToolRegistry(connectors: ConnectorRegistry): ToolRegistry {
  const registry = new ToolRegistry();
  registry.registerAll([
    ...memoryTools,
    ...businessTools,
    ...personalTools,
    ...contentTools,
    ...researchTools,
    ...codeTools,
    ...systemTools,
    ...automationTools,
    ...connectorTools(connectors),
  ]);
  return registry;
}
