import type { WizardErrors } from '../../lib/policyWizard';

export interface SignDeployStepProps {
  /** Current validation errors; a non-empty map blocks submission. (Req 4.9) */
  errors: WizardErrors;
  /** True only when the config is valid AND a testnet wallet can sign. (Req 4.1, 4.9) */
  canSubmit: boolean;
  submitting: boolean;
  /** Field-level rejection returned by the backend draft validation. (Req 4.9) */
  serverError: { field: string; message: string } | null;
  /** A deployment/transaction error message, if signing failed. */
  deployError: string | null;
  /** The resulting transaction digest on success. (Req 4.10) */
  txDigest: string | null;
  onSign: () => void;
}

/**
 * Step 7 — sign + deploy. Surfaces any blocking validation issue (identifying
 * the invalid value), submits the policy-deployment PTB on sign, and shows the
 * resulting tx digest on success. (Req 4.8, 4.9, 4.10)
 */
export function SignDeployStep({
  errors,
  canSubmit,
  submitting,
  serverError,
  deployError,
  txDigest,
  onSign,
}: SignDeployStepProps) {
  const errorEntries = Object.entries(errors) as [string, string][];

  if (txDigest) {
    return (
      <section className="wizard-step" data-testid="step-sign-deploy">
        <h3>Policy deployed</h3>
        <p className="wizard-success" data-testid="deploy-success">
          Your Risk Policy was deployed to Sui Testnet.
        </p>
        <p className="wizard-field">
          <span>Transaction digest</span>
          <code data-testid="tx-digest">{txDigest}</code>
        </p>
      </section>
    );
  }

  return (
    <section className="wizard-step" data-testid="step-sign-deploy">
      <h3>Sign &amp; deploy</h3>

      {errorEntries.length > 0 && (
        <div className="wizard-validation-summary" role="alert" data-testid="validation-summary">
          <p>Resolve the following before submitting:</p>
          <ul>
            {errorEntries.map(([field, message]) => (
              <li key={field} data-testid={`summary-${field}`}>
                <strong>{field}</strong>: {message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {serverError && (
        <p className="wizard-error" role="alert" data-testid="server-error">
          {serverError.field}: {serverError.message}
        </p>
      )}

      {deployError && (
        <p className="wizard-error" role="alert" data-testid="deploy-error">
          {deployError}
        </p>
      )}

      <button
        type="button"
        className="wizard-primary"
        data-testid="sign-deploy-button"
        disabled={!canSubmit || submitting}
        onClick={onSign}
      >
        {submitting ? 'Deploying…' : 'Sign & Deploy'}
      </button>
    </section>
  );
}
