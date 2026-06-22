/**
 * Environment configuration loader.
 *
 * Configuration and secrets are loaded from environment variables ONLY
 * (never from source or committed files). The agent signer key is kept in a
 * separate `secrets` object so it is not accidentally serialized to logs or
 * any client-facing surface. (Requirements 15.1, 15.2, 16.1, 16.2, 16.3)
 *
 * Sentinel runs against Sui Testnet and Walrus Testnet only. (Requirement 1)
 */

export type NodeEnv = 'development' | 'test' | 'production';

/** Non-secret application configuration safe to expose to internal services. */
export interface AppConfig {
  nodeEnv: NodeEnv;
  port: number;

  // Sui Testnet network (Req 1.1)
  suiRpcUrl: string;
  suiTestnetChainId: string;
  packageIds: {
    policy: string;
    demoMarket: string;
    adapters: string;
  };

  // Walrus Testnet evidence storage (Req 1.2, 10)
  walrusPublisherUrl: string;
  walrusAggregatorUrl: string;

  // Datastores
  databaseUrl: string;
  redisUrl: string;

  // API gateway (Req 15.5)
  rateLimitMax: number;
  rateLimitWindowMs: number;

  // AI Explanation Service (Req 6.5, 6.13) — explanation text only, no
  // authority over the score/band/action. Non-secret config; the API key lives
  // in {@link AppSecrets}. DeepSeek is OpenAI-compatible.
  llm: {
    model: string;
    baseUrl: string;
  };
}

/**
 * Secret material. Held by the backend only; MUST NOT be exposed to any
 * client-facing surface. (Req 16.1, 16.2, 16.3)
 *
 * The concrete object returned by {@link loadConfig} is hardened so the secret
 * values can never leak through `JSON.stringify` (client responses) or
 * `console.log`/`util.inspect` (logs): both render `[REDACTED]`. Legitimate
 * backend code reads the values through normal property access (or the
 * {@link getAgentSignerKey} getter).
 */
export interface AppSecrets {
  readonly agentSignerKey: string;
  readonly llmApiKey: string;
}

export interface LoadedConfig {
  config: AppConfig;
  secrets: AppSecrets;
}

/** Placeholder rendered wherever a secret value would otherwise appear. */
export const REDACTED = '[REDACTED]';

/** Environment variable names that hold secret material (never client-facing). */
export const SECRET_ENV_KEYS = ['AGENT_SIGNER_KEY', 'LLM_API_KEY'] as const;

/**
 * Client-safe / loggable view of the loaded configuration.
 *
 * Contains only non-secret config plus boolean presence flags for secrets — the
 * secret values themselves are structurally absent. Safe to serialize into any
 * client-facing response or log line. (Req 16.1, 16.3)
 */
export interface PublicConfig extends AppConfig {
  secretsPresent: {
    agentSignerKey: boolean;
    llmApiKey: boolean;
  };
}

const INSPECT_CUSTOM = Symbol.for('nodejs.util.inspect.custom');

/**
 * Build a hardened secrets object. The raw values are stored in a closure and
 * exposed only via enumerable getters for legitimate backend access, while
 * `toJSON` and the Node inspect hook both render `[REDACTED]` so the secrets
 * cannot leak through serialization or logging.
 */
function createSecrets(values: { agentSignerKey: string; llmApiKey: string }): AppSecrets {
  const redactedView = { agentSignerKey: REDACTED, llmApiKey: REDACTED };

  const secrets = {
    get agentSignerKey(): string {
      return values.agentSignerKey;
    },
    get llmApiKey(): string {
      return values.llmApiKey;
    },
    toJSON(): typeof redactedView {
      return redactedView;
    },
    [INSPECT_CUSTOM](): typeof redactedView {
      return redactedView;
    },
  };

  // Keep the serialization guards off the enumerable surface.
  Object.defineProperty(secrets, 'toJSON', { enumerable: false });
  Object.defineProperty(secrets, INSPECT_CUSTOM, { enumerable: false });

  return Object.freeze(secrets) as AppSecrets;
}

/**
 * Produce a client-safe, loggable view of the configuration that provably
 * excludes every secret value. Secrets are represented only as presence
 * booleans. Use this anywhere config is sent to a client or written to a log.
 * (Req 16.1, 16.3)
 */
export function toPublicConfig(loaded: LoadedConfig): PublicConfig {
  return {
    ...loaded.config,
    packageIds: { ...loaded.config.packageIds },
    secretsPresent: {
      agentSignerKey: loaded.secrets.agentSignerKey.trim() !== '',
      llmApiKey: loaded.secrets.llmApiKey.trim() !== '',
    },
  };
}

