/**
 * Repository for the `risk_snapshots` table (time-series of evaluations). All
 * queries are parameterized. (Requirement 15.3)
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type { RiskSnapshotInsert, RiskSnapshotRow } from '../types.js';

export class RiskSnapshotsRepository {
  constructor(private readonly db: Queryable) {}

  /** Insert a new risk snapshot and return the persisted row. */
  async create(input: RiskSnapshotInsert): Promise<RiskSnapshotRow> {
    const { text, values } = buildInsert('risk_snapshots', {
      id: input.id,
      market_id: input.market_id,
      risk_score: input.risk_score,
      band: input.band,
      classes: input.classes,
      confidence: input.confidence,
      feature_vector: input.feature_vector,
      rule_outputs: input.rule_outputs,
      recommended_action: input.recommended_action,
      refusal_reason: input.refusal_reason,
      model_version: input.model_version,
      prompt_config_version: input.prompt_config_version,
      explanation: input.explanation,
      is_simulated: input.is_simulated,
      data_source: input.data_source,
    });
    const res = await this.db.query<RiskSnapshotRow>(text, values);
    return requireRow(res.rows, 'riskSnapshots.create');
  }

  /** Fetch a snapshot by primary key, or `null`. */
  async getById(id: string): Promise<RiskSnapshotRow | null> {
    const res = await this.db.query<RiskSnapshotRow>(
      'SELECT * FROM risk_snapshots WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  /**
   * List snapshots for a market, newest first, capped by `limit` (default 100).
   * Uses the `(market_id, created_at DESC)` index.
   */
  async listByMarket(marketId: string, limit = 100): Promise<RiskSnapshotRow[]> {
    const res = await this.db.query<RiskSnapshotRow>(
      'SELECT * FROM risk_snapshots WHERE market_id = $1 ORDER BY created_at DESC LIMIT $2',
      [marketId, limit],
    );
    return res.rows;
  }

  /** Return the most recent snapshot for a market, or `null` if none exist. */
  async getLatestByMarket(marketId: string): Promise<RiskSnapshotRow | null> {
    const res = await this.db.query<RiskSnapshotRow>(
      'SELECT * FROM risk_snapshots WHERE market_id = $1 ORDER BY created_at DESC LIMIT 1',
      [marketId],
    );
    return res.rows[0] ?? null;
  }
}
