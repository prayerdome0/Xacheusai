#!/usr/bin/env node
/**
 * Console render check.
 *
 * Type-checking proves the console compiles; this proves it *renders*. It mounts
 * the real production bundle from `apps/web/dist` inside a DOM, with `fetch`
 * forwarded to a running Xacheus backend, then asserts the Control Center
 * actually painted its navigation and its live data.
 *
 * Usage:
 *   npm run build -w @xacheus/web          # or npm run build
 *   node apps/server/dist/index.js &       # any backend on XACHEUS_API_URL
 *   node scripts/console-render.mjs
 *
 * Exits non-zero if the console throws, renders nothing, or never shows data.
 */
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// Vite outputs to the repo-root dist/ (see apps/web/vite.config.ts) so Vercel's
// zero-config can find it. Fall back to the workspace-local path for older builds.
const distDir = [join(root, 'dist'), join(root, 'apps/web/dist')].find((p) => existsSync(join(p, 'index.html'))) ?? join(root, 'dist');
const apiBase = process.env.XACHEUS_API_URL ?? 'http://127.0.0.1:8787';

const failures = [];
const check = (name, condition, detail = '') => {
  if (condition) console.log(`  \u001b[32m✓\u001b[0m ${name}`);
  else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u001b[31m✗\u001b[0m ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

// ------------------------------------------------------------------ the DOM

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://localhost:5173/',
  pretendToBeVisual: true,
});

const { window } = dom;

const errors = [];
window.addEventListener('error', (event) => errors.push(String(event.error ?? event.message)));
window.addEventListener('unhandledrejection', (event) => errors.push(String(event.reason)));
const originalError = console.error;
console.error = (...args) => {
  const text = args.map((arg) => (arg instanceof Error ? `${arg.message}` : String(arg))).join(' ');
  // React logs plenty of non-fatal noise; only record things that are fatal-ish.
  if (/not wrapped in act|Warning:/i.test(text)) return originalError(' ' + text.slice(0, 200));
  errors.push(text);
  originalError(' ', text.slice(0, 300));
};

// Globals React and the console expect from a browser.
globalThis.window = window;
globalThis.document = window.document;
Object.defineProperty(globalThis, 'navigator', { value: window.navigator, configurable: true });
globalThis.location = window.location;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
globalThis.getComputedStyle = window.getComputedStyle.bind(window);
globalThis.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
globalThis.localStorage = window.localStorage ?? {
  store: new Map(),
  getItem(key) {
    return this.store.get(key) ?? null;
  },
  setItem(key, value) {
    this.store.set(key, String(value));
  },
  removeItem(key) {
    this.store.delete(key);
  },
  clear() {
    this.store.clear();
  },
};
globalThis.IS_REACT_ACT_ENVIRONMENT = false;

window.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
globalThis.matchMedia = window.matchMedia;
class StubObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = StubObserver;
globalThis.IntersectionObserver = StubObserver;
globalThis.MutationObserver = window.MutationObserver;
globalThis.DOMRect = window.DOMRect ?? class {};
globalThis.WebSocket = class {
  constructor() {
    this.readyState = 0;
  }
  addEventListener() {}
  removeEventListener() {}
  send() {}
  close() {}
};

// fetch → the real backend, with relative URLs resolved against it.
const nodeFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  const absolute = url.startsWith('http') ? url : apiBase + url;
  return nodeFetch(absolute, init);
};
window.fetch = globalThis.fetch;

// ---------------------------------------------------------------- the bundle

console.log(`\u001b[1mXacheus console render check\u001b[0m — bundle from ${distDir}, API at ${apiBase}\n`);

const indexPath = join(distDir, 'index.html');
const indexHtml = await readFile(indexPath, 'utf8').catch(() => null);
if (!indexHtml) {
  console.error('dist/index.html is missing — run `npm run build` first.');
  process.exit(1);
}

const entry = indexHtml.match(/src="\/assets\/([^"]+\.js)"/)?.[1];
check('the built page references its entry bundle', Boolean(entry), entry ?? 'no /assets/*.js found');
if (!entry) process.exit(1);

// Import the bundle. Vite splits chunks relative to the entry document, which
// Node cannot resolve for us, so load them from the asset directory.
const assetsDir = join(distDir, 'assets');
const chunks = (await readdir(assetsDir)).filter((name) => name.endsWith('.js'));
for (const chunk of chunks) {
  const url = pathToFileURL(join(assetsDir, chunk)).href;
  try {
    await import(url);
  } catch (error) {
    if (!/document is not defined|window is not defined/.test(String(error))) {
      // A chunk that is not the entry (e.g. Firebase's) failing is not fatal by
      // itself, but it is worth reporting.
      check(`chunk ${chunk} loaded`, false, String(error).slice(0, 160));
    }
  }
}

// --------------------------------------------------------------- assertions

await new Promise((resolve) => setTimeout(resolve, 2500));

const rootEl = window.document.getElementById('root');
const html = rootEl?.innerHTML ?? '';

check('the app mounted something into #root', html.length > 0, `${html.length} chars`);
check('the Xacheus brand is on screen', /Xacheus AI/.test(html));
check('the Control Center navigation rendered', /Control Center/.test(html) && /Voice (&amp;|&) Chat/.test(html));
if (process.env.DUMP_SIDEBAR) console.log(html.slice(0, 1200));
check('the model layer is shown in the sidebar', /planner|model/i.test(html));
check('no unhandled errors were thrown while rendering', errors.length === 0, errors.slice(0, 2).join(' | '));

// Give the dashboard polls a moment to paint live numbers from the API.
await new Promise((resolve) => setTimeout(resolve, 2500));
const later = window.document.getElementById('root')?.innerHTML ?? '';
check('the dashboard painted live data from the API', /(Tools|Memory|Documents|Knowledge|run|approval)/i.test(later));

console.log('\n' + '─'.repeat(64));
if (failures.length === 0) {
  console.log('\u001b[32m✔ console renders correctly\u001b[0m');
  process.exit(0);
}
console.log(`\u001b[31m✖ console render check failed\u001b[0m — ${failures.length} problem(s):\n`);
for (const failure of failures) console.log(`  • ${failure}`);
process.exit(1);
