/**
 * Repository for the `policies` table (off-chain mirror of the on-chain
 * RiskPolicy config). All queries are parameterized. (Requirement 15.3)
 */

import type { Queryable } from '../pool.js';
import { buildInsert, requireRow } from '../sql.js';
import type { Json, PolicyInsert, PolicyRow } from '../types.js';

export class PoliciesRepository {
  constructor(private readonly db: Queryable) {}

  /** Insert a new policy and return the persisted row. */
  async create(input: PolicyInsert): Promise<PolicyRow> {
    const { text, values } = buildInsert('policies', {
      id: input.id,
      market_id: input.market_id,
      on_chain_policy_id: input.on_chain_policy_id,
      guardian_cap_id: input.guardian_cap_id,
      override_cap_id: input.override_cap_id,
      owner_address: input.owner_address,
      dao_address: input.dao_address,
      allowed_actions: input.allowed_actions,
      max_ltv_delta_bps: input.max_ltv_delta_bps,
      max_margin_delta_bps: input.max_margin_delta_bps,
      pause_duration_limit_ms: input.pause_duration_limit_ms,
      cooldown_ms: input.cooldown_ms,
      risk_thresholds: input.risk_thresholds,
      is_revoked: input.is_revoked,
      is_paused: input.is_paused,
      version: input.version,
      walrus_config_blob_id: input.walrus_config_blob_id,
    });
    const res = await this.db.query<PolicyRow>(text, values);
    return requireRow(res.rows, 'policies.create');
  }

  /** Fetch a policy by primary key, or `null`. */
  async getById(id: string): Promise<PolicyRow | null> {
    const res = await this.db.query<PolicyRow>(
      'SELECT * FROM policies WHERE id = $1',
      [id],
    );
    return res.rows[0] ?? null;
  }

  /** Fetch a policy by its on-chain policy object id, or `null`. */
  async getByOnChainPolicyId(onChainPolicyId: string): Promise<PolicyRow | null> {
    const res = await this.db.query<PolicyRow>(
      'SELECT * FROM policies WHERE on_chain_policy_id = $1',
      [onChainPolicyId],
    );
    return res.rows[0] ?? null;
  }

  /** List the policies attached to a market, newest first. */
  async listByMarketId(marketId: string): Promise<PolicyRow[]> {
    const res = await this.db.query<PolicyRow>(
      'SELECT * FROM policies WHERE market_id = $1 ORDER BY created_at DESC',
      [marketId],
    );
    return res.rows;
  }

  /**
   * List policies owned by a wallet address (used by API-gateway role
   * resolution to recognise a Protocol_Admin), newest first. (Req 15.1)
   */
  async listByOwnerAddress(ownerAddress: string): Promise<PolicyRow[]> {
    const res = await this.db.query<PolicyRow>(
      'SELECT * FROM policies WHERE owner_address = $1 ORDER BY created_at DESC',
      [ownerAddress],
    );
    return res.rows;
  }

  /**
   * List policies whose DAO override address is the given wallet (the holder of
   * the OverrideCap — used by role resolution to recognise a DAO_Governor),
   * newest first. (Req 15.1)
   */
  async listByDaoAddress(daoAddress: string): Promise<PolicyRow[]> {
    const res = await this.db.query<PolicyRow>(
      'SELECT * FROM policies WHERE dao_address = $1 ORDER BY created_at DESC',
      [daoAddress],
    );
    return res.rows;
  }

  /** Flip the revoked flag and return the updated row (or `null`). */
  async setRevoked(id: string, isRevoked: boolean): Promise<PolicyRow | null> {
    const res = await this.db.query<PolicyRow>(
      'UPDATE policies SET is_revoked = $1 WHERE id = $2 RETURNING *',
      [isRevoked, id],
    );
    return res.rows[0] ?? null;
  }

  /** Flip the paused flag and return the updated row (or `null`). */
  async setPaused(id: string, isPaused: boolean): Promise<PolicyRow | null> {
    const res = await this.db.query<PolicyRow>(
      'UPDATE policies SET is_paused = $1 WHERE id = $2 RETURNING *',
      [isPaused, id],
    );
    return res.rows[0] ?? null;
  }

  /**
   * Replace the risk thresholds and bump the version atomically; returns the
   * updated row (or `null`). Used when the DAO updates policy thresholds.
   */
  async updateThresholds(
    id: string,
    riskThresholds: Json,
    version: number,
  ): Promise<PolicyRow | null> {
    const res = await this.db.query<PolicyRow>(
      'UPDATE policies SET risk_thresholds = $1, version = $2 WHERE id = $3 RETURNING *',
      [riskThresholds, version, id],
    );
    return res.rows[0] ?? null;
  }
}
