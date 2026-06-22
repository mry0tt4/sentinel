// Shared types for the Risk Operations Dashboard (Req 3).
//
// These mirror the camelCase DTOs the backend emits over both REST
// (`GET /api/markets`, `GET /api/markets/:id/risk`) and the WebSocket server
// (`ServerMessage`). The frontend keeps its own copy so the island bundle stays
// self-contained and does not import backend internals.

/** The market status set surfaced on the dashboard. (Req 3.2) */
export type MarketStatus = 'Normal' | 'Warning' | 'Guarded' | 'Paused' | 'Revoked';

/** Every valid market status, in display order. */
export const MARKET_STATUSES: readonly MarketStatus[] = [
  'Normal',
  'Warning',
  'Guarded',
  'Paused',
  'Revoked',
] as const;

/** A monitored market summary from `GET /api/markets`. */
export interface MarketSummary {
  id: string;
  onChainId?: string;
  marketType?: string;
  name: string;
  status: MarketStatus;
  freshnessThresholdMs?: number | string;
  createdAt?: string;
}

/**
 * The indicator feature vector carried on the risk snapshot. The dashboard
 * surfaces oracle freshness/confidence, volatility, liquidity, and exposure
 * from it. (Req 3.5) Extra fields are tolerated.
 */
export interface RiskIndicators {
  oraclePrice?: number;
  oracleConfidence?: number;
  oracleTimestampMs?: number;
  nowMs?: number;
  freshnessThresholdMs?: number;
  realizedVolatilityPct?: number;
  liquidityDepth?: number;
  spreadBps?: number;
  exposure?: number;
  utilization?: number;
  [key: string]: unknown;
}

/** A single deterministic rule output shown in the "Why?" panel. (Req 3.8) */
export interface DeterministicRuleOutput {
  rule: string;
  fired: boolean;
  value: string;
}

/** Freshness computed by `GET /api/markets/:id/risk`. (Req 3.9) */
export interface FreshnessInfo {
  snapshotAt: string | null;
  ageMs: number | null;
  thresholdMs: number;
  stale: boolean;
}

/**
 * Normalized per-market risk view consumed by the dashboard widgets. Built from
 * the REST risk DTO and updated in place by `risk_update` WebSocket messages.
 */
/** USD impact figures from the risk endpoint (real on-chain exposure × Pyth). */
export interface ImpactMetrics {
  protectedValueUsd: number;
  exposureUsd: number;
  lossPreventedUsd: number;
  mitigationActive: boolean;
}

/** Verifiable provenance of the live readings (all real Sui Testnet sources). */
export interface RiskSources {
  network: string;
  oracle: { protocol: string; market: string; feedId: string };
  liquidity: { protocol: string; market: string; pool: string };
  marketState: string;
  evidence: string;
  /** A real Sui lending protocol whose live reserves anchor the impact figures. */
  protocol?: {
    name: string;
    slug: string;
    network: string;
    suppliedUsd: number;
    borrowedUsd: number;
    utilization: number;
    url: string;
    asOfMs: number;
  } | null;
}

export interface MarketRiskView {
  marketId: string;
  status?: MarketStatus | string | null;
  riskScore: number | null;
  band: string | null;
  classes: string[];
  confidence: number | null;
  recommendedAction: string | null;
  indicators: RiskIndicators | null;
  explanation?: string | null;
  ruleOutputs?: DeterministicRuleOutput[];
  impact?: ImpactMetrics | null;
  sources?: RiskSources | null;
  dataSource?: 'live' | 'simulated' | null;
  isSimulated?: boolean | null;
  freshness?: FreshnessInfo;
}

/**
 * Current policy parameters surfaced on the single-market detail page. Mirrors
 * the camelCase params DTO from `GET /api/markets/:id`. (Req 3.6)
 */
export interface PolicyParams {
  id: string;
  onChainPolicyId?: string | null;
  /** On-chain GuardianCap object id (agent authority). */
  guardianCapId?: string | null;
  /** On-chain OverrideCap object id (DAO authority). */
  overrideCapId?: string | null;
  ownerAddress?: string | null;
  daoAddress: string | null;
  allowedActions: string[];
  maxLtvDeltaBps: number | null;
  maxMarginDeltaBps: number | null;
  pauseDurationLimitMs: number | string | null;
  cooldownMs: number | string | null;
  riskThresholds?: unknown;
  isRevoked?: boolean | null;
  isPaused?: boolean | null;
  version?: number | null;
  walrusConfigBlobId?: string | null;
}

/** DAO override status derived from the most recent action. (Req 3.6) */
export type DaoOverrideStatus = 'none' | 'overridden' | 'reversed';

/**
 * A single executed/overridden action record from `GET /api/markets/:id`
 * (`lastAction`). Mirrors the camelCase action DTO. (Req 3.6)
 */
