import { useMemo } from 'react';

import { createDefaultDashboardClient, type DashboardDataClient } from '../../lib/dashboardApi';
import { SuiProvider } from '../SuiProvider';
import { MarketDetailView } from './MarketDetailView';

export interface MarketDetailProps {
  /** The market id from the `/markets/:id` route. */
  marketId?: string;
  /** Injectable backend client; defaults to the global-fetch client. */
  dataClient?: DashboardDataClient;
}

/** Derive the market id from the `/markets/:id` pathname (client fallback). */
function marketIdFromLocation(): string {
  if (typeof window === 'undefined') return '';
  const match = window.location.pathname.match(/\/markets\/([^/?#]+)/);
  return match && match[1] ? decodeURIComponent(match[1]) : '';
}

export function MarketDetailInner({ marketId, dataClient }: MarketDetailProps) {
  const client = useMemo(() => dataClient ?? createDefaultDashboardClient(), [dataClient]);
  const resolvedId = useMemo(
    () => (marketId && marketId.length > 0 ? marketId : marketIdFromLocation()),
    [marketId],
  );
  return <MarketDetailView dataClient={client} marketId={resolvedId} />;
}

/**
 * Client-only island hosting the single-market detail page. Wrapped in
 * {@link SuiProvider} to match the dashboard island pattern. (Req 3.3–3.6)
 */
export function MarketDetail(props: MarketDetailProps) {
  return (
    <SuiProvider>
      <MarketDetailInner {...props} />
    </SuiProvider>
  );
}
