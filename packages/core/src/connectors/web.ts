/**
 * Web connector — the Research Agent's hands.
 *
 * Search uses, in order of preference: Brave Search API (if a key is set), the
 * keyless DuckDuckGo HTML endpoint, then the Wikipedia API. Page reading strips
 * the document down to readable text without a heavy parser dependency.
 */
import type { Connector, ConnectorOperation } from './types.js';
import { describeHttpError, evaluateStatus, failure, httpJson, sandbox } from './types.js';
import type { ConfigStore } from '../config.js';
import { sha1, truncate } from '../util.js';

const USER_AGENT = 'XacheusAI/0.1 (+private personal agent; owner-authorized research)';

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripTags(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/[ \t\f\v]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
  );
}

async function braveSearch(query: string, key: string, count: number): Promise<SearchResult[]> {
  const result = await httpJson(
    `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`,
    { headers: { accept: 'application/json', 'x-subscription-token': key } },
  );
  if (!result.ok) throw new Error(describeHttpError(result));
  const items = (result.payload?.web?.results ?? []) as any[];
  return items.map((item) => ({
    title: decodeEntities(String(item.title ?? '')),
    url: String(item.url ?? ''),
    snippet: stripTags(String(item.description ?? '')),
    source: 'brave',
  }));
}

async function duckDuckGoSearch(query: string, count: number): Promise<SearchResult[]> {
  const result = await httpJson(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    method: 'GET',
    headers: { 'user-agent': USER_AGENT, accept: 'text/html' },
  });
  if (!result.ok || !result.text) throw new Error(describeHttpError(result));

  const results: SearchResult[] = [];
  const linkPattern = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetPattern = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippets = [...result.text.matchAll(snippetPattern)].map((match) => stripTags(match[1] ?? ''));
  let match: RegExpExecArray | null;
  let index = 0;
  while ((match = linkPattern.exec(result.text)) !== null && results.length < count) {
    let url = match[1] ?? '';
    // DuckDuckGo wraps results in a redirect: unwrap the uddg parameter.
    const redirect = url.match(/[?&]uddg=([^&]+)/);
    if (redirect?.[1]) url = decodeURIComponent(redirect[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!url.startsWith('http')) {
      index += 1;
      continue;
    }
    results.push({
      title: stripTags(match[2] ?? ''),
      url,
      snippet: snippets[index] ?? '',
      source: 'duckduckgo',
    });
    index += 1;
  }
  return results;
}

