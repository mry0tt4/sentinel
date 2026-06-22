/**
 * Protocol State Indexer — ports and domain types.
 *
 * The indexer subscribes to on-chain Sui events emitted by `sentinel_policy`
 * (and, where relevant, `sentinel_demo_market`), persists the off-chain
 * mirrors (`actions` / `walrus_blobs` / market & policy status), and records a
 * durable checkpoint so that after a restart it RESUMES from the last
 * persisted cursor and reconciles the database to chain state recovered from
 * the on-chain transaction digests. (Req 3.7, 17.6, 17.7, 17.8)
 *
 * Every external dependency is expressed as a narrow port so unit tests can
 * inject in-memory fakes (no live RPC, no live database):
 *  - {@link SuiEventSource}   — cursor-paginated on-chain event reads.
 *  - {@link CheckpointStore}  — durable last-processed cursor / digest.
 *  - {@link IndexerActionsRepo} / {@link IndexerWalrusRepo} /
 *    {@link IndexerMarketsRepo} / {@link IndexerPoliciesRepo} — persistence,
 *    each structurally satisfied by the concrete repositories in
 *    `db/repositories`.
 */

import type {
  ActionInsert,
  ActionRow,
  MarketRow,
  MarketStatus,
  PolicyRow,
  WalrusBlobRow,
} from '../db/types.js';

// ---------------------------------------------------------------------------
// Event source port (cursor-based pagination over on-chain events).
// ---------------------------------------------------------------------------

/**
 * Opaque pager cursor identifying a single on-chain event. Mirrors Sui's
 * `EventId` (`{ txDigest, eventSeq }`). Reading with a cursor returns the
 * events that come *after* it, so persisting the last processed cursor lets a
 * restarted indexer resume without reprocessing. (Req 17.6)
 */
export interface EventCursor {
  txDigest: string;
  eventSeq: string;
}

/** A single raw on-chain event as surfaced by the source port. */
export interface RawIndexedEvent {
  /** The event's own cursor (`{ txDigest, eventSeq }`). */
  id: EventCursor;
  /** Fully-qualified Move event type, e.g. `0xpkg::sentinel_policy::GuardianRevoked`. */
  type: string;
  /** Decoded Move event fields. */
  parsedJson: Record<string, unknown>;
  /** Address that sent the emitting transaction (used as the action actor). */
  sender?: string | null;
  /** UTC milliseconds since epoch, when available. */
  timestampMs?: string | null;
}

/** A page of events plus the cursor/flag needed to fetch the next page. */
export interface EventPage {
  data: RawIndexedEvent[];
  nextCursor: EventCursor | null;
  hasNextPage: boolean;
}

/** Arguments for a single cursor-paginated read. */
export interface EventQuery {
  /** Resume point; `null`/omitted starts from the earliest event. */
  cursor?: EventCursor | null;
  /** Max events to return in the page. */
  limit?: number;
}

/**
 * Port over the on-chain event stream. The production implementation wraps
 * `SuiClient.queryEvents` (filtered by the policy/demo-market modules); tests
 * supply a deterministic in-memory fake.
 */
export interface SuiEventSource {
  queryEvents(query: EventQuery): Promise<EventPage>;
}

// ---------------------------------------------------------------------------
// Checkpoint store port.
// ---------------------------------------------------------------------------

/**
 * The durable position of the indexer: the cursor/digest of the last fully
 * processed event plus a processed counter. Persisting this after each event
 * is what enables restart recovery. (Req 17.6)
 */
export interface IndexerCheckpoint {
  /** Cursor of the last processed event, or `null` if none processed yet. */
  cursor: EventCursor | null;
  /** Transaction digest of the last processed event (recovery anchor). */
  lastTxDigest: string | null;
  /** Total number of events processed across all runs. */
  processedCount: number;
  /** ISO 8601 UTC timestamp of the last checkpoint write. */
  updatedAt: string;
}

/** Durable store for the indexer checkpoint (in-memory default; Redis/PG later). */
export interface CheckpointStore {
  load(key: string): Promise<IndexerCheckpoint | null>;
  save(key: string, checkpoint: IndexerCheckpoint): Promise<void>;
}