/**
 * Return the agent signer key, throwing if it is not configured. Call this when
 * building an on-chain action context so the key is required at the point of
 * use, while early scaffolding can still boot without it. (Req 16.1, 16.2)
 */
export function getAgentSignerKey(secrets: AppSecrets): string {
  const key = secrets.agentSignerKey;
  if (key === undefined || key.trim() === '') {
    throw new ConfigError(
      'AGENT_SIGNER_KEY is required before building an on-chain action context but is not configured',
    );
  }
  return key;
}

/**
 * Redact any occurrence of the configured secret values from an arbitrary
 * payload (string or object graph) before it is logged or returned to a client.
 * A defense-in-depth backstop in case a secret is ever copied into a message.
 * (Req 16.1, 16.3)
 */
export function redactSecrets<T>(value: T, secrets: AppSecrets): T {
  const needles = [secrets.agentSignerKey, secrets.llmApiKey].filter(
    (s): s is string => typeof s === 'string' && s.trim() !== '',
  );
  if (needles.length === 0) {
    return value;
  }

  const scrub = (input: unknown): unknown => {
    if (typeof input === 'string') {
      let out = input;
      for (const needle of needles) {
        out = out.split(needle).join(REDACTED);
      }
      return out;
    }
    if (Array.isArray(input)) {
      return input.map(scrub);
    }
    if (input !== null && typeof input === 'object') {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(input)) {
        result[k] = scrub(v);
      }
      return result;
    }
    return input;
  };

  return scrub(value) as T;
}

/** Source of environment values. Defaults to `process.env`; injectable for tests. */
export type EnvSource = Record<string, string | undefined>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function requireValue(env: EnvSource, key: string): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new ConfigError(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optionalValue(env: EnvSource, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value;
}

function parseIntValue(env: EnvSource, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new ConfigError(`Environment variable ${key} must be a non-negative integer, got "${raw}"`);
  }
  return parsed;
}

function parseNodeEnv(raw: string): NodeEnv {
  if (raw === 'development' || raw === 'test' || raw === 'production') {
    return raw;
  }
  throw new ConfigError(`NODE_ENV must be one of development|test|production, got "${raw}"`);
}

/**
 * Load and validate configuration from the given environment source.
 *
 * Throws {@link ConfigError} when a required value is missing or malformed so
 * the backend fails fast at startup rather than initializing partially.
 */
export function loadConfig(env: EnvSource = process.env): LoadedConfig {
  const config: AppConfig = {
    nodeEnv: parseNodeEnv(optionalValue(env, 'NODE_ENV', 'development')),
    port: parseIntValue(env, 'PORT', 4000),

    suiRpcUrl: requireValue(env, 'SUI_RPC_URL'),
    suiTestnetChainId: requireValue(env, 'SUI_TESTNET_CHAIN_ID'),
    packageIds: {
      policy: optionalValue(env, 'SENTINEL_POLICY_PACKAGE_ID', ''),
      demoMarket: optionalValue(env, 'SENTINEL_DEMO_MARKET_PACKAGE_ID', ''),
      adapters: optionalValue(env, 'SENTINEL_ADAPTERS_PACKAGE_ID', ''),
    },

    walrusPublisherUrl: requireValue(env, 'WALRUS_PUBLISHER_URL'),
    walrusAggregatorUrl: requireValue(env, 'WALRUS_AGGREGATOR_URL'),

    databaseUrl: requireValue(env, 'DATABASE_URL'),
    redisUrl: requireValue(env, 'REDIS_URL'),

    rateLimitMax: parseIntValue(env, 'RATE_LIMIT_MAX', 120),
    rateLimitWindowMs: parseIntValue(env, 'RATE_LIMIT_WINDOW_MS', 60_000),

    llm: {
      model: optionalValue(env, 'LLM_MODEL', 'deepseek-v4-flash'),
      baseUrl: optionalValue(env, 'LLM_BASE_URL', 'https://api.deepseek.com'),
    },
  };

  const secrets: AppSecrets = createSecrets({
    // Optional during early scaffolding; required before any on-chain action
    // context is built (see getAgentSignerKey). Loaded from env vars ONLY.
    agentSignerKey: optionalValue(env, 'AGENT_SIGNER_KEY', ''),
    llmApiKey: optionalValue(env, 'LLM_API_KEY', ''),
  });

  return { config, secrets };
}
