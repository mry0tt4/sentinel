/**
 * Live configuration for the two ADDITIONAL monitored markets (SUI Perps and
 * USDC Vault) so they are driven by the SAME live risk-control loop as the
 * primary demo market — real Pyth oracle readings each tick, persisted as
 * `risk_snapshots` and pushed over the WebSocket — instead of a one-shot seed
 * that goes stale.
 *
 * The off-chain market UUIDs MUST match the rows written by
 * {@link ./seedExtraMarkets.ts} so the seeded `markets` row, the live loop's
 * snapshots, and the dashboard subscription all agree on the same market.
 *
 * These markets remain monitor-only (no policy / no autonomous on-chain
 * action): the loop evaluates, persists, and pushes their live risk, but no
 * planner is wired so it never auto-submits a transaction for them.
 */

import { DEMO_DEEPBOOK_POOL, DEMO_ORACLE_FEED_ID } from './demoMarket.js';

/**
 * Real Pyth SUI/USD price feed id (Hermes). Shared with the primary demo
 * market — re-exported here so the extra-market wiring reads from one place.
 */
export const PYTH_SUI_USD_FEED_ID = DEMO_ORACLE_FEED_ID;

/**
 * Real Pyth USDC/USD price feed id (Hermes). Drives the USDC Vault's live
 * oracle price (~$1.00) and powers its depeg detection against the $1 peg.
 */
export const PYTH_USDC_USD_FEED_ID =
  '0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a';

/** Oracle freshness threshold (ms) shared by the extra markets. */
export const EXTRA_FRESHNESS_THRESHOLD_MS = 30_000;

/**
 * Per-market live config: the off-chain UUID, its real Pyth feed, an optional
 * real DeepBook pool for live liquidity (falls back to a deterministic baseline
 * when absent), and the protocol-exposure baseline the live oracle/liquidity
 * readings are overlaid onto.
 *
 * `referencePrice` / `expectedPegPrice` are in the SAME 1e-8 fixed-point scale
 * Pyth returns (e.g. $1.00 → 100_000_000), so the divergence/peg checks stay
 * unit-consistent and never false-fire.
 */
export interface ExtraMarketLiveConfig {
  marketId: string;
  name: string;
  oracleFeedId: string;
  /** Human label for the oracle feed (e.g. "SUI/USD"), shown in Live Sources. */
  oracleSymbol: string;
  /** Real DeepBook pool for live liquidity; omit to use a stable baseline. */
  deepBookPool?: string;
  /** Human label for the DeepBook pool market (e.g. "SUI/USDC"). */
  deepBookMarket?: string;
  freshnessThresholdMs: number;
  utilization: number;
  exposure: number;
  currentMaxLtvBps: number;
  realizedVolatilityPct: number;
  liquidityDepth: number;
  spreadBps: number;
  referencePrice?: number;
  expectedPegPrice?: number;
}

export const EXTRA_MARKETS_LIVE: ExtraMarketLiveConfig[] = [
  {
    // SUI Perps — leveraged SUI market: real SUI/USD oracle + real DeepBook
    // SUI/USDC liquidity. Elevated utilization keeps it in the watchful band.
    marketId: '44444444-4444-4444-8444-444444444444',
    name: 'SUI Perps',
    oracleFeedId: PYTH_SUI_USD_FEED_ID,
    oracleSymbol: 'SUI/USD',
    deepBookPool: DEMO_DEEPBOOK_POOL,
    deepBookMarket: 'SUI/USDC',
    freshnessThresholdMs: EXTRA_FRESHNESS_THRESHOLD_MS,
    utilization: 0.8,
    exposure: 3_100_000,
    currentMaxLtvBps: 8000,
    realizedVolatilityPct: 10,
    liquidityDepth: 900_000,
    spreadBps: 24,
    // SUI/USD ~ $0.71 in 1e-8 fixed point.
    referencePrice: 71_000_000,
  },
  {
    // USDC Vault — stable, deep, low utilization: real USDC/USD oracle anchors
    // the live price + peg check; liquidity uses a deep stable baseline (the
    // DeepBook testnet stable book is empty, so depth is modeled, not faked as
    // a live book).
    marketId: '55555555-5555-4555-8555-555555555555',
    name: 'USDC Vault',
    oracleFeedId: PYTH_USDC_USD_FEED_ID,
    oracleSymbol: 'USDC/USD',
    freshnessThresholdMs: EXTRA_FRESHNESS_THRESHOLD_MS,
    utilization: 0.38,
    exposure: 8_000_000,
    currentMaxLtvBps: 9000,
    realizedVolatilityPct: 2,
    liquidityDepth: 5_000_000,
    spreadBps: 4,
    // USDC/USD ~ $1.00 in 1e-8 fixed point; peg target is the same scale.
    referencePrice: 100_000_000,
    expectedPegPrice: 100_000_000,
  },
];
