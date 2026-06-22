/**
 * Repository for the `markets` table (monitored market registry). All queries
 * are parameterized. (Requirement 15.3)
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type { MarketInsert, MarketRow, MarketStatus } from '../types.js';

export class MarketsRepository {
  constructor(private readonly db: Queryable) {}

  /** Insert a new market and return the persisted row. */
  async create(input: MarketInsert): Promise<MarketRow> {
    const { text, values } = buildInsert('markets', {
      id: input.id,
      on_chain_id: input.on_chain_id,
      market_type: input.market_type,
      name: input.name,
      status: input.status,
      freshness_threshold_ms: input.freshness_threshold_ms,
    });
    const res = await this.db.query<MarketRow>(text, values);
    return requireRow(res.rows, 'markets.create');
  }

  /** Fetch a market by primary key, or `null` if absent. */
  async getById(id: string): Promise<MarketRow | null> {
    const res = await this.db.query<MarketRow>(
      'SELECT * FROM markets WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** Fetch a market by its on-chain object id, or `null` if absent. */
  async getByOnChainId(onChainId: string): Promise<MarketRow | null> {
    const res = await this.db.query<MarketRow>(
      'SELECT * FROM markets WHERE on_chain_id = $1',
      [onChainId],
    );
    return res.rows[0] ?? null;
  }

  /** List all markets, newest first. */
  async list(): Promise<MarketRow[]> {
    const res = await this.db.query<MarketRow>(
      'SELECT * FROM markets ORDER BY created_at DESC',
    );
    return res.rows;
  }

  /** Update a market's status and return the updated row (or `null`). */
  async updateStatus(id: string, status: MarketStatus): Promise<MarketRow | null> {
    const res = await this.db.query<MarketRow>(
      'UPDATE markets SET status = $1 WHERE id = $2 RETURNING *',
      [status, id],
    );
    return res.rows[0] ?? null;
  }
}
