import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { DashboardDataClient } from '../../lib/dashboardApi';
import type {
  MarketDetailView as MarketDetailData,
  MarketRiskView,
  MarketSummary,
} from '../../lib/dashboardTypes';
import { UNVERIFIED_DIGEST_MESSAGE } from '../TxDigestDisplay';
import { MarketDetailView } from './MarketDetailView';

const MARKET: MarketSummary = {
  id: 'market-a',
  name: 'SUI Lending',
  status: 'Guarded',
  marketType: 'lending',
};

function detail(overrides: Partial<MarketDetailData> = {}): MarketDetailData {
  return {
    market: MARKET,
    params: {
      id: 'policy-a',
      onChainPolicyId: '0xpolicy',
      ownerAddress: '0xowner',
      daoAddress: '0xdao1234',
      allowedActions: ['pause_market', 'adjust_ltv'],
      maxLtvDeltaBps: 500,
      maxMarginDeltaBps: 250,
      pauseDurationLimitMs: 3_600_000,
      cooldownMs: 60_000,
      riskThresholds: {},
      isRevoked: false,
      isPaused: false,
      version: 1,
      walrusConfigBlobId: 'blob-config-1',
    },
    lastAction: {
      id: 'action-a1',
      policyId: 'policy-a',
      marketId: 'market-a',
      actor: '0xagent',
      actorType: 'agent',
      riskScore: 82,
      actionType: 'adjust_ltv',
      oldValue: '7000',
      newValue: '6500',
      walrusEvidenceBlobId: 'blob-evidence-1',
      evidenceHash: '0xhash',
      txDigest: 'DIGEST_LATEST',
      isReversed: false,
    },
    lastTxDigest: 'DIGEST_LATEST',
    lastTxDigestVerifiedTestnet: true,
    lastWalrusBlobId: 'blob-evidence-1',
    daoOverrideStatus: 'none',
    ...overrides,
  };
}

function riskView(overrides: Partial<MarketRiskView> = {}): MarketRiskView {
  return {
    marketId: 'market-a',
    status: 'Guarded',
    riskScore: 72,
    band: 'Guarded',
    classes: ['high utilization'],
    confidence: 80,
    recommendedAction: 'adjust_ltv',
    indicators: {
      oracleConfidence: 0.02,
      realizedVolatilityPct: 8,
      liquidityDepth: 15_000,
      exposure: 42_000,
    },
    explanation: 'Utilization is high.',
    ruleOutputs: [],
    freshness: { snapshotAt: '2024-01-01T00:00:00Z', ageMs: 10, thresholdMs: 30_000, stale: false },
    ...overrides,
  };
}

/** Stub data client returning canned detail + risk responses. */
function makeDataClient(
  detailView: MarketDetailData,
  risk: MarketRiskView | null = riskView(),
): DashboardDataClient {
  return {
    listMarkets: async () => [MARKET],
    getRisk: async () => (risk === null ? riskView() : risk),
    getMarketDetail: async () => detailView,
  };
}

describe('MarketDetailView', () => {
  it('renders the market header with name and status (Req 3.6)', async () => {
    render(<MarketDetailView dataClient={makeDataClient(detail())} marketId="market-a" />);

    expect(await screen.findByTestId('market-header-name')).toHaveTextContent('SUI Lending');
    expect(screen.getByTestId('market-header-status')).toHaveTextContent('Guarded');
  });

  it('renders the parameters card with policy bounds and allowed actions (Req 3.6)', async () => {
    render(<MarketDetailView dataClient={makeDataClient(detail())} marketId="market-a" />);

    expect(await screen.findByTestId('parameters-card')).toBeInTheDocument();
    expect(screen.getByTestId('param-max-ltv-delta-value')).toHaveTextContent('500 bps');
    expect(screen.getByTestId('param-max-margin-delta-value')).toHaveTextContent('250 bps');
    expect(screen.getByTestId('param-pause-duration-limit-value')).toHaveTextContent('3600000 ms');
    expect(screen.getByTestId('param-cooldown-value')).toHaveTextContent('60000 ms');
    expect(screen.getByTestId('param-allowed-actions-value')).toHaveTextContent(
      'pause_market, adjust_ltv',
    );
    expect(screen.getByTestId('param-dao-address-value')).toHaveTextContent('0xdao1234');
  });

  it('renders the last action card with verified tx digest, blob id, and override status (Req 3.6)', async () => {
    render(<MarketDetailView dataClient={makeDataClient(detail())} marketId="market-a" />);

    expect(await screen.findByTestId('last-action-card')).toBeInTheDocument();
    expect(screen.getByTestId('last-action-type-value')).toHaveTextContent('adjust_ltv');
    // Verified digest is displayed.
    expect(screen.getByTestId('tx-digest')).toHaveTextContent('DIGEST_LATEST');
    expect(screen.getByTestId('last-action-blob-id-value')).toHaveTextContent('blob-evidence-1');
    expect(screen.getByTestId('last-action-override-status-value')).toHaveTextContent('None');
  });

  it('blocks an unverified tx digest via TxDigestDisplay (Req 1.8, 1.9)', async () => {
    const unverified = detail({ lastTxDigestVerifiedTestnet: false });
    render(<MarketDetailView dataClient={makeDataClient(unverified)} marketId="market-a" />);

    expect(await screen.findByTestId('tx-digest-blocked')).toHaveTextContent(
      UNVERIFIED_DIGEST_MESSAGE,
    );
    expect(screen.queryByTestId('tx-digest')).not.toBeInTheDocument();
  });

  it('renders the risk trend chart and current risk score (Req 3.3, 3.4)', async () => {
    render(<MarketDetailView dataClient={makeDataClient(detail())} marketId="market-a" />);

    expect(await screen.findByTestId('risk-trend-chart')).toBeInTheDocument();
    // Current risk score surfaced on the gauge.
    expect(screen.getByTestId('risk-gauge-value')).toHaveTextContent('72');
  });

  it('shows an override status of "Reversed by DAO" when the last action was reversed (Req 3.6)', async () => {
    const reversed = detail({ daoOverrideStatus: 'reversed' });
    render(<MarketDetailView dataClient={makeDataClient(reversed)} marketId="market-a" />);

    expect(await screen.findByTestId('last-action-override-status-value')).toHaveTextContent(
      'Reversed by DAO',
    );
  });

  it('shows an empty state when no policy or action exists', async () => {
    const empty = detail({
      params: null,
      lastAction: null,
      lastTxDigest: null,
      lastWalrusBlobId: null,
      daoOverrideStatus: 'none',
    });
    render(<MarketDetailView dataClient={makeDataClient(empty)} marketId="market-a" />);

    expect(await screen.findByTestId('parameters-card-empty')).toBeInTheDocument();
    expect(screen.getByTestId('last-action-empty')).toBeInTheDocument();
  });
});
