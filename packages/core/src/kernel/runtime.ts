/**
 * The kernel: builds every service once, wires the tools and agents together and
 * hands back a single object. The HTTP server, the automation scheduler, the
 * Android bridge and the tests all drive *this*, so there is exactly one brain.
 */
import { resolve } from 'node:path';
import { ConfigStore } from '../config.js';
import { EventBus } from '../events.js';
import { AuditLog } from '../security/audit.js';
import { PermissionEngine, ALL_SCOPES } from '../security/permissions.js';
import { createStorage } from '../storage/driver.js';
import { MemoryService, ConversationStore } from '../memory/memory.js';
import { KnowledgeService } from '../knowledge/knowledge.js';
import { BusinessService } from '../business/business.js';
import { NotificationService } from '../notifications.js';
import { DeviceBridge } from '../devices/bridge.js';
import { createConnectorRegistry } from '../connectors/index.js';
import { createModelRegistry } from '../models/providers.js';
import { CalendarService } from '../personal/calendar.js';
import { DocumentService } from '../documents/documents.js';
import { AutomationService } from '../automation/automation.js';
import { createToolRegistry } from '../tools/index.js';
import { Orchestrator } from '../agents/orchestrator.js';
import { AGENTS } from '../agents/descriptors.js';
import { Services, uploadsDirFor } from '../services.js';
import type { AgentRun, Principal } from '../types.js';
import { newId } from '../util.js';

export interface KernelOptions {
  env?: NodeJS.ProcessEnv;
  dataDir?: string;
  workspaceRoot?: string;
  /** Start the automation scheduler (default true). */
  startAutomations?: boolean;
}

export interface Kernel {
  services: Services;
  /** Run a request end to end. */
  handle(request: string, options?: { principal?: Principal; sessionId?: string; payload?: unknown }): Promise<{ run: AgentRun; messages: unknown[] }>;
  /** Approve or reject a gated step. */
  confirm(run: AgentRun, stepId: string, approve: boolean, principal?: Principal): Promise<AgentRun>;
  /** Rebuild the model layer after settings change. */
  reloadModels(): Promise<void>;
  close(): Promise<void>;
}

const OWNER: Principal = { id: 'owner', role: 'owner', displayName: 'Owner' };

export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const env = options.env ?? process.env;
  const dataDir = resolve(options.dataDir ?? env.XACHEUS_DATA_DIR ?? '.data');
  const workspaceRoot = resolve(options.workspaceRoot ?? env.XACHEUS_WORKSPACE_ROOT ?? process.cwd());

  const config = new ConfigStore(env, dataDir);
  await config.load();

  const storage = (await createStorage({
    driver: (config.value('XACHEUS_STORAGE', 'json') as 'json' | 'firestore' | 'memory') ?? 'json',
    dataDir,
    serviceAccountPath: config.value('GOOGLE_APPLICATION_CREDENTIALS'),
    serviceAccountJson: config.value('FIREBASE_SERVICE_ACCOUNT_JSON'),
  })).driver;

  const events = new EventBus(300);
  const audit = new AuditLog(dataDir);
  await audit.load();

  const permissions = new PermissionEngine(dataDir);
  await permissions.load();

  const memory = new MemoryService(storage);
  const conversations = new ConversationStore(storage);
  const knowledge = new KnowledgeService(storage);
  const business = new BusinessService(storage);
  const devices = new DeviceBridge((name, payload) => events.emit(name, payload));
  const connectors = createConnectorRegistry(config);
  const calendar = new CalendarService(storage);
  const notifications = new NotificationService(storage, devices, events);

  const documents = new DocumentService({
    config,
    storage,
    knowledge,
    memory,
    events,
    uploadsDir: uploadsDirFor(dataDir),
  });

  const tools = createToolRegistry(connectors);
  // The permission engine learns every tool so the Control Center can toggle them.
  permissions.registerTools(tools.list().map((tool) => ({ id: tool.id, scopes: tool.scopes, risk: tool.risk, requiresConfirmation: tool.requiresConfirmation })));
  permissions.registerAgents(AGENTS.map((agent) => ({ id: agent.id, scopes: agent.scopes as any, enabled: agent.enabled })));

  const automations = new AutomationService({
    storage,
    events,
    tools,
    permissions,
    audit,
    notifications,
    services: () => services,
  });

  const services = {
    config,
    storage,
    events,
    audit,
    permissions,
    memory,
    conversations,
    knowledge,
    business,
    notifications,
    devices,
    connectors,
    models: createModelRegistry(config),
    calendar,
    documents,
    automations,
    tools,
    workspaceRoot,
    dataDir,
  } as Services;

  services.reloadModels = async () => {
    services.models = createModelRegistry(config);
    events.emit('connector.updated', { note: `Model layer reloaded: ${services.models.active.label}` });
  };

  const orchestrator = new Orchestrator(services);
  services.orchestrator = orchestrator;

  if (options.startAutomations !== false) await automations.start();

  // Health notice: it is important that the owner knows when a piece is missing.
  const storageHealth = await storage.healthy();
  events.emit('connector.updated', {
    note: `Kernel started. Storage: ${storage.id} (${storageHealth.ok ? 'ok' : storageHealth.detail}). Model: ${services.models.active.label}.`,
  });

  return {
    services,
    async handle(request, options = {}) {
      const result = await orchestrator.handle({
        request,
        principal: options.principal ?? OWNER,
        sessionId: options.sessionId ?? newId('ses'),
        payload: options.payload,
      });
      return { run: result.run, messages: result.messages };
    },
    async confirm(run, stepId, approve, principal = OWNER) {
      return orchestrator.resolveConfirmation(run, stepId, approve, principal);
    },
    async reloadModels() {
      await services.reloadModels?.();
    },
    async close() {
      await automations.stop();
      await audit.close();
    },
  };
}

export { OWNER as DEFAULT_OWNER, ALL_SCOPES };
