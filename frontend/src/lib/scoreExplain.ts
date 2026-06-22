// Turns a feature vector + risk result into a plain-English "why this score"
// breakdown, so the Simulation Lab explains its reasoning instead of just
// showing raw numbers. Mirrors the signals the deterministic engine weighs
// (oracle, volatility, liquidity, exposure, governance).

export interface ScoreFactor {
  /** Short factor name, e.g. "Utilization". */
  label: string;
  /** Plain-English detail, e.g. "92% — near capacity". */
  detail: string;
  /** How much this is pushing risk up. */
  severity: 'high' | 'medium' | 'ok';
}

function n(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Derive the contributing factors behind a risk score from the feature vector.
 * Returned in rough order of importance; severity drives the colour in the UI.
 */
export function explainScore(
  features: Record<string, unknown> | null | undefined,
  classes: string[] = [],
): ScoreFactor[] {
  if (!features) return [];
  const f = features;
  const factors: ScoreFactor[] = [];

  // Engine-classified risk patterns (e.g. "flash crash", "liquidation cascade").
  const meaningfulClasses = classes.filter((c) => c && c !== 'none');
  if (meaningfulClasses.length > 0) {
    factors.push({
      label: 'Detected pattern',
      detail: meaningfulClasses.join(', '),
      severity: 'high',
    });
  }

  // Oracle freshness (staleness).
  const now = n(f.nowMs);
  const ts = n(f.oracleTimestampMs);
  const threshold = n(f.freshnessThresholdMs, 30_000);
  const ageMs = now > 0 && ts > 0 ? Math.max(0, now - ts) : 0;
  if (ageMs > threshold) {
    factors.push({
      label: 'Oracle stale',
      detail: `last update ${Math.round(ageMs / 1000)}s ago (> ${Math.round(
        threshold / 1000,
      )}s) — the price may be unreliable`,
      severity: 'high',
    });
  }

  // Oracle confidence interval width.
  const price = Math.abs(n(f.oraclePrice));
  const conf = n(f.oracleConfidence);
  if (price > 0 && conf / price > 0.02) {
    factors.push({
      label: 'Wide oracle confidence',
      detail: `± ${((conf / price) * 100).toFixed(1)}% of price — the oracle is uncertain`,
      severity: 'medium',
    });
  }

  // Peg / divergence.
  const peg = n(f.expectedPegPrice);
  if (peg > 0) {
    const dev = Math.abs(price - peg) / peg;
    if (dev > 0.005) {
      factors.push({
        label: 'Depeg',
        detail: `price $${price.toFixed(3)} vs $${peg.toFixed(2)} peg (${(dev * 100).toFixed(
          1,
        )}% off)`,
        severity: dev > 0.02 ? 'high' : 'medium',
      });
    }
  }
  const ref = n(f.referencePrice);
  if (ref > 0) {
    const dev = Math.abs(price - ref) / ref;
    if (dev > 0.02) {
      factors.push({
        label: 'Oracle divergence',
        detail: `${(dev * 100).toFixed(1)}% off the independent reference price`,
        severity: dev > 0.05 ? 'high' : 'medium',
      });
    }
  }

  // Sharp price moves.
  const worstMove = Math.min(n(f.priceChange1mPct), n(f.priceChange5mPct), n(f.priceChange15mPct));
  if (worstMove <= -3) {
    factors.push({
      label: 'Sharp price drop',
      detail: `${worstMove.toFixed(1)}% in a short window — a fast adverse move`,
      severity: worstMove <= -10 ? 'high' : 'medium',
    });
  }

  // Realized volatility.
  const vol = n(f.realizedVolatilityPct);
  if (vol >= 20) {
    factors.push({
      label: 'High volatility',
      detail: `${vol.toFixed(0)}% realized — prices are swinging hard`,
      severity: vol >= 40 ? 'high' : 'medium',
    });
  }

  // Liquidity depth + spread.
  const depth = n(f.liquidityDepth);
  if (depth > 0 && depth < 400_000) {
    factors.push({
      label: 'Thin liquidity',
      detail: `depth ~$${Math.round(depth).toLocaleString('en-US')} — the book can't absorb size`,
      severity: depth < 150_000 ? 'high' : 'medium',
    });
  }
  const spread = n(f.spreadBps);
  if (spread >= 100) {
    factors.push({
      label: 'Wide spread',
      detail: `${Math.round(spread)} bps — a stressed, illiquid market`,
      severity: spread >= 250 ? 'high' : 'medium',
    });
  }

  // Utilization.
  const util = n(f.utilization);
  if (util >= 0.85) {
    factors.push({
      label: 'High utilization',
      detail: `${(util * 100).toFixed(0)}% of supplied funds borrowed — little headroom`,
      severity: util >= 0.92 ? 'high' : 'medium',
    });
  }

  // Governance.
  if (f.guardianRevoked === true) {
    factors.push({
      label: 'Guardian revoked',
      detail: 'the agent has been disabled by the DAO — no autonomous action possible',
      severity: 'high',
    });
  }

  // If nothing fired, the market is calm.
  if (factors.length === 0) {
    factors.push({
      label: 'All clear',
      detail: 'oracle fresh, liquidity healthy, utilization moderate — no stress detected',
      severity: 'ok',
    });
  }

  return factors;
}

/** A one-line headline summarizing the score + band + top driver. */
export function scoreHeadline(
  score: number,
  band: string,
  factors: ScoreFactor[],
): string {
  const top = factors.find((x) => x.severity === 'high') ?? factors[0];
  if (!top || top.severity === 'ok') {
    return `Score ${score} (${band}) — the market looks healthy, so no action is warranted.`;
  }
  return `Score ${score} (${band}) — driven mainly by ${top.label.toLowerCase()}: ${top.detail}.`;
}
