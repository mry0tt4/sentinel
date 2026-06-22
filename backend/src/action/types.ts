/**
 * Action Executor — shared types for server-defined PTB templates.
 *
 * Sentinel's on-chain authority model requires that every autonomous action is
 * composed from a **fixed, server-defined template** — never from arbitrary
 * transaction structure supplied by a caller. (Req 16.4)
 *
 * The {@link BoundedActionRequest} below is deliberately *structured*: it
 * carries only the typed, server-controlled fields the
 * `sentinel_policy::policy::execute_guardian_action` template needs (object
 * ids, an enumerated action type, bounded numeric parameters, evidence
 * references) plus an optional, equally-structured price-feed update. There is
 * **no** field that accepts a raw PTB, a serialized transaction, an arbitrary
 * Move-call target, or a command list. The type system therefore makes it
 * impossible to inject arbitrary transaction structure, and a runtime guard
 * (see {@link assertValidActionRequest}) rejects malformed requests and any
 * attempt to smuggle raw transaction structure through extra properties.
 */

/**
 * Action-type codes, mirroring `sentinel_adapters::adapters` `ACTION_*`
 * constants. These are the *only* action types the server-defined template
 * will ever compose; an action type outside this set is rejected before any
 * PTB is built. (Req 7.1, 7.2, 16.4)
 */
export const ACTION_TYPE = {
  /** Pause new borrows — priority-zero emergency action. */
  PAUSE_BORROWS: 0,
  /** Unpause borrows — restore borrowing. */
  UNPAUSE_BORROWS: 1,
  /** Reduce the market's max LTV (bounded by `max_ltv_delta_bps`). */
  REDUCE_LTV: 2,
  /** Restore a previously reduced max LTV. */
  RESTORE_LTV: 3,
  /** Enter guarded mode. */
  ENTER_GUARDED: 4,
  /** Exit guarded mode. */
  EXIT_GUARDED: 5,
  /** Increase the maintenance margin (bounded by `max_margin_delta_bps`). */
  INCREASE_MARGIN: 6,
} as const;

export type ActionTypeName = keyof typeof ACTION_TYPE;
export type ActionTypeCode = (typeof ACTION_TYPE)[ActionTypeName];

/** Every valid on-chain action-type code, for membership checks. */
export const VALID_ACTION_TYPE_CODES: readonly ActionTypeCode[] = Object.freeze(
  Object.values(ACTION_TYPE) as ActionTypeCode[],
);

/** Bytes accepted for `vector<u8>` arguments: raw bytes or a byte-number list. */
export type ByteInput = Uint8Array | readonly number[];

/**
 * Structured, server-controlled descriptor for an optional Pyth price-feed
 * refresh that precedes the guardian action in the same PTB. (Req 9.3)
 *
 * Like {@link BoundedActionRequest}, this carries only data the fixed template
 * needs — the price-info object to refresh and the server-fetched price-update
 * bytes. The Move-call target itself comes from server configuration (see
 * {@link ActionExecutorConfig.pyth}), never from the caller.
 */
export interface PriceFeedUpdate {
  /** Object id of the Pyth `PriceInfoObject` whose feed is being refreshed. */
  priceInfoObjectId: string;
  /** Server-fetched price-update (VAA) bytes passed to the update call. */
  priceUpdateData: ByteInput;
}

/**
 * The complete, structured input to {@link ActionExecutor.buildActionPtb}.
 *
 * STRUCTURED, server-controlled fields only — there is intentionally no field
 * for a raw PTB / arbitrary Move call. (Req 16.4)
 */
