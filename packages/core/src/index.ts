/**
 * @xacheus/core — the Xacheus AI agent kernel.
 *
 * Public surface:
 *   createKernel()          build the whole brain (services + tools + agents)
 *   createConnectorRegistry  just the integrations
 *   AGENTS / descriptors     the agent roster
 *   types                    every contract the server, console and Android app speak
 */
export * from './types.js';
export * from './services.js';
export * from './util.js';
export { ConfigStore, looksSecret } from './config.js';
export { EventBus, RUNTIME_EVENTS } from './events.js';
export { NotificationService } from './notifications.js';
export { AuditLog } from './security/audit.js';
export { PermissionEngine, ALL_SCOPES, DEFAULT_GRANTED_SCOPES, defaultState } from './security/permissions.js';
export {
  createStorage,
  JsonFileDriver,
  MemoryDriver,
  FirestoreDriver,
  parseServiceAccount,
  googleAccessToken,
} from './storage/driver.js';
export type { StorageDriver, ServiceAccount } from './storage/driver.js';
export { MemoryService, ConversationStore, extractFact, extractKeyValues } from './memory/memory.js';
export { KnowledgeService, chunkText } from './knowledge/knowledge.js';
export { BusinessService } from './business/business.js';
export { CalendarService, parseWhen } from './personal/calendar.js';
export { DocumentService, guessCategory } from './documents/documents.js';
export { extractText } from './documents/extract.js';
export { AutomationService, starterAutomations } from './automation/automation.js';
export { DeviceBridge, DEVICE_COMMANDS } from './devices/bridge.js';
export type { DeviceCommand, DeviceSession, DeviceSocket } from './devices/bridge.js';
export { createModelRegistry, completeWithFallback, HeuristicProvider } from './models/providers.js';
export type { ModelRegistry } from './models/providers.js';
export { createConnectorRegistry } from './connectors/index.js';
export { ConnectorRegistry } from './connectors/registry.js';
export { uploadToCloudinary, isCloudinaryReady } from './connectors/cloudinary.js';
export { extractReadable } from './connectors/web.js';
export { ToolRegistry } from './tools/types.js';
export type { Tool, ToolContext, ToolParameter } from './tools/types.js';
export { createToolRegistry, connectorTools } from './tools/index.js';
export { AGENTS, AGENT_IDS, agentDescriptor } from './agents/descriptors.js';
export { Orchestrator } from './agents/orchestrator.js';
export { buildPlan } from './agents/planner.js';
export { planHeuristically, classifyHeuristically, RULES } from './agents/rules.js';
export { draftSocialPost, draftReply, draftEmail } from './writing/writer.js';
export { verifyFirebaseIdToken } from './firebase/verify.js';
export type { FirebaseTokenResult } from './firebase/verify.js';
export { createKernel, DEFAULT_OWNER } from './kernel/runtime.js';
export type { Kernel, KernelOptions } from './kernel/runtime.js';
