import { useMemo } from 'react';
import { ConnectButton } from '@mysten/dapp-kit';
import { SuiProvider } from '../SuiProvider';
import { useSuiWallet } from '../../hooks/useSuiWallet';
import { createDefaultPolicyApiClient, type PolicyApiClient } from '../../lib/policyApi';
import { defaultPolicyDeployer, type PolicyDeployer } from '../../lib/policyDeployer';
import { PolicyWizardView } from './PolicyWizardView';
import type { DemoMarketOption } from './MarketSelectStep';

export interface PolicyWizardProps {
  /** Injectable backend client; defaults to the global-fetch client. */
  apiClient?: PolicyApiClient;
  /** Injectable deployer; defaults to the create_policy PTB deployer. */
  deployer?: PolicyDeployer;
  /** Existing demo markets to offer in the select step. (Req 4.3) */
  demoMarkets?: DemoMarketOption[];
}

export function PolicyWizardInner({ apiClient, deployer, demoMarkets }: PolicyWizardProps) {
  const wallet = useSuiWallet();
  const client = useMemo(() => apiClient ?? createDefaultPolicyApiClient(), [apiClient]);
  const deploy = deployer ?? defaultPolicyDeployer;

  return (
    <PolicyWizardView
      wallet={wallet}
      apiClient={client}
      deployer={deploy}
      demoMarkets={demoMarkets}
      connectSlot={<ConnectButton />}
    />
  );
}

/**
 * Client-only island hosting the onboarding / policy configuration wizard.
 * Wrapped in {@link SuiProvider} so the dApp Kit wallet hooks resolve. (Req 4.x)
 */
export function PolicyWizard(props: PolicyWizardProps) {
  return (
    <SuiProvider>
      <PolicyWizardInner {...props} />
    </SuiProvider>
  );
}
