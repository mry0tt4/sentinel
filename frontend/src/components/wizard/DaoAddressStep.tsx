import { FieldError, type StepProps } from './stepProps';

/** Step 5 — set the DAO override address. (Req 4.6) */
export function DaoAddressStep({ state, errors, showErrors, onChange }: StepProps) {
  return (
    <fieldset className="wizard-step" data-testid="step-dao-address">
      <legend>DAO override address</legend>
      <p className="wizard-step__hint">
        The DAO/governor address that will hold the Override capability for this policy.
      </p>
      <label className="wizard-field">
        <span>DAO override address</span>
        <input
          type="text"
          aria-label="DAO override address"
          placeholder="0x…"
          value={state.daoAddress}
          onChange={(e) => onChange({ daoAddress: e.target.value })}
        />
        <FieldError show={showErrors} message={errors.daoAddress} field="daoAddress" />
      </label>
    </fieldset>
  );
}
