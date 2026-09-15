/**
 * Typed API client.
 *
 * Everything goes through relative URLs so the console works behind any proxy.
 * The bearer credential is either the owner passcode or a Firebase ID token —
 * both are accepted by the backend, and both are stored only in this browser.
 */

export interface PublicConfig {
  auth: { mode: string; requiresPasscode: boolean; firebaseEnabled: boolean };
  firebase: {
    apiKey: string;
    authDomain: string;
    projectId: string;
    storageBucket: string;
    messagingSenderId: string;
    appId: string;
  };
  features: { model: string; modelBuiltin: boolean; storage: string; tools: number };
}

export interface UiAction {
  type: 'navigate' | 'open-url' | 'highlight' | 'confirm';
  target: string;
  label?: string;
}

export interface ToolResult {
  ok: boolean;
  mode: 'live' | 'sandbox' | 'dry-run' | 'blocked';
  summary: string;
  error?: string;
  data?: any;
  suggestions?: string[];
  ui?: UiAction[];
  durationMs?: number;
}

export interface PlanStep {
  id: string;
  title: string;
  tool: string;
  input: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed' | 'awaiting_confirmation' | 'denied' | 'skipped';
  result?: ToolResult;
  confirmationReason?: string;
}

export interface AgentRun {
  id: string;
  sessionId: string;
  request: string;
  agent: string;
  consulted: string[];
  status: string;
  plan: PlanStep[];
  response: string;
  model: string;
  usedFallbackPlanner: boolean;
  createdAt: string;
  updatedAt: string;
  suggestions?: string[];
  ui?: UiAction[];
}

export interface ChatMessage {
  id: string;
  sessionId: string;
  role: 'owner' | 'xacheus' | 'system' | 'tool';
  text: string;
  createdAt: string;
  runId?: string;
  meta?: Record<string, any>;
}

export interface ConnectorView {
  manifest: {
    id: string;
    name: string;
    category: string;
    description: string;
    fields: { key: string; label: string; secret: boolean; required: boolean; hint?: string }[];
    scopes: string[];
    capabilities: string[];
    docsUrl?: string;
  };
  status: {
    id: string;
    configured: boolean;
    mode: 'live' | 'sandbox';
    enabled: boolean;
    missingFields: string[];
    display: Record<string, string>;
    lastError?: string;
  };
  operations: { id: string; toolId: string; title: string; description: string; risk: string; scopes: string[]; requiresConfirmation: boolean }[];
}

const TOKEN_KEY = 'xacheus.token';
const SESSION_KEY = 'xacheus.session';

export function getToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? '';
}

