/**
 * Impact metrics — the "real-world value" Sentinel protects, in USD.
 *
 * All inputs are REAL, live testnet readings: the monitored exposure +
 * utilization come from the on-chain `MarketState` (read via devInspect), and
 * the oracle price comes from the live Pyth SUI/USD feed. Nothing here is
 * mocked — these are the figures a protocol operator actually cares about:
 *
 *   - Protected value (TVL): the collateral backing the market the agent guards.
 *   - Exposure: the borrowed value at risk in an adverse move.
 *   - Loss prevented: an estimate of the value preserved when a mitigation is
 *     active during an adverse price move (exposure × adverse move fraction),
 *     bounded to the exposure so the figure is never overclaimed.
 *
 * These feed the dashboard's headline impact strip (Real-World Application) and
 * are computed deterministically from the snapshot feature vector.
 */

/** The subset of feature-vector fields the impact computation reads. */
export interface ImpactInputs {
  /** Borrowed exposure (USD notional) from the on-chain MarketState. */
  exposure?: number;
  /** Utilization in [0,1]; collateral = exposure / utilization. */
  utilization?: number;
  /** Worst recent adverse price moves (percent, negative = down). */
  priceChange1mPct?: number;
  priceChange5mPct?: number;
  /** Whether a protective action is currently in force. */
  borrowPaused?: boolean;
  guardedMode?: boolean;
}

/** Computed, USD-denominated impact figures. */
export interface ImpactMetrics {
  /** Total collateral backing the protected market (TVL), in USD. */
  protectedValueUsd: number;
  /** Borrowed value at risk, in USD. */
  exposureUsd: number;
  /** Estimated value preserved by an active mitigation, in USD. */
  lossPreventedUsd: number;
  /** Whether a protective mitigation is currently in force. */
  mitigationActive: boolean;
}

function finite(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * Compute the USD impact figures from a snapshot's feature vector. A mitigation
 * is considered active when borrows are paused, the market is in guarded mode,
 * or `mitigationActive` is forced (e.g. an action was just executed). Loss
 * prevented is `exposure × adverse-move-fraction`, only counted while a
 * mitigation is active, and capped at the exposure.
 */
export function computeImpact(
  fv: ImpactInputs,
  opts: { mitigationActive?: boolean } = {},
): ImpactMetrics {
  const exposureUsd = Math.max(0, finite(fv.exposure));
  const utilization = finite(fv.utilization);
  // Collateral (TVL) = exposure / utilization. Guard against divide-by-zero.
  const protectedValueUsd =
    utilization > 0.0001 ? Math.round(exposureUsd / utilization) : exposureUsd;

  const worstMovePct = Math.min(finite(fv.priceChange1mPct), finite(fv.priceChange5mPct), 0);
  const adverseFraction = Math.min(1, Math.abs(worstMovePct) / 100);

  const mitigationActive =
    opts.mitigationActive === true || fv.borrowPaused === true || fv.guardedMode === true;

  const lossPreventedUsd = mitigationActive
    ? Math.min(exposureUsd, Math.round(exposureUsd * adverseFraction))
    : 0;

  return { protectedValueUsd, exposureUsd, lossPreventedUsd, mitigationActive };
}
