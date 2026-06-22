/**
 * Real Sui DeFi protocol reserve reader.
 *
 * Sentinel's bounded actions execute on its own Sui Testnet policy, but the
 * value it protects is anchored to a REAL, live Sui lending market. This reader
 * fetches the live deposits (TVL) and outstanding borrows of a real Sui lending
 * protocol so the dashboard's "protected value / exposure" reflects genuine
 * on-chain capital rather than a synthetic figure.
 *
 * The numbers come from DefiLlama's protocol endpoint, which aggregates the
 * protocol's on-chain Sui reserves. Lending TVL on DefiLlama is reported net of
 * borrows, so total deposits = net TVL + borrowed, and utilization =
 * borrowed / deposits. The reader caches briefly and fails soft (serving the
 * last good value, or null) so a transient outage never breaks the API.
 */

/** A live snapshot of a real Sui lending market's reserves, in USD. */
export interface ProtocolReserve {
  /** Display name, e.g. "Suilend". */
  name: string;
  /** DefiLlama slug, e.g. "suilend". */
  slug: string;
  /** Total deposits / collateral backing the market (TVL), in USD. */
  suppliedUsd: number;
  /** Outstanding borrows (exposure at risk), in USD. */
  borrowedUsd: number;
  /** Borrowed / supplied in [0,1]. */
  utilization: number;
  /** Public link to verify the figures. */
  url: string;
  /** When this reading was taken (ms epoch). */
  asOfMs: number;
}

/** Narrow read port so the API and tests can inject a fake. */
export interface ProtocolReserveReader {
  read(): Promise<ProtocolReserve | null>;
}

/** Minimal fetch surface so tests can inject a fake without a real network. */
export type FetchLike = (
  url: string,
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface DefiLlamaReaderOptions {
  /** DefiLlama protocol slug (default "suilend"). */
  slug?: string;
  /** Display name (default "Suilend"). */
  displayName?: string;
  /** Chain key in `currentChainTvls` (default "Sui"). */
  chainKey?: string;
  /** Cache TTL in ms (default 60s). */
  ttlMs?: number;
  /** Injectable fetch (default global `fetch`). */
  fetchFn?: FetchLike;
  /** Injectable clock (default `Date.now`). */
  now?: () => number;
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Build a {@link ProtocolReserveReader} backed by DefiLlama for a real Sui
 * lending protocol. Caches for `ttlMs` and serves the last good value on a
 * transient failure so the read endpoint stays resilient.
 */
export function createDefiLlamaReserveReader(
  opts: DefiLlamaReaderOptions = {},
): ProtocolReserveReader {
  const slug = opts.slug ?? 'suilend';
  const fallbackName = opts.displayName ?? 'Suilend';
  const chainKey = opts.chainKey ?? 'Sui';
  const ttlMs = opts.ttlMs ?? 60_000;
  const fetchFn: FetchLike =
    opts.fetchFn ?? ((url) => fetch(url) as unknown as ReturnType<FetchLike>);
  const now = opts.now ?? Date.now;

  let cached: ProtocolReserve | null = null;
  let cachedAt = 0;

  return {
    async read(): Promise<ProtocolReserve | null> {
      const t = now();
      if (cached !== null && t - cachedAt < ttlMs) {
        return cached;
      }
      try {
        const res = await fetchFn(`https://api.llama.fi/protocol/${slug}`);
        if (!res.ok) {
          cachedAt = t;
          return cached;
        }
        const data = (await res.json()) as {
          name?: string;
          currentChainTvls?: Record<string, number>;
        };
        const tvls = data.currentChainTvls ?? {};
        const borrowedUsd = num(tvls.borrowed ?? tvls[`${chainKey}-borrowed`]);
        // DefiLlama lending TVL is net of borrows → deposits = net TVL + borrowed.
        const netTvl = num(tvls[chainKey]);
        const suppliedUsd = netTvl + borrowedUsd;
        if (suppliedUsd <= 0) {
          cachedAt = t;
          return cached;
        }
        const utilization =
          borrowedUsd > 0 ? Math.min(1, borrowedUsd / suppliedUsd) : 0;
        const value: ProtocolReserve = {
          name: data.name ?? fallbackName,
          slug,
          suppliedUsd: Math.round(suppliedUsd),
          borrowedUsd: Math.round(borrowedUsd),
          utilization: Number(utilization.toFixed(4)),
          url: `https://defillama.com/protocol/${slug}`,
          asOfMs: t,
        };
        cached = value;
        cachedAt = t;
        return value;
      } catch {
        // Network/parse failure: serve the last good value (or null) and retry
        // after the TTL — never throw into the request path.
        cachedAt = t;
        return cached;
      }
    },
  };
}