export function setToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export function getSessionId(): string {
  let session = localStorage.getItem(SESSION_KEY);
  if (!session) {
    session = `web_${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(SESSION_KEY, session);
  }
  return session;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');

  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  let payload: any = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    const message = payload?.message ?? payload?.error ?? `HTTP ${response.status}`;
    throw new ApiError(typeof message === 'string' ? message : JSON.stringify(message), response.status);
  }
  return payload as T;
}

export const api = {
  publicConfig: () => request<PublicConfig>('/api/config'),
  health: () => request<{ ok: boolean; service: string; auth: string }>('/api/health'),

  chat: (text: string, sessionId?: string) =>
    request<{ run: AgentRun; messages: ChatMessage[]; awaitingConfirmation: boolean }>('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ text, sessionId }),
    }),

  confirm: (runId: string, stepId: string, approve: boolean) =>
    request<{ run: AgentRun; approved: boolean }>(`/api/runs/${runId}/confirm`, {
      method: 'POST',
      body: JSON.stringify({ stepId, approve }),
    }),

  runs: (limit = 30) => request<{ runs: AgentRun[] }>(`/api/runs?limit=${limit}`),
  pendingRuns: () => request<{ runs: AgentRun[] }>('/api/runs/pending'),
  session: (id: string) => request<{ sessionId: string; messages: ChatMessage[] }>(`/api/sessions/${id}`),
  clearSession: (id: string) => request<{ removed: number }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  stats: () => request<any>('/api/stats'),
  status: () => request<any>('/api/status'),
  agents: () => request<{ agents: any[]; grantedScopes: string[]; allScopes: string[] }>('/api/agents'),

  memory: (kind?: string) => request<{ records: any[]; counts: Record<string, number> }>(`/api/memory${kind ? `?kind=${kind}` : ''}`),
  addMemory: (body: any) => request<{ record: any }>('/api/memory', { method: 'POST', body: JSON.stringify(body) }),
  updateMemory: (id: string, body: any) => request<{ record: any }>(`/api/memory/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  forgetMemory: (id: string, hard = false) => request<{ removed: boolean }>(`/api/memory/${id}${hard ? '?hard=true' : ''}`, { method: 'DELETE' }),

  knowledge: () => request<{ documents: any[]; stats: any }>('/api/knowledge'),
  knowledgeSearch: (q: string) => request<{ hits: any[] }>(`/api/knowledge/search?q=${encodeURIComponent(q)}`),
  addKnowledgeText: (body: any) => request<any>('/api/knowledge/text', { method: 'POST', body: JSON.stringify(body) }),
  deleteKnowledge: (id: string) => request<{ removed: boolean }>(`/api/knowledge/${id}`, { method: 'DELETE' }),
  uploadDocument: async (file: File, fields: { title?: string; tags?: string; collection?: string }) => {
    const form = new FormData();
    form.set('file', file);
    for (const [key, value] of Object.entries(fields)) if (value) form.set(key, value);
    return request<any>('/api/documents', { method: 'POST', body: form });
  },

  business: () => request<{ snapshot: any }>('/api/business'),
  businessBrief: () => request<{ text: string; priorities: any[] }>('/api/business/brief'),
  addTask: (title: string, due?: string) => request<any>('/api/business/tasks', { method: 'POST', body: JSON.stringify({ title, due }) }),
  addLead: (body: any) => request<any>('/api/business/leads', { method: 'POST', body: JSON.stringify(body) }),
  updateCompany: (body: any) => request<any>('/api/business/company', { method: 'PATCH', body: JSON.stringify(body) }),

  calendar: (days = 7) => request<{ events: any[] }>(`/api/calendar?days=${days}`),
  addEvent: (body: any) => request<any>('/api/calendar', { method: 'POST', body: JSON.stringify(body) }),
  deleteEvent: (id: string) => request<any>(`/api/calendar/${id}`, { method: 'DELETE' }),

  notifications: () => request<{ notifications: any[]; unread: number }>('/api/notifications'),
  markNotificationsRead: (id?: string) => request<any>('/api/notifications/read', { method: 'POST', body: JSON.stringify({ id }) }),

  automations: () => request<{ automations: any[]; starters: any[]; runs: any[] }>('/api/automations'),
  createAutomation: (body: any) => request<{ automation: any }>('/api/automations', { method: 'POST', body: JSON.stringify(body) }),
  createStarter: (index: number) => request<{ automation: any }>('/api/automations/starters', { method: 'POST', body: JSON.stringify({ index }) }),
  updateAutomation: (id: string, body: any) => request<{ automation: any }>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteAutomation: (id: string) => request<any>(`/api/automations/${id}`, { method: 'DELETE' }),
  runAutomation: (id: string) => request<{ run: any }>(`/api/automations/${id}/run`, { method: 'POST' }),

  connectors: () => request<{ connectors: ConnectorView[]; config: Record<string, string> }>('/api/connectors'),
  verifyConnector: (id: string) => request<{ ok: boolean; detail: string }>(`/api/connectors/${id}/verify`, { method: 'POST' }),
  saveConnectorConfig: (values: Record<string, string>) =>
    request<{ ok: boolean; masked: Record<string, string>; connectors: any[]; model: string }>('/api/connectors/config', {
      method: 'POST',
      body: JSON.stringify({ values }),
    }),

  tools: () => request<{ tools: any[]; categories: string[] }>('/api/tools'),
  permissions: () => request<any>('/api/permissions'),
  setScopes: (scopes: string[], grant: boolean) =>
    request<{ grantedScopes: string[] }>('/api/permissions/scopes', { method: 'POST', body: JSON.stringify({ scopes, grant }) }),
  setToolPolicy: (id: string, body: any) => request<{ policy: any }>(`/api/permissions/tools/${id}`, { method: 'POST', body: JSON.stringify(body) }),

  audit: (params: { limit?: number; decision?: string; search?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.decision) query.set('decision', params.decision);
    if (params.search) query.set('search', params.search);
    return request<{ entries: any[]; stats: any }>(`/api/audit?${query.toString()}`);
  },

  devices: () => request<{ connected: any[]; paired: any[]; recentCommands: ToolResult[]; commands: string[] }>('/api/devices'),
  pairDevice: (deviceId: string, name: string) => request<any>('/api/devices/pair', { method: 'POST', body: JSON.stringify({ deviceId, name }) }),
  unpairDevice: (id: string) => request<any>(`/api/devices/${id}`, { method: 'DELETE' }),
  deviceCommand: (id: string, command: string, args: Record<string, unknown> = {}) =>
    request<{ result: ToolResult }>(`/api/devices/${id}/command`, { method: 'POST', body: JSON.stringify({ command, args }) }),

  models: () => request<any>('/api/models'),
  selectModel: (model: string) => request<any>('/api/models/select', { method: 'POST', body: JSON.stringify({ model }) }),
  probeModels: () => request<{ probes: any[] }>('/api/models/probe'),
};

/** Live event stream (WebSocket) for run progress and notifications. */
export function connectEvents(onEvent: (event: any) => void): () => void {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = getToken();
  const socket = new WebSocket(`${protocol}://${location.host}/api/events?token=${encodeURIComponent(token)}`);
  socket.onmessage = (message) => {
    try {
      const frame = JSON.parse(message.data);
      if (frame.type === 'hello') onEvent({ name: 'hello', payload: frame.recent });
      else if (frame.type === 'event') onEvent(frame.event);
    } catch {
      /* ignore malformed frames */
    }
  };
  return () => socket.close();
}
