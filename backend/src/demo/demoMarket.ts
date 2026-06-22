/**
 * Shared Demo_Market configuration.
 *
 * A single source of truth for the seeded demo market used by BOTH the database
 * seed script ({@link ../db/seed.ts}) and the live composition wiring
 * ({@link ../composition.ts}). The off-chain market `id` (a UUID) is fixed so
 * the seeded row, the live risk-control loop's `risk_update` messages, and the
 * dashboard's WebSocket subscription all agree on the same market — which is
 * what makes live updates actually reach the dashboard.
 */

/** Off-chain market id (UUID primary key). Fixed so seed + loop + WS all agree. */
export const DEMO_MARKET_ID = '11111111-1111-4111-8111-111111111111';
/** Off-chain policy id (UUID primary key). */
export const DEMO_POLICY_ID = '22222222-2222-4222-8222-222222222222';

/** Display name + on-chain references for the demo market. */
export const DEMO_MARKET_NAME = 'SUI Lending Market (Demo)';
export const DEMO_ON_CHAIN_MARKET_ID = 'demo-market::sui-lending';

/**
 * Pyth SUI/USD price feed id on the Hermes price service (real Testnet feed).
 * Drives genuinely-live oracle readings into the risk-control loop.
 */
export const DEMO_ORACLE_FEED_ID =
  '0x23d7315113f5b1d3ba7a83604c44b94d79f4fd69af77f804fc7f920a6dc65744';

/** Oracle freshness threshold (ms) for staleness detection. */
export const DEMO_FRESHNESS_THRESHOLD_MS = 30_000;

/**
 * Real DeepBook v3 SUI/USDC pool on Sui Testnet (USDC is the DeepBook test
 * stable `DBUSDC`), read via the public DeepBook indexer order-book endpoint.
 * Drives genuinely-live liquidity depth / spread / imbalance.
 */
export const DEMO_DEEPBOOK_POOL = 'SUI_DBUSDC';
export const DEEPBOOK_INDEXER_URL = 'https://deepbook-indexer.testnet.mystenlabs.com';

/** Agent / owner / DAO addresses for the demo policy (public addresses only). */
export const DEMO_OWNER_ADDRESS =
  '0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4';
export const DEMO_DAO_ADDRESS =
  '0xa054daa9e6db27e623f377f17b0702222f2b54b9ef76d16ca02cf3dec189d4b4';

/** Protocol-exposure baseline overlaid with live oracle/liquidity readings. */
export const DEMO_MARKET_BASELINE = {
  utilization: 0.62,
  exposure: 4_200_000,
  currentMaxLtvBps: 7500,
  realizedVolatilityPct: 6,
  liquidityDepth: 1_200_000,
  spreadBps: 12,
} as const;
