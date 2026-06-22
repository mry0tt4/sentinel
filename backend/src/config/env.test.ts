import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { inspect } from 'node:util';

import {
  ConfigError,
  getAgentSignerKey,
  loadConfig,
  redactSecrets,
  REDACTED,
  SECRET_ENV_KEYS,
  toPublicConfig,
  type EnvSource,
} from './env.js';

const baseEnv: EnvSource = {
  NODE_ENV: 'test',
  SUI_RPC_URL: 'https://fullnode.testnet.sui.io:443',
  SUI_TESTNET_CHAIN_ID: '4c78adac',
  WALRUS_PUBLISHER_URL: 'https://publisher.walrus-testnet.walrus.space',
  WALRUS_AGGREGATOR_URL: 'https://aggregator.walrus-testnet.walrus.space',
  DATABASE_URL: 'postgresql://sentinel:sentinel@localhost:5432/sentinel',
  REDIS_URL: 'redis://localhost:6379',
};

describe('loadConfig', () => {
  it('loads a valid configuration from the environment source', () => {
    const { config, secrets } = loadConfig(baseEnv);

    expect(config.nodeEnv).toBe('test');
    expect(config.suiRpcUrl).toBe('https://fullnode.testnet.sui.io:443');
    expect(config.suiTestnetChainId).toBe('4c78adac');
    expect(secrets.agentSignerKey).toBe('');
  });

  it('applies defaults for optional numeric values', () => {
    const { config } = loadConfig(baseEnv);

    expect(config.port).toBe(4000);
    expect(config.rateLimitMax).toBe(120);
    expect(config.rateLimitWindowMs).toBe(60_000);
  });

  it('keeps the agent signer key separate from non-secret config', () => {
    const { config, secrets } = loadConfig({ ...baseEnv, AGENT_SIGNER_KEY: 'super-secret' });

    expect(secrets.agentSignerKey).toBe('super-secret');
    expect(JSON.stringify(config)).not.toContain('super-secret');
  });

  it('throws when a required variable is missing', () => {
    const { SUI_RPC_URL: _omit, ...incomplete } = baseEnv;

    expect(() => loadConfig(incomplete)).toThrow(ConfigError);
  });

  it('throws when a numeric variable is not a non-negative integer', () => {
    expect(() => loadConfig({ ...baseEnv, PORT: 'not-a-number' })).toThrow(ConfigError);
  });

  it('throws on an invalid NODE_ENV', () => {
    expect(() => loadConfig({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(ConfigError);
  });
});

describe('secret hardening', () => {
  const secretEnv: EnvSource = {
    ...baseEnv,
    AGENT_SIGNER_KEY: 'suiprivkey-agent-1234567890',
    LLM_API_KEY: 'sk-llm-abcdef0987654321',
  };

  it('loads secrets from environment variables only and exposes them via property access', () => {
    const { secrets } = loadConfig(secretEnv);

    expect(secrets.agentSignerKey).toBe('suiprivkey-agent-1234567890');
    expect(secrets.llmApiKey).toBe('sk-llm-abcdef0987654321');
  });

  it('never serializes secret values through JSON.stringify (client-facing surface)', () => {
    const { secrets } = loadConfig(secretEnv);

    const serialized = JSON.stringify(secrets);
    expect(serialized).not.toContain('suiprivkey-agent-1234567890');
    expect(serialized).not.toContain('sk-llm-abcdef0987654321');
    expect(serialized).toContain(REDACTED);
  });

  it('never leaks secret values through util.inspect / console logging', () => {
    const { secrets } = loadConfig(secretEnv);

    const logged = inspect(secrets, { depth: null });
    expect(logged).not.toContain('suiprivkey-agent-1234567890');
    expect(logged).not.toContain('sk-llm-abcdef0987654321');
    expect(logged).toContain(REDACTED);
  });

  it('produces a public config view that structurally excludes secret values', () => {
    const loaded = loadConfig(secretEnv);
    const publicConfig = toPublicConfig(loaded);

    const serialized = JSON.stringify(publicConfig);
    expect(serialized).not.toContain('suiprivkey-agent-1234567890');
    expect(serialized).not.toContain('sk-llm-abcdef0987654321');

    // Presence is reported without revealing the values.
    expect(publicConfig.secretsPresent.agentSignerKey).toBe(true);
    expect(publicConfig.secretsPresent.llmApiKey).toBe(true);
    expect('agentSignerKey' in publicConfig).toBe(false);
    expect('llmApiKey' in publicConfig).toBe(false);
  });

  it('reports secret absence in the public view when not configured', () => {
    const publicConfig = toPublicConfig(loadConfig(baseEnv));

    expect(publicConfig.secretsPresent.agentSignerKey).toBe(false);
    expect(publicConfig.secretsPresent.llmApiKey).toBe(false);
  });

  it('getAgentSignerKey returns the key when configured', () => {
    const { secrets } = loadConfig(secretEnv);
    expect(getAgentSignerKey(secrets)).toBe('suiprivkey-agent-1234567890');
  });

  it('getAgentSignerKey throws when the agent key is missing (required before on-chain actions)', () => {
    const { secrets } = loadConfig(baseEnv);
    expect(() => getAgentSignerKey(secrets)).toThrow(ConfigError);
  });

  it('redactSecrets scrubs secret values from arbitrary payloads before logging', () => {
    const { secrets } = loadConfig(secretEnv);

    const payload = {
      message: 'signing with key suiprivkey-agent-1234567890',
      nested: { token: 'sk-llm-abcdef0987654321', safe: 'ok' },
      list: ['prefix-suiprivkey-agent-1234567890-suffix'],
    };

    const scrubbed = redactSecrets(payload, secrets);
    const serialized = JSON.stringify(scrubbed);

    expect(serialized).not.toContain('suiprivkey-agent-1234567890');
    expect(serialized).not.toContain('sk-llm-abcdef0987654321');
    expect(scrubbed.nested.safe).toBe('ok');
    expect(scrubbed.message).toContain(REDACTED);
  });

  it('exposes the canonical set of secret env keys', () => {
    expect(SECRET_ENV_KEYS).toContain('AGENT_SIGNER_KEY');
    expect(SECRET_ENV_KEYS).toContain('LLM_API_KEY');
  });

  // Property: for ANY non-empty secret values, neither the hardened secrets
  // object nor the public config view ever exposes them through serialization
  // or logging. Secrets are loaded from env vars only and stay client-safe.
  it('never exposes any secret value in serialized/logged output (property)', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1 }).map((s) => `ZZAGENT_${s}_ZZ`),
        fc.string({ minLength: 1 }).map((s) => `ZZLLM_${s}_ZZ`),
        (agentKey, llmKey) => {
          const loaded = loadConfig({
            ...baseEnv,
            AGENT_SIGNER_KEY: agentKey,
            LLM_API_KEY: llmKey,
          });

          const publicSerialized = JSON.stringify(toPublicConfig(loaded));
          const configSerialized = JSON.stringify(loaded.config);
          const secretsSerialized = JSON.stringify(loaded.secrets);
          const secretsLogged = inspect(loaded.secrets, { depth: null });

          // The public view and non-secret config never contain the raw values.
          expect(publicSerialized.includes(agentKey)).toBe(false);
          expect(publicSerialized.includes(llmKey)).toBe(false);
          expect(configSerialized.includes(agentKey)).toBe(false);
          expect(configSerialized.includes(llmKey)).toBe(false);

          // Serializing/logging the secrets object itself yields only redactions.
          expect(secretsSerialized.includes(agentKey)).toBe(false);
          expect(secretsSerialized.includes(llmKey)).toBe(false);
          expect(secretsLogged.includes(agentKey)).toBe(false);
          expect(secretsLogged.includes(llmKey)).toBe(false);

          // But legitimate property access still returns the real values.
          expect(loaded.secrets.agentSignerKey).toBe(agentKey);
          expect(loaded.secrets.llmApiKey).toBe(llmKey);
        },
      ),
      { numRuns: 200 },
    );
  });
});
