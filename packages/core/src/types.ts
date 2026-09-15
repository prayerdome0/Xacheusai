/**
 * Xacheus AI — core type contracts.
 *
 * These types are the spine of the whole platform: the backend kernel, the web
 * console, the REST/WS API and the Android bridge all speak them.
 */

/** ---------------------------------------------------------------- identity */

export type PrincipalRole = 'owner' | 'device' | 'service';

export interface Principal {
  id: string;
  role: PrincipalRole;
  displayName?: string;
  /** Tokens issued to a paired Android device identify themselves here. */
  deviceId?: string;
}

/** ------------------------------------------------------------- permissions */

export type PermissionScope =
  // memory
  | 'memory:read'
  | 'memory:write'
  // knowledge
  | 'knowledge:read'
  | 'knowledge:write'
  // open web
  | 'web:read'
  // business data
  | 'business:read'
  | 'business:write'
  // social
  | 'social:read'
  | 'social:draft'
  | 'social:publish'
  // messaging (WhatsApp / SMS-style channels)
  | 'messaging:read'
  | 'messaging:draft'
  | 'messaging:send'
  // email
  | 'mail:read'
  | 'mail:draft'
  | 'mail:send'
  // calendar / reminders / tasks
  | 'calendar:read'
  | 'calendar:write'
  // phone + smart home
  | 'home:read'
  | 'home:control'
  | 'device:read'
  | 'device:control'
  // code
  | 'code:read'
  | 'code:write'
  | 'code:execute'
  // automations
  | 'automation:read'
  | 'automation:write'
  // control center
  | 'admin:control';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** --------------------------------------------------------------- execution */

/**
 * How a result was produced. This is deliberately surfaced everywhere in the UI
 * and in the audit log: Xacheus must never present a simulated action as real.
 */
export type ExecutionMode = 'live' | 'sandbox' | 'dry-run' | 'blocked';

export interface ToolResult<T = unknown> {
  ok: boolean;
  mode: ExecutionMode;
  /** One-line, human-readable outcome. */
  summary: string;
  data?: T;
  /** Populated when ok === false. */
  error?: string;
  /** Set when the tool produced something the console should render (cards, links). */
  ui?: UiAction[];
  /** Follow-up suggestions offered to the owner. */
  suggestions?: string[];
  startedAt?: string;
  durationMs?: number;
}

export interface UiAction {
  type: 'navigate' | 'open-url' | 'highlight' | 'confirm';
  target: string;
  label?: string;
}

/** ---------------------------------------------------------------- messages */

export type MessageRole = 'owner' | 'xacheus' | 'system' | 'tool';

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  text: string;
  createdAt: string;
  runId?: string;
  /** Attachments already uploaded to Cloudinary (or local fallback). */
  attachments?: Attachment[];
  meta?: Record<string, unknown>;
}

export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  bytes: number;
  /** Public URL (Cloudinary) or local `/api/files/:id` URL. */
  url: string;
  provider: 'cloudinary' | 'local';
  createdAt: string;
  extractedText?: string;
}

/** ------------------------------------------------------------------ agents */

export type AgentId =
  | 'master'
  | 'personal'
  | 'business'
  | 'research'
  | 'knowledge'
  | 'code'
  | 'social'
  | 'messaging'
  | 'mail'
  | 'home'
  | 'automation';

export interface AgentDescriptor {
  id: AgentId;
  name: string;
  tagline: string;
  description: string;
  /** Scopes this agent may ever request. Enforced in the permission engine. */
  scopes: PermissionScope[];
  enabled: boolean;
  /** Example utterances the router uses and the console displays. */
  examples: string[];
  icon: string;
}

/** ------------------------------------------------------------------- plans */

export type StepStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'failed'
  | 'awaiting_confirmation'
  | 'denied'
  | 'skipped';

export interface PlanStep {
  id: string;
  title: string;
  /** Tool id, e.g. `home.control`. */
  tool: string;
  input: Record<string, unknown>;
  status: StepStatus;
  result?: ToolResult;
  /** Why the step needs the owner's approval, if it does. */
  confirmationReason?: string;
}

export type RunStatus =
  | 'planning'
  | 'awaiting_confirmation'
  | 'executing'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface AgentRun {
  id: string;
  sessionId: string;
  /** The raw owner request. */
  request: string;
  /** Agent the router selected. */
  agent: AgentId;
  /** Agents consulted (master may fan out). */
  consulted: AgentId[];
  status: RunStatus;
  plan: PlanStep[];
  /** Final spoken/typed answer. */
  response: string;
  /** Which model produced the plan. */
  model: string;
  /** True when the built-in deterministic planner was used instead of an LLM. */
  usedFallbackPlanner: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  ui?: UiAction[];
  suggestions?: string[];
}

/** ------------------------------------------------------------------ memory */

export type MemoryKind =
  | 'conversation'
  | 'long-term'
  | 'company'
  | 'task'
  | 'knowledge';

export interface MemoryRecord {
  id: string;
  kind: MemoryKind;
  /** Short lookup key, e.g. `preferred_tone` or `client:acme`. */
  key: string;
  value: string;
  tags: string[];
  /** Where this came from: 'owner', 'agent:business', a document id… */
  source: string;
  confidence: number;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
  /** Soft-delete / forget support. */
  deletedAt?: string;
}

/** --------------------------------------------------------------- knowledge */

export interface KnowledgeChunk {
  id: string;
  documentId: string;
  index: number;
  text: string;
  tokens: string[];
  /** term -> tf-idf weight, computed at index time. */
  vector: Record<string, number>;
}

