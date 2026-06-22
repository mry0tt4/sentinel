import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WRONG_NETWORK_MESSAGE } from '../lib/network';

// Mock the Sui dApp Kit wallet hooks so we can drive the hook through connected
// (testnet), connected (wrong network), and disconnected states without a real
// wallet adapter or browser environment.
const mocks = vi.hoisted(() => ({
  useCurrentAccount: vi.fn(),
  useCurrentWallet: vi.fn(),
  useSuiClientContext: vi.fn(),
  useSignAndExecuteTransaction: vi.fn(),
  useDisconnectWallet: vi.fn(),
}));

vi.mock('@mysten/dapp-kit', () => ({
  useCurrentAccount: mocks.useCurrentAccount,
  useCurrentWallet: mocks.useCurrentWallet,
  useSuiClientContext: mocks.useSuiClientContext,
  useSignAndExecuteTransaction: mocks.useSignAndExecuteTransaction,
  useDisconnectWallet: mocks.useDisconnectWallet,
}));

import { useSuiWallet } from './useSuiWallet';

const TESTNET_ADDRESS = '0xabc123';
const mutateAsync = vi.fn();
const disconnectMutate = vi.fn();

function setConnected(chains: string[], providerNetwork = 'testnet') {
  mocks.useCurrentAccount.mockReturnValue({ address: TESTNET_ADDRESS, chains });
  mocks.useCurrentWallet.mockReturnValue({ isConnected: true });
  mocks.useSuiClientContext.mockReturnValue({ network: providerNetwork });
}

function setDisconnected() {
  mocks.useCurrentAccount.mockReturnValue(null);
  mocks.useCurrentWallet.mockReturnValue({ isConnected: false });
  mocks.useSuiClientContext.mockReturnValue({ network: 'testnet' });
}

beforeEach(() => {
  mutateAsync.mockReset().mockResolvedValue({ digest: '0xdigest' });
  disconnectMutate.mockReset();
  mocks.useSignAndExecuteTransaction.mockReturnValue({ mutateAsync });
  mocks.useDisconnectWallet.mockReturnValue({ mutate: disconnectMutate });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('useSuiWallet', () => {
  it('exposes the address, detected network, and connected state on testnet', () => {
    setConnected(['sui:testnet']);
    const { result } = renderHook(() => useSuiWallet());

    expect(result.current.address).toBe(TESTNET_ADDRESS);
    expect(result.current.network).toBe('sui:testnet');
    expect(result.current.connected).toBe(true);
    expect(result.current.canSign).toBe(true);
  });

  it('falls back to the provider network when the account reports no sui chain', () => {
    setConnected([], 'testnet');
    const { result } = renderHook(() => useSuiWallet());

    expect(result.current.network).toBe('sui:testnet');
    expect(result.current.canSign).toBe(true);
  });

  it('signs and executes a transaction when connected to testnet', async () => {
    setConnected(['sui:testnet']);
    const { result } = renderHook(() => useSuiWallet());

    const args = { transaction: 'tx-bytes' } as Parameters<typeof result.current.signAndExecute>[0];
    await expect(result.current.signAndExecute(args)).resolves.toEqual({ digest: '0xdigest' });
    expect(mutateAsync).toHaveBeenCalledWith(args);
  });

  it('reports a wrong network and disables signing when connected off testnet', async () => {
    setConnected(['sui:mainnet'], 'mainnet');
    const { result } = renderHook(() => useSuiWallet());

    expect(result.current.connected).toBe(true);
    expect(result.current.network).toBe('sui:mainnet');
    expect(result.current.canSign).toBe(false);

    const args = { transaction: 'tx-bytes' } as Parameters<typeof result.current.signAndExecute>[0];
    const error = await result.current.signAndExecute(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(WRONG_NETWORK_MESSAGE);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('clears the address and disables signing when disconnected', async () => {
    setDisconnected();
    const { result } = renderHook(() => useSuiWallet());

    expect(result.current.address).toBeNull();
    expect(result.current.network).toBeNull();
    expect(result.current.connected).toBe(false);
    expect(result.current.canSign).toBe(false);

    const args = { transaction: 'tx-bytes' } as Parameters<typeof result.current.signAndExecute>[0];
    const error = await result.current.signAndExecute(args).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/connect a sui testnet wallet/i);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('treats account presence without an active connection as disconnected', () => {
    mocks.useCurrentAccount.mockReturnValue({ address: TESTNET_ADDRESS, chains: ['sui:testnet'] });
    mocks.useCurrentWallet.mockReturnValue({ isConnected: false });
    mocks.useSuiClientContext.mockReturnValue({ network: 'testnet' });

    const { result } = renderHook(() => useSuiWallet());

    expect(result.current.connected).toBe(false);
    expect(result.current.address).toBeNull();
    expect(result.current.canSign).toBe(false);
  });

  it('delegates disconnect to the dApp Kit mutation', () => {
    setConnected(['sui:testnet']);
    const { result } = renderHook(() => useSuiWallet());

    result.current.disconnect();
    expect(disconnectMutate).toHaveBeenCalledTimes(1);
  });
});
