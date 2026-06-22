import { ConnectButton } from '@mysten/dapp-kit';

import { useSuiWallet } from '../hooks/useSuiWallet';
import { NetworkBadge } from './NetworkBadge';
import { SuiProvider } from './SuiProvider';

function WalletMenuInner() {
  const { network, connected } = useSuiWallet();

  return (
    <div className="wallet-menu" data-connected={connected ? 'true' : 'false'}>
      <NetworkBadge network={network} />
      <ConnectButton connectText="Connect Wallet" />
    </div>
  );
}

/**
 * Compact wallet control for the global app header: a live network badge plus
 * the dApp Kit connect/account button. Rendered as a client-only island so the
 * wallet adapter (browser APIs) resolves, and present on every page so wallet
 * state is always visible. (Req 2.2, 2.3)
 */
export function WalletMenu() {
  return (
    <SuiProvider>
      <WalletMenuInner />
    </SuiProvider>
  );
}