export interface MarketActionRecord {
  id: string;
  policyId?: string | null;
  marketId?: string | null;
  incidentId?: string | null;
  actor: string | null;
  actorType?: 'agent' | 'dao' | 'admin' | string | null;
  riskScore: number | null;
  actionType: string | null;
  oldValue: string | null;
  newValue: string | null;
  walrusEvidenceBlobId: string | null;
  evidenceHash: string | null;
  txDigest: string | null;
  isReversed: boolean;
  reversedBy?: string | null;
  reversalTxDigest?: string | null;
  overrideReason?: string | null;
  timestampMs?: number | string | null;
  createdAt?: string | null;
}

/**
 * Normalized single-market detail view consumed by the `/markets/:id` page.
 * Built from `GET /api/markets/:id`. (Req 3.6)
 */
export interface MarketDetailView {
  market: MarketSummary;
  params: PolicyParams | null;
  lastAction: MarketActionRecord | null;
  lastTxDigest: string | null;
  /**
   * Whether the last Tx_Digest has been verified by the backend Network_Guard
   * as originating from Sui Testnet. Defaults to false (fail-closed) so an
   * unverified digest is never displayed. (Req 1.8, 1.9)
   */
  lastTxDigestVerifiedTestnet: boolean;
  lastWalrusBlobId: string | null;
  daoOverrideStatus: DaoOverrideStatus;
}

// ---------------------------------------------------------------------------
// WebSocket message mirror (matches backend `src/ws/messages.ts`).
// ---------------------------------------------------------------------------

/** Risk snapshot payload carried by a `risk_update` message. */
export interface RiskSnapshotMessage {
  marketId: string;
  riskScore: number;
  band: string;
  classes: string[];
  confidence: number;
  recommendedAction: string | null;
  refusalReason?: string | null;
  featureVector: RiskIndicators;
  ruleOutputs?: DeterministicRuleOutput[];
  modelVersion: string;
  promptConfigVersion: string;
  explanation?: string | null;
  dataSource: 'live' | 'simulated';
  isSimulated: boolean;
  createdAt: string;
}

/** Action record payload carried by `action_executed` / `override_applied`. */
export interface ActionRecordMessage {
  id: string;
  policyId: string;
  marketId: string;
  actor: string;
  actorType: 'agent' | 'dao' | 'admin';
  riskScore: number | null;
  actionType: string;
  oldValue: string | null;
  newValue: string | null;
  walrusEvidenceBlobId: string | null;
  evidenceHash: string | null;
  txDigest: string | null;
  isReversed: boolean;
  timestampMs: string;
}

/** Messages the server pushes to subscribed dashboards. */
export type ServerMessage =
  | { type: 'risk_update'; marketId: string; snapshot: RiskSnapshotMessage }
  | { type: 'action_executed'; marketId: string; action: ActionRecordMessage }
  | { type: 'guardian_revoked'; marketId: string; at: string }
  | { type: 'override_applied'; marketId: string; action: ActionRecordMessage }
  | { type: 'stale_data'; marketId: string }
  | { type: 'env_check_failed'; checkType: string; detail: string };

/** Messages a client sends to manage its per-market subscriptions. */
export type ClientMessage =
  | { type: 'subscribe'; marketId: string }
  | { type: 'unsubscribe'; marketId: string };

/** A single point on the risk-score trend chart. */
export interface RiskPoint {
  t: number;
  score: number;
}

/** A single point on the oracle price chart. */
export interface PricePoint {
  t: number;
  price: number;
}

/**
 * Fold a `risk_update` snapshot into a {@link MarketRiskView}. Fresh data has
 * just arrived, so the view is no longer stale. (Req 3.7)
 */
export function snapshotToRiskView(snapshot: RiskSnapshotMessage): MarketRiskView {
  return {
    marketId: snapshot.marketId,
    riskScore: snapshot.riskScore,
    band: snapshot.band,
    classes: snapshot.classes ?? [],
    confidence: snapshot.confidence,
    recommendedAction: snapshot.recommendedAction ?? null,
    indicators: snapshot.featureVector ?? null,
    explanation: snapshot.explanation ?? null,
    ruleOutputs: snapshot.ruleOutputs ?? [],
    dataSource: snapshot.dataSource ?? null,
    isSimulated: snapshot.isSimulated ?? null,
    freshness: {
      snapshotAt: snapshot.createdAt,
      ageMs: 0,
      thresholdMs: Number(snapshot.featureVector?.freshnessThresholdMs ?? 0),
      stale: false,
    },
  };
}

/** Whether the most recent risk data for a view is stale. (Req 3.9) */
export function isRiskDataStale(view: MarketRiskView | null): boolean {
  return view?.freshness?.stale ?? false;
}
