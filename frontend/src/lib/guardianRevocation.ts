// Guardian revocation messaging (Req 12.3, 12.4).
//
// Centralizes the EXACT user-facing message the frontend shows when an
// autonomous action is rejected because the GuardianCap was revoked, plus the
// detection of a revocation rejection from the signals the backend surfaces:
//   - the Simulation Lab `SimActionOutcome` (`blocked` + a `revoked` guardian),
//   - the fail-closed Risk_Engine `refusalReason` ("…GuardianCap … is revoked…"),
//   - an on-chain `execute_guardian_action` abort (`MoveAbort: EGuardianRevoked`).
//
// Keeping the message and detection in one tested module lets the action-result
// surfaces render exactly the required string without each re-deriving it. The
// full cross-service wiring into those surfaces is composed in a later task.

/**
 * The EXACT message the Frontend SHALL display when an autonomous action is
 * rejected due to guardian revocation. Must match the requirement verbatim,
 * including the trailing period. (Req 12.4)
 */
export const GUARDIAN_REVOKED_MESSAGE = 'Guardian capability has been revoked.';

/**
 * The signals that identify an action rejection as caused by revocation. All
 * fields are optional so callers can pass whichever signal they hold (a
 * Simulation Lab outcome's `blocked` + guardian `revoked`, or any rejection
 * reason string).
 */
export interface ActionRejection {
  /** Whether the action was blocked / did not succeed. */
  blocked?: boolean | null;
  /** Whether the guardian authorization reported the GuardianCap as revoked. */
  guardianRevoked?: boolean | null;
  /**
   * Human-readable rejection detail — a `blockedReason`, `failureReason`, or
   * fail-closed `refusalReason`.
   */
  reason?: string | null;
}

/**
 * Revocation markers any backend rejection reason may carry: the English
 * word ("revoke"/"revoked"/"revocation") or the on-chain abort code
 * (`EGuardianRevoked`).
 */
const REVOCATION_PATTERN = /\brevok(?:e|ed|ing|ation)\b|guardianrevoked/i;

/**
 * Whether an action rejection was caused by guardian revocation. True when the
 * guardian authorization explicitly reports the cap as `revoked`, or when the
 * rejection reason carries a revocation marker (the fail-closed refusal reason
 * or an on-chain `EGuardianRevoked` abort). (Req 12.3, 12.4)
 */
export function isRevocationRejection(rejection: ActionRejection): boolean {
  if (rejection.guardianRevoked === true) {
    return true;
  }
  const reason = rejection.reason ?? '';
  return REVOCATION_PATTERN.test(reason);
}

/**
 * The exact message to display for an action rejection, or `null` when the
 * rejection was not caused by revocation. Surfaces render this string directly
 * so the displayed text matches the requirement verbatim. (Req 12.4)
 */
export function revocationRejectionMessage(rejection: ActionRejection): string | null {
  return isRevocationRejection(rejection) ? GUARDIAN_REVOKED_MESSAGE : null;
}
