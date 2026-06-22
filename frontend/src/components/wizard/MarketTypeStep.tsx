import { MARKET_TYPES, type MarketType } from '../../lib/policyWizard';
import { FieldError, type StepProps } from './stepProps';

/** Step 1 — choose a market type from {lending, perps, stablecoin, demo}. (Req 4.2) */
export function MarketTypeStep({ state, errors, showErrors, onChange }: StepProps) {
  return (
    <fieldset className="wizard-step" data-testid="step-market-type">
      <legend>Market type</legend>
      <p className="wizard-step__hint">Choose the kind of market this policy protects.</p>
      <div className="wizard-options" role="radiogroup" aria-label="Market type">
        {MARKET_TYPES.map((type) => (
          <label key={type} className="wizard-option">
            <input
              type="radio"
              name="marketType"
              value={type}
              checked={state.marketType === type}
              onChange={() => onChange({ marketType: type as MarketType })}
            />
            <span>{type}</span>
          </label>
        ))}
      </div>
      <FieldError show={showErrors} message={errors.marketType} field="marketType" />
    </fieldset>
  );
}
