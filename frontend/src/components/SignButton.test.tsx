import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SuiWallet } from '../hooks/useSuiWallet';

// Mock the shared wallet hook so we can drive `canSign` without a live wallet
// or the SuiProvider. (Req 2.4, 2.5)
const useSuiWalletMock = vi.fn<() => SuiWallet>();
vi.mock('../hooks/useSuiWallet', () => ({
  useSuiWallet: () => useSuiWalletMock(),
}));

import { SignButton } from './SignButton';

function walletState(overrides: Partial<SuiWallet> = {}): SuiWallet {
  return {
    address: null,
    network: null,
    connected: false,
    canSign: false,
    signAndExecute: vi.fn(),
    disconnect: vi.fn(),
    ...overrides,
  };
}

describe('SignButton', () => {
  afterEach(() => {
    useSuiWalletMock.mockReset();
  });

  it('is enabled when the wallet can sign (connected to testnet)', () => {
    useSuiWalletMock.mockReturnValue(
      walletState({ connected: true, network: 'sui:testnet', canSign: true }),
    );
    render(<SignButton>Sign</SignButton>);
    expect(screen.getByTestId('sign-button')).toBeEnabled();
  });

  it('is disabled on a wrong-network wallet', () => {
    useSuiWalletMock.mockReturnValue(
      walletState({ connected: true, network: 'sui:mainnet', canSign: false }),
    );
    render(<SignButton>Sign</SignButton>);
    expect(screen.getByTestId('sign-button')).toBeDisabled();
  });

  it('is disabled when no wallet is connected', () => {
    useSuiWalletMock.mockReturnValue(walletState());
    render(<SignButton>Sign</SignButton>);
    expect(screen.getByTestId('sign-button')).toBeDisabled();
  });

  it('stays disabled when explicitly disabled even if signing is allowed', () => {
    useSuiWalletMock.mockReturnValue(walletState({ canSign: true }));
    render(<SignButton disabled>Sign</SignButton>);
    expect(screen.getByTestId('sign-button')).toBeDisabled();
  });
});
