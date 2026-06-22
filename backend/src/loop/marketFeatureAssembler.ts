/**
 * Market Feature Assembler — bridges the Oracle Ingestion / Liquidity workers
 * to the {@link RiskControlLoop} (task 21.1).
 *
 * The workers emit *raw* per-market readings to their narrow sink ports
 * ({@link import('../oracle/oracleIngestionWorker.js').OracleReadingSink} /
 * {@link import('../liquidity/liquidityWorker.js').LiquidityReadingSink}). This
 * assembler is the concrete sink the production wiring plugs in: it keeps the
 * latest oracle + liquidity reading per market, merges them with the market's
 * configured baseline into a Risk_Engine {@link FeatureVector} plus the
 * fail-closed {@link FailClosedGuardContext}, and hands the assembled tick to
 * the loop. This is the "workers → Risk Engine" edge of the end-to-end loop.
 *
 * The assembler owns no transport and no infra: it is pure in-memory state plus
 * the injected loop, so it is fully unit-testable. The exact fixed-point price
 * scaling (oracle mantissa → quote price) is a downstream concern handled by
 * the feed mapping; here the mantissa is read as a number, which is sufficient
 * for the deterministic Risk_Engine that consumes plain numbers.
 */

import type { LiquiditySnapshot } from '../liquidity/liquidityWorker.js';
import type { OracleSnapshot } from '../oracle/oracleIngestionWorker.js';
import type { FailClosedGuardContext, PolicyActionBounds } from '../risk/failClosedRiskEngine.js';
import type { FeatureVector } from '../risk/types.js';

import type { LoopOutcome, RiskControlLoop } from './riskControlLoop.js';

/**
 * Per-market baseline + policy configuration the assembler overlays the live
 * oracle/liquidity readings onto. Fields the workers do not measure directly
 * (protocol exposure, governance flags, short-window volatility) come from
 * here; oracle and liquidity fields are filled from the latest readings.
 */
export interface MarketAssemblerConfig {
  marketId: string;
  /** Oracle freshness threshold (ms) for staleness detection. (Req 6.14) */
  freshnessThresholdMs: number;

  // Protocol exposure baseline.
  utilization: number;
  exposure: number;
  currentMaxLtvBps: number;

  // Governance / config flags.
  borrowPaused?: boolean;
  guardedMode?: boolean;
  policyActive?: boolean;
  guardianRevoked?: boolean;
  priorActionsCount?: number;
  priorOverridesCount?: number;
  historicalEvidenceRefs?: string[];

  // Volatility window defaults (the workers do not compute these per reading).
  priceChange1mPct?: number;
  priceChange5mPct?: number;
  priceChange15mPct?: number;
  realizedVolatilityPct?: number;

  // Optional reference / peg prices for divergence + depeg detection.
  referencePrice?: number;
  expectedPegPrice?: number;

  // Oracle fallbacks used until the first oracle reading arrives.
  oraclePrice?: number;
  oracleConfidence?: number;

  // Liquidity fallbacks used until the first liquidity reading arrives.
  liquidityDepth?: number;
  spreadBps?: number;
  imbalance?: number;

  /** Fail-closed policy bounds for action validation. (Req 6.10) */
  policy: PolicyActionBounds;
  /** Whether policy permits an emergency stale-data pause. (Req 6.14) */
  policyPermitsStalePause: boolean;
}

export interface MarketFeatureAssemblerOptions {
  loop: RiskControlLoop;
  markets: MarketAssemblerConfig[];
  /** Clock for the evaluation reference time; defaults to `Date.now`. */
  now?: () => number;
}

/** Latest readings retained per market. */
interface MarketReadings {
  oracle?: OracleSnapshot;
  liquidity?: LiquiditySnapshot;
}

/** Max oracle prices retained per market for realized-volatility computation. */
const PRICE_HISTORY_LIMIT = 40;

/**
 * Realized volatility (%) from a price series: the standard deviation of
 * consecutive percentage returns. Scale-invariant, so it is correct whether the
 * prices are dollars or Pyth fixed-point mantissas. Returns `null` for fewer
 * than three points (not enough returns to be meaningful).
 */
export function realizedVolatilityPct(prices: readonly number[]): number | null {
  const usable = prices.filter((p) => Number.isFinite(p) && p > 0);
  if (usable.length < 3) {
    return null;
  }
  const returns: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    returns.push(((usable[i] as number) - (usable[i - 1] as number)) / (usable[i - 1] as number));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) * (r - mean), 0) / returns.length;
  return Math.sqrt(variance) * 100;
}

/**
 * Assembles feature vectors from worker readings and drives the
 * {@link RiskControlLoop}. Exposes {@link oracleSink} / {@link liquiditySink}
 * implementing the workers' sink ports.
 */
export class MarketFeatureAssembler {
  private readonly loop: RiskControlLoop;
  private readonly configs = new Map<string, MarketAssemblerConfig>();
  private readonly readings = new Map<string, MarketReadings>();
  /** Rolling oracle price history per market, for realized-volatility. */
  private readonly priceHistory = new Map<string, number[]>();
  private readonly now: () => number;

  constructor(options: MarketFeatureAssemblerOptions) {
    this.loop = options.loop;
    this.now = options.now ?? Date.now;
    for (const config of options.markets) {
      this.configs.set(config.marketId, config);
    }
  }

