// Backend client abstraction for the Human Override Console (Req 11).
//
// The HTTP transport is injectable (a `fetch`-like function) so component tests
// can drive the console without a live backend. Mirrors the exact pattern used
// by `dashboardApi.ts` / `policyApi.ts`.
//
// The client has two responsibilities:
//
//   1. READS — assemble the console view (active actions, paused markets, the
//      relevant policy, the Risk_Score at action time, linked Walrus evidence,
//      and the OverrideCap holder address) by composing the existing dashboard
//      read endpoints (`GET /api/markets`, `GET /api/markets/:id`). It reuses
//      the {@link DashboardApiClient.getMarketDetail} shapes rather than
//      re-deriving them. (Req 11.1, 11.2)
//
//   2. WRITES — submit a DAO override operation (reverse / revoke /
//      update-thresholds / unpause / restore / confirm) to the backend
//      `POST /api/actions/override` endpoint, which runs the server-defined
//      OverrideExecutor flow and returns the resulting Tx_Digest. Every
//      operation REQUIRES a non-empty override reason. (Req 11.5, 11.6, 11.7)

import {
  DashboardApiClient,
  type BackendResponse,
  type DashboardDataClient,
} from './dashboardApi';
import type {
  DaoOverrideStatus,
  MarketActionRecord,
  MarketDetailView,
  MarketSummary,
  PolicyParams,
} from './dashboardTypes';

export type { BackendResponse };

/**
 * Minimal `fetch`-like transport supporting both the GET reads (composed from
 * the dashboard endpoints) and the `POST /api/actions/override` write. The
 * global `fetch` satisfies this shape, and it is assignable to the dashboard
 * client's narrower transport. (Mirrors `dashboardApi.ts` / `policyApi.ts`.)
 */
export type BackendFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<BackendResponse>;

// ---------------------------------------------------------------------------
// Console operations (Req 11.5).
// ---------------------------------------------------------------------------

/**
 * The override controls the console offers. Each maps to a
 * `sentinel_policy::policy` function. The first five are wired through the
 * backend OverrideExecutor (`VALID_OVERRIDE_OPERATIONS`); `confirm_action` and
 * `restore_ltv` additionally satisfy the confirm/restore controls Req 11.5
 * requires the console to present.
 */
export const CONSOLE_OPERATIONS = [
  'reverse_action',
  'confirm_action',
  'revoke_guardian',
  'update_thresholds',
  'unpause_market',
  'restore_ltv',
] as const;

export type ConsoleOperation = (typeof CONSOLE_OPERATIONS)[number];

/** Human-readable label for each console operation. */
export const CONSOLE_OPERATION_LABEL: Record<ConsoleOperation, string> = {
  reverse_action: 'Reverse action',
  confirm_action: 'Confirm action',
  revoke_guardian: 'Revoke guardian',
  update_thresholds: 'Update thresholds',
  unpause_market: 'Unpause market',
  restore_ltv: 'Restore parameter',
};

// ---------------------------------------------------------------------------
// Console view DTOs (composed from the dashboard read shapes).
// ---------------------------------------------------------------------------

/**
 * Per-market override view: the relevant policy, the most recent (active)
 * action with the Risk_Score recorded at action time and its linked Walrus
 * evidence, whether the market is currently paused, the last verified
 * Tx_Digest, and the wallet address holding the OverrideCap authority.
 * (Req 11.1, 11.2)
 */
