/**
 * Repository for the `actions` table (executed/reversed actions, an off-chain
 * mirror of the on-chain ActionLog). All queries are parameterized.
 * (Requirement 15.3)
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type { ActionInsert, ActionRow } from '../types.js';

export class ActionsRepository {
  constructor(private readonly db: Queryable) {}

  /** Insert a new action record and return the persisted row. */
  async create(input: ActionInsert): Promise<ActionRow> {
    const { text, values } = buildInsert('actions', {
      id: input.id,
      policy_id: input.policy_id,
      market_id: input.market_id,
      incident_id: input.incident_id,
      actor: input.actor,
      actor_type: input.actor_type,
      risk_score: input.risk_score,
      action_type: input.action_type,
      old_value: input.old_value,
      new_value: input.new_value,
      walrus_evidence_blob_id: input.walrus_evidence_blob_id,
      evidence_hash: input.evidence_hash,
      tx_digest: input.tx_digest,
      is_reversed: input.is_reversed,
      reversed_by: input.reversed_by,
      reversal_tx_digest: input.reversal_tx_digest,
      override_reason: input.override_reason,
      timestamp_ms: input.timestamp_ms,
    });
    const res = await this.db.query<ActionRow>(text, values);
    return requireRow(res.rows, 'actions.create');
  }

  /** Fetch an action by primary key, or `null`. */
  async getById(id: string): Promise<ActionRow | null> {
    const res = await this.db.query<ActionRow>(
      'SELECT * FROM actions WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Fetch an action by its on-chain transaction digest, or `null`. */
  async getByTxDigest(txDigest: string): Promise<ActionRow | null> {
    const res = await this.db.query<ActionRow>(
      'SELECT * FROM actions WHERE tx_digest = $1',
      [txDigest],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Attach the on-chain execution result (tx digest + Walrus evidence
   * references) to a previously-created pending action row. Returns the updated
   * row, or `null` if no such action exists.
   */
  async attachExecutionResult(
    id: string,
    result: {
      txDigest: string | null;
      walrusEvidenceBlobId: string | null;
      evidenceHash: string | null;
    },
  ): Promise<ActionRow | null> {
    const res = await this.db.query<ActionRow>(
      `UPDATE actions
         SET tx_digest = $1,
             walrus_evidence_blob_id = $2,
             evidence_hash = $3
       WHERE id = $4
       RETURNING *`,
      [result.txDigest, result.walrusEvidenceBlobId, result.evidenceHash, id],
    );
    return res.rows[0] ?? null;
  }

  /** List actions for a market, newest first. */
  async listByMarket(marketId: string): Promise<ActionRow[]> {
    const res = await this.db.query<ActionRow>(
      'SELECT * FROM actions WHERE market_id = $1 ORDER BY timestamp_ms DESC',
      [marketId],
    );
    return res.rows;
  }

  /** List actions executed under a policy, newest first. */
  async listByPolicy(policyId: string): Promise<ActionRow[]> {
    const res = await this.db.query<ActionRow>(
      'SELECT * FROM actions WHERE policy_id = $1 ORDER BY timestamp_ms DESC',
      [policyId],
    );
    return res.rows;
  }

  /** List actions belonging to an incident, oldest first (timeline order). */
  async listByIncident(incidentId: string): Promise<ActionRow[]> {
    const res = await this.db.query<ActionRow>(
      'SELECT * FROM actions WHERE incident_id = $1 ORDER BY timestamp_ms ASC',
      [incidentId],
    );
    return res.rows;
  }

  /**
   * Mark an action reversed, recording who reversed it and the reversal tx
   * digest. Returns the updated row (or `null`).
   */
  async markReversed(
    id: string,
    reversedBy: string,
    reversalTxDigest: string,
  ): Promise<ActionRow | null> {
    const res = await this.db.query<ActionRow>(
      'UPDATE actions SET is_reversed = true, reversed_by = $1, reversal_tx_digest = $2 WHERE id = $3 RETURNING *',
      [reversedBy, reversalTxDigest, id],
    );
    return res.rows[0] ?? null;
  }
}
