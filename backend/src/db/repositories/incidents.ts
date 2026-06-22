/**
 * Repository for the `incidents` table (grouped timelines). All queries are
 * parameterized. (Requirement 15.3)
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type { IncidentInsert, IncidentRow } from '../types.js';

export class IncidentsRepository {
  constructor(private readonly db: Queryable) {}

  /** Insert a new incident and return the persisted row. */
  async create(input: IncidentInsert): Promise<IncidentRow> {
    const { text, values } = buildInsert('incidents', {
      id: input.id,
      market_id: input.market_id,
      started_at: input.started_at,
      ended_at: input.ended_at,
      scenario_id: input.scenario_id,
      is_simulated: input.is_simulated,
      summary: input.summary,
    });
    const res = await this.db.query<IncidentRow>(text, values);
    return requireRow(res.rows, 'incidents.create');
  }

  /** Fetch an incident by primary key, or `null`. */
  async getById(id: string): Promise<IncidentRow | null> {
    const res = await this.db.query<IncidentRow>(
      'SELECT * FROM incidents WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** List incidents for a market, newest first. */
  async listByMarket(marketId: string): Promise<IncidentRow[]> {
    const res = await this.db.query<IncidentRow>(
      'SELECT * FROM incidents WHERE market_id = $1 ORDER BY started_at DESC',
      [marketId],
    );
    return res.rows;
  }

  /** List incidents that are still open (no `ended_at`), oldest first. */
  async listOpen(marketId: string): Promise<IncidentRow[]> {
    const res = await this.db.query<IncidentRow>(
      'SELECT * FROM incidents WHERE market_id = $1 AND ended_at IS NULL ORDER BY started_at ASC',
      [marketId],
    );
    return res.rows;
  }

  /** Close an incident by setting `ended_at` (and optional summary). */
  async close(
    id: string,
    endedAt: Date | string,
    summary?: string | null,
  ): Promise<IncidentRow | null> {
    const res = await this.db.query<IncidentRow>(
      'UPDATE incidents SET ended_at = $1, summary = COALESCE($2, summary) WHERE id = $3 RETURNING *',
      [endedAt, summary ?? null, id],
    );
    return res.rows[0] ?? null;
  }
}
