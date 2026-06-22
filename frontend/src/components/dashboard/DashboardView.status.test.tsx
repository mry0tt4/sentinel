import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DashboardDataClient } from '../../lib/dashboardApi';
import { MARKET_STATUSES, type MarketRiskView, type MarketSummary } from '../../lib/dashboardTypes';
import type { RiskSocketClient, RiskSocketListener } from '../../lib/riskSocket';
import { DashboardView } from './DashboardView';

// One market per status in the set {Normal, Warning, Guarded, Paused, Revoked}.
const MARKETS: MarketSummary[] = MARKET_STATUSES.map((status, i) => ({
  id: `m${i}`,
  name: `${status} Market`,
  status,
}));

function freshRiskView(marketId: string): MarketRiskView {
  return {
    marketId,
    status: 'Normal',
    riskScore: 10,
    band: 'Normal',
    classes: [],
    confidence: 80,
    recommendedAction: null,
    indicators: { oraclePrice: 1, realizedVolatilityPct: 1 },
    explanation: 'Stable.',
    ruleOutputs: [],
    freshness: { snapshotAt: '2024-01-01T00:00:00Z', ageMs: 5, thresholdMs: 30_000, stale: false },
  };
}

function staleRiskView(marketId: string): MarketRiskView {
  return {
    ...freshRiskView(marketId),
    freshness: { snapshotAt: null, ageMs: 99_999, thresholdMs: 30_000, stale: true },
  };
}

function makeDataClient(risk: (id: string) => MarketRiskView): DashboardDataClient {
  return {
    listMarkets: async () => MARKETS,
    getRisk: async (id: string) => risk(id),
    getMarketDetail: async (id: string) => ({
      market: MARKETS.find((m) => m.id === id) ?? { id, name: id, status: 'Normal' },
      params: null,
      lastAction: null,
      lastTxDigest: null,
      lastTxDigestVerifiedTestnet: false,
      lastWalrusBlobId: null,
      daoOverrideStatus: 'none',
    }),
  };
}

/** Minimal no-op socket so the view mounts without a live server. */
class NoopSocketClient implements RiskSocketClient {
  subscribe(): void {}
  unsubscribe(): void {}
  addListener(_listener: RiskSocketListener): () => void {
    return () => {};
  }
  close(): void {}
}

describe('DashboardView market status + stale state', () => {
  it('renders every market with its status from the full set {Normal, Warning, Guarded, Paused, Revoked} (Req 3.2)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient(freshRiskView)}
        socketClient={new NoopSocketClient()}
        initialMarkets={MARKETS}
      />,
    );

    // Each market's status pill renders the exact status label.
    MARKET_STATUSES.forEach((status, i) => {
      expect(screen.getByTestId(`market-status-m${i}`)).toHaveTextContent(status);
    });

    // Wait for the auto-selected market's risk to load (score 10) so the async
    // state update is flushed inside act before the test ends.
    await waitFor(() => expect(screen.getByTestId('risk-gauge-value')).toHaveTextContent('10'));
  });

  it('does not show the stale badge while the selected market data is fresh (Req 3.9)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient(freshRiskView)}
        socketClient={new NoopSocketClient()}
        initialMarkets={MARKETS}
        initialSelectedId="m0"
      />,
    );

    // Wait for the risk load to settle (score 10), then assert no stale badge.
    await waitFor(() => expect(screen.getByTestId('risk-gauge-value')).toHaveTextContent('10'));
    expect(screen.getByTestId('selected-market-name')).toBeInTheDocument();
    expect(screen.queryByTestId('stale-badge')).not.toBeInTheDocument();
  });

  it('displays the stale badge for the selected market when its risk data is stale (Req 3.9)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient(staleRiskView)}
        socketClient={new NoopSocketClient()}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    expect(await screen.findByTestId('stale-badge')).toBeInTheDocument();
  });
});
