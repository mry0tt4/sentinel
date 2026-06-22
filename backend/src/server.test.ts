import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AppConfig } from './config/env.js';
import { createApp } from './server.js';

const testConfig: AppConfig = {
  nodeEnv: 'test',
  port: 0,
  suiRpcUrl: 'https://fullnode.testnet.sui.io:443',
  suiTestnetChainId: '4c78adac',
  packageIds: { policy: '', demoMarket: '', adapters: '' },
  walrusPublisherUrl: 'https://publisher.walrus-testnet.walrus.space',
  walrusAggregatorUrl: 'https://aggregator.walrus-testnet.walrus.space',
  databaseUrl: 'postgresql://localhost:5432/sentinel',
  redisUrl: 'redis://localhost:6379',
  rateLimitMax: 120,
  rateLimitWindowMs: 60_000,
  llm: { model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
};

describe('createApp', () => {
  let server: ReturnType<ReturnType<typeof createApp>['listen']>;
  let baseUrl: string;

  beforeAll(async () => {
    const app = createApp(testConfig);
    await new Promise<void>((resolve) => {
      server = app.listen(0, () => resolve());
    });
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('responds on the health endpoint with testnet status', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.network).toBe('sui:testnet');
  });
});
