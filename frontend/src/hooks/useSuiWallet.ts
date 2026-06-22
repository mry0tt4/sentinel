import { useCallback, useMemo } from 'react';
import {
  useCurrentAccount,
  useCurrentWallet,
  useDisconnectWallet,
  useSignAndExecuteTransaction,
  useSuiClientContext,
} from '@mysten/dapp-kit';
import { isSuiTestnet, WRONG_NETWORK_MESSAGE } from '../lib/network';

// Argument and result types for the sign-and-execute mutation. Derived from the
// dApp Kit hook so the wrapper stays in lockstep with the installed SDK version
// without re-declaring the (unexported) input/output shapes.
type SignAndExecuteMutation = ReturnType<typeof useSignAndExecuteTransaction>;
export type SignAndExecuteArgs = Parameters<SignAndExecuteMutation['mutateAsync']>[0];
export type SignAndExecuteResult = Awaited<ReturnType<SignAndExecuteMutation['mutateAsync']>>;

/**
 * Shared wallet-adapter contract used across every page. Wraps the Sui dApp Kit
 * wallet hooks behind a single, network-aware surface.
 * (Design: "All pages share a useSuiWallet() hook exposing
 * { address, network, connected, signAndExecute() }".)
 */
export interface SuiWallet {
  /** Connected account address, or null when no wallet is connected. (Req 2.2, 2.5) */
  address: string | null;
  /**
   * Detected wallet/connection network identifier (e.g. `sui:testnet`), or null
   * when disconnected. (Req 2.2)
   */
  network: string | null;
  /** Whether a wallet is currently connected. (Req 2.5) */
  connected: boolean;
  /**
   * True only when connected AND on Sui Testnet — the precondition for enabling
   * signing controls. Surfaces enough state for the network-badge gating in 15.2.
   * (Req 2.4, 2.5)
   */
  canSign: boolean;
  /**
   * Signs and executes a transaction. Rejects with a clear error when the wallet
   * is disconnected or not on Sui Testnet, so signing is effectively disabled
   * outside the supported network. (Req 2.4, 2.5)
   */
  signAndExecute: (args: SignAndExecuteArgs) => Promise<SignAndExecuteResult>;
  /** Disconnects the active wallet; address clears and signing disables. (Req 2.5) */
  disconnect: () => void;
}

/**
 * Resolves the network identifier reported by the connected wallet account.
 *
 * Wallet accounts advertise the chains they operate on (e.g. `['sui:testnet']`).
 * We prefer the `sui:*` chain the account reports and fall back to the network
 * the provider is pinned to (normalized to a `sui:<network>` identifier) when an
 * account is connected but exposes no Sui chain.
 */
function resolveNetwork(
  chains: readonly string[] | undefined,
  providerNetwork: string | undefined,
): string | null {
  const suiChain = chains?.find((chain) => chain.toLowerCase().startsWith('sui:'));
  if (suiChain) return suiChain;
  if (providerNetwork) return `sui:${providerNetwork}`;
  return null;
}

/**
 * The wallet-adapter hook every page shares. Must be rendered inside the
 * {@link SuiProvider} so the underlying dApp Kit hooks resolve. (Req 2.1, 2.2, 2.5)
 */
export function useSuiWallet(): SuiWallet {
  const account = useCurrentAccount();
  const { isConnected } = useCurrentWallet();
  const { network: providerNetwork } = useSuiClientContext();
  const { mutateAsync } = useSignAndExecuteTransaction();
  const { mutate: disconnectWallet } = useDisconnectWallet();

  // On disconnect dApp Kit clears the current account, so deriving from it keeps
  // `address`/`connected` in sync without extra wiring. (Req 2.5)
  const connected = isConnected && account != null;
  const address = connected ? account.address : null;
  const network = connected ? resolveNetwork(account.chains, providerNetwork) : null;
  const canSign = connected && isSuiTestnet(network);

  const signAndExecute = useCallback(
    (args: SignAndExecuteArgs): Promise<SignAndExecuteResult> => {
      if (!connected) {
        return Promise.reject(new Error('Connect a Sui Testnet wallet before signing.'));
      }
      if (!isSuiTestnet(network)) {
        return Promise.reject(new Error(WRONG_NETWORK_MESSAGE));
      }
      return mutateAsync(args);
    },
    [connected, network, mutateAsync],
  );

  const disconnect = useCallback(() => {
    disconnectWallet();
  }, [disconnectWallet]);

  return useMemo(
    () => ({ address, network, connected, canSign, signAndExecute, disconnect }),
    [address, network, connected, canSign, signAndExecute, disconnect],
  );
}