export interface OverrideConsoleMarket {
  market: MarketSummary;
  /** The relevant Risk_Policy parameters for this market. (Req 11.1) */
  policy: PolicyParams | null;
  /** The most recent executed action for this market. (Req 11.1) */
  activeAction: MarketActionRecord | null;
  /** Risk_Score recorded at the time of the active action. (Req 11.1) */
  riskScoreAtAction: number | null;
  /** Linked Walrus evidence Blob_ID for the active action. (Req 11.1) */
  evidenceBlobId: string | null;
  /** Whether the market is currently paused. (Req 11.1) */
  isPaused: boolean;
  /** DAO override status derived from the most recent action. */
  daoOverrideStatus: DaoOverrideStatus;
  /** Last Tx_Digest surfaced by the backend. */
  lastTxDigest: string | null;
  /** Whether the last Tx_Digest is verified as a Sui Testnet transaction. */
  lastTxDigestVerifiedTestnet: boolean;
  /** Wallet address holding the OverrideCap authority (the DAO address). (Req 11.2) */
  overrideCapHolder: string | null;
}

/** The assembled console view across every monitored market. */
export interface OverrideConsoleData {
  markets: OverrideConsoleMarket[];
}

// ---------------------------------------------------------------------------
// Reversal / change preview (Req 11.3).
// ---------------------------------------------------------------------------

/** A single before/after change line shown in the preview. */
export interface PreviewChange {
  field: string;
  before: string;
  after: string;
}

/** The previewed effect of an override operation, shown BEFORE signing. (Req 11.3) */
export interface OverridePreview {
  operation: ConsoleOperation;
  label: string;
  changes: PreviewChange[];
}

/** New policy bounds + thresholds for the `update_thresholds` operation. */
export interface ThresholdUpdate {
  newMaxLtvDeltaBps: number;
  newMaxMarginDeltaBps: number;
  newPauseDurationLimitMs: number;
  newCooldownMs: number;
  newRiskThresholds: number[];
}

// ---------------------------------------------------------------------------
// Override submission + result.
// ---------------------------------------------------------------------------

/** On-chain object ids an override PTB template needs (best-effort from reads). */
export interface OverrideOnChainRefs {
  policyObjectId: string;
  overrideCapObjectId: string;
  marketStateObjectId?: string;
  guardianCapObjectId?: string;
  actionLogObjectId?: string;
}

/**
 * The high-level submission the console produces. {@link buildOverrideExecuteBody}
 * translates it into the backend `POST /api/actions/override` body.
 */
export interface OverrideSubmission {
  operation: ConsoleOperation;
  /** Override reason — REQUIRED and non-empty for every operation. (Req 11.6) */
  reason: string;
  /** Off-chain policy id for the recorded ActionLog row. */
  policyId: string;
  /** Off-chain market id for the recorded ActionLog row. */
  marketId: string;
  /** OverrideCap holder (DAO) address — recorded as the action actor. (Req 11.2) */
  daoAddress: string;
  /** On-chain ActionLog id the evidence links to after submit. */
  actionLogId: string;
  /** Risk_Score recorded on the row, when known. */
  riskScore?: number | null;
  /** Id of the original action being reversed (for reversal operations). (Req 11.4) */
  originalActionId?: string;
  /** On-chain object ids for the PTB template. */
  onChain: OverrideOnChainRefs;
  /** New bounds for the `update_thresholds` operation. */
  thresholds?: ThresholdUpdate;
  /** Opaque risk evaluation passed through for evidence generation. */
  evaluation?: unknown;
  /** Opaque action-flow context passed through for evidence generation. */
  actionContext?: unknown;
}

/** Backend `POST /api/actions/override` request body (OverrideExecuteRequest). */
export interface OverrideExecuteBody {
  request: Record<string, unknown> & { operation: ConsoleOperation; reason: string };
  evaluation: unknown;
  actionContext: unknown;
  actionLogId: string;
  record: {
    policyId: string;
    marketId: string;
    daoAddress: string;
    riskScore?: number | null;
    originalActionId?: string;
  };
}

/** Normalized outcome of an override submission. */
export interface OverrideSubmissionResult {
  success: boolean;
  operation: ConsoleOperation;
  /** The resulting Tx_Digest, displayed via the guarded TxDigestDisplay. (Req 11.7) */
  txDigest: string | null;
  /**
   * Whether the digest is testnet-verified. The backend OverrideExecutor
   * confirms the digest origin on Sui Testnet before reporting success, so a
   * successful result with a digest is verified. (Req 1.8, 1.9)
   */
  txDigestVerifiedTestnet: boolean;
  blobId: string | null;
  overrideReason: string | null;
  failureReason: string | null;
}

