import { useMemo } from 'react';

import { useSuiWallet } from '../../hooks/useSuiWallet';
import { createDefaultOverrideClient, type OverrideDataClient } from '../../lib/overrideApi';
import { SuiProvider } from '../SuiProvider';
import { OverrideConsoleView } from './OverrideConsoleView';
import type { OverrideWallet } from './overrideWallet';

export interface OverrideConsoleProps {
  /** Injectable backend client; defaults to the global-fetch client. */
  dataClient?: OverrideDataClient;
}

export function OverrideConsoleInner({ dataClient }: OverrideConsoleProps) {
  const client = useMemo(() => dataClient ?? createDefaultOverrideClient(), [dataClient]);
  const w = useSuiWallet();
  const wallet: OverrideWallet = useMemo(
    () => ({
      connected: w.connected,
      canSign: w.canSign,
      network: w.network,
      address: w.address,
    }),
    [w.connected, w.canSign, w.network, w.address],
  );

  return <OverrideConsoleView dataClient={client} wallet={wallet} />;
}

/**
 * Client-only island hosting the Human Override Console. Wrapped in
 * {@link SuiProvider} so the wallet hook resolves for the network gate and the
 * OverrideCap-holder comparison. (Req 11)
 */
export function OverrideConsole(props: OverrideConsoleProps) {
  return (
    <SuiProvider>
      <OverrideConsoleInner {...props} />
    </SuiProvider>
  );
}
