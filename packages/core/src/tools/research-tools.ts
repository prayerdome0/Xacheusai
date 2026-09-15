/**
 * Research Agent tools — search, read, compare, and turn findings into a durable,
 * cited report that lands in the knowledge base.
 *
 * Reports always carry their sources: a private agent that invents facts about a
 * prospect is worse than useless.
 */
import type { Tool, ToolContext } from './types.js';
import { truncate } from '../util.js';

interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

async function webSearch(ctx: ToolContext, query: string, count = 5): Promise<SearchHit[]> {
  const web = ctx.services.connectors.findOperation('web.search');
  if (!web) return [];
  const result = await web.operation.run({ query, count }, ctx.services.connectors.context(ctx.log, ctx.runId));
  const hits = (result.data as { results?: SearchHit[] } | undefined)?.results ?? [];
  return hits;
}

async function readPage(ctx: ToolContext, url: string, maxChars = 12_000): Promise<{ title: string; text: string; url: string } | null> {
  const read = ctx.services.connectors.findOperation('web.readPage');
  if (!read) return null;
  const result = await read.operation.run({ url, maxChars }, ctx.services.connectors.context(ctx.log, ctx.runId));
  if (!result.ok) return null;
  const data = result.data as { title?: string; text?: string; url?: string } | undefined;
  if (!data?.text) return null;
  return { title: data.title ?? url, text: data.text, url: data.url ?? url };
}

