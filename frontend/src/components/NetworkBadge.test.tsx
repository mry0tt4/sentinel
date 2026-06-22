import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { NetworkBadge } from './NetworkBadge';
import { SUI_TESTNET_LABEL } from '../lib/network';

// Smoke test confirming the component test runner (Vitest + Testing Library +
// jsdom) is correctly wired. Behavioral tests for wallet/network gating are
// added in task 15.3.
describe('NetworkBadge', () => {
  it('shows the Sui Testnet label when connected to testnet', () => {
    render(<NetworkBadge network="sui:testnet" />);
    expect(screen.getByTestId('network-badge')).toHaveTextContent(SUI_TESTNET_LABEL);
  });

  it('warns when the wallet is on the wrong network', () => {
    render(<NetworkBadge network="mainnet" />);
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/wrong network/i);
  });

  it('shows an idle state when no wallet is connected', () => {
    render(<NetworkBadge network={null} />);
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/not connected/i);
  });
});