export interface BoundedActionRequest {
  /** Object id of the on-chain `RiskPolicy`. */
  policyObjectId: string;
  /** Object id of the agent's `GuardianCap`. */
  guardianCapObjectId: string;
  /** Object id of the target `MarketState`. */
  marketStateObjectId: string;
  /** Enumerated action type — must be one of {@link VALID_ACTION_TYPE_CODES}. */
  actionType: ActionTypeCode;
  /** New parameter value for value-setting actions (e.g. new max-LTV bps). */
  newParamValue: bigint | number;
  /** Requested pause duration (ms) for the pause-borrows action. */
  pauseDurationMs: bigint | number;
  /** Risk score recorded on the action (0..100, encoded on-chain as u8). */
  riskScore: number;
  /** Walrus evidence Blob_ID (UTF-8 encoded into the on-chain `vector<u8>`). */
  evidenceBlobId: string;
  /** Evidence hash bytes. */
  evidenceHash: ByteInput;
  /** Optional tx-digest bytes placeholder (empty by default; on-chain records). */
  txDigest?: ByteInput;
  /** Clock object id (defaults to the framework `0x6` clock). */
  clockObjectId?: string;
  /** Optional, structured price-feed refresh composed before the action. */
  priceFeedUpdate?: PriceFeedUpdate;
}

/**
 * Reserved property names that would indicate an attempt to smuggle raw
 * transaction structure through a request object. Their presence causes
 * {@link assertValidActionRequest} to reject the request outright. (Req 16.4)
 */
export const FORBIDDEN_REQUEST_KEYS: readonly string[] = Object.freeze([
  'transaction',
  'transactionBlock',
  'txBytes',
  'transactionBytes',
  'moveCall',
  'moveCalls',
  'commands',
  'command',
  'kind',
  'data',
  'serialized',
  'ptb',
  'rawPtb',
]);

/** Result of a dry-run simulation, normalized across client implementations. */
export interface SimulationResult {
  /** True when the dry-run reported `effects.status.status === 'success'`. */
  success: boolean;
  /** Failure detail when `success` is false (e.g. the on-chain abort string). */
  error?: string;
  /** Events the dry-run would emit, when available. */
  events?: unknown[];
}

/** Outcome of {@link ActionExecutor.submit} / {@link ActionExecutor.execute}. */
export interface SubmitResult {
  txDigest: string;
  events: unknown[];
}

/** Raised when a request is malformed or attempts to inject arbitrary PTB structure. */
export class ActionTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionTemplateError';
  }
}

// ===========================================================================
// DAO Override operations (Override_Console) — server-defined templates.
//
// Unlike {@link BoundedActionRequest} (agent-authorized via GuardianCap), these
// are privileged human interventions authorized by an OverrideCap (DAO). Each
// is composed from a fixed template targeting `sentinel_policy::policy::<fn>`;
// there is, as with the agent path, NO field that accepts raw transaction
// structure. (Req 11.4, 11.5, 11.6, 12.1, 16.4)
// ===========================================================================

/**
 * The DAO override operations the Override_Console wires to on-chain. Each maps
 * to an equally-named `sentinel_policy::policy` function. (Req 11.4, 12.1)
 */
export const OVERRIDE_OPERATION = {
  /** Reverse a prior autonomous action (alias of reverse_action on-chain). */
  OVERRIDE_ACTION: 'override_action',
  /** Reverse a prior autonomous action. */
  REVERSE_ACTION: 'reverse_action',
  /** Revoke the agent's GuardianCap. */
  REVOKE_GUARDIAN: 'revoke_guardian',
  /** Retune policy bounds + risk thresholds. */
  UPDATE_THRESHOLDS: 'update_thresholds',
  /** Unpause borrows on the policy's market. */
  UNPAUSE_MARKET: 'unpause_market',
} as const;

export type OverrideOperationName = keyof typeof OVERRIDE_OPERATION;
export type OverrideOperation = (typeof OVERRIDE_OPERATION)[OverrideOperationName];

/** Every valid override operation, for membership checks. */
export const VALID_OVERRIDE_OPERATIONS: readonly OverrideOperation[] = Object.freeze(
  Object.values(OVERRIDE_OPERATION) as OverrideOperation[],
);

