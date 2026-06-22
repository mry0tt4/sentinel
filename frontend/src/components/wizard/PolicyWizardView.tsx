import { type ReactNode, useMemo, useState } from 'react';
import {
  STEP_FIELDS,
  WIZARD_STEPS,
  initialWizardState,
  validateWizard,
  type WizardState,
  type WizardStepId,
} from '../../lib/policyWizard';
import type { PolicyApi } from '../../lib/policyApi';
import type { PolicyDeployer } from '../../lib/policyDeployer';
import type { SignAndExecuteArgs, SignAndExecuteResult } from '../../hooks/useSuiWallet';
import { WRONG_NETWORK_MESSAGE } from '../../lib/network';
import { NetworkBadge } from '../NetworkBadge';
import { WizardStepper } from './WizardStepper';
import { MarketTypeStep } from './MarketTypeStep';
import { MarketSelectStep, type DemoMarketOption } from './MarketSelectStep';
import { FeedMappingStep } from './FeedMappingStep';
import { ThresholdsBoundsStep } from './ThresholdsBoundsStep';
import { DaoAddressStep } from './DaoAddressStep';
import { ReviewStep } from './ReviewStep';
import { SignDeployStep } from './SignDeployStep';

/** The wallet surface the wizard depends on. {@link SuiWallet} satisfies this. */
export interface WizardWallet {
  connected: boolean;
  canSign: boolean;
  network: string | null;
  signAndExecute: (args: SignAndExecuteArgs) => Promise<SignAndExecuteResult>;
}

export interface PolicyWizardViewProps {
  wallet: WizardWallet;
  apiClient: PolicyApi;
  deployer: PolicyDeployer;
  demoMarkets?: DemoMarketOption[];
  /** Affordance for connecting a wallet (e.g. dApp Kit ConnectButton). */
  connectSlot?: ReactNode;
}

/**
 * The onboarding / policy configuration wizard. Gated behind a connected Sui
 * Testnet wallet (Req 4.1); steps through market type, demo market, feed
 * mapping, thresholds/bounds, DAO override, review, and sign-to-deploy; blocks
 * submission and identifies any missing or out-of-range value (Req 4.9); and on
 * a successful sign persists the policy and shows the tx digest (Req 4.8, 4.10).
 *
 * The wallet, backend client, and deployer are injected so this view is fully
 * testable without a live wallet or backend.
 */
export function PolicyWizardView({
  wallet,
  apiClient,
  deployer,
  demoMarkets,
  connectSlot,
}: PolicyWizardViewProps) {
  const [state, setState] = useState<WizardState>(initialWizardState);
  const [stepIndex, setStepIndex] = useState(0);
  const [showErrors, setShowErrors] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<{ field: string; message: string } | null>(null);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [txDigest, setTxDigest] = useState<string | null>(null);

  const validation = useMemo(() => validateWizard(state), [state]);
  const currentStep = WIZARD_STEPS[stepIndex] ?? WIZARD_STEPS[0]!;

  const patch = (p: Partial<WizardState>) => {
    setState((s) => ({ ...s, ...p }));
    setServerError(null);
    setDeployError(null);
  };

  const stepHasErrors = (stepId: WizardStepId): boolean =>
    STEP_FIELDS[stepId].some((field) => validation.errors[field] !== undefined);

  const goNext = () => {
    if (stepHasErrors(currentStep.id)) {
      setShowErrors(true);
      return;
    }
    setShowErrors(false);
    setStepIndex((i) => Math.min(i + 1, WIZARD_STEPS.length - 1));
  };

  const goBack = () => {
    setShowErrors(false);
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  const handleSign = async () => {
    // Always surface validation when a submission is attempted. (Req 4.9)
    setShowErrors(true);
    if (!validation.valid || !validation.draft || !wallet.canSign) {
      return;
    }
    setSubmitting(true);
    setServerError(null);
    setDeployError(null);
    try {
      // Reuse the backend draft endpoint for authoritative range validation. (Req 4.9)
      const draftRes = await apiClient.draft(validation.draft);
      if (!draftRes.ok) {
        setServerError({ field: draftRes.field, message: draftRes.message });
        return;
      }
      // Submit the policy-deployment PTB via the wallet. (Req 4.8)
      const { digest } = await deployer(validation.draft, wallet.signAndExecute);
      // Persist the policy record with its digest. (Req 4.10)
      await apiClient.persist({ ...validation.draft, txDigest: digest });
      setTxDigest(digest);
    } catch (err) {
      setDeployError(err instanceof Error ? err.message : 'Policy deployment failed.');
    } finally {
      setSubmitting(false);
    }
  };

  // Gate 1 — require a connected wallet. (Req 4.1)
  if (!wallet.connected) {
    return (
      <section className="wizard-gate" data-testid="wizard-gate-disconnected">
        <h2>Connect a wallet</h2>
        <p>Connect a Sui Testnet wallet to configure and deploy a Risk Policy.</p>
        {connectSlot}
      </section>
    );
  }

  // Gate 2 — require Sui Testnet. (Req 4.1, 1.5)
  if (!wallet.canSign) {
    return (
      <section className="wizard-gate" data-testid="wizard-gate-wrong-network">
        <NetworkBadge network={wallet.network} />
        <p className="wizard-error" role="alert" data-testid="wrong-network-message">
          {WRONG_NETWORK_MESSAGE}
        </p>
      </section>
    );
  }

  const stepProps = { state, errors: validation.errors, showErrors, onChange: patch };

  return (
    <div className="policy-wizard" data-testid="policy-wizard">
      <WizardStepper currentStep={stepIndex} />

      <div className="policy-wizard__body">
        {currentStep.id === 'market-type' && <MarketTypeStep {...stepProps} />}
        {currentStep.id === 'market-select' && (
          <MarketSelectStep {...stepProps} demoMarkets={demoMarkets} />
        )}
        {currentStep.id === 'feed-mapping' && <FeedMappingStep {...stepProps} />}
        {currentStep.id === 'thresholds-bounds' && <ThresholdsBoundsStep {...stepProps} />}
        {currentStep.id === 'dao-address' && <DaoAddressStep {...stepProps} />}
        {currentStep.id === 'review' && <ReviewStep state={state} />}
        {currentStep.id === 'sign-deploy' && (
          <SignDeployStep
            errors={validation.errors}
            canSubmit={validation.valid && wallet.canSign}
            submitting={submitting}
            serverError={serverError}
            deployError={deployError}
            txDigest={txDigest}
            onSign={handleSign}
          />
        )}
      </div>

      <div className="policy-wizard__nav">
        <button
          type="button"
          className="wizard-secondary"
          data-testid="wizard-back"
          onClick={goBack}
          disabled={stepIndex === 0 || submitting || txDigest !== null}
        >
          Back
        </button>
        {currentStep.id !== 'sign-deploy' && (
          <button
            type="button"
            className="wizard-primary"
            data-testid="wizard-next"
            onClick={goNext}
          >
            Next
          </button>
        )}
      </div>
    </div>
  );
}