// ---------------------------------------------------------------------------
// Repository ports (structurally satisfied by db/repositories).
// ---------------------------------------------------------------------------

/** Subset of `ActionsRepository` the indexer depends on. */
export interface IndexerActionsRepo {
  getByTxDigest(txDigest: string): Promise<ActionRow | null>;
  create(input: ActionInsert): Promise<ActionRow>;
}

/** Subset of `WalrusBlobsRepository` the indexer depends on. */
export interface IndexerWalrusRepo {
  getById(blobId: string): Promise<WalrusBlobRow | null>;
  linkToAction(
    blobId: string,
    actionId: string,
    evidenceHash: string,
  ): Promise<WalrusBlobRow | null>;
}

/** Subset of `MarketsRepository` the indexer depends on. */
export interface IndexerMarketsRepo {
  getByOnChainId(onChainId: string): Promise<MarketRow | null>;
  updateStatus(id: string, status: MarketStatus): Promise<MarketRow | null>;
}

/** Subset of `PoliciesRepository` the indexer depends on. */
export interface IndexerPoliciesRepo {
  getByOnChainPolicyId(onChainPolicyId: string): Promise<PolicyRow | null>;
  setRevoked(id: string, isRevoked: boolean): Promise<PolicyRow | null>;
}

// ---------------------------------------------------------------------------
// Decoded, classified events.
// ---------------------------------------------------------------------------

/** Discriminator for the four `sentinel_policy` events plus an unknown bucket. */
export type IndexedEventKind =
  | 'RiskActionExecuted'
  | 'RiskActionOverridden'
  | 'GuardianRevoked'
  | 'PolicyUpdated'
  | 'Unknown';

interface IndexedEventBase {
  kind: IndexedEventKind;
  cursor: EventCursor;
  txDigest: string;
  timestampMs: string | null;
}

/** `RiskActionExecuted` — an autonomous bounded action was applied on-chain. */
export interface RiskActionExecutedEvent extends IndexedEventBase {
  kind: 'RiskActionExecuted';
  policyId: string;
  marketId: string;
  actionType: number;
  riskScore: number;
  oldValue: string;
  newValue: string;
  evidenceBlobId: string;
  evidenceHash: string;
}

/** `RiskActionOverridden` — the DAO reversed/overrode a prior action. */
export interface RiskActionOverriddenEvent extends IndexedEventBase {
  kind: 'RiskActionOverridden';
  policyId: string;
  originalActionId: string;
  daoAddress: string;
  reason: string;
}

/** `GuardianRevoked` — a guardian capability was revoked. */
export interface GuardianRevokedEvent extends IndexedEventBase {
  kind: 'GuardianRevoked';
  policyId: string;
  guardianCapId: string;
  daoAddress: string;
}

/** `PolicyUpdated` — policy thresholds/configuration changed. */
export interface PolicyUpdatedEvent extends IndexedEventBase {
  kind: 'PolicyUpdated';
  policyId: string;
  version: number;
}

/** Any event whose type suffix is not one of the four known events. */
export interface UnknownEvent extends IndexedEventBase {
  kind: 'Unknown';
  type: string;
}

export type IndexedEvent =
  | RiskActionExecutedEvent
  | RiskActionOverriddenEvent
  | GuardianRevokedEvent
  | PolicyUpdatedEvent
  | UnknownEvent;

// ---------------------------------------------------------------------------
// Action-type code → canonical name mapping (mirrors `sentinel_adapters`).
// ---------------------------------------------------------------------------

/**
 * Canonical action-type names keyed by the on-chain `ACTION_*` u8 codes
 * defined in `sentinel_adapters`. Ordered so `pause_new_borrows` is code 0
 * (priority-zero emergency action). (Req 7.1, 7.10)
 */
export const ACTION_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'pause_new_borrows',
  1: 'unpause_borrows',
  2: 'reduce_max_ltv',
  3: 'restore_max_ltv',
  4: 'enter_guarded_mode',
  5: 'exit_guarded_mode',
  6: 'increase_maintenance_margin',
};

/** Map an on-chain action-type code to its canonical name (falls back to the code). */
export function actionTypeName(code: number): string {
  return ACTION_TYPE_NAMES[code] ?? `action_${code}`;
}
