/**
 * The built-in planner.
 *
 * A deterministic intent router + planner, written as an ordered rule table. This
 * is what makes Xacheus fully functional with **no language model at all** — and
 * it is also the safety net: whenever a model is configured but returns
 * something unparseable, planning falls back here instead of failing.
 *
 * Rules are ordered by specificity: the first match wins.
 */
import type { AgentId, PermissionScope } from '../types.js';

/** Scope names the permission rules can resolve to. */
const ALL_SCOPE_TOKENS: PermissionScope[] = [
  'memory:read', 'memory:write', 'knowledge:read', 'knowledge:write', 'web:read',
  'business:read', 'business:write', 'social:read', 'social:draft', 'social:publish',
  'messaging:read', 'messaging:draft', 'messaging:send', 'mail:read', 'mail:draft', 'mail:send',
  'calendar:read', 'calendar:write', 'home:read', 'home:control', 'device:read', 'device:control',
  'code:read', 'code:write', 'code:execute', 'automation:read', 'automation:write', 'admin:control',
];

export interface PlannedStep {
  title: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface PlanResult {
  agent: AgentId;
  steps: PlannedStep[];
  confidence: number;
  /** Set when the rule knows how to answer from data alone. */
  note?: string;
  suggestions?: string[];
}

interface Rule {
  id: string;
  agent: AgentId;
  pattern: RegExp;
  /** Build steps from the match. Return null to fall through to the next rule. */
  build: (match: RegExpMatchArray, request: string) => PlannedStep[] | null;
  suggestions?: string[];
}

const step = (tool: string, input: Record<string, unknown> = {}, title?: string): PlannedStep => ({
  title: title ?? `Run ${tool}`,
  tool,
  input,
});

const clean = (value?: string): string =>
  (value ?? '')
    .replace(/^[\s,:;.-]+/, '')
    .replace(/[\s,.;]+$/, '')
    .replace(/\s+(please|thanks|thank you)$/i, '')
    .trim();

/** Split "...at 8am" / "...tomorrow morning" off the end of a phrase. */
const WHEN_WORDS = 'tomorrow(?:\\s+(?:morning|afternoon|evening|night))?|today(?:\\s+\\w+)?|tonight|this\\s+\\w+|next\\s+\\w+(?:\\s+\\w+)?|in\\s+\\d+\\s+\\w+|at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|on\\s+\\w+|(?:mon|tues|wednes|thurs|fri|satur|sun)day(?:\\s+\\w+)?';

/**
 * Split a time expression out of a phrase, whether it leads ("tomorrow morning
 * to check the website") or trails ("call the supplier at 3pm").
 */
function splitWhen(text: string): { text: string; when: string } {
  const leading = text.match(new RegExp(`^(?:the\\s+)?(${WHEN_WORDS})\\s+(?:to\\s+)?(.+)$`, 'i'));
  if (leading) return { text: clean(leading[2]), when: clean(leading[1]) };

  const trailing = text.match(new RegExp(`^(.+?)\\s+(?:at|on|by|in|${WHEN_WORDS})\\s+(.+)$`, 'i'));
  if (trailing) {
    const when = trailing[0].slice(trailing[1].length).trim().replace(/^(at|on|by|in)\s+/i, '');
    return { text: clean(trailing[1]), when: clean(when) };
  }
  return { text: clean(text.replace(/^to\s+/i, '')), when: '' };
}

const PLATFORM = (value: string): string => {
  const lower = value.toLowerCase();
  if (lower.includes('instagram') || lower === 'ig') return 'instagram';
  if (lower.includes('whatsapp') || lower === 'wa') return 'whatsapp';
  if (lower.includes('facebook') || lower.includes('fb') || lower.includes('page')) return 'facebook';
  return 'facebook';
};

export const RULES: Rule[] = [
  // ------------------------------------------------------------- meta / system
  {
    id: 'capabilities',
    agent: 'master',
    pattern: /^(help|what can you do|what are you capable of|capabilities|commands|how do i use you)\b/i,
    build: () => [step('system.capabilities', {}, 'List agents, tools and connectors')],
  },
  {
    id: 'status',
    agent: 'master',
    pattern: /\b(status|are you (connected|online)|what'?s? (connected|running))\b/i,
    build: () => [step('system.status', {}, 'Check platform status'), step('connectors.list', {}, 'Check connector modes')],
  },
  {
    id: 'automation-list',
    agent: 'automation',
    pattern: /\b(show|list|what|which|do i have|are there)\b[^?]*\bautomations?\b|\bwhat'?s? running in the background\b/i,
    build: () => [step('automation.list', {}, 'List automations')],
  },
  {
    id: 'navigate',
    agent: 'master',
    pattern: /\b(open|show|go to|take me to|bring up)\s+(?:my\s+|the\s+)?(dashboard|memory|knowledge|automations?|connectors?|devices?|audit|settings|code|business|chat|control center)\b/i,
    build: (match) => {
      const view = (match[2] ?? 'dashboard').toLowerCase().replace(/s$/, '');
      return [step('system.navigate', { view: view === 'control center' ? 'settings' : view }, `Open ${view}`)];
    },
  },
  {
    id: 'audit',
    agent: 'master',
    pattern: /\b(activity log|audit log|what have you (done|been doing)|recent activity)\b/i,
    build: () => [step('audit.recent', { limit: 20 }, 'Read the activity log')],
  },
  {
    id: 'connectors-missing',
    agent: 'master',
    pattern: /\b(what'?s? not connected|which connectors? (are )?(missing|need)|what needs credentials|sandbox mode)\b/i,
    build: () => [step('connectors.list', {}, 'List connector status')],
  },
  {
    id: 'verify-connector',
    agent: 'master',
    pattern: /\b(verify|test|check)\s+(?:the\s+)?(facebook|instagram|whatsapp|mail|email|home|cloudinary|firebase|web|device|api)\s*(?:connector|connection)?\b/i,
    build: (match) => {
      const alias = (match[2] ?? '').toLowerCase();
      const id = alias === 'email' ? 'mail' : alias;
      return [step('connectors.verify', { connectorId: id }, `Verify ${id} connector`)];
    },
  },
  {
    id: 'grant-permission',
    agent: 'master',
    pattern: /\b(grant|allow|give me|enable|revoke|remove)\b\s+(?:permission (?:for|to)\\s*)?(?<what>[a-z: ]{3,40})$/i,
    build: (match) => {
      const raw = clean(match.groups?.what ?? '').toLowerCase();
      const revoke = /^(revoke|remove)/i.test(match[1] ?? '');
      const scopeMap: [RegExp, string][] = [
        [/home|light|switch|plug|thermostat/, 'home:control'],
        [/publish|post to|facebook|instagram/, 'social:publish'],
        [/whatsapp|message customer|send message/, 'messaging:send'],
        [/send (?:an )?email|smtp/, 'mail:send'],
        [/send email|mail:send/, 'mail:send'],
        [/camera|phone control|device control|control my phone/, 'device:control'],
        [/run code|execute|terminal|shell/, 'code:execute'],
        [/write (?:to )?(?:my )?files|edit (?:my )?code|code:write/, 'code:write'],
        [/admin|control center/, 'admin:control'],
        [/calendar/, 'calendar:write'],
        [/web|browse|search/, 'web:read'],
        [/business write|update (?:my )?business/, 'business:write'],
      ];
      const found = scopeMap.find(([pattern]) => pattern.test(raw));
      const scopes = found ? [found[1]] : ALL_SCOPE_TOKENS.filter((scope) => scope.includes(raw.replace(/\s+/g, ':')));
      if (!scopes.length) return null;
      return [step('permissions.set', { scopes, grant: !revoke }, `${revoke ? 'Revoke' : 'Grant'} ${scopes.join(', ')}`)];
    },
  },
  {
    id: 'model',
    agent: 'master',
    pattern: /\b(use|switch to|change to|set)\s+(?:the\s+)?(heuristic|built[- ]?in|local|ollama|openai|anthropic|claude|gpt)\s*(model)?\b/i,
    build: (match) => {
      const raw = (match[2] ?? '').toLowerCase();
      const model = raw.includes('ollama') || raw === 'local'
        ? 'ollama'
        : raw.includes('anthropic') || raw.includes('claude')
          ? 'anthropic'
          : raw.includes('openai') || raw.includes('gpt')
            ? 'openai-compatible'
            : 'heuristic';
      return [step('system.setModel', { model }, `Switch model layer to ${model}`)];
    },
  },

  // ------------------------------------------------------------------- briefs
  {
    id: 'brief',
    agent: 'business',
    pattern:
      /\b(what do i have (today|on|going)|what(?:'?s| is| are)? (?:on|up|happening)(?: for me| today| my plate)?|what'?s? (my|the) (day|plate)|today'?s? (brief|priorities)|my brief|daily brief|good morning|morning brief|business priorities|what should i (do|focus on) today)\b/i,
    build: () => [
      step('business.todayBrief', {}, 'Build the business brief'),
      step('calendar.agenda', {}, 'Check the agenda'),
      step('personal.brief', {}, 'Assemble the daily brief'),
    ],
    suggestions: ['Draft follow-ups for the open inquiries', 'What did I sell this month?', 'Show me stale leads'],
  },
  {
    id: 'agenda',
    agent: 'personal',
    pattern: /\b(what'?s? on my (calendar|schedule)|my (calendar|schedule|agenda)|upcoming (events|appointments|meetings)|do i have (any )?(meetings|appointments)|this week look like)\b/i,
    build: () => [step('calendar.agenda', { days: 7 }, 'Read the agenda for the next week')],
  },
  {
    id: 'reminder',
    agent: 'personal',
    pattern: /\bremind me\b(?<rest>.+)/i,
    build: (match) => {
      const rest = clean((match.groups?.rest ?? '').replace(/^to\s+/i, ''));
      if (!rest) return null;
      const { text, when } = splitWhen(rest);
      return [step('reminder.create', { text: text || rest, when: when || 'in 1 hour' }, `Set a reminder: ${text || rest}`)];
    },
  },
  {
    id: 'calendar-create',
    agent: 'personal',
    pattern: /\b(schedule|book|add|create|set up)\s+(?:a\s+)?(?:new\s+)?(?:meeting|event|appointment|call)\b(?<rest>.*)/i,
    build: (match) => {
      const rest = clean(match.groups?.rest ?? '');
      const { text, when } = splitWhen(rest);
      if (!text) return null;
      return [step('calendar.create', { title: text, when: when || 'tomorrow at 10am' }, `Schedule "${text}"`)];
    },
  },
  {
    id: 'schedule-with-when',
    agent: 'personal',
    pattern: /\b(?:schedule|book)\s+(?<title>.+?)\s+(?:for|at|on)\s+(?<when>.+)$/i,
    build: (match) => {
      const title = clean(match.groups?.title);
      const when = clean(match.groups?.when);
      if (!title || !when) return null;
      return [step('calendar.create', { title, when }, `Schedule "${title}"`)];
    },
  },
  {
    id: 'cancel-calendar',
    agent: 'personal',
    pattern: /\b(cancel|delete|remove)\s+(?:my\s+|the\s+)?(?<rest>.*(?:reminder|event|meeting|appointment).*)/i,
    build: (match) => {
      const hint = clean((match.groups?.rest ?? '').replace(/\b(reminder|event|meeting|appointment)\b/gi, ''));
      if (!hint) return null;
      return [step('calendar.cancel', { hint }, `Cancel "${hint}"`)];
    },
  },

  // ------------------------------------------------------------------ memory
  {
    id: 'remember',
    agent: 'master',
    pattern: /\b(remember|note that|keep in mind|don'?t forget)\b\s+(?<value>.+)/i,
    build: (match) => {
      const value = clean(match.groups?.value);
      if (!value) return null;
      return [step('memory.remember', { value }, 'Store this in memory')];
    },
  },
  {
    id: 'forget',
    agent: 'master',
    pattern: /\b(forget|delete (the )?memory|remove (the )?memory)\b\s+(?<query>.+)/i,
    build: (match) => {
      const query = clean(match.groups?.query);
      if (!query) return null;
      return [step('memory.forget', { query }, `Forget "${query}"`)];
    },
  },
  {
    id: 'recall',
    agent: 'knowledge',
    pattern: /\b(what do you know about|what do we know about|do you remember|what did i (say|tell you) about)\b\s+(?<query>.+)/i,
    build: (match) => {
      const query = clean(match.groups?.query);
      if (!query) return null;
      return [
        step('research.digestQuestion', { question: query }, `Answer from your own data: ${query}`),
        step('memory.recall', { query }, 'Check memory'),
      ];
    },
    suggestions: ['Search the web for this too', 'Save what you find as a note'],
  },
  {
    id: 'document-search',
    agent: 'knowledge',
    pattern: /\b(search|look (?:in|through)|find (?:in)?)\s+(?:my\s+)?(documents?|files?|knowledge base|notes?|papers?)\b\s*(?:for\s+)?(?<query>.*)/i,
    build: (match) => {
      const query = clean(match.groups?.query);
      return [step('knowledge.search', query ? { query } : {}, 'Search the knowledge base')];
    },
  },
  {
    id: 'knowledge-stats',
    agent: 'knowledge',
    pattern: /\b(how many documents|knowledge base status|what'?s? in my knowledge)\b/i,
    build: () => [step('knowledge.stats', {}, 'Knowledge base overview'), step('knowledge.list', {}, 'List documents')],
  },

  // ---------------------------------------------------------------- business
  {
    id: 'products',
    agent: 'business',
    pattern: /\b(show|list|what are|tell me)\b.*\b(products?|catalogue|catalog|inventory|prices?)\b/i,
    build: () => [step('business.snapshot', {}, 'Read the product catalogue')],
  },
  {
    id: 'leads',
    agent: 'business',
    pattern: /\b(show|list|what are|who are|how many)\b.*\b(leads?|pipeline|prospects?|customers?)\b/i,
    build: () => [step('business.snapshot', {}, 'Read the pipeline')],
  },
  {
    id: 'stale-leads',
    agent: 'business',
    pattern: /\b(stale|gone quiet|not heard|follow[- ]?ups?)\b.*\b(leads?|deals?|customers?)\b|\bwhich leads (are )?(quiet|stale)\b/i,
    build: () => [step('business.expireStaleLeads', { days: 14 }, 'Sweep for stale leads'), step('business.todayBrief', {}, 'Show the pipeline brief')],
  },
  {
    id: 'add-lead',
    agent: 'business',
    pattern: /\b(add|new|record)\s+(?:a\s+)?lead\b\s*(?<name>.*)/i,
    build: (match) => {
      const name = clean(match.groups?.name);
      if (!name) return null;
      return [step('business.addLead', { name }, `Add lead ${name}`)];
    },
  },
  {
    id: 'add-task',
    agent: 'business',
    pattern: /\b(?:add|create|new)\s+(?:a\s+)?task\b\s*(?<title>.*)/i,
    build: (match) => {
      const title = clean(match.groups?.title);
      if (!title) return null;
      return [step('business.addTask', { title }, `Add task: ${title}`)];
    },
  },
  {
    id: 'complete-task',
    agent: 'business',
    pattern: /\b(complete|finish|done with|close)\s+(?:the\s+)?task\b\s*(?<title>.*)/i,
    build: (match) => {
      const title = clean(match.groups?.title);
      if (!title) return null;
      return [step('business.completeTask', { title }, `Complete task: ${title}`)];
    },
  },
  {
    id: 'tasks',
    agent: 'business',
    pattern: /\b(my|show|list|what are)\b.*\btasks?\b/i,
    build: () => [step('business.snapshot', {}, 'Read open tasks')],
  },
  {
    id: 'sales',
    agent: 'business',
    pattern: /\b(sales|revenue|how much did i (sell|make)|margin|expenses)\b/i,
    build: () => [step('business.todayBrief', {}, 'Read sales and margin')],
  },
  {
    id: 'import-csv',
    agent: 'business',
    pattern: /\bimport\b.*\b(csv|spreadsheet|contacts|products)\b/i,
    build: () => null,
    suggestions: ['Upload the CSV in the Control Center, or paste it and I will import it.'],
  },

  // ----------------------------------------------------------------- content
  {
    id: 'social-draft',
    agent: 'social',
    pattern: /\b(create|write|draft|make|prepare|give me)\b.*\b(facebook|instagram|ig|whatsapp|social)\b.*\b(posts?|content|caption|update|ad)\b(?<rest>.*)/i,
    build: (match) => {
      const platform = PLATFORM(match[2] ?? 'facebook');
      const stripped = clean(match.groups?.rest ?? '').replace(/^(for|about|on|regarding|promoting)\s+/i, '');
      const generic = !stripped || /^(this|the|our|my)\s+(product|item|offer|service)s?$/i.test(stripped);
      const topic = generic ? 'our latest offer' : stripped;
      return [step('content.draftSocial', { topic, platform }, `Draft a ${platform} post about ${topic}`)];
    },
    suggestions: ['Publish this to Facebook', 'Make it shorter', 'Plan a week of content around it'],
  },
  {
    id: 'social-publish',
    agent: 'social',
    pattern: /\b(publish|post)\b(?<rest>.*)\b(facebook|page|instagram|ig)\b/i,
    build: (match) => {
      const platform = PLATFORM(match[3] ?? 'facebook');
      const rest = clean(match.groups?.rest?.replace(/^(this|it|the post|to (my )?)\s*/i, ''));
      const input: Record<string, unknown> = {};
      if (rest) input.message = rest;
      else input.message = '{{last-draft}}';
      return platform === 'instagram'
        ? [step('content.draftSocial', { topic: rest || 'launch', platform: 'instagram' }, 'Prepare the Instagram caption'), step('instagram.publishPhoto', { caption: rest || 'launch', imageUrl: '{{product-image}}' }, 'Publish to Instagram')]
        : [step('facebook.createPost', input, 'Publish to the Facebook Page')];
    },
  },
  {
    id: 'campaign',
    agent: 'social',
    pattern: /\b(plan|prepare|schedule)\b.*\b(content|campaign|posts?)\b/i,
    build: (match) => {
      const rest = clean((match[1] ?? '').toString());
      const goalMatch = match[0].match(/\b(?:for|about|around)\s+(.+)$/i);
      const goal = clean(goalMatch?.[1]) || rest || 'grow enquiries this week';
      return [step('content.campaignPlan', { goal, days: 3 }, `Plan content for: ${goal}`)];
    },
    suggestions: ['Publish day 1', 'Change the tone', 'Save the plan as a note'],
  },
  {
    id: 'tone',
    agent: 'social',
    pattern: /\b(?:my\s+)?(?:brand\s+)?(tone|voice|style)\s+(?:is|should be|to)\s+(?<tone>.+)/i,
    build: (match) => {
      const tone = clean(match.groups?.tone);
      if (!tone) return null;
      return [step('content.toneGuide', { tone }, 'Save the brand tone')];
    },
  },
  {
    id: 'reply-draft',
    agent: 'messaging',
    pattern: /\b(draft|write|prepare)\s+(?:a\s+)?reply\b(?<rest>.*)|\breply to (?:this|the) (?:customer|message|inquiry)\b(?<rest2>.*)/i,
    build: (match) => {
      const rest = clean(match.groups?.rest ?? match.groups?.rest2 ?? '');
      const quoted = rest.match(/[:"']\s*(.+)$/);
      const message = quoted?.[1] ? clean(quoted[1]) : rest || 'the most recent customer inquiry';
      return [step('content.draftReply', { message }, 'Draft a reply')];
    },
    suggestions: ['Send it after I approve', 'Record them as a lead'],
  },
  {
    id: 'whatsapp-send',
    agent: 'messaging',
    pattern: /\b(send|message|text)\b.*\b(whatsapp|wa)\b(?<rest>.*)/i,
    build: (match) => {
      const rest = clean(match.groups?.rest);
      const toMatch = rest.match(/\b(?:to\s+)?(\+?\d[\d\s-]{6,})/);
      const bodyMatch = rest.match(/\b(?:saying|that|message:?)\s+(.+)$/i);
      if (!toMatch?.[1]) return null;
      return [
        step(
          'whatsapp.sendMessage',
          { to: toMatch[1].replace(/[\s-]/g, ''), body: clean(bodyMatch?.[1]) },
          `Send a WhatsApp message to ${toMatch[1]}`,
        ),
      ];
    },
  },

  // -------------------------------------------------------------------- mail
  {
    id: 'mail-summarize',
    agent: 'mail',
    pattern: /\b(summarise|summarize|check|read|show|any)\b.*\b(mail|email|inbox|messages)\b/i,
    build: () => [step('mail.summarize', { limit: 10 }, 'Summarise the inbox')],
    suggestions: ['Draft replies for the inquiries', 'Turn the important ones into tasks'],
  },
  {
    id: 'mail-draft',
    agent: 'mail',
    pattern: /\b(draft|write|compose)\b.*\b(email|mail)\b(?<rest>.*)/i,
    build: (match) => {
      const rest = clean(match.groups?.rest);
      const toMatch = rest.match(/\b(?:to\s+)?([\w.+-]+@[\w.-]+)/);
      const purpose = clean(rest.replace(/to\s+[\w.+-]+@[\w.-]+/i, '').replace(/^(about|regarding|saying)\s+/i, ''));
      return [step('content.draftEmail', { purpose: purpose || 'follow up', to: toMatch?.[1] }, 'Draft an email')];
    },
  },
  {
    id: 'mail-send',
    agent: 'mail',
    pattern: /\bsend\b.*\b(email|mail)\b(?<rest>.*)/i,
    build: (match) => {
      const rest = clean(match.groups?.rest);
      const toMatch = rest.match(/([\w.+-]+@[\w.-]+)/);
      if (!toMatch?.[1]) return null;
      return [step('mail.send', { to: toMatch[1], subject: 'Following up', body: clean(rest.replace(toMatch[1], '')) || 'Following up as discussed.' }, `Send an email to ${toMatch[1]}`)];
    },
  },
  {
    id: 'mail-followups',
    agent: 'mail',
    pattern: /\b(follow[- ]?ups?|what needs an answer|who needs a reply)\b/i,
    build: () => [step('mail.summarize', { limit: 15, unreadOnly: true }, 'Find messages needing an answer')],
  },

  // ---------------------------------------------------------------- research
  {
    id: 'prospect',
    agent: 'research',
    pattern: /\b(research|investigate|look into|find out about|prospect|due diligence on|prepare a (?:prospect )?report on)\b\s+(?<company>.+)/i,
    build: (match) => {
      const company = clean(match.groups?.company)?.replace(/\b(and|then)\s+(prepare|write|make).*/i, '').trim();
      if (!company) return null;
      return [step('research.prospectReport', { company }, `Research ${company}`)];
    },
    suggestions: ['Draft an opening message', 'Add them as a lead', 'Research their competitors'],
  },
  {
    id: 'compare',
    agent: 'research',
    pattern: /\bcompare\b\s+(?<options>.+)/i,
    build: (match) => {
      const raw = clean(match.groups?.options);
      const options = raw.split(/\s+(?:vs\.?|versus|and|or)\s+/i).map((option) => clean(option)).filter(Boolean);
      if (options.length < 2) return null;
      return [step('research.compare', { options }, `Compare ${options.join(' vs ')}`)];
    },
  },
  {
    id: 'read-url',
    agent: 'research',
    pattern: /\b(summarise|summarize|read|fetch|open|what does)\b.*?(https?:\/\/\S+)/i,
    build: (match) => {
      const url = (match[2] ?? '').replace(/[),.]+$/, '');
      return [
        step('web.readPage', { url }, `Read ${url}`),
        step('knowledge.ingestText', { title: url, text: '{{last-result}}', collection: 'research' }, 'Save the page to the knowledge base'),
      ];
    },
  },
  {
    id: 'web-search',
    agent: 'research',
    pattern: /\b(search|google|look up|find)\b\s*(?:the web|online|on the internet|for)?\s*(?<query>.+)/i,
    build: (match) => {
      const query = clean(match.groups?.query);
      if (!query || query.length < 2) return null;
      return [step('web.search', { query, count: 6 }, `Search the web for "${query}"`)];
    },
    suggestions: ['Read the top result', 'Save this to my knowledge base'],
  },

  // ------------------------------------------------------------- smart home
  {
    id: 'home-area',
    agent: 'home',
    pattern: /\bturn\s+(on|off)\s+(?:everything|all(?:\s+the)?\s+(?:lights|devices)?)\s*(?:in|on|downstairs|upstairs|in the)?\s*(?<area>.*)/i,
    build: (match) => {
      const action = (match[1] ?? 'off').toLowerCase();
      const area = clean(match.groups?.area) || 'downstairs';
      return [step('home.setByDescription', { target: area, action }, `Turn ${action} everything in ${area}`)];
    },
  },
  {
    id: 'home-area-simple',
    agent: 'home',
    pattern: /\bturn\s+(on|off)\s+(?:the\s+)?(?<area>downstairs|upstairs|kitchen|living room|living-room|bedroom|office|garage|garden|whole house|everything)\b/i,
    build: (match) => {
      const action = (match[1] ?? 'off').toLowerCase();
      return [step('home.setByDescription', { target: clean(match.groups?.area), action }, `Turn ${action} ${match.groups?.area}`)];
    },
  },
  {
    id: 'home-device',
    agent: 'home',
    pattern: /\bturn\s+(on|off)\s+(?:the\s+)?(?<target>.+)/i,
    build: (match) => {
      const action = (match[1] ?? 'off').toLowerCase();
      const target = clean(match.groups?.target);
      if (!target) return null;
      return [step('home.setByDescription', { target, action }, `Turn ${action} ${target}`)];
    },
  },
  {
    id: 'home-set-level',
    agent: 'home',
    pattern: /\b(dim|brighten|set)\s+(?:the\s+)?(?<target>.+?)\s+to\s+(?<level>\d{1,3})\s*%?/i,
    build: (match) => [
      step('home.setByDescription', { target: clean(match.groups?.target), action: 'on', brightnessPct: Number(match.groups?.level) }, 'Set the light level'),
    ],
  },
  {
    id: 'home-status',
    agent: 'home',
    pattern: /\b(what'?s? (on|off)|which (devices|lights) are on|list (my )?(devices|lights)|smart home status)\b/i,
    build: () => [step('home.listEntities', {}, 'List smart-home devices')],
  },

  // -------------------------------------------------------------- phone/device
  {
    id: 'device-open-app',
    agent: 'personal',
    pattern: /\bopen\s+(?:the\s+)?(?:app\s+)?(?<app>whatsapp|facebook|instagram|youtube|camera|maps|chrome|gmail|settings|calendar|clock|spotify|telegram|tiktok|bank|notes)\b/i,
    build: (match) => [step('device.action', { command: 'device.openApp', args: { app: clean(match.groups?.app) } }, `Open ${match.groups?.app}`)],
  },
  {
    id: 'device-open-url',
    agent: 'personal',
    pattern: /\bopen\s+(?<url>[\w.-]+\.(?:com|net|org|io|ai|app|ng|co|uk|dev)(?:\.\w+)?(?:\/\S*)?)\b/i,
    build: (match) => [step('device.action', { command: 'device.openUrl', args: { url: match.groups?.url } }, `Open ${match.groups?.url}`)],
  },
  {
    id: 'device-photo',
    agent: 'personal',
    pattern: /\btake a (photo|picture|selfie)\b/i,
    build: () => [step('device.action', { command: 'device.takePhoto', args: {} }, 'Take a photo')],
  },
  {
    id: 'device-battery',
    agent: 'personal',
    pattern: /\b(battery|charge level)\b/i,
    build: () => [step('device.action', { command: 'device.batteryStatus', args: {} }, 'Check battery')],
  },
  {
    id: 'device-location',
    agent: 'personal',
    pattern: /\b(where am i|my location|current location)\b/i,
    build: () => [step('device.action', { command: 'device.location', args: {} }, 'Get location')],
  },
  {
    id: 'device-call',
    agent: 'personal',
    pattern: /\b(call|dial|phone)\s+(?<who>[\w\s+()-]{3,})/i,
    build: (match) => {
      const value = clean(match.groups?.who);
      if (!value) return null;
      const number = value.replace(/[^\d+]/g, '');
      return [step('device.action', { command: 'device.call', args: number.length >= 6 ? { number } : { contact: value } }, `Call ${value}`)];
    },
  },
  {
    id: 'device-sms',
    agent: 'personal',
    pattern: /\b(?:send (?:an? )?(?:sms|text)|text)\s+(?<who>\+?[\d\s-]{6,}|[A-Z][\w]*(?:\s+[A-Z][\w]*)?)\s+(?:saying|that|:)?\s*(?<body>.*)/i,
    build: (match) => {
      const who = clean(match.groups?.who);
      if (!who) return null;
      const number = who.replace(/[^\d+]/g, '');
      return [
        step(
          'device.action',
          { command: 'device.sendSms', args: { ...(number.length >= 6 ? { number } : { contact: who }), body: clean(match.groups?.body) } },
          `Text ${who}`,
        ),
      ];
    },
  },
  {
    id: 'device-media',
    agent: 'personal',
    pattern: /\b(play|pause|next|previous|skip|stop)\b.*\b(music|song|media|track|playback)\b|\b(pause|play) (the )?(music|song)\b/i,
    build: (match) => {
      const action = (match[1] ?? match[3] ?? 'play').toLowerCase();
      return [step('device.action', { command: 'device.mediaControl', args: { action } }, `${action} media`)];
    },
  },
  {
    id: 'device-notifications',
    agent: 'personal',
    pattern: /\b(my )?notifications\b.*\b(what|show|read|check|list)\b|\b(what'?s? in my notifications)\b/i,
    build: () => [step('device.action', { command: 'device.listNotifications', args: {} }, 'Read notifications')],
  },
  {
    id: 'device-torch',
    agent: 'personal',
    pattern: /\b(torch|flashlight)\b/i,
    build: (match) => {
      const on = !/\boff\b/i.test(match[0]);
      return [step('device.action', { command: 'device.torch', args: { on } }, `Turn the torch ${on ? 'on' : 'off'}`)];
    },
  },
  {
    id: 'device-vibrate',
    agent: 'personal',
    pattern: /\b(vibrate|buzz my phone)\b/i,
    build: () => [step('device.action', { command: 'device.vibrate', args: {} }, 'Vibrate the phone')],
  },
  {
    id: 'device-clipboard',
    agent: 'personal',
    pattern: /\b(clipboard)\b/i,
    build: () => [step('device.action', { command: 'device.readClipboard', args: {} }, 'Read the clipboard')],
  },
  {
    id: 'device-navigate',
    agent: 'personal',
    pattern: /\b(navigate to|directions to|take me to)\s+(?<destination>.+)/i,
    build: (match) => [step('device.action', { command: 'device.navigate', args: { destination: clean(match.groups?.destination) } }, 'Start navigation')],
  },
  {
    id: 'device-speak',
    agent: 'personal',
    pattern: /\b(say|speak|announce)\s+(?<text>.+?)\s+on my phone\b/i,
    build: (match) => [step('device.action', { command: 'device.speak', args: { text: clean(match.groups?.text) } }, 'Speak on the phone')],
  },
  {
    id: 'device-notify',
    agent: 'personal',
    pattern: /\b(notify|ping|remind) me\b(?<text>.+)/i,
    build: (match) => {
      const text = clean(match.groups?.text);
      if (!text) return null;
      return [step('system.notify', { title: 'Xacheus', body: text }, 'Notify me')];
    },
  },

  // -------------------------------------------------------------------- code
  {
    id: 'code-run-tests',
    agent: 'code',
    pattern: /\b(run|execute)\b.*\b(tests?|test suite|type ?check|build)\b/i,
    build: (match) => {
      const target = match[2]?.toLowerCase() ?? '';
      const command = target.includes('type') ? 'npx tsc' : target.includes('build') ? 'npm run build' : 'npm test';
      return [step('code.run', { command }, `Run: ${command}`)];
    },
  },
  {
    id: 'code-explain',
    agent: 'code',
    pattern: /\b(explain|read|analyse|analyze|review|walk me through)\b\s+(?:the\s+)?(?:file\s+)?(?<path>[\w./-]+\.[a-z]{1,5})/i,
    build: (match) => [step('code.explain', { path: clean(match.groups?.path) }, `Explain ${match.groups?.path}`)],
  },
  {
    id: 'code-review',
    agent: 'code',
    pattern: /\b(find|check for)\b.*\b(bugs?|issues?|problems?|todos?|tech debt)\b/i,
    build: () => [
      step('code.search', { pattern: 'TODO|FIXME|HACK', limit: 40 }, 'Find TODOs and known issues'),
      step('code.list', { limit: 200 }, 'Survey the project'),
    ],
  },
  {
    id: 'code-search',
    agent: 'code',
    pattern: /\b(search|grep|find)\b\s+(?:the\s+)?code\s*(?:base\s*)?(?:for\s+)?(?<query>.+)/i,
    build: (match) => {
      const query = clean(match.groups?.query);
      if (!query) return null;
      return [step('code.search', { pattern: query }, `Search the codebase for "${query}"`)];
    },
  },
  {
    id: 'code-list',
    agent: 'code',
    pattern: /\b(list|show)\b.*\b(project files|files in the project|codebase|repository)\b/i,
    build: () => [step('code.list', {}, 'List project files')],
  },

  // -------------------------------------------------------------- automation
  {
    id: 'automation-every',
    agent: 'automation',
    pattern: /\bevery\s+(?<freq>morning|day|evening|night|week|hour|(?<n>\d+)\s*(?<unit>minutes?|hours?))\b/i,
    build: (match) => {
      const freq = (match.groups?.freq ?? '').toLowerCase();
      const n = Number(match.groups?.n ?? 0);
      const unit = (match.groups?.unit ?? '').toLowerCase();
      if (unit.startsWith('min')) {
        return [step('automation.create', { name: `Every ${n || 30} minutes`, triggerType: 'interval', everyMinutes: n || 30, actionTool: 'system.notify', actionInput: { title: 'Xacheus', body: 'Scheduled check-in' } }, 'Create an interval automation')];
      }
      if (unit.startsWith('hour')) {
        return [step('automation.create', { name: `Every ${n || 1} hour(s)`, triggerType: 'interval', everyMinutes: (n || 1) * 60, actionTool: 'system.notify', actionInput: { title: 'Xacheus', body: 'Scheduled check-in' } }, 'Create an interval automation')];
      }
      const at = freq.includes('morning') ? '07:30' : freq.includes('evening') ? '19:00' : freq.includes('night') ? '21:00' : '08:00';
      return [
        step(
          'automation.create',
          {
            name: `Daily brief at ${at}`,
            triggerType: 'schedule',
            at,
            actionTool: 'business.todayBrief',
            actionInput: {},
          },
          `Brief me every ${freq} at ${at}`,
        ),
      ];
    },
    suggestions: ['Also watch a competitor page', 'Show my automations'],
  },
  {
    id: 'automation-when',
    agent: 'automation',
    pattern: /\bwhen(?:ever)?\s+(?:an?|a new)?\s*(?<event>inquiry|message|email|order|document)\b(?<rest>.*)/i,
    build: (match) => {
      const kind = (match.groups?.event ?? '').toLowerCase();
      const event = kind === 'inquiry' ? 'inquiry.received' : kind === 'document' ? 'document.ingested' : 'message.received';
      const action = kind === 'document'
        ? { tool: 'knowledge.stats', input: {} }
        : { tool: 'content.draftReply', input: { message: '{{message}}' } };
      return [
        step('automation.create', { name: `On ${kind}: prepare a response`, triggerType: 'event', event, actionTool: action.tool, actionInput: action.input, notify: true }, `Automate ${kind} handling`),
      ];
    },
  },
  {
    id: 'automation-watch',
    agent: 'automation',
    pattern: /\b(watch|monitor|track)\b.*?(?<url>https?:\/\/\S+|\bthis page\b|\bthis site\b)/i,
    build: (match) => {
      const url = (match.groups?.url ?? '').replace(/[),.]+$/, '') || 'https://example.com';
      return [
        step('automation.create', { name: `Watch ${url}`, triggerType: 'interval', everyMinutes: 360, actionTool: 'web.checkChanged', actionInput: { url } }, `Watch ${url} for changes`),
      ];
    },
  },
];

export interface HeuristicPlan extends PlanResult {
  matchedRule?: string;
}

/**
 * Match the request against the rule table and produce a plan.
 * Returns `null` when nothing matches — the caller then falls back to a
 * knowledge/memory answer.
 */
export function planHeuristically(request: string): HeuristicPlan | null {
  const trimmed = request.trim();
  if (!trimmed) return null;

  for (const rule of RULES) {
    const match = trimmed.match(rule.pattern);
    if (!match) continue;
    const steps = rule.build(match, trimmed);
    if (!steps || !steps.length) continue;
    return {
      agent: rule.agent,
      steps,
      confidence: 0.85,
      matchedRule: rule.id,
      suggestions: rule.suggestions,
    };
  }
  return null;
}

/** Which agent a request probably belongs to (used for logging and routing hints). */
export function classifyHeuristically(request: string): AgentId {
  const plan = planHeuristically(request);
  if (plan) return plan.agent;
  const lower = request.toLowerCase();
  if (/\b(code|bug|function|repo|branch|compile|test)\b/.test(lower)) return 'code';
  if (/\b(email|inbox|mail)\b/.test(lower)) return 'mail';
  if (/\b(light|thermostat|plug|switch|camera|lock|home)\b/.test(lower)) return 'home';
  if (/\b(post|instagram|facebook|caption|hashtag)\b/.test(lower)) return 'social';
  if (/\b(whatsapp|message|customer (wrote|asked))\b/.test(lower)) return 'messaging';
  if (/\b(research|search|web|website|article|report)\b/.test(lower)) return 'research';
  if (/\b(document|policy|pdf|file|contract)\b/.test(lower)) return 'knowledge';
  if (/\b(sales|lead|customer|invoice|product|price)\b/.test(lower)) return 'business';
  if (/\b(remind|calendar|schedule|meeting|task|note)\b/.test(lower)) return 'personal';
  if (/\b(every|when|automate|automation|background)\b/.test(lower)) return 'automation';
  return 'master';
}