  /** Sink the Oracle Ingestion Worker writes each reading to. */
  get oracleSink(): { record(snapshot: OracleSnapshot): Promise<void> } {
    return {
      record: (snapshot: OracleSnapshot) => this.recordOracle(snapshot),
    };
  }

  /** Sink the Liquidity Worker writes each reading to. */
  get liquiditySink(): { record(snapshot: LiquiditySnapshot): Promise<void> } {
    return {
      record: (snapshot: LiquiditySnapshot) => this.recordLiquidity(snapshot),
    };
  }

  /** Record a fresh oracle reading and trigger a re-evaluation for its market. */
  async recordOracle(snapshot: OracleSnapshot): Promise<void> {
    const readings = this.readingsFor(snapshot.marketId);
    readings.oracle = snapshot;
    // Maintain a rolling price history for realized-volatility (real data).
    const price = Number(snapshot.price);
    if (Number.isFinite(price) && price > 0) {
      const history = this.priceHistory.get(snapshot.marketId) ?? [];
      history.push(price);
      if (history.length > PRICE_HISTORY_LIMIT) {
        history.shift();
      }
      this.priceHistory.set(snapshot.marketId, history);
    }
    await this.tick(snapshot.marketId);
  }

  /** Record a fresh liquidity reading and trigger a re-evaluation for its market. */
  async recordLiquidity(snapshot: LiquiditySnapshot): Promise<void> {
    const readings = this.readingsFor(snapshot.marketId);
    readings.liquidity = snapshot;
    await this.tick(snapshot.marketId);
  }

  /**
   * Assemble the current feature vector + guard context for a market and run a
   * loop tick. Markets without a registered config are ignored (no orphaned
   * evaluation). Returns the {@link LoopOutcome}, or `null` when the market is
   * unconfigured.
   */
  async tick(marketId: string): Promise<LoopOutcome | null> {
    const config = this.configs.get(marketId);
    if (config === undefined) {
      return null;
    }
    const nowMs = this.now();
    const features = this.assembleFeatures(config, nowMs);
    const guard = this.buildGuardContext(config, features);
    return this.loop.onTick({ marketId, features, guard, dataSource: 'live' });
  }

  private readingsFor(marketId: string): MarketReadings {
    let readings = this.readings.get(marketId);
    if (readings === undefined) {
      readings = {};
      this.readings.set(marketId, readings);
    }
    return readings;
  }

  /** Merge the market baseline with the latest oracle + liquidity readings. */
  private assembleFeatures(config: MarketAssemblerConfig, nowMs: number): FeatureVector {
    const readings = this.readings.get(config.marketId) ?? {};
    const oracle = readings.oracle;
    const liquidity = readings.liquidity;

    return {
      oraclePrice: oracle ? Number(oracle.price) : config.oraclePrice ?? 1,
      oracleConfidence: oracle ? Number(oracle.confidence) : config.oracleConfidence ?? 0,
      oracleTimestampMs: oracle ? oracle.timestampMs : nowMs,
      nowMs,
      freshnessThresholdMs: config.freshnessThresholdMs,
      referencePrice: config.referencePrice,
      expectedPegPrice: config.expectedPegPrice,

      priceChange1mPct: config.priceChange1mPct ?? 0,
      priceChange5mPct: config.priceChange5mPct ?? 0,
      priceChange15mPct: config.priceChange15mPct ?? 0,
      // Prefer realized volatility computed from the live oracle price history;
      // fall back to the configured baseline until enough samples exist.
      realizedVolatilityPct:
        realizedVolatilityPct(this.priceHistory.get(config.marketId) ?? []) ??
        config.realizedVolatilityPct ??
        0,

      liquidityDepth: liquidity ? liquidity.liquidityDepth : config.liquidityDepth ?? 1_000_000,
      spreadBps: liquidity ? liquidity.spreadBps : config.spreadBps ?? 0,
      imbalance: liquidity ? liquidity.imbalance : config.imbalance ?? 0,

      utilization: config.utilization,
      exposure: config.exposure,
      currentMaxLtvBps: config.currentMaxLtvBps,

      borrowPaused: config.borrowPaused ?? false,
      guardedMode: config.guardedMode ?? false,
      policyActive: config.policyActive ?? true,
      guardianRevoked: config.guardianRevoked ?? false,
      priorActionsCount: config.priorActionsCount ?? 0,
      priorOverridesCount: config.priorOverridesCount ?? 0,
      historicalEvidenceRefs: config.historicalEvidenceRefs ?? [],
    };
  }

  /** Build the fail-closed guard context from the assembled features + policy. */
  private buildGuardContext(
    config: MarketAssemblerConfig,
    features: FeatureVector,
  ): FailClosedGuardContext {
    const oracleAgeMs = Math.max(0, features.nowMs - features.oracleTimestampMs);
    return {
      evaluationComplete: true,
      oracle: { present: true },
      isSuiTestnet: true,
      guardianRevoked: features.guardianRevoked,
      policy: config.policy,
      proposedMagnitude: {},
      oracleAgeMs,
      freshnessThresholdMs: features.freshnessThresholdMs,
      policyPermitsStalePause: config.policyPermitsStalePause,
    };
  }
}