/** Raised when an override submission is missing its required reason. (Req 11.6) */
export class OverrideReasonRequiredError extends Error {
  constructor() {
    super('An override reason is required for every override operation.');
    this.name = 'OverrideReasonRequiredError';
  }
}

// ---------------------------------------------------------------------------
// Coercion helpers.
// ---------------------------------------------------------------------------

function asString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function asNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && !Number.isNaN(value) ? value : null;
}

function isMarketPaused(market: MarketSummary, params: PolicyParams | null): boolean {
  return market.status === 'Paused' || params?.isPaused === true;
}

// ---------------------------------------------------------------------------
// Preview builder — pure, so it is trivially unit-testable. (Req 11.3)
// ---------------------------------------------------------------------------

/**
 * Compute the before/after changes an override operation would apply to a
 * market, shown to the governor BEFORE signing. (Req 11.3, 11.5)
 */
export function buildOverridePreview(
  operation: ConsoleOperation,
  entry: OverrideConsoleMarket,
  thresholds?: ThresholdUpdate,
): OverridePreview {
  const label = CONSOLE_OPERATION_LABEL[operation];
  const action = entry.activeAction;
  const params = entry.policy;

  const changes: PreviewChange[] = [];

  switch (operation) {
    case 'reverse_action':
    case 'restore_ltv': {
      // Reverting an action inverts its parameter change (new → old). (Req 11.4)
      const before = asString(action?.newValue) ?? '—';
      const after = asString(action?.oldValue) ?? '—';
      changes.push({
        field: action?.actionType ? `${action.actionType} value` : 'Parameter value',
        before,
        after,
      });
      changes.push({ field: 'Action status', before: 'Active', after: 'Reversed by DAO' });
      break;
    }
    case 'unpause_market': {
      changes.push({ field: 'Borrow status', before: 'Paused', after: 'Active' });
      changes.push({ field: 'Market status', before: entry.market.status, after: 'Normal' });
      break;
    }
    case 'revoke_guardian': {
      changes.push({ field: 'Guardian capability', before: 'Active', after: 'Revoked' });
      changes.push({
        field: 'Future autonomous actions',
        before: 'Permitted',
        after: 'Blocked',
      });
      break;
    }
    case 'update_thresholds': {
      changes.push({
        field: 'Max LTV delta (bps)',
        before: String(params?.maxLtvDeltaBps ?? '—'),
        after: String(thresholds?.newMaxLtvDeltaBps ?? '—'),
      });
      changes.push({
        field: 'Max margin delta (bps)',
        before: String(params?.maxMarginDeltaBps ?? '—'),
        after: String(thresholds?.newMaxMarginDeltaBps ?? '—'),
      });
      changes.push({
        field: 'Pause duration limit (ms)',
        before: String(params?.pauseDurationLimitMs ?? '—'),
        after: String(thresholds?.newPauseDurationLimitMs ?? '—'),
      });
      changes.push({
        field: 'Cooldown (ms)',
        before: String(params?.cooldownMs ?? '—'),
        after: String(thresholds?.newCooldownMs ?? '—'),
      });
      break;
    }
    case 'confirm_action': {
      // Confirming keeps the action in place; no parameter change. (Req 11.5)
      changes.push({ field: 'Action status', before: 'Active', after: 'Confirmed (kept)' });
      break;
    }
    default: {
      const never: never = operation;
      throw new Error(`Unknown override operation: ${String(never)}`);
    }
  }

  return { operation, label, changes };
}

// ---------------------------------------------------------------------------
// Request builder — pure, so it is trivially unit-testable. (Req 11.6)
// ---------------------------------------------------------------------------

