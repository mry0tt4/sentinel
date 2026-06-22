/**
 * Repository layer barrel + factory.
 *
 * Each repository wraps the narrow {@link Queryable} interface so it can run
 * against the shared `pg.Pool` in production or an in-memory fake in tests.
 * {@link createRepositories} bundles all seven table repositories behind a
 * single object sharing one `Queryable`. (Requirement 15.3)
 */

import { getPool, type Queryable } from '../pool.js';

import { ActionsRepository } from './actions.js';
import { EnvironmentChecksRepository } from './environmentChecks.js';
import { IncidentsRepository } from './incidents.js';
import { MarketsRepository } from './markets.js';
import { PoliciesRepository } from './policies.js';
import { RiskSnapshotsRepository } from './riskSnapshots.js';
import { WalrusBlobsRepository } from './walrusBlobs.js';

export { ActionsRepository } from './actions.js';
export { EnvironmentChecksRepository } from './environmentChecks.js';
export { IncidentsRepository } from './incidents.js';
export { MarketsRepository } from './markets.js';
export { PoliciesRepository } from './policies.js';
export { RiskSnapshotsRepository } from './riskSnapshots.js';
export { WalrusBlobsRepository } from './walrusBlobs.js';

/** Bundle of every table repository, all sharing one query surface. */
export interface Repositories {
  markets: MarketsRepository;
  policies: PoliciesRepository;
  riskSnapshots: RiskSnapshotsRepository;
  incidents: IncidentsRepository;
  actions: ActionsRepository;
  walrusBlobs: WalrusBlobsRepository;
  environmentChecks: EnvironmentChecksRepository;
}

/**
 * Construct the repository bundle over a given query surface. Defaults to the
 * process-wide connection pool; pass a fake `Queryable` in tests.
 */
export function createRepositories(db: Queryable = getPool()): Repositories {
  return {
    markets: new MarketsRepository(db),
    policies: new PoliciesRepository(db),
    riskSnapshots: new RiskSnapshotsRepository(db),
    incidents: new IncidentsRepository(db),
    actions: new ActionsRepository(db),
    walrusBlobs: new WalrusBlobsRepository(db),
    environmentChecks: new EnvironmentChecksRepository(db),
  };
}