export interface KnowledgeDocument {
  id: string;
  title: string;
  source: string;
  mimeType: string;
  bytes: number;
  url?: string;
  provider: 'cloudinary' | 'local' | 'inline';
  tags: string[];
  collection: string;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface KnowledgeHit {
  documentId: string;
  documentTitle: string;
  chunkId: string;
  text: string;
  score: number;
  source: string;
}

/** --------------------------------------------------------------- connectors */

export type ConnectorCategory =
  | 'social'
  | 'messaging'
  | 'mail'
  | 'calendar'
  | 'home'
  | 'storage'
  | 'database'
  | 'web'
  | 'device'
  | 'business';

export interface ConnectorField {
  key: string;
  label: string;
  secret: boolean;
  required: boolean;
  hint?: string;
}

export interface ConnectorManifest {
  id: string;
  name: string;
  category: ConnectorCategory;
  description: string;
  /** Credentials the owner pastes into the Control Center. */
  fields: ConnectorField[];
  scopes: PermissionScope[];
  /** What the connector can do when configured. */
  capabilities: string[];
  docsUrl?: string;
}

export interface ConnectorStatus {
  id: string;
  configured: boolean;
  /** 'live' when credentials are present, 'sandbox' when actions are simulated. */
  mode: Extract<ExecutionMode, 'live' | 'sandbox'>;
  enabled: boolean;
  missingFields: string[];
  lastCheckedAt?: string;
  lastError?: string;
  /** Non-secret configuration, safe to show in the console. */
  display: Record<string, string>;
}

/** -------------------------------------------------------------- automations */

export type TriggerType = 'schedule' | 'interval' | 'event' | 'manual';

export interface AutomationTrigger {
  type: TriggerType;
  /** interval: minutes between runs. */
  everyMinutes?: number;
  /** schedule: 24h local time "HH:MM". */
  at?: string;
  /** event: name from the runtime event bus, e.g. `inquiry.received`. */
  event?: string;
}

export interface AutomationCondition {
  type: 'always' | 'keyword' | 'field';
  /** keyword: comma-separated terms; field: dotted path. */
  value?: string;
}

export interface AutomationAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface Automation {
  id: string;
  name: string;
  description: string;
  trigger: AutomationTrigger;
  condition: AutomationCondition;
  actions: AutomationAction[];
  enabled: boolean;
  /** Whether the run reports back to the owner. */
  notify: boolean;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastStatus?: 'ok' | 'failed' | 'skipped';
  runCount: number;
}

export interface AutomationRun {
  id: string;
  automationId: string;
  automationName: string;
  trigger: string;
  status: 'ok' | 'failed' | 'skipped';
  detail: string;
  steps: { tool: string; ok: boolean; mode: ExecutionMode; summary: string }[];
  startedAt: string;
  durationMs: number;
}

/** ------------------------------------------------------------------- audit */

export interface AuditEntry {
  id: string;
  at: string;
  principalId: string;
  /** Human-readable actor label ("Owner", "Android device"). */
  actor: string;
  /** What the pipeline decided. */
  stage: 'auth' | 'permission' | 'confirmation' | 'validation' | 'execution';
  decision: 'allowed' | 'denied' | 'pending' | 'executed' | 'failed';
  action: string;
  tool?: string;
  scopes?: PermissionScope[];
  mode?: ExecutionMode;
  detail: string;
  runId?: string;
  stepId?: string;
  durationMs?: number;
}

/** ------------------------------------------------------------------- events */

export interface RuntimeEvent<T = unknown> {
  id: string;
  name: string;
  at: string;
  payload: T;
}

/** ------------------------------------------------------------- notifications */

export interface Notification {
  id: string;
  title: string;
  body: string;
  level: 'info' | 'success' | 'warning' | 'critical';
  at: string;
  read: boolean;
  source: string;
  runId?: string;
}

/** ------------------------------------------------------------- model layer */

export interface ToolSchema {
  name: string;
  description: string;
  parameters: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    description: string;
    required: boolean;
    enum?: string[];
  }[];
}

export interface ModelRequest {
  system: string;
  prompt: string;
  /** Ask the provider for a JSON object. */
  json?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Tools the model may reference in its plan. */
  tools?: ToolSchema[];
  /** Identifier used for audit + caching. */
  purpose: string;
}

export interface ModelResponse {
  text: string;
  model: string;
  provider: string;
  /** True when no external model was called (built-in planner). */
  synthetic?: boolean;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface ModelProvider {
  id: string;
  label: string;
  /** 'local' = runs on your hardware, 'cloud' = third-party endpoint. */
  locality: 'local' | 'cloud' | 'builtin';
  /** Whether the provider is usable right now. */
  probe(): Promise<{ available: boolean; detail: string }>;
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** -------------------------------------------------------------- business data */

export interface BusinessSnapshot {
  company: { name: string; industry: string; currency: string };
  priorities: { title: string; detail: string; weight: 'high' | 'medium' | 'low'; source: string }[];
  leads: { id: string; name: string; stage: string; value: number; updatedAt: string; note?: string }[];
  salesToday: { orders: number; revenue: number };
  salesThisMonth: { orders: number; revenue: number };
  expensesThisMonth: { label: string; amount: number }[];
  tasks: { id: string; title: string; due?: string; done: boolean; owner?: string }[];
  products: { id: string; name: string; price: number; tags: string[]; blurb: string }[];
  customers: { id: string; name: string; since: string; lifetimeValue: number; lastContact?: string }[];
}
