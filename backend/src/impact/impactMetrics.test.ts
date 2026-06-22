import { describe, expect, it } from 'vitest';

import { computeImpact } from './impactMetrics.js';

describe('computeImpact', () => {
  it('derives collateral (TVL) from exposure / utilization', () => {
    const m = computeImpact({ exposure: 6_200_000, utilization: 0.62 });
    expect(m.exposureUsd).toBe(6_200_000);
    expect(m.protectedValueUsd).toBe(10_000_000);
    expect(m.lossPreventedUsd).toBe(0); // no mitigation in a calm state
    expect(m.mitigationActive).toBe(false);
  });

  it('counts loss prevented only while a mitigation is active, capped at exposure', () => {
    const calm = computeImpact(
      { exposure: 1_000_000, utilization: 0.5, priceChange1mPct: -20 },
      { mitigationActive: false },
    );
    expect(calm.lossPreventedUsd).toBe(0);

    const acting = computeImpact(
      { exposure: 1_000_000, utilization: 0.5, priceChange1mPct: -20, priceChange5mPct: -35 },
      { mitigationActive: true },
    );
    // worst move -35% → 35% of 1,000,000 = 350,000.
    expect(acting.lossPreventedUsd).toBe(350_000);
    expect(acting.mitigationActive).toBe(true);
  });

  it('treats a paused / guarded market as an active mitigation', () => {
    const paused = computeImpact({ exposure: 500_000, utilization: 0.5, priceChange1mPct: -10, borrowPaused: true });
    expect(paused.mitigationActive).toBe(true);
    expect(paused.lossPreventedUsd).toBe(50_000);
  });

  it('handles missing / zero fields without dividing by zero', () => {
    const m = computeImpact({});
    expect(m.exposureUsd).toBe(0);
    expect(m.protectedValueUsd).toBe(0);
    expect(m.lossPreventedUsd).toBe(0);
  });
});
