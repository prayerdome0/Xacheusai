/**
 * The agent roster.
 *
 * The Master Agent is the only entry point: it routes a request, may consult
 * specialists, validates every step against the tool registry and the permission
 * engine, then reports back. Specialists never exceed their declared scopes.
 */
import type { AgentDescriptor } from '../types.js';

export const AGENTS: AgentDescriptor[] = [
  {
    id: 'master',
    name: 'Xacheus Master Agent',
    tagline: 'Plans, routes and coordinates everything.',
    description:
      'Understands the request, decides which specialists to involve, builds an ordered plan of tool calls, checks permissions and confirmations, executes, then reports what actually happened.',
    scopes: ['*'] as any,
    enabled: true,
    icon: '🧠',
    examples: ['Xacheus, handle this for me', 'What do I have today?', 'Research this company and prepare a prospect report'],
  },
  {
    id: 'personal',
    name: 'Personal Agent',
    tagline: 'Your day: calendar, reminders, notes, phone.',
    description: 'Manages reminders, schedule, tasks, notes and recurring routines, and mirrors them onto your Android device.',
    scopes: ['calendar:read', 'calendar:write', 'memory:read', 'knowledge:write', 'device:control', 'device:read', 'business:read'],
    enabled: true,
    icon: '📅',
    examples: ['Remind me tomorrow morning to check the website', 'What is on my calendar?', 'Add a note about the supplier call'],
  },
  {
    id: 'business',
    name: 'Business Agent',
    tagline: 'Products, customers, leads, sales, expenses.',
    description:
      'Answers from your live business data: today\'s priorities, the pipeline, margins, open tasks and the follow-ups that matter.',
    scopes: ['business:read', 'business:write', 'knowledge:read', 'memory:read', 'memory:write', 'web:read'],
    enabled: true,
    icon: '💼',
    examples: ['Show me today\'s business priorities', 'Which leads have gone quiet?', 'What did I sell this month?'],
  },
  {
    id: 'research',
    name: 'Research Agent',
    tagline: 'Search, read, compare, report.',
    description: 'Searches the web, reads pages, extracts facts, compares options and produces cited reports saved to your knowledge base.',
    scopes: ['web:read', 'knowledge:read', 'knowledge:write', 'memory:read', 'memory:write'],
    enabled: true,
    icon: '🌐',
    examples: ['Research this company and prepare a prospect report', 'Compare these two suppliers', 'Search the web for import rules'],
  },
  {
    id: 'knowledge',
    name: 'Knowledge Agent',
    tagline: 'Your documents become answers.',
    description: 'Indexes PDFs, documents, notes and reports, then answers questions strictly from them with the passages used.',
    scopes: ['knowledge:read', 'knowledge:write', 'memory:read', 'memory:write'],
    enabled: true,
    icon: '📚',
    examples: ['What does our refund policy say?', 'Search my documents for the delivery terms', 'How many documents are indexed?'],
  },
  {
    id: 'code',
    name: 'Code Agent',
    tagline: 'Read, explain, search, patch and test your projects.',
    description:
      'Works inside a sandboxed project root: explains files, finds patterns and bugs, searches the codebase, proposes patches and runs allow-listed test commands with your approval.',
    scopes: ['code:read', 'code:write', 'code:execute'],
    enabled: true,
    icon: '🧑‍💻',
    examples: ['Explain src/index.ts', 'Search the codebase for TODO', 'Run the tests'],
  },
  {
    id: 'social',
    name: 'Social Agent',
    tagline: 'Facebook and Instagram, prepared and approved.',
    description:
      'Drafts and plans content from your catalogue and brand tone, then publishes to Facebook Pages and Instagram Business accounts through the official APIs once you approve.',
    scopes: ['social:read', 'social:draft', 'social:publish', 'memory:read', 'knowledge:read', 'business:read'],
    enabled: true,
    icon: '📣',
    examples: ['Create a Facebook post for this product', 'Prepare tomorrow\'s Instagram content', 'What is my engagement this week?'],
  },
  {
    id: 'messaging',
    name: 'WhatsApp Agent',
    tagline: 'Understand, draft, escalate, reply.',
    description:
      'Reads incoming WhatsApp messages, classifies the intent, drafts replies grounded in your knowledge base and sends only after your approval. Important conversations are escalated to you.',
    scopes: ['messaging:read', 'messaging:draft', 'messaging:send', 'business:write', 'knowledge:read', 'memory:read'],
    enabled: true,
    icon: '💬',
    examples: ['Draft a reply to the last WhatsApp inquiry', 'Who messaged us today?', 'Send a message to this customer after I approve'],
  },
  {
    id: 'mail',
    name: 'Mail Agent',
    tagline: 'Triage, summarise, draft, follow up.',
    description: 'Organises email: summarises the inbox, classifies inquiries, drafts replies and follow-ups, and sends only with permission.',
    scopes: ['mail:read', 'mail:draft', 'mail:send', 'business:write', 'knowledge:read'],
    enabled: true,
    icon: '📧',
    examples: ['Summarise my email', 'Draft a reply to the supplier', 'Which emails need an answer today?'],
  },
  {
    id: 'home',
    name: 'Xacheus Home Agent',
    tagline: 'Your smart home, by voice.',
    description:
      'Controls lights, switches, plugs, fans, thermostats, cameras, TVs, speakers and supported locks through Home Assistant — including whole-area commands like "turn off everything downstairs".',
    scopes: ['home:read', 'home:control', 'device:control'],
    enabled: true,
    icon: '🏠',
    examples: ['Turn on the living-room light', 'Turn off everything downstairs', 'What devices are on?'],
  },
  {
    id: 'automation',
    name: 'Automation Agent',
    tagline: 'Trigger → condition → action → notification.',
    description:
      'Builds and runs background rules: inquiry handling, scheduled briefs, page watching and follow-up sweeps. Anything requiring approval is escalated instead of executed.',
    scopes: ['automation:read', 'automation:write', 'business:write', 'knowledge:write', 'memory:write'],
    enabled: true,
    icon: '⚙️',
    examples: ['Brief me every morning at 7:30', 'When an inquiry arrives, draft a reply', 'Watch this page for changes'],
  },
];

export const AGENT_IDS = AGENTS.map((agent) => agent.id);

export function agentDescriptor(id: string): AgentDescriptor | undefined {
  return AGENTS.find((agent) => agent.id === id);
}
