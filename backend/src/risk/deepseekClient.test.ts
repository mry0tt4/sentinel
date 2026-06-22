import { describe, expect, it, vi } from 'vitest';

import { DeepSeekLlmClient, createLlmClient } from './deepseekClient.js';

/** Build a fake `fetch` returning a canned chat-completions response. */
function okFetch(content: string): typeof fetch {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content } }] }),
    text: async () => '',
  })) as unknown as typeof fetch;
}

describe('DeepSeekLlmClient', () => {
  it('returns the model message content on a successful response', async () => {
    const fetchFn = okFetch('Volatility spiked; score reflects oracle risk.');
    const client = new DeepSeekLlmClient({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      fetchFn,
    });

    const text = await client.complete('explain this');
    expect(text).toBe('Volatility spiked; score reflects oracle risk.');
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it('posts to the OpenAI-compatible /chat/completions endpoint with auth + model', async () => {
    const fetchFn = okFetch('ok');
    const client = new DeepSeekLlmClient({
      apiKey: 'sk-secret',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
      fetchFn,
    });
    await client.complete('p');

    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-secret');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('deepseek-chat');
    expect(body.stream).toBe(false);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('does not double-append the path when the base URL already includes it', async () => {
    const fetchFn = okFetch('ok');
    const client = new DeepSeekLlmClient({
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://example.com/v1/chat/completions',
      fetchFn,
    });
    await client.complete('p');
    const [url] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://example.com/v1/chat/completions');
  });

  it('throws on a non-2xx response so the explanation service can fall back', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({}),
      text: async () => 'rate limited',
    })) as unknown as typeof fetch;
    const client = new DeepSeekLlmClient({ apiKey: 'k', model: 'm', baseUrl: 'https://x', fetchFn });

    await expect(client.complete('p')).rejects.toThrow(/HTTP 429/);
  });

  it('throws when the response has no message content', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '' } }] }),
      text: async () => '',
    })) as unknown as typeof fetch;
    const client = new DeepSeekLlmClient({ apiKey: 'k', model: 'm', baseUrl: 'https://x', fetchFn });

    await expect(client.complete('p')).rejects.toThrow(/no message content/);
  });

  it('rejects an empty API key at construction', () => {
    expect(
      () => new DeepSeekLlmClient({ apiKey: '  ', model: 'm', baseUrl: 'https://x' }),
    ).toThrow(/apiKey/);
  });
});

describe('createLlmClient', () => {
  it('returns undefined when no API key is configured (template fallback)', () => {
    expect(
      createLlmClient({ apiKey: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' }),
    ).toBeUndefined();
  });

  it('returns a client when an API key is present', () => {
    const client = createLlmClient({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      baseUrl: 'https://api.deepseek.com',
    });
    expect(client).toBeInstanceOf(DeepSeekLlmClient);
  });
});
