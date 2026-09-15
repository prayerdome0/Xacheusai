/**
 * Code Agent tools.
 *
 * The agent works inside a single root (`services.workspaceRoot`) and cannot
 * escape it: every path is resolved and re-checked against that root. Writes and
 * command execution are high/critical risk and confirmation-gated by default —
 * the agent can propose, but you approve.
 */
import { readFile, readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Tool, ToolContext } from './types.js';
import { spawn } from 'node:child_process';
import { truncate } from '../util.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '.venv', '__pycache__', 'coverage', '.turbo', 'out']);
const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.md', '.css', '.scss', '.html', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.swift', '.php', '.cs', '.sh', '.yml', '.yaml', '.toml', '.sql', '.env.example', '.dart', '.kt',
]);
const MAX_FILE_BYTES = 400_000;

/** Resolve a user-supplied path inside the workspace root, or refuse. */
function safePath(ctx: ToolContext, input: string): { path: string } | { error: string } {
  const root = resolve(ctx.services.workspaceRoot);
  const target = resolve(root, input || '.');
  if (target !== root && !target.startsWith(root + sep)) {
    return { error: `Refusing to touch "${input}" — it is outside the Code Agent workspace (${root}).` };
  }
  return { path: target };
}

async function walk(root: string, onFile: (path: string) => void | Promise<void>, depth = 6): Promise<void> {
  async function recurse(dir: string, level: number): Promise<void> {
    if (level > depth) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await recurse(full, level + 1);
      } else if (entry.isFile()) {
        await onFile(full);
      }
    }
  }
  await recurse(root, 0);
}

