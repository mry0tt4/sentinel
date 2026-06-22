// Backend client abstraction for the Risk Operations Dashboard.
//
// The HTTP transport is injectable (a `fetch`-like function) so component tests
// can drive the dashboard without a live backend. Mirrors the pattern used by
// `policyApi.ts`. (Design: "Make the WS URL + a data-fetch client injectable so
// tests don't need a live server.")

import type {
  DaoOverrideStatus,
  DeterministicRuleOutput,
  FreshnessInfo,
  MarketActionRecord,
  MarketDetailView,
  MarketRiskView,
  MarketStatus,
  MarketSummary,
  PolicyParams,
  RiskIndicators,
} from './dashboardTypes';

/** Minimal response shape compatible with the Fetch API `Response`. */
export interface BackendResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal `fetch`-like transport. The global `fetch` satisfies this shape. */
export type BackendFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<BackendResponse>;

/**
 * The dashboard backend surface. {@link DashboardApiClient} implements it;
 * tests may supply a stub.
 */
export interface DashboardDataClient {
  /** List monitored markets with status. (Req 3.2) */
  listMarkets(): Promise<MarketSummary[]>;
  /** Fetch the current risk view for a market. (Req 3.3, 3.5, 3.9) */
  getRisk(marketId: string): Promise<MarketRiskView>;
  /**
   * Fetch the single-market detail: current params, last executed action,
   * last Tx_Digest, last Walrus Blob_ID, and DAO override status. (Req 3.6)
   */
  getMarketDetail(marketId: string): Promise<MarketDetailView>;
}

function asMarketStatus(value: unknown): MarketStatus {
  const allowed: MarketStatus[] = ['Normal', 'Warning', 'Guarded', 'Paused', 'Revoked'];
  return allowed.includes(value as MarketStatus) ? (value as MarketStatus) : 'Normal';
}

function toMarketSummary(row: Record<string, unknown>): MarketSummary {
  return {
    id: String(row.id ?? ''),
    onChainId: row.onChainId === undefined ? undefined : String(row.onChainId),
    marketType: row.marketType === undefined ? undefined : String(row.marketType),
    name: String(row.name ?? row.id ?? 'Unknown market'),
    status: asMarketStatus(row.status),
    freshnessThresholdMs: row.freshnessThresholdMs as number | string | undefined,
    createdAt: row.createdAt === undefined ? undefined : String(row.createdAt),
  };
}

function toFreshness(value: unknown): FreshnessInfo | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const f = value as Record<string, unknown>;
  return {
    snapshotAt: f.snapshotAt === undefined ? null : (f.snapshotAt as string | null),
    ageMs: typeof f.ageMs === 'number' ? f.ageMs : null,
    thresholdMs: Number(f.thresholdMs ?? 0),
    stale: Boolean(f.stale),
  };
}

function toRiskView(payload: Record<string, unknown>): MarketRiskView {
  return {
    marketId: String(payload.marketId ?? ''),
    status: (payload.status as MarketStatus | null | undefined) ?? null,
    riskScore: typeof payload.riskScore === 'number' ? payload.riskScore : null,
    band: (payload.band as string | null | undefined) ?? null,
    classes: Array.isArray(payload.classes) ? (payload.classes as string[]) : [],
    confidence: typeof payload.confidence === 'number' ? payload.confidence : null,
    recommendedAction: (payload.recommendedAction as string | null | undefined) ?? null,
    indicators: (payload.indicators as RiskIndicators | null) ?? null,
    explanation: (payload.explanation as string | null | undefined) ?? null,
    ruleOutputs: Array.isArray(payload.ruleOutputs)
      ? (payload.ruleOutputs as DeterministicRuleOutput[])
      : [],
    impact: (payload.impact as MarketRiskView['impact']) ?? null,
    sources: (payload.sources as MarketRiskView['sources']) ?? null,
    dataSource: (payload.dataSource as 'live' | 'simulated' | null | undefined) ?? null,
    isSimulated: (payload.isSimulated as boolean | null | undefined) ?? null,
    freshness: toFreshness(payload.freshness),
  };
}

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function toPolicyParams(value: unknown): PolicyParams | null {
  if (typeof value !== 'object' || value === null) return null;
  const p = value as Record<string, unknown>;
  return {
    id: String(p.id ?? ''),
    onChainPolicyId: asString(p.onChainPolicyId),
    guardianCapId: asString(p.guardianCapId),
    overrideCapId: asString(p.overrideCapId),
    ownerAddress: asString(p.ownerAddress),
    daoAddress: asString(p.daoAddress),
    allowedActions: Array.isArray(p.allowedActions) ? (p.allowedActions as string[]) : [],
    maxLtvDeltaBps: asNumberOrNull(p.maxLtvDeltaBps),
    maxMarginDeltaBps: asNumberOrNull(p.maxMarginDeltaBps),
    pauseDurationLimitMs: (p.pauseDurationLimitMs as number | string | null | undefined) ?? null,
    cooldownMs: (p.cooldownMs as number | string | null | undefined) ?? null,
    riskThresholds: p.riskThresholds,
    isRevoked: (p.isRevoked as boolean | null | undefined) ?? null,
    isPaused: (p.isPaused as boolean | null | undefined) ?? null,
    version: asNumberOrNull(p.version),
    walrusConfigBlobId: asString(p.walrusConfigBlobId),
  };
}

