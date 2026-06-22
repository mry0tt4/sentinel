import { WIZARD_STEPS } from '../../lib/policyWizard';

export interface WizardStepperProps {
  /** Zero-based index of the active step. */
  currentStep: number;
}

/**
 * Progress indicator showing the ordered wizard steps and the active one.
 * Presentational only. (Req 4.x onboarding wizard)
 */
export function WizardStepper({ currentStep }: WizardStepperProps) {
  return (
    <ol className="wizard-stepper" data-testid="wizard-stepper">
      {WIZARD_STEPS.map((step, index) => {
        const status =
          index === currentStep ? 'active' : index < currentStep ? 'done' : 'upcoming';
        return (
          <li
            key={step.id}
            className={`wizard-stepper__item wizard-stepper__item--${status}`}
            aria-current={index === currentStep ? 'step' : undefined}
            data-testid={`step-indicator-${step.id}`}
          >
            <span className="wizard-stepper__index">{index + 1}</span>
            <span className="wizard-stepper__label">{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}
