import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WrongNetworkBanner } from './WrongNetworkBanner';
import { WRONG_NETWORK_MESSAGE } from '../lib/network';

// Wrong-network gate banner. (Req 1.5, 2.4)
describe('WrongNetworkBanner', () => {
  it('shows the exact testnet-switch message on a non-testnet wallet', () => {
    render(<WrongNetworkBanner network="sui:mainnet" />);
    expect(screen.getByTestId('wrong-network-banner')).toHaveTextContent(
      WRONG_NETWORK_MESSAGE,
    );
  });

  it('renders nothing when connected to Sui Testnet', () => {
    const { container } = render(<WrongNetworkBanner network="sui:testnet" />);
    expect(screen.queryByTestId('wrong-network-banner')).not.toBeInTheDocument();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when no wallet is connected', () => {
    render(<WrongNetworkBanner network={null} />);
    expect(screen.queryByTestId('wrong-network-banner')).not.toBeInTheDocument();
  });
});