function toActionRecord(value: unknown): MarketActionRecord | null {
  if (typeof value !== 'object' || value === null) return null;
  const a = value as Record<string, unknown>;
  return {
    id: String(a.id ?? ''),
    policyId: asString(a.policyId),
    marketId: asString(a.marketId),
    incidentId: asString(a.incidentId),
    actor: asString(a.actor),
    actorType: (a.actorType as string | null | undefined) ?? null,
    riskScore: asNumberOrNull(a.riskScore),
    actionType: asString(a.actionType),
    oldValue: asString(a.oldValue),
    newValue: asString(a.newValue),
    walrusEvidenceBlobId: asString(a.walrusEvidenceBlobId),
    evidenceHash: asString(a.evidenceHash),
    txDigest: asString(a.txDigest),
    isReversed: Boolean(a.isReversed),
    reversedBy: asString(a.reversedBy),
    reversalTxDigest: asString(a.reversalTxDigest),
    overrideReason: asString(a.overrideReason),
    timestampMs: (a.timestampMs as number | string | null | undefined) ?? null,
    createdAt: asString(a.createdAt),
  };
}

function asOverrideStatus(value: unknown): DaoOverrideStatus {
  return value === 'overridden' || value === 'reversed' ? value : 'none';
}

function toMarketDetailView(payload: Record<string, unknown>): MarketDetailView {
  const market =
    typeof payload.market === 'object' && payload.market !== null
      ? toMarketSummary(payload.market as Record<string, unknown>)
      : toMarketSummary({});
  return {
    market,
    params: toPolicyParams(payload.params),
    lastAction: toActionRecord(payload.lastAction),
    lastTxDigest: asString(payload.lastTxDigest),
    // Fail-closed: only treat the digest as displayable when the backend has
    // explicitly verified it as a Sui Testnet transaction. (Req 1.8, 1.9)
    lastTxDigestVerifiedTestnet: payload.lastTxDigestVerifiedTestnet === true,
    lastWalrusBlobId: asString(payload.lastWalrusBlobId),
    daoOverrideStatus: asOverrideStatus(payload.daoOverrideStatus),
  };
}

/**
 * Thin client over the Sentinel backend read endpoints. All network access goes
 * through the injected {@link BackendFetch}, keeping the dashboard testable.
 */
export class DashboardApiClient implements DashboardDataClient {
  private readonly fetchFn: BackendFetch;
  private readonly baseUrl: string;

  constructor(fetchFn: BackendFetch, baseUrl = '') {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async listMarkets(): Promise<MarketSummary[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/markets`, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`Failed to list markets (status ${res.status})`);
    }
    const payload = (await res.json()) as { markets?: unknown };
    const markets = Array.isArray(payload.markets) ? payload.markets : [];
    return markets.map((m) => toMarketSummary(m as Record<string, unknown>));
  }

  async getRisk(marketId: string): Promise<MarketRiskView> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/markets/${encodeURIComponent(marketId)}/risk`,
      { method: 'GET' },
    );
    if (!res.ok) {
      throw new Error(`Failed to load risk for ${marketId} (status ${res.status})`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return toRiskView(payload);
  }

  async getMarketDetail(marketId: string): Promise<MarketDetailView> {
    const res = await this.fetchFn(
      `${this.baseUrl}/api/markets/${encodeURIComponent(marketId)}`,
      { method: 'GET' },
    );
    if (!res.ok) {
      throw new Error(`Failed to load market detail for ${marketId} (status ${res.status})`);
    }
    const payload = (await res.json()) as Record<string, unknown>;
    return toMarketDetailView(payload);
  }
}

/** Build a {@link DashboardApiClient} from the global `fetch`, pointed at the backend. */
export function createDefaultDashboardClient(): DashboardApiClient {
  const baseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_BACKEND_URL) || '';
  const transport: BackendFetch = (url, init) =>
    fetch(url, init) as unknown as Promise<BackendResponse>;
  return new DashboardApiClient(transport, baseUrl);
}
