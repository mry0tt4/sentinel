// Client for the real-event replay endpoint (`GET /api/replay/:id`).
//
// The replay streams a REAL recorded price series through the backend's
// deterministic Risk Engine, so the frontend just fetches and renders the
// resulting score trajectory. Mirrors the backend `ReplayResult` DTO.

import { resolveBackendBaseUrl } from './backendConfig';

export interface ReplayPoint {
  t: string;
  price: number;
  priceChangePct: number;
  cumulativeChangePct: number;
  riskScore: number;
  band: string;
  recommendedAction: string | null;
}

export interface ReplayResult {
  id: string;
  title: string;
  asset: string;
  description: string;
  source: string;
  methodology: string;
  points: ReplayPoint[];
  summary: {
    startPrice: number;
    troughPrice: number;
    maxDrawdownPct: number;
    peakRiskScore: number;
    peakBand: string;
    wouldHaveActed: boolean;
    firstActionType: string | null;
    firstActionAt: string | null;
  };
}

function backendBaseUrl(): string {
  return resolveBackendBaseUrl();
}

/** Fetch a real-event replay. Defaults to the primary event when `id` omitted. */
export async function fetchReplay(
  id = 'sui-oct-2025-crash',
  fetchFn: typeof fetch = fetch,
): Promise<ReplayResult> {
  const res = await fetchFn(`${backendBaseUrl()}/api/replay/${encodeURIComponent(id)}`, {
    method: 'GET',
  });
  if (!res.ok) {
    throw new Error(`Failed to load replay (status ${res.status})`);
  }
  return (await res.json()) as ReplayResult;
}
