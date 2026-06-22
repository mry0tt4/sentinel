export interface RiskScoreGaugeProps {
  /** Risk score in [0, 100], or null when no evaluation is available yet. */
  score: number | null;
  /** Assigned band label (Normal / Warning / Guarded / ...). */
  band?: string | null;
}

/** Map a score to a band-coloured class for the gauge fill. */
function bandClass(score: number): string {
  if (score >= 90) return 'gauge--emergency';
  if (score >= 75) return 'gauge--adjust';
  if (score >= 60) return 'gauge--guarded';
  if (score >= 40) return 'gauge--warning';
  return 'gauge--normal';
}

/** Band fill colour for the conic ring. */
function bandColor(score: number): string {
  if (score >= 90) return '#dc2626';
  if (score >= 75) return '#f97316';
  if (score >= 60) return '#ea580c';
  if (score >= 40) return '#d97706';
  return '#059669';
}

/**
 * Displays a market's current Risk_Score as an integer from 0 to 100 with a
 * radial conic-ring fill (matching the hero dashboard gauge). (Req 3.3)
 */
export function RiskScoreGauge({ score, band }: RiskScoreGaugeProps) {
  if (score === null || score === undefined || Number.isNaN(score)) {
    return (
      <div className="risk-gauge" data-testid="risk-gauge">
        <div className="risk-gauge__hole">
          <span className="risk-gauge__value" data-testid="risk-gauge-value">
            —
          </span>
          <span className="risk-gauge__label">No score</span>
        </div>
      </div>
    );
  }

  // Display as an integer in [0, 100]. (Req 3.3)
  const display = Math.max(0, Math.min(100, Math.round(score)));
  const color = bandColor(display);

  return (
    <div
      className={`risk-gauge ${bandClass(display)}`}
      data-testid="risk-gauge"
      style={{ background: `conic-gradient(${color} ${display}%, var(--bg-tint) ${display}% 100%)` }}
    >
      <div className="risk-gauge__hole">
        <span
          className="risk-gauge__value"
          data-testid="risk-gauge-value"
          role="meter"
          aria-valuenow={display}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Risk score"
        >
          {display}
        </span>
        {band ? (
          <span className="risk-gauge__label" data-testid="risk-gauge-band" style={{ color }}>
            {band}
          </span>
        ) : null}
      </div>
    </div>
  );
}
