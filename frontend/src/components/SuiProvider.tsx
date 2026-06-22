import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SuiClientProvider, WalletProvider, createNetworkConfig } from '@mysten/dapp-kit';
import { getFullnodeUrl } from '@mysten/sui/client';
import '@mysten/dapp-kit/dist/index.css';

// Sui dApp Kit network configuration. Testnet only for the hackathon demo.
// (Requirements 1.1, 2.1)
const { networkConfig } = createNetworkConfig({
  testnet: { url: getFullnodeUrl('testnet') },
});

const queryClient = new QueryClient();

export interface SuiProviderProps {
  children: ReactNode;
}

/**
 * Wraps the app in the providers required by Sui dApp Kit: TanStack Query,
 * the Sui client (pinned to testnet), and the wallet adapter. Rendered inside
 * client-only islands since the wallet relies on browser APIs.
 */
export function SuiProvider({ children }: SuiProviderProps) {
  return (
    <QueryClientProvider client={queryClient}>
      <SuiClientProvider networks={networkConfig} defaultNetwork="testnet">
        <WalletProvider autoConnect>{children}</WalletProvider>
      </SuiClientProvider>
    </QueryClientProvider>
  );
}