/**
 * Build the backend `POST /api/actions/override` body from a high-level console
 * submission. Throws {@link OverrideReasonRequiredError} when the reason is
 * missing or empty, before any network call. (Req 11.6)
 */
export function buildOverrideExecuteBody(submission: OverrideSubmission): OverrideExecuteBody {
  if (typeof submission.reason !== 'string' || submission.reason.trim() === '') {
    throw new OverrideReasonRequiredError();
  }

  const clean = submission.reason.trim();
  const { onChain } = submission;

  const request: Record<string, unknown> & { operation: ConsoleOperation; reason: string } = {
    operation: submission.operation,
    reason: clean,
    policyObjectId: onChain.policyObjectId,
    overrideCapObjectId: onChain.overrideCapObjectId,
  };

  switch (submission.operation) {
    case 'reverse_action':
    case 'restore_ltv':
    case 'confirm_action':
      if (onChain.actionLogObjectId) request.actionLogObjectId = onChain.actionLogObjectId;
      if (onChain.marketStateObjectId) request.marketStateObjectId = onChain.marketStateObjectId;
      break;
    case 'revoke_guardian':
      if (onChain.guardianCapObjectId) request.guardianCapObjectId = onChain.guardianCapObjectId;
      break;
    case 'unpause_market':
      if (onChain.marketStateObjectId) request.marketStateObjectId = onChain.marketStateObjectId;
      break;
    case 'update_thresholds':
      if (submission.thresholds) {
        request.newMaxLtvDeltaBps = submission.thresholds.newMaxLtvDeltaBps;
        request.newMaxMarginDeltaBps = submission.thresholds.newMaxMarginDeltaBps;
        request.newPauseDurationLimitMs = submission.thresholds.newPauseDurationLimitMs;
        request.newCooldownMs = submission.thresholds.newCooldownMs;
        request.newRiskThresholds = submission.thresholds.newRiskThresholds;
      }
      break;
    default:
      break;
  }

  return {
    request,
    evaluation: submission.evaluation ?? defaultOverrideEvaluation(submission.marketId, submission.riskScore),
    actionContext: {
      policyId: submission.policyId,
      marketId: submission.marketId,
      agentSigner: submission.daoAddress,
      dataSource: 'live',
      timestampMs: Date.now(),
      priorActionIds: [],
      ...(isRecord(submission.actionContext) ? submission.actionContext : {}),
      overrideReason: clean,
    },
    actionLogId: submission.actionLogId,
    record: {
      policyId: submission.policyId,
      marketId: submission.marketId,
      daoAddress: submission.daoAddress,
      riskScore: submission.riskScore ?? null,
      ...(submission.originalActionId ? { originalActionId: submission.originalActionId } : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A baseline {@link RiskEvaluation}-shaped object used for evidence generation
 * when the console does not carry a full evaluation. The backend Evidence
 * Service requires a complete feature vector to serialize the bundle; the
 * override reason (woven in separately) is the substantive evidence. Numbers
 * are finite so canonical serialization never rejects them.
 */
export function defaultOverrideEvaluation(
  marketId: string,
  riskScore?: number | null,
): Record<string, unknown> {
  const now = Date.now();
  const score = typeof riskScore === 'number' && Number.isFinite(riskScore) ? riskScore : 0;
  return {
    marketId,
    modelVersion: 'override-context@1.0.0',
    promptConfigVersion: 'override-context@1.0.0',
    riskScore: score,
    band: 'Normal',
    classes: [],
    recommendedAction: null,
    confidence: 100,
    explanation: 'DAO override action',
    ruleOutputs: [],
    featureVector: {
      oraclePrice: 1, oracleConfidence: 0.001, oracleTimestampMs: now, nowMs: now,
      freshnessThresholdMs: 60_000, priceChange1mPct: 0, priceChange5mPct: 0,
      priceChange15mPct: 0, realizedVolatilityPct: 0, liquidityDepth: 0, spreadBps: 0,
      imbalance: 0, utilization: 0, exposure: 0, currentMaxLtvBps: 0, borrowPaused: false,
      guardedMode: false, policyActive: true, guardianRevoked: false, priorActionsCount: 0,
      priorOverridesCount: 0, historicalEvidenceRefs: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Client.
// ---------------------------------------------------------------------------

/**
 * The override-console backend surface. {@link OverrideApiClient} implements it;
 * tests may supply a stub.
 */
export interface OverrideDataClient {
  /** Assemble the console view across every monitored market. (Req 11.1, 11.2) */
  loadConsole(): Promise<OverrideConsoleData>;
  /** Submit a DAO override operation and return the resulting Tx_Digest. (Req 11.7) */
  submitOverride(submission: OverrideSubmission): Promise<OverrideSubmissionResult>;
}

/** Map a {@link MarketDetailView} into a console market entry. */
function toConsoleMarket(detail: MarketDetailView): OverrideConsoleMarket {
  const action = detail.lastAction;
  return {
    market: detail.market,
    policy: detail.params,
    activeAction: action,
    riskScoreAtAction: asNumberOrNull(action?.riskScore),
    evidenceBlobId: action?.walrusEvidenceBlobId ?? detail.lastWalrusBlobId ?? null,
    isPaused: isMarketPaused(detail.market, detail.params),
    daoOverrideStatus: detail.daoOverrideStatus,
    lastTxDigest: detail.lastTxDigest,
    lastTxDigestVerifiedTestnet: detail.lastTxDigestVerifiedTestnet,
    // The OverrideCap is held by the policy's DAO address. (Req 11.2)
    overrideCapHolder: detail.params?.daoAddress ?? null,
  };
}

/**
 * Thin client over the Sentinel backend. Reads compose the dashboard endpoints
 * (reusing {@link DashboardApiClient.getMarketDetail}); writes post to
 * `POST /api/actions/override`. All network access goes through the injected
 * {@link BackendFetch}, keeping the console testable without a live backend.
 */
export class OverrideApiClient implements OverrideDataClient {
  private readonly fetchFn: BackendFetch;
  private readonly baseUrl: string;
  private readonly reads: DashboardDataClient;

  constructor(fetchFn: BackendFetch, baseUrl = '', reads?: DashboardDataClient) {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.reads = reads ?? new DashboardApiClient(fetchFn, baseUrl);
  }

  async loadConsole(): Promise<OverrideConsoleData> {
    const markets = await this.reads.listMarkets();
    const details = await Promise.all(
      markets.map((m) => this.reads.getMarketDetail(m.id)),
    );
    return { markets: details.map(toConsoleMarket) };
  }

  async submitOverride(submission: OverrideSubmission): Promise<OverrideSubmissionResult> {
    // Build (and validate the required reason) BEFORE any network call. (Req 11.6)
    const body = buildOverrideExecuteBody(submission);

    const res = await this.fetchFn(`${this.baseUrl}/api/actions/override`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = (await res.json()) as { result?: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    const result = (payload.result ?? payload) as Record<string, unknown>;

    const success = result.success === true;
    const txDigest = asString(result.txDigest);

    return {
      success,
      operation: submission.operation,
      txDigest,
      // A successful submit means the backend confirmed the digest on testnet.
      txDigestVerifiedTestnet: success && txDigest !== null,
      blobId: asString(result.blobId),
      overrideReason: asString(result.overrideReason) ?? submission.reason,
      failureReason: asString(result.failureReason),
    };
  }
}

/** Build an {@link OverrideApiClient} from the global `fetch`, pointed at the backend. */
export function createDefaultOverrideClient(): OverrideApiClient {
  const baseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_BACKEND_URL) || '';
  const transport: BackendFetch = (url, init) =>
    fetch(url, init as RequestInit) as unknown as Promise<BackendResponse>;
  return new OverrideApiClient(transport, baseUrl);
}
