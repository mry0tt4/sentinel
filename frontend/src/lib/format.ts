// Display formatting helpers for dashboard indicators.
//
// Live oracle readings come from Pyth, which reports prices as fixed-point
// integers on a 1e-8 scale (e.g. 70445558 = $0.70445558). Simulated scenarios
// instead use plain dollar values (e.g. 2.0). We detect the fixed-point case by
// magnitude — a raw value this large is never a human dollar price — so both
// live and simulated readings render correctly.

const PYTH_SCALE = 1e8;
const FIXED_POINT_THRESHOLD = 1e5;

/** Convert a possibly-fixed-point oracle value to a human dollar amount. */
export function toUsd(raw: number): number {
  return Math.abs(raw) >= FIXED_POINT_THRESHOLD ? raw / PYTH_SCALE : raw;
}

/** Format an oracle price as USD with sensible precision (sub-dollar aware). */
export function formatUsdPrice(raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
  const v = toUsd(raw);
  const maxDecimals = Math.abs(v) >= 1 ? 4 : 6;
  return `$${v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: maxDecimals,
  })}`;
}

/** Format an oracle confidence interval as a ± USD band. */
export function formatUsdConfidence(raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
  const v = toUsd(raw);
  return `± $${v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  })}`;
}

/** Format a plain numeric amount with thousands separators. */
export function formatAmount(raw: unknown, maxDecimals = 2): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
  return raw.toLocaleString('en-US', { maximumFractionDigits: maxDecimals });
}

/** Format a percentage value (already expressed in percent units). */
export function formatPercent(raw: unknown, maxDecimals = 2): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
  return `${raw.toLocaleString('en-US', { maximumFractionDigits: maxDecimals })}%`;
}

/** Compact USD for headline figures: $10.0M, $6.2M, $940K, $1,250. */
export function formatUsdCompact(raw: unknown): string {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return '—';
  const abs = Math.abs(raw);
  if (abs >= 1_000_000) return `$${(raw / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M`;
  if (abs >= 1_000) return `$${(raw / 1_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}K`;
  return `$${raw.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

/** Shorten a 0x object id for display: 0x9512…06d12. */
export function shortId(id: unknown, lead = 6, tail = 5): string {
  if (typeof id !== 'string' || id.length <= lead + tail + 1) return typeof id === 'string' ? id : '—';
  return `${id.slice(0, lead)}…${id.slice(-tail)}`;
}