async function wikipediaSearch(query: string, count: number): Promise<SearchResult[]> {
  const result = await httpJson(
    `https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${count}&srsearch=${encodeURIComponent(query)}`,
    { headers: { 'user-agent': USER_AGENT } },
  );
  if (!result.ok) throw new Error(describeHttpError(result));
  const items = (result.payload?.query?.search ?? []) as any[];
  return items.map((item) => ({
    title: String(item.title ?? ''),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(item.title ?? '').replace(/ /g, '_'))}`,
    snippet: stripTags(String(item.snippet ?? '')),
    source: 'wikipedia',
  }));
}

/** Extract the readable core of an HTML document. */
export function extractReadable(html: string): { title: string; text: string; description: string } {
  const title = stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').slice(0, 200);
  const description = decodeEntities(
    html.match(/<meta[^>]+(?:name|property)="(?:description|og:description)"[^>]+content="([^"]*)"/i)?.[1] ?? '',
  ).slice(0, 400);

  const body =
    html.match(/<article[\s\S]*?<\/article>/i)?.[0] ??
    html.match(/<main[\s\S]*?<\/main>/i)?.[0] ??
    html.match(/<body[\s\S]*?<\/body>/i)?.[0] ??
    html;

  const text = stripTags(body)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter((line) => !/^(cookie|accept all|subscribe|sign in|menu|skip to)/i.test(line))
    .join('\n');
  return { title, text, description };
}

const webOperations: ConnectorOperation[] = [
  {
    id: 'search',
    title: 'Search the web',
    description: 'Runs a web search and returns titles, URLs and snippets.',
    scopes: ['web:read'],
    risk: 'low',
    parameters: [
      { name: 'query', type: 'string', description: 'Search query.', required: true },
      { name: 'count', type: 'number', description: 'Number of results (1-10).', required: false },
    ],
    async run(input, ctx) {
      const query = String(input.query ?? '').trim();
      if (!query) return { ok: false, mode: 'live', summary: 'A search query is required.', error: 'missing query' };
      const count = Math.min(Math.max(Number(input.count ?? 5) || 5, 1), 10);
      const key = ctx.config.value('BRAVE_API_KEY');

      const attempts: { name: string; fn: () => Promise<SearchResult[]> }[] = [];
      if (key) attempts.push({ name: 'brave', fn: () => braveSearch(query, key, count) });
      attempts.push({ name: 'duckduckgo', fn: () => duckDuckGoSearch(query, count) });
      attempts.push({ name: 'wikipedia', fn: () => wikipediaSearch(query, count) });

      const errors: string[] = [];
      for (const attempt of attempts) {
        try {
          const results = await attempt.fn();
          if (results.length) {
            return {
              ok: true,
              mode: 'live',
              summary: `Found ${results.length} result(s) for "${query}" via ${attempt.name}.`,
              data: { query, engine: attempt.name, results },
            };
          }
          errors.push(`${attempt.name}: no results`);
        } catch (error) {
          errors.push(`${attempt.name}: ${(error as Error).message}`);
        }
      }
      return {
        ok: false,
        mode: 'live',
        summary: `Web search failed for "${query}".`,
        error: errors.join(' | '),
      };
    },
  },
  {
    id: 'readPage',
    title: 'Read a web page',
    description: 'Fetches a URL and returns its readable text so Xacheus can summarise or extract from it.',
    scopes: ['web:read'],
    risk: 'low',
    parameters: [
      { name: 'url', type: 'string', description: 'Absolute URL to read.', required: true },
      { name: 'maxChars', type: 'number', description: 'Truncate the extracted text (default 12000).', required: false },
    ],
    async run(input, ctx) {
      const url = String(input.url ?? '').trim();
      if (!/^https?:\/\//i.test(url)) {
        return { ok: false, mode: 'live', summary: 'Only http(s) URLs can be read.', error: 'invalid url' };
      }
      const result = await httpJson(url, { method: 'GET', headers: { 'user-agent': USER_AGENT }, timeoutMs: 20_000 });
      if (!result.ok || !result.text) return failure('Web page read', describeHttpError(result));
      const extracted = extractReadable(result.text);
      const maxChars = Math.min(Number(input.maxChars ?? 12_000) || 12_000, 60_000);
      return {
        ok: true,
        mode: 'live',
        summary: `Read "${extracted.title || url}" (${extracted.text.length} characters of text).`,
        data: {
          url,
          title: extracted.title,
          description: extracted.description,
          text: truncate(extracted.text, maxChars),
          hash: sha1(extracted.text),
        },
      };
    },
  },
  {
    id: 'checkChanged',
    title: 'Check whether a page changed',
    description:
      'Hashes a page so an automation can detect changes. Pass the previous hash; Xacheus reports whether the content moved.',
    scopes: ['web:read'],
    risk: 'low',
    parameters: [
      { name: 'url', type: 'string', description: 'URL to monitor.', required: true },
      { name: 'previousHash', type: 'string', description: 'Hash returned by the previous run.', required: false },
    ],
    async run(input, ctx) {
      const url = String(input.url ?? '').trim();
      const result = await httpJson(url, { method: 'GET', headers: { 'user-agent': USER_AGENT }, timeoutMs: 20_000 });
      if (!result.ok || !result.text) return failure('Page monitor', describeHttpError(result));
      const extracted = extractReadable(result.text);
      const hash = sha1(extracted.text);
      const previous = String(input.previousHash ?? '');
      const changed = previous !== '' && previous !== hash;
      return {
        ok: true,
        mode: 'live',
        summary: previous === ''
          ? `Baseline captured for ${url}.`
          : changed
            ? `${url} has changed since the last check.`
            : `${url} is unchanged.`,
        data: { url, hash, changed, title: extracted.title, excerpt: truncate(extracted.text, 1200) },
      };
    },
  },
];

export const webConnector: Connector = {
  manifest: {
    id: 'web',
    name: 'Open Web',
    category: 'web',
    description:
      'Search and page reading for the Research Agent. Works with no API key (DuckDuckGo/Wikipedia); add a Brave Search key for higher quality results.',
    fields: [{ key: 'BRAVE_API_KEY', label: 'Brave Search API key (optional)', secret: true, required: false }],
    scopes: ['web:read'],
    capabilities: ['Web search', 'Read pages', 'Monitor pages for changes'],
  },
  operations: webOperations,
  status: (config) => evaluateStatus(webConnector, config),
  async verify(config) {
    const key = config.value('BRAVE_API_KEY');
    const probe = key ? await braveSearch('xacheus test', key, 1).then(() => true, () => false) : true;
    return {
      ok: probe,
      detail: key
        ? probe
          ? 'Brave Search key works.'
          : 'Brave Search key was rejected — falling back to keyless search.'
        : 'No search key set: using keyless DuckDuckGo/Wikipedia search.',
    };
  },
};

export { sandbox };
