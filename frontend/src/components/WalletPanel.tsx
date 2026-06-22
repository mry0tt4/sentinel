import { useState } from 'react';
import { ConnectButton, useSignPersonalMessage } from '@mysten/dapp-kit';

import { useSuiWallet } from '../hooks/useSuiWallet';
import { NetworkBadge } from './NetworkBadge';
import { SignButton } from './SignButton';
import { SuiProvider } from './SuiProvider';
import { WrongNetworkBanner } from './WrongNetworkBanner';

type VerifyStatus = 'idle' | 'signing' | 'signed' | 'error';

/** Short, human-readable middle-ellipsis of a long address/signature. */
function shorten(value: string, head = 10, tail = 8): string {
  return value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value;
}

function WalletPanelInner() {
  // Shared wallet-adapter contract: connected address + detected network.
  // `canSign` gates the verify control to a connected Sui Testnet wallet.
  const { address, network, connected, canSign } = useSuiWallet();
  const { mutateAsync: signPersonalMessage } = useSignPersonalMessage();

  const [status, setStatus] = useState<VerifyStatus>('idle');
  const [signature, setSignature] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function verifyOwnership() {
    setStatus('signing');
    setError(null);
    setSignature(null);
    try {
      const message = new TextEncoder().encode(
        `Sentinel Risk Guardian — verify wallet ownership @ ${new Date().toISOString()}`,
      );
      const result = await signPersonalMessage({ message });
      setSignature(result.signature);
      setStatus('signed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Signing was rejected or failed.');
      setStatus('error');
    }
  }

  async function copyAddress() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — ignore */
    }
  }

  return (
    <section className="wallet-panel">
      <div className="wallet-panel__row">
        <ConnectButton connectText="Connect Wallet" />
        <NetworkBadge network={network} />
      </div>

      {/* Wrong-network gate: exact testnet-switch message. (Req 1.5, 2.4) */}
      <WrongNetworkBanner network={network} />

      {connected && address ? (
        <div className="wallet-panel__state">
          <span className="network-badge network-badge--ok" aria-hidden="true" />
          <span className="wallet-panel__address" data-testid="wallet-address">
            {shorten(address)}
          </span>
          <button type="button" className="btn btn--ghost" style={{ padding: '0.3rem 0.6rem' }} onClick={copyAddress}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <p className="wallet-panel__hint">
          Connect a Sui Testnet wallet to verify ownership and unlock signing controls.
        </p>
      )}

      {/* A real action with visible feedback: sign a personal message to prove
          ownership. Gated to a connected testnet wallet. (Req 2.4) */}
      <SignButton
        className="wallet-panel__sign"
        loading={status === 'signing'}
        onClick={verifyOwnership}
      >
        {status === 'signing' ? 'Awaiting wallet…' : 'Verify wallet ownership'}
      </SignButton>

      {status === 'signed' && signature ? (
        <div className="wallet-panel__feedback wallet-panel__feedback--ok" role="status">
          <span aria-hidden="true">✓</span>
          <span>
            Ownership verified. Signature:{' '}
            <span className="wallet-panel__sig">{shorten(signature, 14, 10)}</span>
          </span>
        </div>
      ) : null}

      {status === 'error' && error ? (
        <div className="wallet-panel__feedback wallet-panel__feedback--err" role="alert">
          <span aria-hidden="true">✕</span>
          <span>{error}</span>
        </div>
      ) : null}

      {!canSign && connected ? (
        <p className="wallet-panel__hint">Switch your wallet to Sui Testnet to enable signing.</p>
      ) : null}
    </section>
  );
}

/**
 * Client-only island: wallet connection + a working ownership-verification
 * sign flow with explicit loading / success / error feedback. Wrapped in
 * {@link SuiProvider} so dApp Kit hooks resolve.
 */
export function WalletPanel() {
  return (
    <SuiProvider>
      <WalletPanelInner />
    </SuiProvider>
  );
}
