import { useMemo, useState } from 'react';

import {
  buildOverridePreview,
  CONSOLE_OPERATION_LABEL,
  CONSOLE_OPERATIONS,
  type ConsoleOperation,
  type OverrideConsoleMarket,
  type OverrideDataClient,
  type OverrideSubmission,
  type OverrideSubmissionResult,
  type ThresholdUpdate,
} from '../../lib/overrideApi';
import { TxDigestDisplay } from '../TxDigestDisplay';
import { InfoHint } from '../InfoHint';
import { OPERATION_HELP } from '../../lib/glossary';
import type { OverrideWallet } from './overrideWallet';

export interface MarketOverridePanelProps {
  entry: OverrideConsoleMarket;
  wallet: OverrideWallet;
  dataClient: OverrideDataClient;
  /** Notifies the parent so it can refresh the console after a successful override. */
  onSubmitted?: (result: OverrideSubmissionResult) => void;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

/** Controls that require an active action to operate on. */
const ACTION_OPERATIONS: ReadonlySet<ConsoleOperation> = new Set([
  'reverse_action',
  'confirm_action',
  'restore_ltv',
]);

/** Default threshold inputs seeded from the current policy. */
function seedThresholds(entry: OverrideConsoleMarket): ThresholdUpdate {
  const p = entry.policy;
  return {
    newMaxLtvDeltaBps: Number(p?.maxLtvDeltaBps ?? 0),
    newMaxMarginDeltaBps: Number(p?.maxMarginDeltaBps ?? 0),
    newPauseDurationLimitMs: Number(p?.pauseDurationLimitMs ?? 0),
    newCooldownMs: Number(p?.cooldownMs ?? 0),
    newRiskThresholds: [40, 60, 75, 90],
  };
}

/**
 * One market's override surface. Renders the relevant policy, the active action
 * (with the Risk_Score recorded at action time and the linked Walrus evidence),
 * the paused state, and the OverrideCap holder address (Req 11.1, 11.2); offers
 * the confirm/revoke/update-thresholds/unpause/restore/reverse controls
 * (Req 11.5), previews the resulting changes before signing (Req 11.3), requires
 * an override reason (Req 11.6), and displays the resulting Tx_Digest on
 * completion (Req 11.7).
 */
export function MarketOverridePanel({
  entry,
  wallet,
  dataClient,
  onSubmitted,
}: MarketOverridePanelProps) {
  const [operation, setOperation] = useState<ConsoleOperation | null>(null);
  const [reason, setReason] = useState('');
  const [thresholds, setThresholds] = useState<ThresholdUpdate>(() => seedThresholds(entry));
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<OverrideSubmissionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const marketId = entry.market.id;
  const action = entry.activeAction;

  const preview = useMemo(
    () => (operation ? buildOverridePreview(operation, entry, thresholds) : null),
    [operation, entry, thresholds],
  );

  const reasonOk = reason.trim().length > 0;
  // Submit is gated by a non-empty reason (Req 11.6) AND a signing-capable
  // testnet wallet (Req 1.5, 2.4).
  const canSubmit = operation !== null && reasonOk && wallet.canSign && !submitting;

  function selectOperation(next: ConsoleOperation) {
    setOperation((current) => (current === next ? null : next));
    setResult(null);
    setError(null);
  }

  async function handleSubmit() {
    if (operation === null || !reasonOk) return;
    setSubmitting(true);
    setError(null);
    try {
      const submission: OverrideSubmission = {
        operation,
        reason: reason.trim(),
        policyId: entry.policy?.id ?? marketId,
        marketId,
        daoAddress: entry.overrideCapHolder ?? '',
        actionLogId: action?.id ?? '',
        riskScore: entry.riskScoreAtAction,
        originalActionId: action?.id,
        onChain: {
          policyObjectId: entry.policy?.onChainPolicyId ?? '',
          overrideCapObjectId: entry.policy?.overrideCapId ?? '',
          marketStateObjectId: entry.market.onChainId,
          guardianCapObjectId: entry.policy?.guardianCapId ?? undefined,
          actionLogObjectId: action?.id,
        },
        thresholds: operation === 'update_thresholds' ? thresholds : undefined,
      };
      const submitted = await dataClient.submitOverride(submission);
      setResult(submitted);
      if (submitted.success) {
        onSubmitted?.(submitted);
      } else if (submitted.failureReason) {
        setError(submitted.failureReason);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Override submission failed.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="override-panel" data-testid={`override-panel-${marketId}`}>
      <header className="override-panel__head">
        <div>
          <h3 className="override-panel__name" data-testid="override-market-name">
            {entry.market.name}
          </h3>
          <span className="override-panel__status" data-testid="override-market-status">
            {entry.market.status}
          </span>
        </div>
        {entry.isPaused ? (
          <span className="override-badge override-badge--paused" data-testid="override-paused-badge">
            Paused
          </span>
        ) : null}
      </header>

      {/* Relevant policy + OverrideCap holder. (Req 11.1, 11.2) */}
      <dl className="override-grid">
        <div className="override-grid__row">
          <dt>OverrideCap holder<InfoHint term="OverrideCap holder" /></dt>
          <dd className="override-grid__mono" data-testid="override-cap-holder">
            {fmt(entry.overrideCapHolder)}
          </dd>
        </div>
        <div className="override-grid__row">
          <dt>Max LTV delta<InfoHint term="Max LTV delta" /></dt>
          <dd data-testid="override-policy-ltv">{fmt(entry.policy?.maxLtvDeltaBps)} bps</dd>
        </div>
        <div className="override-grid__row">
          <dt>Max margin delta<InfoHint term="Max margin delta" /></dt>
          <dd data-testid="override-policy-margin">{fmt(entry.policy?.maxMarginDeltaBps)} bps</dd>
        </div>
        <div className="override-grid__row">
          <dt>Allowed actions<InfoHint term="Allowed actions" /></dt>
          <dd data-testid="override-policy-actions">
            {entry.policy && entry.policy.allowedActions.length > 0
              ? entry.policy.allowedActions.join(', ')
              : '—'}
          </dd>
        </div>
      </dl>

      {/* Active action: risk score at action time + linked Walrus evidence. (Req 11.1) */}
      <div className="override-action" data-testid="override-active-action">
        <h4 className="override-panel__subhead">Active action</h4>
        {action === null ? (
          <p className="override-empty" data-testid="override-no-action">
            No active autonomous action for this market.
          </p>
        ) : (
          <dl className="override-grid">
            <div className="override-grid__row">
              <dt>Action</dt>
              <dd data-testid="override-action-type">{fmt(action.actionType)}</dd>
            </div>
            <div className="override-grid__row">
              <dt>Change</dt>
              <dd data-testid="override-action-change">
                {fmt(action.oldValue)} → {fmt(action.newValue)}
              </dd>
            </div>
            <div className="override-grid__row">
              <dt>Risk score at action time<InfoHint term="Risk score at action time" /></dt>
              <dd data-testid="override-risk-score">{fmt(entry.riskScoreAtAction)}</dd>
            </div>
            <div className="override-grid__row">
              <dt>Walrus evidence<InfoHint term="Walrus evidence" /></dt>
              <dd className="override-grid__mono" data-testid="override-evidence-blob">
                {fmt(entry.evidenceBlobId)}
              </dd>
            </div>
            <div className="override-grid__row">
              <dt>Last tx digest</dt>
              <dd>
                <TxDigestDisplay
                  digest={entry.lastTxDigest}
                  verifiedTestnet={entry.lastTxDigestVerifiedTestnet}
                />
              </dd>
            </div>
          </dl>
        )}
      </div>

      {/* Controls. (Req 11.5) */}
      <div className="override-controls" role="group" aria-label="Override controls">
        {CONSOLE_OPERATIONS.map((op) => {
          const requiresAction = ACTION_OPERATIONS.has(op);
          const disabled =
            (requiresAction && action === null) ||
            (op === 'unpause_market' && !entry.isPaused);
          return (
            <button
              type="button"
              key={op}
              className={`override-control${operation === op ? ' override-control--active' : ''}`}
              data-testid={`override-control-${op}`}
              aria-pressed={operation === op}
              disabled={disabled}
              title={OPERATION_HELP[op]}
              onClick={() => selectOperation(op)}
            >
              {CONSOLE_OPERATION_LABEL[op]}
            </button>
          );
        })}
      </div>

      {/* Preview + reason + sign. (Req 11.3, 11.6, 11.7) */}
      {operation !== null && preview !== null ? (
        <div className="override-stage" data-testid="override-stage">
          <h4 className="override-panel__subhead">
            Preview: <span data-testid="override-stage-op">{preview.label}</span>
          </h4>

          <table className="override-preview" data-testid="override-preview">
            <thead>
              <tr>
                <th>Field</th>
                <th>Before</th>
                <th>After</th>
              </tr>
            </thead>
            <tbody>
              {preview.changes.map((change, i) => (
                <tr key={change.field + i} data-testid={`override-preview-change-${i}`}>
                  <td>{change.field}</td>
                  <td data-testid={`override-preview-before-${i}`}>{change.before}</td>
                  <td data-testid={`override-preview-after-${i}`}>{change.after}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {operation === 'update_thresholds' ? (
            <div className="override-thresholds" data-testid="override-thresholds">
              <label>
                Max LTV delta bps
                <input
                  type="number"
                  data-testid="override-input-ltv"
                  value={thresholds.newMaxLtvDeltaBps}
                  onChange={(e) =>
                    setThresholds((t) => ({ ...t, newMaxLtvDeltaBps: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Max margin delta bps
                <input
                  type="number"
                  data-testid="override-input-margin"
                  value={thresholds.newMaxMarginDeltaBps}
                  onChange={(e) =>
                    setThresholds((t) => ({ ...t, newMaxMarginDeltaBps: Number(e.target.value) }))
                  }
                />
              </label>
              <label>
                Pause duration limit ms
                <input
                  type="number"
                  data-testid="override-input-pause"
                  value={thresholds.newPauseDurationLimitMs}
                  onChange={(e) =>
                    setThresholds((t) => ({
                      ...t,
                      newPauseDurationLimitMs: Number(e.target.value),
                    }))
                  }
                />
              </label>
              <label>
                Cooldown ms
                <input
                  type="number"
                  data-testid="override-input-cooldown"
                  value={thresholds.newCooldownMs}
                  onChange={(e) =>
                    setThresholds((t) => ({ ...t, newCooldownMs: Number(e.target.value) }))
                  }
                />
              </label>
            </div>
          ) : null}

          {/* An override reason is REQUIRED for every operation. (Req 11.6) */}
          <label className="override-reason">
            Override reason
            <textarea
              data-testid="override-reason-input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this override being performed?"
            />
          </label>
          {!reasonOk ? (
            <p className="override-hint" data-testid="override-reason-required">
              An override reason is required before signing.
            </p>
          ) : null}

          {!wallet.canSign ? (
            <p className="override-hint" data-testid="override-cannot-sign">
              Connect a Sui Testnet wallet to sign this override.
            </p>
          ) : null}

          <button
            type="button"
            className="override-submit"
            data-testid="override-submit-button"
            disabled={!canSubmit}
            onClick={handleSubmit}
          >
            {submitting ? 'Submitting…' : `Sign & ${preview.label}`}
          </button>
        </div>
      ) : null}

      {error !== null ? (
        <p className="override-error" role="alert" data-testid="override-error">
          {error}
        </p>
      ) : null}

      {/* Resulting tx digest, guarded so an unverified digest is blocked. (Req 11.7) */}
      {result !== null ? (
        <div className="override-result" data-testid="override-result">
          <p data-testid="override-result-status">
            {result.success ? 'Override submitted.' : 'Override did not complete.'}
          </p>
          <div className="override-result__digest">
            <span>Tx digest</span>
            <TxDigestDisplay
              digest={result.txDigest}
              verifiedTestnet={result.txDigestVerifiedTestnet}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
