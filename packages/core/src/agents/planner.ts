/**
 * The planner.
 *
 * Preferred path: ask the configured model for a plan, described as JSON, with the
 * *actual tool catalogue* in the prompt. Then validate every step against the
 * registry — an invented tool id, an unknown agent or a malformed argument object
 * is thrown away rather than executed.
 *
 * Fallback path: the deterministic rule table (`rules.ts`). This is why Xacheus is
 * fully usable with no model configured, and why a model outage degrades instead
 * of breaking.
 */
import type { AgentId, ToolSchema } from '../types.js';
import type { Services } from '../services.js';
import { AGENT_IDS } from './descriptors.js';
import { planHeuristically, classifyHeuristically, type PlannedStep } from './rules.js';
import { completeWithFallback } from '../models/providers.js';
import { tryParseJson, truncate } from '../util.js';

export interface PlanRequest {
  request: string;
  services: Services;
  sessionId: string;
  transcript?: string;
  /** Extra context the orchestrator already gathered (memory, knowledge). */
  context?: string;
  payload?: unknown;
}

export interface Plan {
  agent: AgentId;
  steps: PlannedStep[];
  response?: string;
  suggestions: string[];
  confidence: number;
  usedFallback: boolean;
  model: string;
  notes: string[];
  /** True when nothing matched and the answer should come from context alone. */
  conversational: boolean;
}

const PLAN_SYSTEM = `You are the Xacheus Master Agent — a private, owner-controlled assistant.

You plan, you do not chat. Given the owner's request and the available tools, reply with ONE JSON object:

{
  "agent": "master|personal|business|research|knowledge|code|social|messaging|mail|home|automation",
  "steps": [ { "tool": "<tool id from the catalogue>", "title": "short human label", "input": { } } ],
  "suggestions": ["short follow-up the owner might want"],
  "notes": "anything the owner must know, e.g. that an action needs approval"
}

Hard rules:
- Use ONLY tool ids from the catalogue. Never invent a tool.
- Prefer the fewest steps that genuinely answer the request (1-3).
- Never claim something happened: the steps report their own results.
- If the request is a question you can answer from the supplied context, return "steps": [] and explain in "notes".
- Anything that sends, publishes, calls, pays or changes settings needs approval — the runtime will ask, so plan it normally.
- Reply with JSON only, no prose, no code fences.`;

export async function buildPlan(request: PlanRequest): Promise<Plan> {
  const { services } = request;
  const notes: string[] = [];

  // 1. Always compute the deterministic plan: it is the safety net and the router.
  const heuristic = planHeuristically(request.request);
  const heuristicAgent = heuristic?.agent ?? classifyHeuristically(request.request);

  if (services.models.builtin) {
    return fromHeuristic(heuristic, heuristicAgent, 'builtin', [
      'Planned by the built-in deterministic router (no language model configured).',
    ], services);
  }

  // 2. Ask the model, with the real tool catalogue.
  const agentForPlanning = heuristic?.agent ?? 'master';
  const tools = services.tools.forAgent('master');
  const catalogue = services.tools.catalogue(tools);
  const schemas: ToolSchema[] = services.tools.schemas(tools);

  const prompt = [
    request.context ? `Context you already have:\n${request.context}\n` : '',
    request.transcript ? `Recent conversation:\n${request.transcript}\n` : '',
    `Owner request: "${request.request}"`,
    '',
    `Suggested specialist (from the deterministic router): ${agentForPlanning}`,
    '',
    'Tool catalogue:',
    catalogue,
  ]
    .filter(Boolean)
    .join('\n');

  const { response, providerId, failures } = await completeWithFallback(services.models, {
    system: PLAN_SYSTEM,
    prompt,
    json: true,
    temperature: 0.2,
    purpose: 'plan',
    tools: schemas,
  });

  for (const failure of failures) notes.push(`Model ${failure.provider} failed: ${failure.error}`);

  if (!response.text.trim() || response.synthetic) {
    return fromHeuristic(heuristic, heuristicAgent, 'builtin', [
      ...notes,
      'Fell back to the built-in planner because no model returned a usable plan.',
    ], services);
  }

  const parsed = tryParseJson<{
    agent?: string;
    steps?: { tool?: string; title?: string; input?: Record<string, unknown> }[];
    suggestions?: string[];
    notes?: string;
  }>(response.text);

  if (!parsed) {
    notes.push(`Model ${providerId} returned unparseable JSON (${truncate(response.text, 160)}); using the built-in planner.`);
    return fromHeuristic(heuristic, heuristicAgent, providerId, notes, services);
  }

  const agent = (AGENT_IDS.includes(parsed.agent as AgentId) ? parsed.agent : heuristicAgent) as AgentId;
  const steps: PlannedStep[] = [];
  const rejected: string[] = [];

  for (const candidate of parsed.steps ?? []) {
    const toolId = String(candidate?.tool ?? '').trim();
    if (!toolId) continue;
    if (!services.tools.has(toolId)) {
      rejected.push(toolId);
      continue;
    }
    const tool = services.tools.get(toolId)!;
    const allowedForAgent = tool.owners.includes(agent) || tool.owners.includes('*') || tool.owners.includes('master');
    if (!allowedForAgent) {
      rejected.push(`${toolId} (not available to the ${agent} agent)`);
      continue;
    }
    steps.push({
      title: String(candidate.title ?? tool.name),
      tool: toolId,
      input: candidate.input && typeof candidate.input === 'object' ? (candidate.input as Record<string, unknown>) : {},
    });
  }

  if (rejected.length) notes.push(`Rejected invented or out-of-scope tool(s): ${rejected.join(', ')}.`);

  if (!steps.length && heuristic?.steps.length) {
    notes.push('The model planned nothing usable; using the built-in plan.');
    return fromHeuristic(heuristic, heuristicAgent, providerId, notes, services);
  }

  if (parsed.notes) notes.push(parsed.notes);

  return {
    agent: coordinate(agent, steps, services),
    steps,
    suggestions: (parsed.suggestions ?? []).slice(0, 4),
    confidence: steps.length ? 0.8 : 0.5,
    usedFallback: false,
    model: response.model,
    notes,
    conversational: steps.length === 0,
  };
}

/**
 * If a plan spans several specialists, the Master Agent owns the run — that is
 * literally its job, and it keeps each specialist inside its own lane.
 */
export function coordinate(agent: AgentId, steps: PlannedStep[], services: Services): AgentId {
  const owners = new Set<AgentId>();
  for (const step of steps) {
    const tool = services.tools.get(step.tool);
    if (!tool) continue;
    for (const owner of tool.owners) {
      if (owner !== '*' && AGENT_IDS.includes(owner as AgentId)) owners.add(owner as AgentId);
    }
  }
  if (owners.size > 1) return 'master';
  if (owners.size === 1 && !owners.has(agent) && agent !== 'master') {
    // The plan belongs to exactly one specialist: route it there.
    return [...owners][0]!;
  }
  return agent;
}

function fromHeuristic(
  heuristic: ReturnType<typeof planHeuristically>,
  agent: AgentId,
  model: string,
  notes: string[],
  services?: Services,
): Plan {
  if (heuristic) {
    return {
      agent: services ? coordinate(heuristic.agent, heuristic.steps, services) : heuristic.agent,
      steps: heuristic.steps,
      suggestions: heuristic.suggestions ?? [],
      confidence: heuristic.confidence,
      usedFallback: true,
      model,
      notes,
      conversational: false,
    };
  }
  return {
    agent,
    steps: [],
    suggestions: [],
    confidence: 0.3,
    usedFallback: true,
    model,
    notes,
    conversational: true,
  };
}
