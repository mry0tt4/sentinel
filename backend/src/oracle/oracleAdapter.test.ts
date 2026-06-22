import { describe, expect, it } from 'vitest';

import {
  type FetchLike,
  type HttpResponseLike,
  MockOracleAdapter,
  OracleReadError,
  PythOracleAdapter,
  createOracleAdapter,
  parseHermesReading,
} from './oracleAdapter.js';

/** Build a fake Hermes `/v2/updates/price/latest` body for one feed. */
function hermesBody(opts: {
  id?: string;
  price: string;
  conf: string;
  expo?: number;
  publishTimeSec: number;
}): unknown {
  return {
    parsed: [
      {
        id: opts.id ?? 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
        price: {
          price: opts.price,
          conf: opts.conf,
          expo: opts.expo ?? -8,
          publish_time: opts.publishTimeSec,
        },
      },
    ],
  };
}

/** Wrap a JSON body in an OK fetch response. */
function okResponse(body: unknown): HttpResponseLike {
  return { ok: true, status: 200, json: async () => body };
}

const FEED_ID = '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43';

describe('PythOracleAdapter.readFeed', () => {
  it('maps a Hermes response to { price, confidence, timestampMs }', async () => {
    const fetchFn: FetchLike = async () =>
      okResponse(hermesBody({ price: '5123456789', conf: '1234567', publishTimeSec: 1_700_000_001 }));

    const adapter = new PythOracleAdapter({ fetchFn });
    const reading = await adapter.readFeed(FEED_ID);

    expect(reading.price).toBe(5123456789n);
    expect(reading.confidence).toBe(1234567n);
    // publish_time (seconds) is scaled to milliseconds.
    expect(reading.timestampMs).toBe(1_700_000_001_000);
  });

  it('requests the configured feed id against the configured base url', async () => {
    let requestedUrl = '';
    const fetchFn: FetchLike = async (url) => {
      requestedUrl = url;
      return okResponse(hermesBody({ price: '1', conf: '1', publishTimeSec: 1 }));
    };
    const adapter = new PythOracleAdapter({ fetchFn, baseUrl: 'https://hermes.example/' });
    await adapter.readFeed(FEED_ID);

    expect(requestedUrl).toContain('https://hermes.example/v2/updates/price/latest');
    expect(requestedUrl).toContain(encodeURIComponent(FEED_ID));
    // Trailing slash on the base url is normalized (no double slash in path).
    expect(requestedUrl).not.toContain('.example//v2');
  });

  it('throws OracleReadError on a non-OK HTTP status', async () => {
    const fetchFn: FetchLike = async () => ({ ok: false, status: 503, json: async () => ({}) });
    const adapter = new PythOracleAdapter({ fetchFn });
    await expect(adapter.readFeed(FEED_ID)).rejects.toBeInstanceOf(OracleReadError);
  });

  it('throws OracleReadError when the feed transport fails', async () => {
    const fetchFn: FetchLike = async () => {
      throw new Error('network down');
    };
    const adapter = new PythOracleAdapter({ fetchFn });
    await expect(adapter.readFeed(FEED_ID)).rejects.toBeInstanceOf(OracleReadError);
  });

  it('rejects an empty feed id without calling fetch', async () => {
    let called = false;
    const fetchFn: FetchLike = async () => {
      called = true;
      return okResponse({});
    };
    const adapter = new PythOracleAdapter({ fetchFn });
    await expect(adapter.readFeed('   ')).rejects.toBeInstanceOf(OracleReadError);
    expect(called).toBe(false);
  });
});

describe('parseHermesReading', () => {
  it('throws when the parsed array is empty or missing', () => {
    expect(() => parseHermesReading({ parsed: [] }, FEED_ID)).toThrow(OracleReadError);
    expect(() => parseHermesReading({}, FEED_ID)).toThrow(OracleReadError);
  });

  it('throws when price fields are absent', () => {
    const body = { parsed: [{ id: 'x', price: { expo: -8 } }] };
    expect(() => parseHermesReading(body, FEED_ID)).toThrow(OracleReadError);
  });

  it('matches the requested feed id among multiple entries', () => {
    const body = {
      parsed: [
        { id: 'aaaa', price: { price: '1', conf: '1', expo: -8, publish_time: 1 } },
        {
          id: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
          price: { price: '999', conf: '7', expo: -8, publish_time: 2 },
        },
      ],
    };
    const reading = parseHermesReading(body, FEED_ID);
    expect(reading.price).toBe(999n);
    expect(reading.confidence).toBe(7n);
    expect(reading.timestampMs).toBe(2000);
  });
});

describe('MockOracleAdapter.readFeed', () => {
  it('returns seeded readings verbatim', async () => {
    const adapter = new MockOracleAdapter({
      readings: { 'feed-a': { price: 42n, confidence: 3n, timestampMs: 1234 } },
    });
    const reading = await adapter.readFeed('feed-a');
    expect(reading).toEqual({ price: 42n, confidence: 3n, timestampMs: 1234 });
  });

  it('is deterministic for unseeded feeds (same input -> same output)', async () => {
    const adapter = new MockOracleAdapter();
    const first = await adapter.readFeed('SUI/USD');
    const second = await adapter.readFeed('SUI/USD');
    expect(second).toEqual(first);
    expect(typeof first.price).toBe('bigint');
    expect(typeof first.confidence).toBe('bigint');
    expect(Number.isInteger(first.timestampMs)).toBe(true);
  });

  it('rejects an empty feed id', async () => {
    const adapter = new MockOracleAdapter();
    await expect(adapter.readFeed('')).rejects.toBeInstanceOf(OracleReadError);
  });
});

describe('createOracleAdapter', () => {
  it('builds a mock adapter', async () => {
    const adapter = createOracleAdapter({ kind: 'mock' });
    expect(adapter).toBeInstanceOf(MockOracleAdapter);
  });

  it('builds a pyth adapter with an injected fetch', async () => {
    const fetchFn: FetchLike = async () =>
      okResponse(hermesBody({ price: '10', conf: '2', publishTimeSec: 5 }));
    const adapter = createOracleAdapter({ kind: 'pyth', fetchFn });
    expect(adapter).toBeInstanceOf(PythOracleAdapter);
    const reading = await adapter.readFeed(FEED_ID);
    expect(reading.price).toBe(10n);
  });
});
