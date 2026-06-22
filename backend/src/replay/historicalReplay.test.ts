import { describe, expect, it } from 'vitest';

import {
  HISTORICAL_EVENTS,
  SUI_OCT_2025_CRASH,
  SUI_JUNE_2026_SELLOFF,
  getHistoricalEvent,
  runHistoricalReplay,
} from './historicalReplay.js';

describe('historical event replay', () => {
  it('defaults to the Oct 2025 crash and resolves events by id', () => {
    expect(getHistoricalEvent()).toBe(SUI_OCT_2025_CRASH);
    expect(getHistoricalEvent('sui-jun-2026-selloff')).toBe(SUI_JUNE_2026_SELLOFF);
    expect(getHistoricalEvent('nope')).toBeUndefined();
  });

  it('replays the real Oct 2025 crash and the engine would have acted', () => {
    const r = runHistoricalReplay(SUI_OCT_2025_CRASH);

    expect(r.points).toHaveLength(SUI_OCT_2025_CRASH.series.length);
    // A real ~28% drawdown — the engine must escalate and recommend an action.
    expect(r.summary.maxDrawdownPct).toBeLessThan(-25);
    expect(r.summary.peakRiskScore).toBeGreaterThanOrEqual(70);
    expect(r.summary.wouldHaveActed).toBe(true);
    expect(r.summary.firstActionType).not.toBeNull();
    expect(r.summary.firstActionAt).not.toBeNull();
  });

  it('produces a deterministic, monotonic-in-fields trajectory', () => {
    const a = runHistoricalReplay(SUI_OCT_2025_CRASH);
    const b = runHistoricalReplay(SUI_OCT_2025_CRASH);
    // Scores are deterministic for the same series.
    expect(a.points.map((p) => p.riskScore)).toEqual(b.points.map((p) => p.riskScore));
    // Every score is a valid 0–100 integer; every point carries a band.
    for (const p of a.points) {
      expect(Number.isInteger(p.riskScore)).toBe(true);
      expect(p.riskScore).toBeGreaterThanOrEqual(0);
      expect(p.riskScore).toBeLessThanOrEqual(100);
      expect(typeof p.band).toBe('string');
    }
  });

  it('stays calm before the crash begins', () => {
    const r = runHistoricalReplay(SUI_OCT_2025_CRASH);
    // The first observation (pre-crash) should be Normal/low risk.
    expect(r.points[0]?.riskScore).toBeLessThan(40);
  });

  it('registers exactly the two real events', () => {
    expect(HISTORICAL_EVENTS).toHaveLength(2);
    expect(HISTORICAL_EVENTS.map((e) => e.id)).toContain('sui-oct-2025-crash');
  });
});
