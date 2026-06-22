import { POLICY_ACTIONS, WIZARD_BOUNDS, type PolicyAction } from '../../lib/policyWizard';
import { FieldError, type StepProps } from './stepProps';

/**
 * Step 4 — select allowed actions and set the action bounds: max LTV delta
 * (bps), max margin delta (bps), pause duration limit (ms), and cooldown (ms).
 * (Req 4.5)
 */
export function ThresholdsBoundsStep({ state, errors, showErrors, onChange }: StepProps) {
  const toggleAction = (action: PolicyAction) => {
    const has = state.allowedActions.includes(action);
    const next = has
      ? state.allowedActions.filter((a) => a !== action)
      : [...state.allowedActions, action];
    onChange({ allowedActions: next });
  };

  return (
    <fieldset className="wizard-step" data-testid="step-thresholds-bounds">
      <legend>Thresholds &amp; bounds</legend>

      <div className="wizard-subsection">
        <span className="wizard-subsection__title">Allowed actions</span>
        <div className="wizard-options" role="group" aria-label="Allowed actions">
          {POLICY_ACTIONS.map((action) => (
            <label key={action} className="wizard-option">
              <input
                type="checkbox"
                value={action}
                checked={state.allowedActions.includes(action)}
                onChange={() => toggleAction(action)}
              />
              <span>{action}</span>
            </label>
          ))}
        </div>
        <FieldError show={showErrors} message={errors.allowedActions} field="allowedActions" />
      </div>

      <label className="wizard-field">
        <span>
          Max LTV delta (bps) — {WIZARD_BOUNDS.maxLtvDeltaBps.min}–
          {WIZARD_BOUNDS.maxLtvDeltaBps.max}
        </span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Max LTV delta bps"
          value={state.maxLtvDeltaBps}
          onChange={(e) => onChange({ maxLtvDeltaBps: e.target.value })}
        />
        <FieldError show={showErrors} message={errors.maxLtvDeltaBps} field="maxLtvDeltaBps" />
      </label>

      <label className="wizard-field">
        <span>
          Max margin delta (bps) — {WIZARD_BOUNDS.maxMarginDeltaBps.min}–
          {WIZARD_BOUNDS.maxMarginDeltaBps.max}
        </span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Max margin delta bps"
          value={state.maxMarginDeltaBps}
          onChange={(e) => onChange({ maxMarginDeltaBps: e.target.value })}
        />
        <FieldError
          show={showErrors}
          message={errors.maxMarginDeltaBps}
          field="maxMarginDeltaBps"
        />
      </label>

      <label className="wizard-field">
        <span>Pause duration limit (ms)</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Pause duration limit ms"
          value={state.pauseDurationLimitMs}
          onChange={(e) => onChange({ pauseDurationLimitMs: e.target.value })}
        />
        <FieldError
          show={showErrors}
          message={errors.pauseDurationLimitMs}
          field="pauseDurationLimitMs"
        />
      </label>

      <label className="wizard-field">
        <span>Cooldown (ms)</span>
        <input
          type="text"
          inputMode="numeric"
          aria-label="Cooldown ms"
          value={state.cooldownMs}
          onChange={(e) => onChange({ cooldownMs: e.target.value })}
        />
        <FieldError show={showErrors} message={errors.cooldownMs} field="cooldownMs" />
      </label>
    </fieldset>
  );
}
