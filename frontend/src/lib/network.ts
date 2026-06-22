// Sentinel runs on Sui Testnet ONLY for the hackathon demo. Mainnet is disabled.
// These constants are the single source of truth for the expected network and
// the user-facing message shown when a wallet is on the wrong network.
// (Requirements 1.5, 2.3)

export const EXPECTED_SUI_NETWORK = 'testnet' as const;

/** Human-readable label for the testnet status indicator. */
export const SUI_TESTNET_LABEL = 'Sui Testnet';

/** Message shown when a connected wallet is not on Sui Testnet. (Req 1.5) */
export const WRONG_NETWORK_MESSAGE =
  'Sentinel is running on Sui Testnet for the hackathon demo. Please switch your wallet to Sui Testnet.';

/**
 * Normalizes the various network identifiers a wallet adapter may report
 * (`'testnet'`, `'sui:testnet'`) and returns whether it is Sui Testnet.
 */
export function isSuiTestnet(network: string | null | undefined): boolean {
  if (!network) return false;
  const normalized = network.toLowerCase();
  return normalized === 'testnet' || normalized === 'sui:testnet';
}
