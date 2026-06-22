import { isSuiTestnet, WRONG_NETWORK_MESSAGE } from '../lib/network';

export interface WrongNetworkBannerProps {
  /** Network reported by the connected wallet, or null when disconnected. */
  network?: string | null;
}

/**
 * Wrong-network gate banner.
 *
 * Renders the exact testnet-switch message when a wallet is connected to a
 * network other than Sui Testnet, prompting the user to switch. Renders nothing
 * when disconnected (no network) or already on Sui Testnet, so signing controls
 * are only blocked while the wallet is genuinely on the wrong network.
 * (Requirements 1.5, 2.4)
 */
export function WrongNetworkBanner({ network }: WrongNetworkBannerProps) {
  // No wallet connected, or already on testnet -> nothing to warn about.
  if (!network || isSuiTestnet(network)) {
    return null;
  }

  return (
    <div className="wrong-network-banner" role="alert" data-testid="wrong-network-banner">
      {WRONG_NETWORK_MESSAGE}
    </div>
  );
}