export const codeTools: Tool[] = [
  {
    id: 'code.list',
    name: 'List project files',
    description: 'Lists the files in your project workspace so Xacheus knows what it is working with.',
    category: 'code',
    scopes: ['code:read'],
    risk: 'low',
    parameters: [
      { name: 'path', type: 'string', description: 'Subdirectory to list (default: workspace root).', required: false },
      { name: 'limit', type: 'number', description: 'Max files (default 200).', required: false },
    ],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const resolved = safePath(ctx, String(input.path ?? '.'));
      if ('error' in resolved) return { ok: false, mode: 'live', summary: resolved.error, error: 'path outside workspace' };
      const files: { path: string; bytes: number }[] = [];
      const limit = Number(input.limit ?? 200) || 200;
      await walk(resolved.path, async (file) => {
        if (files.length >= limit) return;
        const info = await stat(file).catch(() => null);
        files.push({ path: relative(resolve(ctx.services.workspaceRoot), file), bytes: info?.size ?? 0 });
      });
      return {
        ok: true,
        mode: 'live',
        summary: `Found ${files.length} file(s) under ${input.path ?? '.'}.`,
        data: { files, root: ctx.services.workspaceRoot },
      };
    },
  },
  {
    id: 'code.read',
    name: 'Read a file',
    description: 'Reads a file from the project workspace.',
    category: 'code',
    scopes: ['code:read'],
    risk: 'low',
    parameters: [
      { name: 'path', type: 'string', description: 'File path relative to the workspace.', required: true },
      { name: 'maxChars', type: 'number', description: 'Truncate output (default 20000).', required: false },
    ],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const resolved = safePath(ctx, String(input.path ?? ''));
      if ('error' in resolved) return { ok: false, mode: 'live', summary: resolved.error, error: 'path outside workspace' };
      try {
        const info = await stat(resolved.path);
        if (!info.isFile()) return { ok: false, mode: 'live', summary: `${input.path} is not a file.`, error: 'not a file' };
        if (info.size > MAX_FILE_BYTES) {
          return { ok: false, mode: 'live', summary: `${input.path} is ${(info.size / 1024).toFixed(0)} KB — too large to read in one go.`, error: 'file too large' };
        }
        const content = await readFile(resolved.path, 'utf8');
        const lines = content.split('\n');
        return {
          ok: true,
          mode: 'live',
          summary: `Read ${input.path} (${lines.length} lines).`,
          data: {
            path: input.path,
            lines: lines.length,
            content: truncate(content, Number(input.maxChars ?? 20_000) || 20_000),
          },
        };
      } catch (error) {
        return { ok: false, mode: 'live', summary: `Could not read ${input.path}.`, error: (error as Error).message };
      }
    },
  },
  {
    id: 'code.search',
    name: 'Search the codebase',
    description: 'Searches files for text or a regular expression — the first step in finding a bug or understanding a flow.',
    category: 'code',
    scopes: ['code:read'],
    risk: 'low',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Text or regular expression.', required: true },
      { name: 'path', type: 'string', description: 'Subdirectory to search.', required: false },
      { name: 'limit', type: 'number', description: 'Max matches (default 40).', required: false },
    ],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const pattern = String(input.pattern ?? '').trim();
      if (!pattern) return { ok: false, mode: 'live', summary: 'What should I search for?', error: 'missing pattern' };
      const resolved = safePath(ctx, String(input.path ?? '.'));
      if ('error' in resolved) return { ok: false, mode: 'live', summary: resolved.error, error: 'path outside workspace' };

      let regex: RegExp;
      try {
        regex = new RegExp(pattern, 'i');
      } catch {
        regex = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      }

      const matches: { file: string; line: number; text: string }[] = [];
      const limit = Number(input.limit ?? 40) || 40;
      await walk(resolved.path, async (file) => {
        if (matches.length >= limit) return;
        const extension = file.slice(file.lastIndexOf('.'));
        if (!CODE_EXTENSIONS.has(extension) && !file.includes('.env')) return;
        const info = await stat(file).catch(() => null);
        if (!info || info.size > MAX_FILE_BYTES) return;
        const content = await readFile(file, 'utf8').catch(() => '');
        content.split('\n').forEach((line, index) => {
          if (matches.length >= limit) return;
          if (regex.test(line)) {
            matches.push({ file: relative(resolve(ctx.services.workspaceRoot), file), line: index + 1, text: truncate(line.trim(), 200) });
          }
        });
      });

      return {
        ok: true,
        mode: 'live',
        summary: matches.length ? `Found ${matches.length} match(es) for /${pattern}/.` : `No matches for /${pattern}/.`,
        data: { matches },
      };
    },
  },
  {
    id: 'code.explain',
    name: 'Explain a file',
    description:
      'Analyses a source file without an LLM: size, structure, exports, imports, functions, TODOs and risky patterns — a factual map you can act on.',
    category: 'code',
    scopes: ['code:read'],
    risk: 'low',
    parameters: [{ name: 'path', type: 'string', description: 'File to analyse.', required: true }],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const resolved = safePath(ctx, String(input.path ?? ''));
      if ('error' in resolved) return { ok: false, mode: 'live', summary: resolved.error, error: 'path outside workspace' };
      try {
        const content = await readFile(resolved.path, 'utf8');
        const lines = content.split('\n');
        const analysis = {
          path: input.path,
          lines: lines.length,
          characters: content.length,
          functions: (content.match(/(?:function\s+\w+|const\s+\w+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>|(?:async\s+)?\w+\s*\([^)]*\)\s*{)/g) ?? []).length,
          classes: (content.match(/class\s+\w+/g) ?? []).map((match) => match.replace('class ', '')),
          exports: [
            ...new Set([
              ...(content.match(/export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g) ?? []).map((match) => match.split(/\s+/).pop()!),
              ...(content.match(/export\s*\*\s*from\s*['"]([^'"]+)['"]/g) ?? []).map((match) => `* from ${match.replace(/.*['"]([^'"]+)['"].*/, '$1')}`),
              ...(content.match(/export\s*\{[^}]*\}/g) ?? []).flatMap((block) =>
                block
                  .replace(/export\s*\{|\}/g, '')
                  .split(',')
                  .map((entry) => entry.trim().split(/\s+as\s+/).pop()!.trim())
                  .filter(Boolean),
              ),
            ]),
          ],
          imports: [...new Set((content.match(/from\s+['"]([^'"]+)['"]/g) ?? []).map((match) => match.replace(/from\s+['"]|['"]/g, '')))],
          todos: lines.map((line, index) => ({ line: index + 1, text: truncate(line.trim(), 160) })).filter((entry) => /TODO|FIXME|HACK|XXX/.test(entry.text)),
          riskyPatterns: lines
            .map((line, index) => ({ line: index + 1, text: line.trim() }))
            .filter((entry) => /\beval\(|new Function\(|dangerouslySetInnerHTML|exec\(|execSync\(|child_process|innerHTML\s*=/.test(entry.text))
            .map((entry) => ({ line: entry.line, text: truncate(entry.text, 160) })),
          longLines: lines.filter((line) => line.length > 160).length,
          commentRatio: lines.length
            ? Number(((lines.filter((line) => /^\s*(\/\/|\*|\/\*|#)/.test(line)).length / lines.length) * 100).toFixed(1))
            : 0,
        };
        return {
          ok: true,
          mode: 'live',
          summary: `${input.path}: ${analysis.lines} lines, ${analysis.functions} function-like blocks, ${analysis.exports.length} exports, ${analysis.todos.length} TODO(s)${analysis.riskyPatterns.length ? `, ${analysis.riskyPatterns.length} risky pattern(s)` : ''}.`,
          data: analysis,
          suggestions: analysis.todos.length ? ['Summarise the TODOs as tasks', 'Show me the risky patterns in detail'] : undefined,
        };
      } catch (error) {
        return { ok: false, mode: 'live', summary: `Could not analyse ${input.path}.`, error: (error as Error).message };
      }
    },
  },
  {
    id: 'code.write',
    name: 'Write or patch a file',
    description:
      'Writes a file in the workspace, or applies a string replacement patch. High risk: the exact change is shown and requires your approval.',
    category: 'code',
    scopes: ['code:write'],
    risk: 'high',
    requiresConfirmation: true,
    parameters: [
      { name: 'path', type: 'string', description: 'File path relative to the workspace.', required: true },
      { name: 'content', type: 'string', description: 'Full content to write (overwrite mode).', required: false },
      { name: 'find', type: 'string', description: 'Text to find (patch mode).', required: false },
      { name: 'replace', type: 'string', description: 'Replacement text (patch mode).', required: false },
      { name: 'reason', type: 'string', description: 'Why this change is needed — recorded in the audit log.', required: true },
    ],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const resolved = safePath(ctx, String(input.path ?? ''));
      if ('error' in resolved) return { ok: false, mode: 'live', summary: resolved.error, error: 'path outside workspace' };
      const reason = String(input.reason ?? '').trim();
      if (!reason) return { ok: false, mode: 'live', summary: 'A reason is required for any code change.', error: 'missing reason' };

      try {
        if (input.find !== undefined && input.replace !== undefined) {
          const existing = await readFile(resolved.path, 'utf8');
          const find = String(input.find);
          if (!existing.includes(find)) {
            return { ok: false, mode: 'live', summary: `The patch target was not found in ${input.path}.`, error: 'find text missing' };
          }
          const updated = existing.replace(find, String(input.replace));
          await writeFile(resolved.path, updated, 'utf8');
          return {
            ok: true,
            mode: 'live',
            summary: `Patched ${input.path}: replaced ${find.length} characters. Reason: ${reason}`,
            data: { path: input.path, mode: 'patch' },
          };
        }

        const content = String(input.content ?? '');
        if (!content) return { ok: false, mode: 'live', summary: 'No content to write.', error: 'empty content' };
        await mkdir(dirname(resolved.path), { recursive: true });
        await writeFile(resolved.path, content, 'utf8');
        return {
          ok: true,
          mode: 'live',
          summary: `Wrote ${input.path} (${content.split('\n').length} lines). Reason: ${reason}`,
          data: { path: input.path, mode: 'overwrite', bytes: Buffer.byteLength(content) },
        };
      } catch (error) {
        return { ok: false, mode: 'live', summary: `Could not write ${input.path}.`, error: (error as Error).message };
      }
    },
  },
  {
    id: 'code.run',
    name: 'Run a project command',
    description:
      'Runs an allow-listed command (tests, type checks, linters, builds) inside the workspace and returns the output. Critical risk: always needs approval, and only known-safe command shapes are permitted.',
    category: 'code',
    scopes: ['code:execute'],
    risk: 'critical',
    requiresConfirmation: true,
    parameters: [
      { name: 'command', type: 'string', description: 'Command to run.', required: true, example: 'npm test' },
      { name: 'timeoutSeconds', type: 'number', description: 'Kill after this long (default 120).', required: false },
    ],
    owners: ['code', 'master'],
    async run(input, ctx) {
      const command = String(input.command ?? '').trim();
      if (!command) return { ok: false, mode: 'live', summary: 'Which command should I run?', error: 'missing command' };

      const ALLOWED = [
        /^npm (test|run [\w:-]+)$/,
        /^npx (tsc|vite build|eslint)\b/,
        /^node --test\b/,
        /^node --version$/,
        /^pytest\b/,
        /^python(3)? -m pytest\b/,
        /^go (test|build|vet)\b/,
        /^cargo (test|build|check)\b/,
        /^git (status|diff|log --oneline)\b/,
        /^ls\b/,
        /^dir\b/,
      ];
      if (!ALLOWED.some((pattern) => pattern.test(command))) {
        return {
          ok: false,
          mode: 'blocked',
          summary: `Refusing to run "${command}". Allowed shapes: npm test, npm run <script>, npx tsc/eslint, node --test, pytest, go test, cargo check, git status/diff/log.`,
          error: 'command not allow-listed',
        };
      }

      const timeout = Math.min(Math.max(Number(input.timeoutSeconds ?? 120) || 120, 5), 600);
      const started = Date.now();
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((finish) => {
        const child = spawn(command, [], {
          cwd: resolve(ctx.services.workspaceRoot),
          shell: true,
          env: { ...process.env, CI: '1' },
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeout * 1000);
        child.stdout?.on('data', (chunk) => {
          if (stdout.length < 60_000) stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
          if (stderr.length < 60_000) stderr += chunk.toString();
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          finish({ code, stdout, stderr, timedOut });
        });
        child.on('error', (error) => {
          clearTimeout(timer);
          finish({ code: -1, stdout, stderr: String(error.message), timedOut });
        });
      });

      const summary = result.timedOut
        ? `"${command}" timed out after ${timeout}s.`
        : `"${command}" exited with code ${result.code} in ${((Date.now() - started) / 1000).toFixed(1)}s.`;

      return {
        ok: result.code === 0 && !result.timedOut,
        mode: 'live',
        summary,
        data: { command, exitCode: result.code, stdout: truncate(result.stdout, 8000), stderr: truncate(result.stderr, 4000) },
      };
    },
  },
];
