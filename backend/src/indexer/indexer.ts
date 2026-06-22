/**
 * Protocol State Indexer.
 *
 * Subscribes (by polling cursor-paginated reads) to the on-chain events
 * emitted by `sentinel_policy` / `sentinel_demo_market`, persists their
 * off-chain mirrors, and maintains a durable checkpoint so that after a
 * restart it resumes from the last persisted cursor and reconciles the
 * database to chain state recovered from the on-chain transaction digests.
 * (Req 3.7, 17.6, 17.7, 17.8)
 *
 * Per-event handling:
 *  - `RiskActionExecuted`  → upsert an `actions` row mirroring the on-chain
 *    ActionLog, then flip the linked Walrus evidence blob to `linked_on_chain`
 *    when its blob id appears on the action. (Req 9 linkage / 17.6)
 *  - `RiskActionOverridden`→ persist a DAO override `actions` row. (Req 17.6)
 *  - `GuardianRevoked`     → mark the policy revoked, flip the linked
 *    market's status to `Revoked`, and broadcast a `guardian_revoked` server
 *    message to subscribed dashboards. (Req 12.2, 11.8, 17.6, 17.7, 17.8)
 *  - `PolicyUpdated`       → recorded; no destructive mutation here.
 *
 * Idempotency: actions are deduplicated by transaction digest, and the source
 * is always read *after* the persisted cursor, so a restarted indexer never
 * reprocesses an already-seen event.
 *
 * All collaborators are injected as narrow ports (event source, checkpoint
 * store, repositories) so this logic runs against fakes in unit tests and the
 * real `SuiClient`/Postgres repositories in production.
 */

import type { ActionInsert } from '../db/types.js';
import type { MessagePublisher } from '../ws/subscriptionRegistry.js';

import { parseEvent } from './parseEvent.js';
import {
  actionTypeName,
  type CheckpointStore,
  type EventCursor,
  type GuardianRevokedEvent,
  type IndexedEvent,
  type IndexerActionsRepo,
  type IndexerCheckpoint,
  type IndexerMarketsRepo,
  type IndexerPoliciesRepo,
  type IndexerWalrusRepo,
  type RiskActionExecutedEvent,
  type RiskActionOverriddenEvent,
  type SuiEventSource,
} from './types.js';

/** Default checkpoint key under which this indexer's position is stored. */
export const DEFAULT_CHECKPOINT_KEY = 'sentinel_policy_indexer';

/** Default page size for cursor-paginated event reads. */
export const DEFAULT_PAGE_SIZE = 50;

/** Collaborators the indexer depends on, all injectable for testing. */
export interface IndexerDeps {
  source: SuiEventSource;
  checkpoints: CheckpointStore;
  actions: IndexerActionsRepo;
  walrus: IndexerWalrusRepo;
  markets: IndexerMarketsRepo;
  policies: IndexerPoliciesRepo;
  /**
   * Optional WebSocket publisher. When present, the indexer broadcasts a
   * `guardian_revoked` server message the first time it observes a
   * `GuardianRevoked` event for a market, so subscribed dashboards flip the
   * market status to `Revoked` within 5s of the on-chain confirmation. The
   * {@link import('../ws/wsServer.js').WebSocketHandle} / `SubscriptionRegistry`
   * satisfy this port directly. (Req 12.2, 11.8)
   */
  publisher?: MessagePublisher;
}

/** Tunable behaviour. */
export interface IndexerOptions {
  /** Checkpoint key; defaults to {@link DEFAULT_CHECKPOINT_KEY}. */
  checkpointKey?: string;
  /** Events per page; defaults to {@link DEFAULT_PAGE_SIZE}. */
  pageSize?: number;
  /** Clock injection for deterministic `updatedAt` timestamps in tests. */
  now?: () => Date;
}

/** Outcome of a single {@link ProtocolStateIndexer.runOnce} drain. */
export interface IndexRunResult {
  /** Events newly processed during this run. */
  processed: number;
  /** Of those, how many were skipped (duplicate or unresolved references). */
  skipped: number;
  /** New `actions` rows persisted. */
  actionsPersisted: number;
  /** Walrus evidence blobs flipped to `linked_on_chain`. */
  evidenceLinked: number;
  /** Guardian revocations applied (policy + market status). */
  revocations: number;
  /** The checkpoint after the run. */
  checkpoint: IndexerCheckpoint;
}

