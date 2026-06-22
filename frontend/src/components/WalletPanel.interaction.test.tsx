import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SUI_TESTNET_LABEL, WRONG_NETWORK_MESSAGE } from '../lib/network';

// Interaction tests for wallet + network gating. (Task 15.3, Req 2.4, 2.5, 1.5)
//
// We render the full WalletPanel (which wraps SuiProvider) and mock
// `@mysten/dapp-kit` so the REAL composition under test — WalletPanel ->
// useSuiWallet -> NetworkBadge / WrongNetworkBanner / SignButton — runs end to
// end. The five wallet hooks drive the connection state; the providers and
// ConnectButton are passthroughs so SuiProvider mounts without a live wallet or
// browser wallet extension. This mirrors the hoisted-mock pattern used in
// useSuiWallet.test.tsx.
const mocks = vi.hoisted(() => ({
  useCurrentAccount: vi.fn(),
  useCurrentWallet: vi.fn(),
  useSuiClientContext: vi.fn(),
  useSignAndExecuteTransaction: vi.fn(),
  useSignPersonalMessage: vi.fn(),
  useDisconnectWallet: vi.fn(),
}));

vi.mock('@mysten/dapp-kit', () => ({
  // Wallet hooks consumed by the real useSuiWallet hook.
  useCurrentAccount: mocks.useCurrentAccount,
  useCurrentWallet: mocks.useCurrentWallet,
  useSuiClientContext: mocks.useSuiClientContext,
  useSignAndExecuteTransaction: mocks.useSignAndExecuteTransaction,
  useSignPersonalMessage: mocks.useSignPersonalMessage,
  useDisconnectWallet: mocks.useDisconnectWallet,
  // Passthrough UI + provider stubs so SuiProvider/WalletPanel render.
  ConnectButton: () => <button type="button">Connect Wallet</button>,
  SuiClientProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  WalletProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  createNetworkConfig: () => ({ networkConfig: {} }),
}));

import { WalletPanel } from './WalletPanel';

const TESTNET_ADDRESS = '0xabc123def456';
const mutateAsync = vi.fn();
const disconnectMutate = vi.fn();

/** Simulate a connected wallet reporting the given chains / provider network. */
function setConnected(chains: string[], providerNetwork = 'testnet') {
  mocks.useCurrentAccount.mockReturnValue({ address: TESTNET_ADDRESS, chains });
  mocks.useCurrentWallet.mockReturnValue({ isConnected: true });
  mocks.useSuiClientContext.mockReturnValue({ network: providerNetwork });
}

/** Simulate a disconnected wallet (dApp Kit clears the current account). */
function setDisconnected() {
  mocks.useCurrentAccount.mockReturnValue(null);
  mocks.useCurrentWallet.mockReturnValue({ isConnected: false });
  mocks.useSuiClientContext.mockReturnValue({ network: 'testnet' });
}

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({ digest: '0xdigest' });
  disconnectMutate.mockReset();
  mocks.useSignAndExecuteTransaction.mockReturnValue({ mutateAsync });
  mocks.useSignPersonalMessage.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({ signature: '0xsig', bytes: '0xbytes' }),
  });
  mocks.useDisconnectWallet.mockReturnValue({ mutate: disconnectMutate });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('WalletPanel wallet + network gating (interaction)', () => {
  it('connected to Sui Testnet: shows address, testnet badge, and enables signing', () => {
    // CONNECTED to Sui Testnet. (Req 2.2, 2.3, 2.4, 2.5)
    setConnected(['sui:testnet']);
    render(<WalletPanel />);

    // Connected address is displayed.
    expect(screen.getByTestId('wallet-address')).toHaveTextContent(TESTNET_ADDRESS);

    // Network badge shows the Sui Testnet status indicator.
    expect(screen.getByTestId('network-badge')).toHaveTextContent(SUI_TESTNET_LABEL);

    // No wrong-network warning, and signing is enabled.
    expect(screen.queryByTestId('wrong-network-banner')).not.toBeInTheDocument();
    expect(screen.getByTestId('sign-button')).toBeEnabled();
  });

  it('connected to a wrong network: shows the switch message and disables signing', () => {
    // CONNECTED to a non-testnet network. (Req 1.5, 2.4)
    setConnected(['sui:mainnet'], 'mainnet');
    render(<WalletPanel />);

    // Exact wrong-network message is displayed.
    expect(screen.getByTestId('wrong-network-banner')).toHaveTextContent(
      WRONG_NETWORK_MESSAGE,
    );

    // Badge reflects the wrong network and signing controls are disabled.
    expect(screen.getByTestId('network-badge')).toHaveTextContent(/wrong network/i);
    expect(screen.getByTestId('sign-button')).toBeDisabled();
  });

  it('disconnected: shows no address and disables signing', () => {
    // DISCONNECTED. (Req 2.5)
    setDisconnected();
    render(<WalletPanel />);

    // No connected address is rendered; signing is disabled.
    expect(screen.queryByTestId('wallet-address')).not.toBeInTheDocument();
    expect(screen.getByTestId('sign-button')).toBeDisabled();

    // No wrong-network warning while disconnected (no network to warn about).
    expect(screen.queryByTestId('wrong-network-banner')).not.toBeInTheDocument();
  });

  it('transition: disconnecting clears the address and disables signing', () => {
    // Start connected on testnet with signing enabled. (Req 2.4)
    setConnected(['sui:testnet']);
    const { rerender } = render(<WalletPanel />);

    expect(screen.getByTestId('wallet-address')).toHaveTextContent(TESTNET_ADDRESS);
    expect(screen.getByTestId('sign-button')).toBeEnabled();

    // Wallet disconnects -> address cleared, signing disabled. (Req 2.5)
    setDisconnected();
    rerender(<WalletPanel />);

    expect(screen.queryByTestId('wallet-address')).not.toBeInTheDocument();
    expect(screen.getByTestId('sign-button')).toBeDisabled();
  });
});
