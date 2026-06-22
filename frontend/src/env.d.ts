/// <reference types="astro/client" />

interface ImportMetaEnv {
  /** Target Sui network for the hackathon demo. Always `testnet`. */
  readonly PUBLIC_SUI_NETWORK: string;
  /** Base URL of the Sentinel backend REST API. */
  readonly PUBLIC_BACKEND_URL: string;
  /** WebSocket URL for live dashboard updates. */
  readonly PUBLIC_WS_URL: string;
  /** Published `sentinel_policy` package ID on Sui Testnet (set by deploy). */
  readonly PUBLIC_SENTINEL_POLICY_PACKAGE_ID: string;
  /** Published `sentinel_demo_market` package ID on Sui Testnet (set by deploy). */
  readonly PUBLIC_SENTINEL_DEMO_MARKET_PACKAGE_ID: string;
  /** Published `sentinel_adapters` package ID on Sui Testnet (set by deploy). */
  readonly PUBLIC_SENTINEL_ADAPTERS_PACKAGE_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
