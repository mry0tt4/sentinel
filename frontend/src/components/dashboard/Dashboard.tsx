import { useMemo } from 'react';

import { useSuiWallet } from '../../hooks/useSuiWallet';
import { createDefaultDashboardClient, type DashboardDataClient } from '../../lib/dashboardApi';
import type { MarketSummary } from '../../lib/dashboardTypes';
import {
  defaultRiskSocketUrl,
  WebSocketRiskClient,
  type RiskSocketClient,
} from '../../lib/riskSocket';
import { SuiProvider } from '../SuiProvider';
import { DashboardView } from './DashboardView';

export interface DashboardProps {
  /** Injectable backend client; defaults to the global-fetch client. */
  dataClient?: DashboardDataClient;
  /** Injectable socket client; defaults to a browser WebSocket client. */
  socketClient?: RiskSocketClient;
  /** Optionally seed the market list. */
  initialMarkets?: MarketSummary[];
}

export function DashboardInner({ dataClient, socketClient, initialMarkets }: DashboardProps) {
  const wallet = useSuiWallet();
  const client = useMemo(() => dataClient ?? createDefaultDashboardClient(), [dataClient]);
  const socket = useMemo<RiskSocketClient>(
    () => socketClient ?? new WebSocketRiskClient(defaultRiskSocketUrl()),
    [socketClient],
  );

  return (
    <DashboardView
      dataClient={client}
      socketClient={socket}
      walletNetwork={wallet.network}
      initialMarkets={initialMarkets}
    />
  );
}

/**
 * Client-only island hosting the Risk Operations Dashboard. Wrapped in
 * {@link SuiProvider} so the wallet hook resolves for the network badge.
 * (Req 3.1–3.9)
 */
export function Dashboard(props: DashboardProps) {
  return (
    <SuiProvider>
      <DashboardInner {...props} />
    </SuiProvider>
  );
}
