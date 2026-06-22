import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

import type { DashboardDataClient } from '../../lib/dashboardApi';
import type {
  MarketRiskView,
  MarketSummary,
  RiskSnapshotMessage,
  ServerMessage,
} from '../../lib/dashboardTypes';
import type { RiskSocketClient, RiskSocketListener } from '../../lib/riskSocket';
import { DashboardView } from './DashboardView';

const MARKETS: MarketSummary[] = [
  { id: 'm1', name: 'SUI Lending', status: 'Warning' },
  { id: 'm2', name: 'USDC Stable', status: 'Normal' },
];

function riskView(overrides: Partial<MarketRiskView> = {}): MarketRiskView {
  return {
    marketId: 'm1',
    status: 'Warning',
    riskScore: 42,
    band: 'Warning',
    classes: ['volatility'],
    confidence: 70,
    recommendedAction: null,
    indicators: {
      oraclePrice: 1.02,
      oracleConfidence: 0.01,
      oracleTimestampMs: 1_000,
      nowMs: 1_500,
      realizedVolatilityPct: 5,
      liquidityDepth: 12_000,
      exposure: 50_000,
    },
    explanation: 'Volatility is rising on the SUI feed.',
    ruleOutputs: [{ rule: 'volatility_spike', fired: true, value: '5%' }],
    freshness: { snapshotAt: '2024-01-01T00:00:00Z', ageMs: 10, thresholdMs: 30_000, stale: false },
    ...overrides,
  };
}

/** Stub data client returning canned market + risk responses. */
function makeDataClient(risk: Record<string, MarketRiskView>): DashboardDataClient {
  return {
    listMarkets: async () => MARKETS,
    getRisk: async (id: string) => risk[id] ?? riskView({ marketId: id }),
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

/** Fake socket that lets the test push messages synchronously. */
class FakeRiskSocketClient implements RiskSocketClient {
  readonly listeners = new Set<RiskSocketListener>();
  readonly subscribed: string[] = [];

  subscribe(marketId: string): void {
    this.subscribed.push(marketId);
  }
  unsubscribe(): void {}
  addListener(listener: RiskSocketListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close(): void {}

  emit(message: ServerMessage): void {
    act(() => {
      for (const listener of this.listeners) listener(message);
    });
  }
}

function snapshot(overrides: Partial<RiskSnapshotMessage> = {}): RiskSnapshotMessage {
  return {
    marketId: 'm1',
    riskScore: 88,
    band: 'ParamAdjust',
    classes: ['volatility'],
    confidence: 90,
    recommendedAction: 'reduce_max_ltv',
    featureVector: { oraclePrice: 0.95, realizedVolatilityPct: 22 },
    ruleOutputs: [{ rule: 'volatility_spike', fired: true, value: '22%' }],
    modelVersion: 'v1',
    promptConfigVersion: 'v1',
    explanation: 'Sharp drop detected.',
    dataSource: 'live',
    isSimulated: false,
    createdAt: '2024-01-01T00:01:00Z',
    ...overrides,
  };
}

describe('DashboardView', () => {
  it('renders the testnet badge and wallet network status (Req 3.1)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: riskView() })}
        socketClient={new FakeRiskSocketClient()}
        walletNetwork="sui:testnet"
        initialMarkets={MARKETS}
      />,
    );
    expect(screen.getByTestId('testnet-badge')).toHaveTextContent(/sui testnet/i);
    expect(screen.getByTestId('network-badge')).toBeInTheDocument();

    // Auto-selected m1 loads its risk asynchronously; await it so the state
    // update settles inside act before the test ends.
    await screen.findByText('42');
  });

  it('renders the risk gauge and indicator panel for the selected market (Req 3.3, 3.5)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: riskView() })}
        socketClient={new FakeRiskSocketClient()}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    // Gauge shows the integer score from the loaded risk view.
    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.getByTestId('risk-gauge-value')).toHaveTextContent('42');

    // Indicator panel surfaces freshness/confidence/volatility/liquidity/exposure.
    expect(screen.getByTestId('indicator-oracle-freshness')).toBeInTheDocument();
    expect(screen.getByTestId('indicator-oracle-confidence-value')).toHaveTextContent('0.01');
    expect(screen.getByTestId('indicator-volatility-value')).toHaveTextContent('5%');
    expect(screen.getByTestId('indicator-liquidity-value')).toHaveTextContent('12,000');
    expect(screen.getByTestId('indicator-exposure-value')).toHaveTextContent('50,000');
  });

  it('shows the AI explanation and rule outputs in the Why panel (Req 3.8)', async () => {
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: riskView() })}
        socketClient={new FakeRiskSocketClient()}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    await screen.findByText('42');
    await userEvent.click(screen.getByTestId('why-panel-toggle'));

    expect(screen.getByTestId('why-panel-explanation')).toHaveTextContent(
      'Volatility is rising on the SUI feed.',
    );
    expect(screen.getByTestId('why-panel-rule-volatility_spike')).toHaveTextContent(
      'volatility_spike',
    );
  });

  it('shows the stale badge when the latest risk data is stale (Req 3.9)', async () => {
    const staleRisk = riskView({
      freshness: { snapshotAt: null, ageMs: 99_999, thresholdMs: 30_000, stale: true },
    });
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: staleRisk })}
        socketClient={new FakeRiskSocketClient()}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    expect(await screen.findByTestId('stale-badge')).toBeInTheDocument();
  });

  it('updates the displayed score when a risk_update message arrives (Req 3.7)', async () => {
    const socket = new FakeRiskSocketClient();
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: riskView() })}
        socketClient={socket}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    // Initial score from the REST load.
    expect(await screen.findByText('42')).toBeInTheDocument();
    await waitFor(() => expect(socket.subscribed).toContain('m1'));

    // A live risk_update for the selected market updates the gauge.
    socket.emit({ type: 'risk_update', marketId: 'm1', snapshot: snapshot({ riskScore: 88 }) });

    expect(screen.getByTestId('risk-gauge-value')).toHaveTextContent('88');
  });

  it('marks the market Revoked on a guardian_revoked message (Req 3.2, 12.2)', async () => {
    const socket = new FakeRiskSocketClient();
    render(
      <DashboardView
        dataClient={makeDataClient({ m1: riskView() })}
        socketClient={socket}
        initialMarkets={MARKETS}
        initialSelectedId="m1"
      />,
    );

    await screen.findByText('42');
    socket.emit({ type: 'guardian_revoked', marketId: 'm1', at: '2024-01-01T00:02:00Z' });

    expect(screen.getByTestId('market-status-m1')).toHaveTextContent('Revoked');
  });
});
