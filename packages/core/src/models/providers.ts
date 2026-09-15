/**
 * Model layer — the "Xacheus Model Layer" from the architecture.
 *
 * Xacheus must never be hard-wired to one model. Every provider implements the
 * same tiny interface, so switching from a built-in local planner to Ollama, to
 * a hosted API, to your own fine-tuned model later is a config change — the
 * agents, tools and memory code above it does not change at all.
 *
 * Providers, in order of privacy:
 *   heuristic  — no network at all, deterministic (always available)
 *   ollama     — local/open model on your own hardware
 *   openai     — any OpenAI-compatible endpoint (OpenAI, Groq, Together, vLLM, LM Studio)
 *   anthropic  — Claude via the Messages API
 */
import type { ModelProvider, ModelRequest, ModelResponse } from '../types.js';
import type { ConfigStore } from '../config.js';

const DEFAULT_TIMEOUT_MS = 60_000;

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ ok: boolean; status: number; payload: any; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: any = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = text;
    }
    if (!response.ok) {
      return { ok: false, status: response.status, payload, error: `HTTP ${response.status}: ${typeof payload === 'string' ? payload.slice(0, 300) : JSON.stringify(payload).slice(0, 300)}` };
    }
    return { ok: true, status: response.status, payload };
  } catch (error) {
    return { ok: false, status: 0, payload: null, error: (error as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The built-in provider. It performs no inference — it is the honest fallback so
 * that the platform is fully functional (routing, planning, tools, memory,
 * knowledge, automations) without any model at all. `synthetic: true` marks every
 * response so nothing downstream can mistake it for model output.
 */
export class HeuristicProvider implements ModelProvider {
  readonly id = 'heuristic';
  readonly label = 'Built-in planner (no external model)';
  readonly locality = 'builtin' as const;

  async probe(): Promise<{ available: boolean; detail: string }> {
    return {
      available: true,
      detail:
        'Always available. Deterministic intent router + tool planner. No language model is called, so output is structured and predictable rather than generative.',
    };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    return {
      text: '',
      model: 'xacheus-heuristic',
      provider: this.id,
      synthetic: true,
      usage: { inputTokens: request.prompt.length, outputTokens: 0 },
    };
  }
}

/** Local model via Ollama — the recommended first step for a private agent. */
export class OllamaProvider implements ModelProvider {
  readonly id = 'ollama';
  readonly label = 'Ollama (local model)';
  readonly locality = 'local' as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async probe(): Promise<{ available: boolean; detail: string }> {
    try {
      const response = await fetch(new URL('/api/tags', this.baseUrl), {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) return { available: false, detail: `Ollama responded ${response.status} at ${this.baseUrl}` };
      const payload = (await response.json()) as { models?: { name: string }[] };
      const names = (payload.models ?? []).map((m) => m.name);
      const hasModel = names.some((name) => name === this.model || name.startsWith(`${this.model}:`));
      return {
        available: true,
        detail: hasModel
          ? `Ollama reachable; model ${this.model} is installed.`
          : `Ollama reachable but "${this.model}" is not pulled. Run: ollama pull ${this.model}. Installed: ${names.join(', ') || 'none'}`,
      };
    } catch (error) {
      return { available: false, detail: `Ollama not reachable at ${this.baseUrl} (${(error as Error).message}).` };
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const result = await postJson(
      new URL('/api/chat', this.baseUrl).toString(),
      {
        model: this.model,
        stream: false,
        format: request.json ? 'json' : undefined,
        options: { temperature: request.temperature ?? 0.3 },
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
      },
      {},
    );
    if (!result.ok) throw new Error(result.error ?? 'Ollama request failed');
    return {
      text: result.payload?.message?.content ?? '',
      model: this.model,
      provider: this.id,
      usage: {
        inputTokens: result.payload?.prompt_eval_count,
        outputTokens: result.payload?.eval_count,
      },
    };
  }
}

/** Any OpenAI-compatible chat-completions endpoint. */
export class OpenAICompatProvider implements ModelProvider {
  readonly id = 'openai-compatible';
  readonly label: string;
  readonly locality: 'cloud' | 'local' = 'cloud';

  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly model: string,
    label?: string,
  ) {
    this.label = label ?? `OpenAI-compatible (${model})`;
    if (/localhost|127\.0\.0\.1|host\.docker\.internal/.test(baseUrl)) this.locality = 'local';
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    if (!this.apiKey) return { available: false, detail: 'No API key configured.' };
    return { available: true, detail: `Endpoint ${this.baseUrl}, model ${this.model}.` };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.prompt },
      ],
      temperature: request.temperature ?? 0.3,
    };
    if (request.json) body.response_format = { type: 'json_object' };
    if (request.maxTokens) body.max_tokens = request.maxTokens;

    const result = await postJson(
      `${this.baseUrl.replace(/\/$/, '')}/chat/completions`,
      body,
      { authorization: `Bearer ${this.apiKey}` },
    );
    if (!result.ok) throw new Error(result.error ?? 'Model request failed');
    return {
      text: result.payload?.choices?.[0]?.message?.content ?? '',
      model: this.model,
      provider: this.id,
      usage: {
        inputTokens: result.payload?.usage?.prompt_tokens,
        outputTokens: result.payload?.usage?.completion_tokens,
      },
    };
  }
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  readonly label: string;
  readonly locality = 'cloud' as const;

  constructor(
    private readonly apiKey: string,
    private readonly model: string,
  ) {
    this.label = `Anthropic (${model})`;
  }

  async probe(): Promise<{ available: boolean; detail: string }> {
    if (!this.apiKey) return { available: false, detail: 'No ANTHROPIC_API_KEY configured.' };
    return { available: true, detail: `Model ${this.model}.` };
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const system = request.json ? `${request.system}\n\nRespond with a single valid JSON object and nothing else.` : request.system;
    const result = await postJson(
      'https://api.anthropic.com/v1/messages',
      {
        model: this.model,
        max_tokens: request.maxTokens ?? 2048,
        temperature: request.temperature ?? 0.3,
        system,
        messages: [{ role: 'user', content: request.prompt }],
      },
      { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
    );
    if (!result.ok) throw new Error(result.error ?? 'Anthropic request failed');
    const blocks = (result.payload?.content ?? []) as { type: string; text?: string }[];
    return {
      text: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n'),
      model: this.model,
      provider: this.id,
      usage: {
        inputTokens: result.payload?.usage?.input_tokens,
        outputTokens: result.payload?.usage?.output_tokens,
      },
    };
  }
}

export interface ModelRegistryEntry {
  provider: ModelProvider;
  selected: boolean;
}

export interface ModelRegistry {
  /** The provider the orchestrator will try first. */
  active: ModelProvider;
  /** Every provider, in preference order (active first). */
  all: ModelRegistryEntry[];
  /** True when no real model is configured (planning falls back to rules). */
  builtin: boolean;
  notes: string[];
}

/**
 * Build the registry from configuration. The built-in provider is always last
 * so there is never a state where Xacheus has *nothing* to think with.
 */
export function createModelRegistry(config: ConfigStore): ModelRegistry {
  const notes: string[] = [];
  const requested = (config.value('XACHEUS_MODEL', 'heuristic') || 'heuristic').toLowerCase();
  const providers: ModelProvider[] = [];

  if (config.has('ANTHROPIC_API_KEY')) {
    providers.push(new AnthropicProvider(config.value('ANTHROPIC_API_KEY'), config.value('ANTHROPIC_MODEL', 'claude-sonnet-4-5')));
  }
  if (config.has('OPENAI_API_KEY') || config.value('OPENAI_BASE_URL', '').includes('localhost')) {
    providers.push(
      new OpenAICompatProvider(
        config.value('OPENAI_BASE_URL', 'https://api.openai.com/v1'),
        config.value('OPENAI_API_KEY'),
        config.value('OPENAI_MODEL', 'gpt-4o-mini'),
      ),
    );
  }
  if (config.has('OLLAMA_BASE_URL')) {
    providers.push(new OllamaProvider(config.value('OLLAMA_BASE_URL'), config.value('OLLAMA_MODEL', 'llama3.1:8b')));
  }

  const builtin = new HeuristicProvider();
  const selected = providers.find((provider) => provider.id === requested || provider.id.startsWith(requested));

  const ordered: ModelProvider[] = [];
  if (selected) ordered.push(selected);
  for (const provider of providers) if (provider !== selected) ordered.push(provider);
  ordered.push(builtin);

  if (!selected && requested !== 'heuristic') {
    notes.push(
      `XACHEUS_MODEL="${requested}" is not configured (missing credentials), so Xacheus is using the built-in deterministic planner.`,
    );
  }
  if (!providers.length) {
    notes.push(
      'No language model configured. Xacheus runs on its built-in deterministic planner: intent routing, tool selection, memory and knowledge all work, but responses are structured rather than conversational. Set XACHEUS_MODEL=ollama for a fully local model.',
    );
  }

  const active = ordered[0] ?? builtin;
  return {
    active,
    all: ordered.map((provider, index) => ({ provider, selected: index === 0 })),
    builtin: active.locality === 'builtin',
    notes,
  };
}

/** Try each provider in order until one produces content. */
export async function completeWithFallback(
  registry: ModelRegistry,
  request: ModelRequest,
): Promise<{ response: ModelResponse; providerId: string; failures: { provider: string; error: string }[] }> {
  const failures: { provider: string; error: string }[] = [];
  for (const { provider } of registry.all) {
    if (provider.locality === 'builtin') {
      return { response: await provider.complete(request), providerId: provider.id, failures };
    }
    try {
      const response = await provider.complete(request);
      if (response.text.trim()) return { response, providerId: provider.id, failures };
      failures.push({ provider: provider.id, error: 'empty response' });
    } catch (error) {
      failures.push({ provider: provider.id, error: (error as Error).message });
    }
  }
  const builtin = registry.all.at(-1)!.provider;
  return { response: await builtin.complete(request), providerId: builtin.id, failures };
}