export const researchTools: Tool[] = [
  {
    id: 'research.prospectReport',
    name: 'Prospect research report',
    description:
      'Researches a company across the open web and produces a cited prospect report: what they do, signals, possible fit with your products, objections and a suggested opener. Saves the report to your knowledge base.',
    category: 'research',
    scopes: ['web:read', 'knowledge:write'],
    risk: 'medium',
    parameters: [
      { name: 'company', type: 'string', description: 'Company name to research.', required: true },
      { name: 'website', type: 'string', description: 'Known website, if any.', required: false },
      { name: 'focus', type: 'string', description: 'What you want to know, e.g. "do they buy wholesale".', required: false },
      { name: 'save', type: 'boolean', description: 'Save the report to the knowledge base (default true).', required: false },
    ],
    owners: ['research', 'business', 'master'],
    async run(input, ctx) {
      const company = String(input.company ?? '').trim();
      if (!company) return { ok: false, mode: 'live', summary: 'Which company should I research?', error: 'missing company' };

      const queries = [
        company,
        `${company} products services`,
        `${company} contact about`,
        input.focus ? `${company} ${String(input.focus)}` : `${company} reviews customers`,
      ];

      const findings: { query: string; hits: SearchHit[] }[] = [];
      for (const query of queries) {
        const hits = await webSearch(ctx, query, 4);
        if (hits.length) findings.push({ query, hits });
      }

      if (!findings.length) {
        // No web access (offline, blocked network, or no search provider). Produce
        // what we can from your own data and say plainly what is missing.
        const [snapshot, knowledge, memories] = await Promise.all([
          ctx.services.business.get(),
          ctx.services.knowledge.search(company, { limit: 5 }),
          ctx.services.memory.recall(company, { limit: 5 }),
        ]);
        if (knowledge.length || memories.length) {
          const report = [
            `# Prospect report — ${company} (internal only)`,
            '',
            'Web research was unavailable, so this report uses only what is already in your own system.',
            '',
            '## From your documents',
            ...knowledge.map((hit) => `- [${hit.documentTitle}] ${truncate(hit.text, 400)}`),
            '',
            '## From memory',
            ...memories.map((memory) => `- ${memory.key}: ${memory.value}`),
            '',
            '## Your catalogue for matching',
            ...snapshot.products.slice(0, 6).map((product) => `- ${product.name} (${snapshot.company.currency} ${product.price})`),
            '',
            '## Next step',
            '- Retry when web access is available, or set BRAVE_API_KEY for a more reliable search provider.',
          ].join('\n');

          return {
            ok: true,
            mode: 'live',
            summary: report,
            data: { report, webAvailable: false, internalOnly: true },
            suggestions: ['Add them as a lead', 'Try again later', 'Paste their website and I will read it (if reachable)'],
          };
        }
        return {
          ok: false,
          mode: 'live',
          summary: `I could not reach any search results for "${company}", and there is nothing about them in your documents or memory yet. Check the network, or add a BRAVE_API_KEY for a more reliable search provider.`,
          error: 'no search results and no internal knowledge',
        };
      }

      // Read the most promising pages (home page first, then search hits).
      const pages: { title: string; text: string; url: string }[] = [];
      const candidateUrls = [
        ...(input.website ? [String(input.website)] : []),
        ...findings.flatMap((finding) => finding.hits.map((hit) => hit.url)),
      ].slice(0, 4);

      for (const url of candidateUrls) {
        const page = await readPage(ctx, url);
        if (page) pages.push(page);
      }

      const [snapshot, knowledge] = await Promise.all([
        ctx.services.business.get(),
        ctx.services.knowledge.search(company, { limit: 3 }),
      ]);

      const report = buildReport(company, findings, pages, {
        products: snapshot.products.map((product) => `${product.name} (${snapshot.company.currency} ${product.price})`),
        ourCompany: snapshot.company.name,
        focus: input.focus ? String(input.focus) : undefined,
        internalKnowledge: knowledge.map((hit) => `${hit.documentTitle}: ${truncate(hit.text, 220)}`),
      });

      let savedTo: string | undefined;
      if (input.save !== false) {
        const { document } = await ctx.services.documents.ingestText({
          title: `Prospect report — ${company}`,
          text: report,
          source: 'research-agent',
          collection: 'research',
          tags: ['prospect', 'research', company.toLowerCase().slice(0, 24)],
        });
        savedTo = document.id;
        await ctx.services.memory.remember({
          kind: 'company',
          key: `prospect_${company.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`,
          value: `Researched ${company}: ${pages[0]?.text.split(/\.\s/)[0] ?? 'no page summary'}`,
          tags: ['prospect', 'research'],
          source: `research:${document.id}`,
          confidence: 0.6,
        });
      }

      return {
        ok: true,
        mode: 'live',
        summary: report,
        data: { report, sources: pages.map((page) => page.url), savedTo },
        suggestions: [`Draft an opening message for ${company}`, 'Add them as a lead', 'Research their main competitor'],
      };
    },
  },
  {
    id: 'research.compare',
    name: 'Compare options',
    description: 'Researches two or more options against criteria and produces a sourced comparison table.',
    category: 'research',
    scopes: ['web:read'],
    risk: 'low',
    parameters: [
      { name: 'options', type: 'array', description: 'Things to compare (2-4).', required: true },
      { name: 'criteria', type: 'string', description: 'Comma-separated criteria, e.g. "price, support, availability".', required: false },
    ],
    owners: ['research', 'business', 'master'],
    async run(input, ctx) {
      const options = (Array.isArray(input.options) ? (input.options as string[]) : []).map((option) => String(option).trim()).filter(Boolean);
      if (options.length < 2) return { ok: false, mode: 'live', summary: 'Give me at least two things to compare.', error: 'too few options' };
      const criteria = String(input.criteria ?? 'price, quality, availability, reputation')
        .split(',')
        .map((criterion) => criterion.trim())
        .filter(Boolean);

      const blocks: string[] = [`# Comparison: ${options.join(' vs ')}`, '', `Criteria: ${criteria.join(', ')}`, ''];
      const sources: string[] = [];

      for (const option of options) {
        const hits = await webSearch(ctx, `${option} ${criteria.join(' ')}`, 3);
        const page = hits[0] ? await readPage(ctx, hits[0].url) : null;
        if (page) sources.push(page.url);
        blocks.push(`## ${option}`);
        if (hits.length) {
          for (const hit of hits.slice(0, 3)) {
            blocks.push(`- ${hit.title} — ${truncate(hit.snippet || hit.url, 220)}`);
          }
        } else {
          blocks.push('- No sources found for this option.');
        }
        if (page) blocks.push(`\nNotes from ${page.url}: ${truncate(page.text, 700)}`);
        blocks.push('');
      }

      blocks.push('## Sources');
      for (const source of [...new Set(sources)]) blocks.push(`- ${source}`);
      blocks.push('', '_Compiled from the sources above. Xacheus did not invent any claim in this table._');

      return {
        ok: true,
        mode: 'live',
        summary: blocks.join('\n'),
        data: { comparison: blocks.join('\n'), sources: [...new Set(sources)], options, criteria },
      };
    },
  },
  {
    id: 'research.digestQuestion',
    name: 'Answer from your own documents',
    description:
      'Answers a question using only your knowledge base and memory, with the passages it used. Use this before searching the web.',
    category: 'research',
    scopes: ['knowledge:read', 'memory:read'],
    risk: 'low',
    parameters: [
      { name: 'question', type: 'string', description: 'The question to answer.', required: true },
      { name: 'limit', type: 'number', description: 'How many passages to use.', required: false },
    ],
    owners: ['research', 'knowledge', 'business', 'master'],
    async run(input, ctx) {
      const question = String(input.question ?? '').trim();
      if (!question) return { ok: false, mode: 'live', summary: 'What should I look up?', error: 'missing question' };
      const [hits, memories] = await Promise.all([
        ctx.services.knowledge.search(question, { limit: Number(input.limit ?? 5) }),
        ctx.services.memory.recall(question, { limit: 5 }),
      ]);

      if (!hits.length && !memories.length) {
        return {
          ok: true,
          mode: 'live',
          summary: 'Nothing in your documents or memory covers that yet. Upload the relevant file, or ask me to research it on the web.',
          data: { hits: [], memories: [] },
        };
      }

      const lines: string[] = [];
      if (memories.length) {
        lines.push('From memory:');
        for (const memory of memories) lines.push(`- ${memory.key}: ${memory.value}`);
        lines.push('');
      }
      if (hits.length) {
        lines.push('From your documents:');
        for (const hit of hits) lines.push(`- [${hit.documentTitle}] ${truncate(hit.text, 420)}`);
      }
      lines.push('', 'These are the exact passages I found — no outside information was added.');

      return {
        ok: true,
        mode: 'live',
        summary: lines.join('\n'),
        data: { hits, memories },
        suggestions: ['Summarise this for a customer reply', 'Search the web instead', 'Save this as a note'],
      };
    },
  },
];

