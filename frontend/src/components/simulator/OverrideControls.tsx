import { useState } from 'react';

import type { OverrideOutcome } from '../../lib/simulatorApi';
import { TxDigestDisplay } from '../TxDigestDisplay';

/** The DAO override operations selectable in the console. (Req 11.4, 12.1) */
export const OVERRIDE_OPERATIONS: readonly { value: string; label: string; help: string }[] =
  Object.freeze([
    {
      value: 'unpause_market',
      label: 'Unpause market',
      help: 'Lift a borrow pause the agent placed, re-opening the market for new borrows. Best demoed after a scenario pauses the market.',
    },
    {
      value: 'update_thresholds',
      label: 'Update thresholds',
      help: 'Retune the policy limits (max LTV / margin deltas, pause limit, cooldown, risk bands). Non-destructive and reversible — a safe operation to demo.',
    },
  ]);

export interface OverrideControlsProps {
  /** Whether a testnet wallet is connected and able to sign. (Req 2.4) */
  canSign: boolean;
  /** Whether an override request is in flight. */
  submitting: boolean;
  /** The latest override outcome to surface, if any. */
  outcome: OverrideOutcome | null;
  /**
   * Whether the latest override tx digest has been verified as testnet. Fail-
   * closed: defaults to false so an unverified digest is suppressed. (Req 1.9)
   */
  txDigestVerifiedTestnet: boolean;
  /** Invoked with the chosen operation + required reason on submit. (Req 11.6) */
  onSubmit: (operation: string, reason: string) => void;
}

/**
 * Override controls for the Simulation Lab. Lets a DAO governor reverse a prior
 * action, revoke the guardian, update thresholds, or unpause the market during a
 * scenario (Req 14.4). An override reason is REQUIRED before submission (Req
 * 11.6); the submit control is disabled until the wallet can sign and a non-empty
 * reason is entered. The resulting tx digest is shown via {@link TxDigestDisplay}.
 */
export function OverrideControls({
  canSign,
  submitting,
  outcome,
  txDigestVerifiedTestnet,
  onSubmit,
}: OverrideControlsProps) {
  const [operation, setOperation] = useState<string>(OVERRIDE_OPERATIONS[0]!.value);
  const [reason, setReason] = useState('');

  const reasonMissing = reason.trim() === '';
  const disabled = submitting || !canSign || reasonMissing;
  const activeHelp = OVERRIDE_OPERATIONS.find((op) => op.value === operation)?.help ?? '';

  return (
    <section className="override-controls" data-testid="override-controls">
      <h3 className="override-controls__heading">DAO Override Console</h3>
      <p className="override-controls__intro">
        The agent acts within bounds — but a human DAO always has the final say. Use this console to
        intervene on the agent: reverse its last action, unpause the market, retune the limits, or
        revoke its authority entirely. Every override is signed on Sui Testnet and recorded with the
        reason you give, so the trail stays auditable.
      </p>

      {!canSign ? (
        <p className="override-controls__hint" data-testid="override-needs-wallet">
          Connect a Sui Testnet wallet to apply an override.
        </p>
      ) : null}

      <label className="override-controls__field">
        <span>Operation</span>
        <select
          data-testid="override-operation"
          value={operation}
          disabled={submitting}
          onChange={(e) => setOperation(e.target.value)}
        >
          {OVERRIDE_OPERATIONS.map((op) => (
            <option key={op.value} value={op.value}>
              {op.label}
            </option>
          ))}
        </select>
      </label>
      {activeHelp ? <p className="override-controls__op-help">{activeHelp}</p> : null}

      <label className="override-controls__field">
        <span>Override reason (required)</span>
        <textarea
          data-testid="override-reason"
          value={reason}
          rows={2}
          placeholder="Why are you overriding the autonomous action?"
          disabled={submitting}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>

      {reasonMissing ? (
        <p className="override-controls__reason-hint" data-testid="override-reason-required">
          An override reason is required.
        </p>
      ) : null}

      <button
        type="button"
        className="override-controls__submit"
        data-testid="override-submit"
        disabled={disabled}
        onClick={() => onSubmit(operation, reason.trim())}
      >
        {submitting ? 'Submitting…' : 'Apply override'}
      </button>

      {outcome ? (
        <div className="override-controls__outcome" data-testid="override-outcome">
          {outcome.ok && outcome.success ? (
            <>
              <p data-testid="override-success">Override applied on Sui Testnet.</p>
              <div className="override-controls__digest">
                <span>Transaction digest</span>
                <TxDigestDisplay
                  digest={outcome.txDigest ?? null}
                  verifiedTestnet={txDigestVerifiedTestnet}
                />
              </div>
            </>
          ) : (
            <p className="override-controls__error" role="alert" data-testid="override-error">
              {outcome.message ?? outcome.failureReason ?? 'The override did not succeed.'}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
