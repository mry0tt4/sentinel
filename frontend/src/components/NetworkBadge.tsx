import { isSuiTestnet, SUI_TESTNET_LABEL } from '../lib/network';

export interface NetworkBadgeProps {
  /** Network reported by the connected wallet, or null when disconnected. */
  network?: string | null;
}

/**
 * Presentational status indicator for the active wallet network.
 *
 * Shows a Sui Testnet badge when connected to testnet, a wrong-network warning
 * otherwise, and a neutral state when no wallet is connected.
 * (Requirements 2.3, 2.4, 3.1)
 */
export function NetworkBadge({ network }: NetworkBadgeProps) {
  if (!network) {
    return (
      <span className="network-badge network-badge--idle" data-testid="network-badge">
        Wallet not connected
      </span>
    );
  }

  if (isSuiTestnet(network)) {
    return (
      <span className="network-badge network-badge--ok" data-testid="network-badge">
        {SUI_TESTNET_LABEL}
      </span>
    );
  }

  return (
    <span className="network-badge network-badge--warn" data-testid="network-badge">
      Wrong network: {network}
    </span>
  );
}
