/**
 * Minimal wallet contract the Override_Console needs. Injected into
 * {@link import('./OverrideConsoleView').OverrideConsoleView} so it can be
 * tested without a live wallet (mirrors the wizard's `WizardWallet`). The
 * island maps {@link import('../../hooks/useSuiWallet').useSuiWallet} onto it.
 */
export interface OverrideWallet {
  /** Whether a wallet is currently connected. (Req 2.5) */
  connected: boolean;
  /** True only when connected AND on Sui Testnet — gates signing. (Req 1.5, 2.4) */
  canSign: boolean;
  /** Detected wallet/connection network identifier, or null. (Req 2.2) */
  network: string | null;
  /** Connected account address, or null when disconnected. (Req 2.2) */
  address: string | null;
}
