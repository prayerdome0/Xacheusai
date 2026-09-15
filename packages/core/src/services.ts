/**
 * The kernel's shared service bag.
 *
 * Everything the agents and tools need is assembled once, here, and passed down.
 * No module reaches for a global: this is what makes Xacheus testable and lets the
 * web console, the Android bridge and the automation engine share one brain.
 */
import { join } from 'node:path';
import type { ConfigStore } from './config.js';
import type { StorageDriver } from './storage/driver.js';
import type { EventBus } from './events.js';
import type { AuditLog } from './security/audit.js';
import type { PermissionEngine } from './security/permissions.js';
import type { MemoryService, ConversationStore } from './memory/memory.js';
import type { KnowledgeService } from './knowledge/knowledge.js';
import type { BusinessService } from './business/business.js';
import type { NotificationService } from './notifications.js';
import type { DeviceBridge } from './devices/bridge.js';
import type { ConnectorRegistry } from './connectors/registry.js';
import type { ModelRegistry } from './models/providers.js';
import type { CalendarService } from './personal/calendar.js';
import type { DocumentService } from './documents/documents.js';
import type { AutomationService } from './automation/automation.js';
import type { ToolRegistry } from './tools/types.js';
import type { Orchestrator } from './agents/orchestrator.js';
import type { AgentId } from './types.js';

export interface Services {
  /** 'server' on a long-lived process, 'serverless' on a function platform. */
  runtime: 'server' | 'serverless';
  config: ConfigStore;
  storage: StorageDriver;
  /** Notes from storage setup, e.g. "Firestore was requested but unusable". */
  storageNotes: string[];
  events: EventBus;
  audit: AuditLog;
  permissions: PermissionEngine;
  memory: MemoryService;
  conversations: ConversationStore;
  knowledge: KnowledgeService;
  business: BusinessService;
  notifications: NotificationService;
  devices: DeviceBridge;
  connectors: ConnectorRegistry;
  models: ModelRegistry;
  calendar: CalendarService;
  documents: DocumentService;
  automations: AutomationService;
  tools: ToolRegistry;
  /** Set by the runtime after construction to avoid a circular import. */
  orchestrator?: Orchestrator;
  /** Rebuild the model registry after the owner changes model settings. */
  reloadModels?: () => Promise<void>;
  /** Root directory Xacheus may read/write for the Code Agent. */
  workspaceRoot: string;
  dataDir: string;
}

export function uploadsDirFor(dataDir: string): string {
  return join(dataDir, 'uploads');
}

export type { AgentId };
