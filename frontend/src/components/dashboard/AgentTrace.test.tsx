import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { MarketRiskView } from '../../lib/dashboardTypes';
import { AgentTrace } from './AgentTrace';

function riskView(overrides: Partial<MarketRiskView> = {}): MarketRiskView {
  return {
    marketId: 'm1',
    status: 'Normal',
    riskScore: 24,
    band: 'Normal',
    classes: [],
    confidence: 80,
    recommendedAction: null,
    indicators: { oraclePrice: 70_900_000 },
    sources: {
      network: 'sui:testnet',
      oracle: { protocol: 'Pyth', market: 'SUI/USD', feedId: '0xfeed' },
      liquidity: { protocol: 'DeepBook', market: 'SUI/USDC', pool: 'SUI_DBUSDC' },
      marketState: '0xmarket',
      evidence: 'Walrus',
    },
    ...overrides,
  };
}

describe('AgentTrace', () => {
  it('renders all eight pipeline stages', () => {
    render(<AgentTrace risk={riskView()} />);
    for (const key of [
      'observe',
      'score',
      'decide',
      'evidence',
      'build',
      'simulate',
      'submit',
      'govern',
    ]) {
      expect(screen.getByTestId(`agent-stage-${key}`)).toBeInTheDocument();
    }
  });

  it('shows a monitoring status when no action is recommended', () => {
    render(<AgentTrace risk={riskView({ recommendedAction: null })} />);
    expect(screen.getByTestId('agent-trace-status')).toHaveTextContent(/monitoring/i);
  });

  it('arms the pipeline when the live score recommends an action', () => {
    render(
      <AgentTrace
        risk={riskView({ riskScore: 87, band: 'ParamAdjust', recommendedAction: 'reduce_max_ltv' })}
      />,
    );
    expect(screen.getByTestId('agent-trace-status')).toHaveTextContent(/armed/i);
    expect(screen.getByTestId('agent-stage-decide')).toHaveTextContent(/Reduce max ltv/i);
  });

  it('links the real tx digest + Walrus blob when a verified action exists', () => {
    render(
      <AgentTrace
        risk={riskView()}
        lastAction={{
          actionType: 'reduce_max_ltv',
          riskScore: 87,
          txDigest: 'GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU',
          walrusBlobId: '2PMM51awFAYran58Z--VEYgVlh3DqzqFmvioZUO_1fE',
          verifiedTestnet: true,
        }}
      />,
    );
    expect(screen.getByTestId('agent-trace-status')).toHaveTextContent(/verified on-chain/i);
    const submit = screen.getByTestId('agent-stage-submit');
    const link = submit.querySelector('a');
    expect(link).not.toBeNull();
    expect(link?.getAttribute('href')).toContain('GypsZ8GjXHvLtTmjCSN2HpuXBJPJSMkvCsUDGrkfYuVU');
  });
});
