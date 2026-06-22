/**
 * DeepSeek (OpenAI-compatible) LLM client for the AI Explanation Service.
 *
 * Implements the narrow {@link LlmClient} port (`complete(prompt) => text`) by
 * calling an OpenAI-compatible `/chat/completions` endpoint. DeepSeek's API is
 * OpenAI-compatible, so the same client works for `deepseek-chat` (V3) or
 * `deepseek-reasoner` (R1) — and for any other OpenAI-compatible provider by
 * changing the base URL.
 *
 * IMPORTANT: this client only produces explanation TEXT. It is wired behind the
 * {@link LlmExplanationService}, which has no authority over the risk score,
 * band, classes, recommended action, or confidence (Req 6.5, 6.13). A network
 * failure, timeout, or malformed response simply throws — the explanation
 * service then falls back to the deterministic template, so the gating path is
 * never affected.
 *
 * The API key is read from {@link AppSecrets} (env var `LLM_API_KEY`) and is
 * never logged or echoed. When no key is configured, {@link createLlmClient}
 * returns `undefined` so the system uses the template fallback.
 */

import type { LlmClient } from './aiExplanationService.js';

/** Options for {@link DeepSeekLlmClient}. */
export interface DeepSeekClientOptions {
  /** API key (secret). */
  apiKey: string;
  /** Model id, e.g. `deepseek-chat` or `deepseek-reasoner`. */
  model: string;
  /** OpenAI-compatible base URL, e.g. `https://api.deepseek.com`. */
  baseUrl: string;
  /** Request timeout in ms (default 12_000). */
  timeoutMs?: number;
  /** Sampling temperature (default 0.2 — concise, low-variance explanations). */
  temperature?: number;
  /** Upper bound on generated tokens (default 320 ≈ comfortably under 1000 chars). */
  maxTokens?: number;
  /** Injectable fetch for testing; defaults to the global `fetch`. */
  fetchFn?: typeof fetch;
}

/** Minimal shape of the OpenAI-compatible chat-completions response we read. */
interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null>;
}

/**
 * OpenAI-compatible chat-completions client (DeepSeek by default). Turns a
 * prompt into a single text completion. Throws on non-2xx, timeout, or a
 * response missing message content so the explanation service can fall back.
 */
export class DeepSeekLlmClient implements LlmClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly temperature: number;
  private readonly maxTokens: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: DeepSeekClientOptions) {
    if (!options.apiKey || options.apiKey.trim() === '') {
      throw new Error('DeepSeekLlmClient requires a non-empty apiKey');
    }
    this.apiKey = options.apiKey;
    this.model = options.model;
    // Normalize: allow base URLs with or without a trailing slash or path.
    const base = options.baseUrl.replace(/\/+$/, '');
    this.endpoint = base.endsWith('/chat/completions')
      ? base
      : `${base}/chat/completions`;
    this.timeoutMs = options.timeoutMs ?? 12_000;
    this.temperature = options.temperature ?? 0.2;
    this.maxTokens = options.maxTokens ?? 320;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async complete(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          temperature: this.temperature,
          max_tokens: this.maxTokens,
          stream: false,
          messages: [
            {
              role: 'system',
              content:
                'You are a DeFi risk analyst. Explain a precomputed risk assessment ' +
                'in clear, plain language. You must not recommend or take any action; ' +
                'the score and action are already decided deterministically and cannot ' +
                'be changed by you. Keep the response under 1000 characters.',
            },
            { role: 'user', content: prompt },
          ],
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const detail = await safeText(res);
        throw new Error(`LLM request failed: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`);
      }

      const body = (await res.json()) as ChatCompletionResponse;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('LLM response contained no message content');
      }
      return content;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Read a response body as text without throwing (best-effort error detail). */
async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try {
    const t = await res.text();
    return t.length > 200 ? `${t.slice(0, 200)}…` : t;
  } catch {
    return '';
  }
}

/**
 * Build an {@link LlmClient} from config + secret, or `undefined` when no API
 * key is configured (so the explanation service uses the deterministic template
 * fallback). Keeps the LLM entirely optional. (Req 6.5)
 */
export function createLlmClient(input: {
  apiKey: string;
  model: string;
  baseUrl: string;
  fetchFn?: typeof fetch;
}): LlmClient | undefined {
  if (!input.apiKey || input.apiKey.trim() === '') {
    return undefined;
  }
  return new DeepSeekLlmClient({
    apiKey: input.apiKey,
    model: input.model,
    baseUrl: input.baseUrl,
    fetchFn: input.fetchFn,
  });
}
