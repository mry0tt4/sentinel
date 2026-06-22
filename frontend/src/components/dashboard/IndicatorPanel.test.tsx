import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { RiskIndicators } from '../../lib/dashboardTypes';
import { IndicatorPanel } from './IndicatorPanel';

/**
 * Component tests for the dashboard indicator panel: oracle freshness, oracle
 * confidence, volatility, liquidity, and exposure. (Req 3.5, 3.8)
 */
describe('IndicatorPanel', () => {
  it('renders all five indicators for the selected market (Req 3.5, 3.8)', () => {
    const indicators: RiskIndicators = {
      oracleConfidence: 0.01,
      oracleTimestampMs: 1_000,
      nowMs: 1_750,
      realizedVolatilityPct: 5,
      liquidityDepth: 12_000,
      exposure: 50_000,
    };
    render(<IndicatorPanel indicators={indicators} />);

    // The panel itself plus each labelled row is present.
    expect(screen.getByTestId('indicator-panel')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-oracle-freshness')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-oracle-confidence')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-volatility')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-liquidity')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-exposure')).toBeInTheDocument();

    // Human-readable labels are surfaced.
    expect(screen.getByText('Oracle freshness')).toBeInTheDocument();
    expect(screen.getByText('Oracle confidence')).toBeInTheDocument();
    expect(screen.getByText('Volatility')).toBeInTheDocument();
    expect(screen.getByText('Liquidity')).toBeInTheDocument();
    expect(screen.getByText('Exposure')).toBeInTheDocument();
  });

  it('formats each indicator value, deriving freshness age from now - oracle timestamp', () => {
    const indicators: RiskIndicators = {
      oracleConfidence: 0.01,
      oracleTimestampMs: 1_000,
      nowMs: 1_750,
      realizedVolatilityPct: 5,
      liquidityDepth: 12_000,
      exposure: 50_000,
    };
    render(<IndicatorPanel indicators={indicators} />);

    // Freshness age = nowMs - oracleTimestampMs = 750 ms.
    expect(screen.getByTestId('indicator-oracle-freshness-value')).toHaveTextContent('750 ms');
    expect(screen.getByTestId('indicator-oracle-confidence-value')).toHaveTextContent('0.01');
    // Volatility carries a percent suffix.
    expect(screen.getByTestId('indicator-volatility-value')).toHaveTextContent('5%');
    expect(screen.getByTestId('indicator-liquidity-value')).toHaveTextContent('12,000');
    expect(screen.getByTestId('indicator-exposure-value')).toHaveTextContent('50,000');
  });

  it('shows a dash for missing numeric indicators', () => {
    // Only confidence is present; the rest should fall back to an em dash.
    render(<IndicatorPanel indicators={{ oracleConfidence: 0.5 }} />);

    expect(screen.getByTestId('indicator-oracle-freshness-value')).toHaveTextContent('—');
    expect(screen.getByTestId('indicator-oracle-confidence-value')).toHaveTextContent('0.5');
    expect(screen.getByTestId('indicator-volatility-value')).toHaveTextContent('—');
    expect(screen.getByTestId('indicator-liquidity-value')).toHaveTextContent('—');
    expect(screen.getByTestId('indicator-exposure-value')).toHaveTextContent('—');
  });

  it('renders an empty state when no indicator data is available', () => {
    render(<IndicatorPanel indicators={null} />);

    expect(screen.getByTestId('indicator-panel-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('indicator-panel')).not.toBeInTheDocument();
  });
});