function buildReport(
  company: string,
  findings: { query: string; hits: SearchHit[] }[],
  pages: { title: string; text: string; url: string }[],
  context: { products: string[]; ourCompany: string; focus?: string; internalKnowledge: string[] },
): string {
  const lines: string[] = [];
  const seen = new Set<string>();

  lines.push(`# Prospect report — ${company}`);
  lines.push(`Prepared ${new Date().toDateString()} by the Xacheus Research Agent for ${context.ourCompany}.`);
  if (context.focus) lines.push(`Focus: ${context.focus}`);
  lines.push('');

  lines.push('## What they appear to be');
  if (pages.length) {
    const summary = pages[0]!.text.split(/\n/).filter((line) => line.length > 40).slice(0, 6).join(' ');
    lines.push(truncate(summary || pages[0]!.text, 900));
  } else {
    lines.push('No page could be read directly — the notes below come from search snippets only.');
  }
  lines.push('');

  lines.push('## Signals from the web');
  for (const finding of findings) {
    for (const hit of finding.hits) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      lines.push(`- **${hit.title || hit.url}** — ${truncate(hit.snippet || '(no snippet)', 260)}`);
      lines.push(`  Source: ${hit.url}`);
      if (seen.size >= 8) break;
    }
    if (seen.size >= 8) break;
  }
  lines.push('');

  if (context.internalKnowledge.length) {
    lines.push('## What you already know internally');
    for (const entry of context.internalKnowledge) lines.push(`- ${entry}`);
    lines.push('');
  }

  lines.push('## Possible fit with your catalogue');
  lines.push(
    context.products.length
      ? context.products.slice(0, 6).map((product) => `- ${product}`).join('\n')
      : '- No products recorded yet. Add your catalogue to the Control Center so I can match offers.',
  );
  lines.push('');

  lines.push('## Suggested opener');
  lines.push(
    `"Hi — I noticed ${company} focuses on what they do best. We help similar businesses with ${context.products[0] ?? 'supply and support'}. Would it be useful if I sent a short overview with pricing?"`,
  );
  lines.push('');

  lines.push('## Sources');
  const allSources = [...new Set([...pages.map((page) => page.url), ...findings.flatMap((finding) => finding.hits.map((hit) => hit.url))])];
  for (const source of allSources.slice(0, 12)) lines.push(`- ${source}`);
  lines.push('', '_Every claim above is traceable to a listed source. Verify before acting on it._');
  return lines.join('\n');
}
