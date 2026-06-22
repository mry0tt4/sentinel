import { useCallback, useEffect, useState } from 'react';

import {
  type OverrideConsoleData,
  type OverrideDataClient,
} from '../../lib/overrideApi';
import { WRONG_NETWORK_MESSAGE } from '../../lib/network';
import { MarketOverridePanel } from './MarketOverridePanel';
import type { OverrideWallet } from './overrideWallet';

export interface OverrideConsoleViewProps {
  /** Injectable backend client (reads + override submit). */
  dataClient: OverrideDataClient;
  /** Injected wallet contract; the island maps `useSuiWallet` onto it. */
  wallet: OverrideWallet;
  /** Optionally seed the console data (skips the initial fetch) — used in tests. */
  initialData?: OverrideConsoleData;
}

/**
 * The Human Override Console (Req 11). Lists every monitored market with its
 * active action, paused state, relevant policy, the Risk_Score at action time,
 * linked Walrus evidence, and the OverrideCap holder address; offers the
 * confirm/revoke/update-thresholds/unpause/restore controls with a
 * before-signing preview and a required override reason; and surfaces the
 * resulting Tx_Digest. Split from the provider-wrapped island so it can be
 * tested with an injected client + wallet (no live backend or wallet).
 */
export function OverrideConsoleView({
  dataClient,
  wallet,
  initialData,
}: OverrideConsoleViewProps) {
  const [data, setData] = useState<OverrideConsoleData | null>(initialData ?? null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    let cancelled = false;
    dataClient
      .loadConsole()
      .then((next) => {
        if (!cancelled) {
          setData(next);
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load the override console');
        }
      });
    return () => {
      cancelled = true;
    };
  }, [dataClient]);

  useEffect(() => {
    if (initialData) return undefined;
    return load();
  }, [initialData, load]);

  // Refresh the console after a successful override so reversed/paused state
  // reflects the new chain state.
  const handleSubmitted = useCallback(() => {
    load();
  }, [load]);

  return (
    <section className="override-console" data-testid="override-console">
      <div className="override-console__head">
        <h2 className="override-console__title">Override console</h2>
        <p className="override-console__sub">
          Reverse, confirm, revoke, update thresholds, unpause, or restore — every operation
          requires a reason and is recorded as on-chain evidence.
        </p>
      </div>

      {/* Wrong-network gate: signing is disabled and the exact message shown. (Req 1.5, 2.4) */}
      {wallet.connected && !wallet.canSign ? (
        <p className="override-console__warning" role="alert" data-testid="override-wrong-network">
          {WRONG_NETWORK_MESSAGE}
        </p>
      ) : null}

      {!wallet.connected ? (
        <p className="override-console__hint" data-testid="override-disconnected">
          Connect a Sui Testnet wallet to sign override operations.
        </p>
      ) : null}

      {error !== null ? (
        <p className="override-console__error" role="alert" data-testid="override-console-error">
          {error}
        </p>
      ) : null}

      {data === null && error === null ? (
        <p className="override-console__loading" data-testid="override-console-loading">
          Loading override console…
        </p>
      ) : null}

      {data !== null && data.markets.length === 0 ? (
        <p className="override-console__empty" data-testid="override-console-empty">
          No monitored markets.
        </p>
      ) : null}

      {data !== null ? (
        <div className="override-console__list">
          {data.markets.map((entry) => (
            <MarketOverridePanel
              key={entry.market.id}
              entry={entry}
              wallet={wallet}
              dataClient={dataClient}
              onSubmitted={handleSubmitted}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
