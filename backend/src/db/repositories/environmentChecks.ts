/**
 * Repository for the `environment_checks` table (network enforcement audit
 * trail). All queries are parameterized. (Requirement 15.3)
 *
 * Records are append-only: the Network Guard writes one row per verification
 * with an ISO 8601 UTC timestamp (the column default), the check type, and a
 * pass/fail outcome.
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type {
  EnvCheckType,
  EnvironmentCheckInsert,
  EnvironmentCheckRow,
} from '../types.js';

export class EnvironmentChecksRepository {
  constructor(private readonly db: Queryable) {}

  /** Append a new environment-check record and return the persisted row. */
  async append(input: EnvironmentCheckInsert): Promise<EnvironmentCheckRow> {
    const { text, values } = buildInsert('environment_checks', {
      id: input.id,
      check_type: input.check_type,
      outcome: input.outcome,
      detail: input.detail,
    });
    const res = await this.db.query<EnvironmentCheckRow>(text, values);
    return requireRow(res.rows, 'environmentChecks.append');
  }

  /** List checks of a given type, newest first, capped by `limit`. */
  async listByType(checkType: EnvCheckType, limit = 100): Promise<EnvironmentCheckRow[]> {
    const res = await this.db.query<EnvironmentCheckRow>(
      'SELECT * FROM environment_checks WHERE check_type = $1 ORDER BY checked_at DESC LIMIT $2',
      [checkType, limit],
    );
    return res.rows;
  }

  /** Return the most recent check of a given type, or `null`. */
  async latestByType(checkType: EnvCheckType): Promise<EnvironmentCheckRow | null> {
    const res = await this.db.query<EnvironmentCheckRow>(
      'SELECT * FROM environment_checks WHERE check_type = $1 ORDER BY checked_at DESC LIMIT 1',
      [checkType],
    );
    return res.rows[0] ?? null;
  }
}
