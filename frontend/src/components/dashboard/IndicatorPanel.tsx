import type { RiskIndicators } from '../../lib/dashboardTypes';
import {
  formatAmount,
  formatPercent,
  formatUsdConfidence,
  formatUsdPrice,
} from '../../lib/format';
import { InfoHint } from '../InfoHint';

export interface IndicatorPanelProps {
  indicators: RiskIndicators | null;
}

/** Derive oracle freshness age (ms) from the feature vector, if possible. */
function oracleFreshnessMs(ind: RiskIndicators): number | null {
  if (typeof ind.oracleTimestampMs !== 'number') return null;
  const now = typeof ind.nowMs === 'number' ? ind.nowMs : Date.now();
  return Math.max(0, now - ind.oracleTimestampMs);
}

/**
 * Shows the per-market risk indicators: oracle price, oracle freshness, oracle
 * confidence, volatility, liquidity, and exposure. (Req 3.5)
 */
export function IndicatorPanel({ indicators }: IndicatorPanelProps) {
  if (!indicators) {
    return (
      <p className="indicator-panel__empty" data-testid="indicator-panel-empty">
        No indicator data available.
      </p>
    );
  }

  const freshnessMs = oracleFreshnessMs(indicators);

  const rows: { key: string; label: string; value: string }[] = [
    {
      key: 'oracle-price',
      label: 'Oracle price',
      value: formatUsdPrice(indicators.oraclePrice),
    },
    {
      key: 'oracle-freshness',
      label: 'Oracle freshness',
      value: freshnessMs === null ? '—' : `${Math.round(freshnessMs).toLocaleString('en-US')} ms`,
    },
    {
      key: 'oracle-confidence',
      label: 'Oracle confidence',
      value: formatUsdConfidence(indicators.oracleConfidence),
    },
    {
      key: 'volatility',
      label: 'Volatility',
      value: formatPercent(indicators.realizedVolatilityPct),
    },
    {
      key: 'liquidity',
      label: 'Liquidity',
      value: formatAmount(indicators.liquidityDepth),
    },
    {
      key: 'exposure',
      label: 'Exposure',
      value: formatAmount(indicators.exposure),
    },
  ];

  return (
    <dl className="indicator-panel" data-testid="indicator-panel">
      {rows.map((row) => (
        <div className="indicator-panel__row" key={row.key} data-testid={`indicator-${row.key}`}>
          <dt className="indicator-panel__label">
            {row.label}
            <InfoHint term={row.label} />
          </dt>
          <dd className="indicator-panel__value" data-testid={`indicator-${row.key}-value`}>
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