/**
 * The override operations that reverse a prior action on-chain (and therefore
 * pass the governor's reason to the Move function as a `vector<u8>`). All five
 * operations still REQUIRE a reason at the Override_Console layer (Req 11.6);
 * these two additionally carry it on-chain.
 */
export const REVERSAL_OPERATIONS: readonly OverrideOperation[] = Object.freeze([
  OVERRIDE_OPERATION.OVERRIDE_ACTION,
  OVERRIDE_OPERATION.REVERSE_ACTION,
]);

/** Fields shared by every override request. */
interface BaseOverrideRequest {
  /** A valid OverrideCap scoped to the policy, presented by its dao_address. */
  overrideCapObjectId: string;
  /** Object id of the on-chain `RiskPolicy`. */
  policyObjectId: string;
  /**
   * Human override reason (Req 11.6). REQUIRED and non-empty for every override
   * operation; recorded into the Evidence_Bundle and the off-chain ActionLog,
   * and (for reversal operations) passed to the on-chain function.
   */
  reason: string;
  /** Clock object id (defaults to the framework `0x6` clock). */
  clockObjectId?: string;
}

/**
 * Reverse / override a prior autonomous action: `override_action` or
 * `reverse_action`. Marks the original ActionLog reversed, applies the inverse
 * market mutation, records a new reversal ActionLog, and emits
 * `RiskActionOverridden` with the reason. (Req 11.4)
 */
export interface ReverseActionOverrideRequest extends BaseOverrideRequest {
  operation: typeof OVERRIDE_OPERATION.OVERRIDE_ACTION | typeof OVERRIDE_OPERATION.REVERSE_ACTION;
  /** Object id of the original `ActionLog` being reversed. */
  actionLogObjectId: string;
  /** Object id of the target `MarketState` whose effect is inverted. */
  marketStateObjectId: string;
  /** Optional reversal tx-digest bytes recorded on-chain (empty by default). */
  reversalTxDigest?: ByteInput;
}

/** Revoke the agent's GuardianCap. (Req 12.1) */
export interface RevokeGuardianOverrideRequest extends BaseOverrideRequest {
  operation: typeof OVERRIDE_OPERATION.REVOKE_GUARDIAN;
  /** Object id of the agent's `GuardianCap` to revoke. */
  guardianCapObjectId: string;
}

/** Retune policy bounds + risk thresholds. (Req 8.9, 12.5) */
export interface UpdateThresholdsOverrideRequest extends BaseOverrideRequest {
  operation: typeof OVERRIDE_OPERATION.UPDATE_THRESHOLDS;
  newMaxLtvDeltaBps: bigint | number;
  newMaxMarginDeltaBps: bigint | number;
  newPauseDurationLimitMs: bigint | number;
  newCooldownMs: bigint | number;
  /** New risk-threshold band cutoffs (u64 each). */
  newRiskThresholds: readonly (bigint | number)[];
}

/** Unpause borrows on the policy's market. (Req 8.13) */
export interface UnpauseMarketOverrideRequest extends BaseOverrideRequest {
  operation: typeof OVERRIDE_OPERATION.UNPAUSE_MARKET;
  /** Object id of the policy's `MarketState`. */
  marketStateObjectId: string;
}

/**
 * The complete, structured input to the override PTB builder. A discriminated
 * union on `operation` — STRUCTURED, server-controlled fields only; there is
 * intentionally no field for a raw PTB / arbitrary Move call. (Req 16.4)
 */
export type OverrideActionRequest =
  | ReverseActionOverrideRequest
  | RevokeGuardianOverrideRequest
  | UpdateThresholdsOverrideRequest
  | UnpauseMarketOverrideRequest;

/**
 * Raised when an override request is malformed, omits the required reason, or
 * attempts to inject arbitrary PTB structure. Distinct from
 * {@link ActionTemplateError} so the API layer can map it to a descriptive 400.
 * (Req 11.6, 16.4)
 */
export class OverrideRequestError extends Error {
  /** The offending field, when one can be named. */
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message);
    this.name = 'OverrideRequestError';
    this.field = field;
  }
}
