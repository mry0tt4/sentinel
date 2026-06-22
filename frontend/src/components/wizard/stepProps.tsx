import type { WizardErrors, WizardState } from '../../lib/policyWizard';

/** Props shared by every wizard step component. */
export interface StepProps {
  state: WizardState;
  errors: WizardErrors;
  /** Whether validation errors should be surfaced (after a submit/next attempt). */
  showErrors: boolean;
  /** Patch the wizard state with a partial update. */
  onChange: (patch: Partial<WizardState>) => void;
}

/** Render a field error message when present and surfacing is enabled. (Req 4.9) */
export function FieldError({
  show,
  message,
  field,
}: {
  show: boolean;
  message: string | undefined;
  field: string;
}) {
  if (!show || !message) return null;
  return (
    <p className="wizard-error" role="alert" data-testid={`error-${field}`}>
      {message}
    </p>
  );
}