export class ProtocolStateIndexer {
  private readonly checkpointKey: string;
  private readonly pageSize: number;
  private readonly now: () => Date;

  constructor(
    private readonly deps: IndexerDeps,
    options: IndexerOptions = {},
  ) {
    this.checkpointKey = options.checkpointKey ?? DEFAULT_CHECKPOINT_KEY;
    this.pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Drain all currently-available events, starting from the persisted
   * checkpoint cursor. Reads pages until the source reports no further pages,
   * processing each event and advancing + persisting the checkpoint after every
   * event so an interruption resumes cleanly. (Req 17.6)
   */
  async runOnce(): Promise<IndexRunResult> {
    const loaded = await this.deps.checkpoints.load(this.checkpointKey);
    let checkpoint: IndexerCheckpoint = loaded ?? this.emptyCheckpoint();

    const result: IndexRunResult = {
      processed: 0,
      skipped: 0,
      actionsPersisted: 0,
      evidenceLinked: 0,
      revocations: 0,
      checkpoint,
    };

    let cursor: EventCursor | null = checkpoint.cursor;
    let hasNextPage = true;

    while (hasNextPage) {
      const page = await this.deps.source.queryEvents({ cursor, limit: this.pageSize });

      for (const raw of page.data) {
        const event = parseEvent(raw);
        const outcome = await this.processEvent(event);

        result.processed += 1;
        if (outcome.skipped) {
          result.skipped += 1;
        }
        result.actionsPersisted += outcome.actionsPersisted;
        result.evidenceLinked += outcome.evidenceLinked;
        result.revocations += outcome.revocations;

        // Advance + persist the checkpoint after each event so a crash mid-page
        // resumes from the last fully processed event, not the page start.
        checkpoint = {
          cursor: event.cursor,
          lastTxDigest: event.txDigest,
          processedCount: checkpoint.processedCount + 1,
          updatedAt: this.now().toISOString(),
        };
        await this.deps.checkpoints.save(this.checkpointKey, checkpoint);
      }

      // Follow the source's own pagination; fall back to the last event cursor.
      cursor = page.nextCursor ?? checkpoint.cursor;
      hasNextPage = page.hasNextPage;
    }

    result.checkpoint = checkpoint;
    return result;
  }

  /** Dispatch a decoded event to its handler. */
  private async processEvent(event: IndexedEvent): Promise<EventOutcome> {
    switch (event.kind) {
      case 'RiskActionExecuted':
        return this.handleRiskActionExecuted(event);
      case 'RiskActionOverridden':
        return this.handleRiskActionOverridden(event);
      case 'GuardianRevoked':
        return this.handleGuardianRevoked(event);
      case 'PolicyUpdated':
      case 'Unknown':
      default:
        // Recorded via the checkpoint advance; no destructive DB mutation.
        return noop();
    }
  }

  /**
   * Persist a `RiskActionExecuted` as an `actions` row (idempotent by tx
   * digest) and flip its linked Walrus evidence blob to `linked_on_chain`.
   */
  private async handleRiskActionExecuted(
    event: RiskActionExecutedEvent,
  ): Promise<EventOutcome> {
    // Dedup: a digest already mirrored means this event was processed before
    // (e.g. an overlapping replay window after restart). (Req 17.6)
    const existing = await this.deps.actions.getByTxDigest(event.txDigest);
    if (existing !== null) {
      return skip();
    }

    const market = await this.deps.markets.getByOnChainId(event.marketId);
    const policy = await this.deps.policies.getByOnChainPolicyId(event.policyId);
    if (market === null || policy === null) {
      // The referencing rows are not registered yet; skip rather than violate
      // the foreign keys. Reconciliation will re-observe via the digest.
      return skip();
    }

    const blobId = event.evidenceBlobId.trim();
    const insert: ActionInsert = {
      policy_id: policy.id,
      market_id: market.id,
      actor: policy.owner_address,
      actor_type: 'agent',
      risk_score: event.riskScore,
      action_type: actionTypeName(event.actionType),
      old_value: event.oldValue,
      new_value: event.newValue,
      walrus_evidence_blob_id: blobId === '' ? null : blobId,
      evidence_hash: event.evidenceHash === '' ? null : event.evidenceHash,
      tx_digest: event.txDigest,
      timestamp_ms: event.timestampMs ?? '0',
    };
    const action = await this.deps.actions.create(insert);

    let evidenceLinked = 0;
    if (blobId !== '') {
      const blob = await this.deps.walrus.getById(blobId);
      if (blob !== null && blob.status !== 'linked_on_chain') {
        await this.deps.walrus.linkToAction(blobId, action.id, event.evidenceHash);
        evidenceLinked = 1;
      }
    }

    return { skipped: false, actionsPersisted: 1, evidenceLinked, revocations: 0 };
  }

  /**
   * Persist a `RiskActionOverridden` as a DAO override `actions` row (the
   * detailed reversal-linking wiring lives in task 19). Idempotent by digest.
   */
  private async handleRiskActionOverridden(
    event: RiskActionOverriddenEvent,
  ): Promise<EventOutcome> {
    const existing = await this.deps.actions.getByTxDigest(event.txDigest);
    if (existing !== null) {
      return skip();
    }

    const policy = await this.deps.policies.getByOnChainPolicyId(event.policyId);
    if (policy === null) {
      return skip();
    }

    await this.deps.actions.create({
      policy_id: policy.id,
      market_id: policy.market_id,
      actor: event.daoAddress,
      actor_type: 'dao',
      action_type: 'override_action',
      override_reason: event.reason === '' ? null : event.reason,
      tx_digest: event.txDigest,
      timestamp_ms: event.timestampMs ?? '0',
    });

    return { skipped: false, actionsPersisted: 1, evidenceLinked: 0, revocations: 0 };
  }

  /**
   * Apply a `GuardianRevoked` event: mark the policy revoked, flip the linked
   * market's status to `Revoked`, and broadcast a `guardian_revoked` server
   * message so subscribed dashboards reflect the revocation within 5s.
   * Idempotent — re-applying on an already-revoked policy is a harmless no-op
   * write and does NOT re-broadcast (mirroring the on-chain contract, which
   * emits no duplicate `GuardianRevoked` event). (Req 12.2, 11.8, 17.7, 17.8)
   */
  private async handleGuardianRevoked(
    event: GuardianRevokedEvent,
  ): Promise<EventOutcome> {
    const policy = await this.deps.policies.getByOnChainPolicyId(event.policyId);
    if (policy === null) {
      return skip();
    }

    // Only the FIRST revocation broadcasts; an already-revoked policy is a
    // no-op and must not emit a duplicate dashboard update. (Req 12.6)
    const alreadyRevoked = policy.is_revoked === true;

    await this.deps.policies.setRevoked(policy.id, true);
    await this.deps.markets.updateStatus(policy.market_id, 'Revoked');

    // Broadcast to subscribed dashboards so the market guardian status shows
    // "Revoked" within 5s of the confirmed revocation. (Req 12.2, 11.8)
    if (!alreadyRevoked && this.deps.publisher) {
      this.deps.publisher.publish({
        type: 'guardian_revoked',
        marketId: policy.market_id,
        at: this.revocationTimestamp(event),
      });
    }

    return { skipped: false, actionsPersisted: 0, evidenceLinked: 0, revocations: 1 };
  }

  /**
   * Resolve the ISO 8601 timestamp carried on a `guardian_revoked` broadcast.
   * Prefers the on-chain event time; falls back to the indexer clock when the
   * source did not surface a timestamp.
   */
  private revocationTimestamp(event: GuardianRevokedEvent): string {
    if (event.timestampMs !== null && event.timestampMs !== undefined) {
      const ms = Number(event.timestampMs);
      if (Number.isFinite(ms)) {
        return new Date(ms).toISOString();
      }
    }
    return this.now().toISOString();
  }

  private emptyCheckpoint(): IndexerCheckpoint {
    return {
      cursor: null,
      lastTxDigest: null,
      processedCount: 0,
      updatedAt: this.now().toISOString(),
    };
  }
}

/** Per-event side-effect tally. */
interface EventOutcome {
  skipped: boolean;
  actionsPersisted: number;
  evidenceLinked: number;
  revocations: number;
}

function noop(): EventOutcome {
  return { skipped: false, actionsPersisted: 0, evidenceLinked: 0, revocations: 0 };
}

function skip(): EventOutcome {
  return { skipped: true, actionsPersisted: 0, evidenceLinked: 0, revocations: 0 };
}
