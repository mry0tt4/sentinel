// Feature: sentinel-risk-guardian, Property 30: Invalid API input is rejected; rate limit enforced
//
// **Validates: Requirements 15.4, 15.5**
//
// Property 30 has two parts:
//   (a) INVALID INPUT REJECTED (Req 15.4): for ANY request body that violates
//       the policy-draft contract — missing/blank marketId, missing/empty/
//       non-array allowedActions, an action outside VALID_POLICY_ACTIONS, or a
//       policy bound (maxLtvDeltaBps / maxMarginDeltaBps / pauseDurationLimitMs
//       / cooldownMs) that is missing, non-integer, negative, or outside
//       DEFAULT_POLICY_BOUNDS — the backend SHALL reject it with a DESCRIPTIVE
//       error that NAMES the offending field. We exercise this both as a pure
//       function (validatePolicyDraft, covering non-object bodies too) and over
//       the real HTTP endpoint POST /api/policies/draft via supertest.
//   (b) RATE LIMIT ENFORCED (Req 15.5): for ANY configured `max` in a small
//       range, the first `max` valid requests within the window all pass, and
//       the (max+1)-th request within the same window is rejected with HTTP 429.

import request from 'supertest';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../config/env.js';
import type { Repositories } from '../db/repositories/index.js';
import { createApp, type CreateAppDeps } from '../server.js';
import {
  DEFAULT_POLICY_BOUNDS,
  VALID_POLICY_ACTIONS,
  validatePolicyDraft,
  type PolicyBoundsRanges,
} from './actionRoutes.js';

const NUM_RUNS = 100;

const baseConfig: AppConfig = {
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

// The action routes never touch repositories; a bare object satisfies the type.
const emptyRepositories = {} as unknown as Repositories;

function makeApp(overrides: Partial<AppConfig> = {}) {
  const deps: CreateAppDeps = { repositories: emptyRepositories };
  return createApp({ ...baseConfig, ...overrides }, deps);
}

const BOUND_FIELDS = [
  'maxLtvDeltaBps',
  'maxMarginDeltaBps',
  'pauseDurationLimitMs',
  'cooldownMs',
] as const;
type BoundField = (typeof BOUND_FIELDS)[number];

/** A fresh, fully-valid policy-draft body. */
function validBody(): Record<string, unknown> {
  return {
    marketId: 'market-a',
    allowedActions: ['pause_new_borrows', 'reduce_max_ltv'],
    maxLtvDeltaBps: 500,
    maxMarginDeltaBps: 300,
    pauseDurationLimitMs: 3_600_000,
    cooldownMs: 60_000,
  };
}

interface InvalidCase {
  /** The malformed body (or non-object value) to feed the validator/endpoint. */
  body: unknown;
  /** The field the descriptive error MUST name. */
  expectedField: string;
  /** True when `body` is a JSON object (so supertest can POST it sensibly). */
  httpSafe: boolean;
}

const bounds: PolicyBoundsRanges = DEFAULT_POLICY_BOUNDS;

// --- Generators of single-mutation invalid bodies --------------------------
// Each generator starts from a fully-valid body and breaks exactly ONE field,
// so the field validatePolicyDraft reports is deterministic. Validation order
// is marketId -> allowedActions -> maxLtvDeltaBps -> maxMarginDeltaBps ->
// pauseDurationLimitMs -> cooldownMs, so breaking any single field surfaces it.

const marketIdCase: fc.Arbitrary<InvalidCase> = fc
  .oneof(
    fc.constant<{ kind: 'delete' }>({ kind: 'delete' }),
    fc.constant<unknown>('').map((v) => ({ kind: 'set' as const, value: v })),
    fc.constant<unknown>('   ').map((v) => ({ kind: 'set' as const, value: v })),
    fc.integer().map((v) => ({ kind: 'set' as const, value: v })),
    fc.constant<unknown>(null).map((v) => ({ kind: 'set' as const, value: v })),
    fc.boolean().map((v) => ({ kind: 'set' as const, value: v })),
  )
  .map((m): InvalidCase => {
    const body = validBody();
    if (m.kind === 'delete') {
      delete body.marketId;
    } else {
      body.marketId = m.value;
    }
    return { body, expectedField: 'marketId', httpSafe: true };
  });

const allowedActionsContainerCase: fc.Arbitrary<InvalidCase> = fc
  .oneof(
    fc.constant<{ kind: 'delete' }>({ kind: 'delete' }),
    fc.constant<unknown>([]).map((v) => ({ kind: 'set' as const, value: v })),
    fc.string().map((v) => ({ kind: 'set' as const, value: v })),
    fc.integer().map((v) => ({ kind: 'set' as const, value: v })),
    fc.constant<unknown>({}).map((v) => ({ kind: 'set' as const, value: v })),
  )
  .map((m): InvalidCase => {
    const body = validBody();
    if (m.kind === 'delete') {
      delete body.allowedActions;
    } else {
      body.allowedActions = m.value;
    }
    return { body, expectedField: 'allowedActions', httpSafe: true };
  });

// An invalid token (string not in the valid set, or a non-string) placed after
// `prefixLen` valid actions, so the reported field is `allowedActions[prefixLen]`.
const allowedActionsEntryCase: fc.Arbitrary<InvalidCase> = fc
  .record({
    prefixLen: fc.integer({ min: 0, max: 3 }),
    badToken: fc.oneof(
      fc
        .string()
        .filter((s) => !VALID_POLICY_ACTIONS.includes(s)) as fc.Arbitrary<unknown>,
      fc.integer() as fc.Arbitrary<unknown>,
      fc.constant<unknown>(null),
      fc.constant<unknown>('delete_everything'),
    ),
  })
  .map(({ prefixLen, badToken }): InvalidCase => {
    const prefix: string[] = [];
    for (let i = 0; i < prefixLen; i += 1) {
      prefix.push(VALID_POLICY_ACTIONS[i % VALID_POLICY_ACTIONS.length]);
    }
    const body = validBody();
    body.allowedActions = [...prefix, badToken];
    return { body, expectedField: `allowedActions[${prefixLen}]`, httpSafe: true };
  });

function boundCase(field: BoundField): fc.Arbitrary<InvalidCase> {
  const range = bounds[field];
  return fc
    .oneof(
      // Above the max.
      fc.integer({ min: 1, max: 100_000 }).map((d) => ({ value: range.max + d as unknown })),
      // Below the min (min is 0 by default => negative).
      fc.integer({ min: 1, max: 100_000 }).map((d) => ({ value: range.min - d as unknown })),
      // Non-integer within range.
      fc
        .integer({ min: range.min, max: Math.max(range.min, range.max - 1) })
        .map((n) => ({ value: (n + 0.5) as unknown })),
      // Non-number.
      fc.constant<unknown>('not-a-number').map((v) => ({ value: v })),
      fc.constant<unknown>(null).map((v) => ({ value: v })),
      // Missing entirely.
      fc.constant<{ value: '__delete__' }>({ value: '__delete__' }),
    )
    .map((m): InvalidCase => {
      const body = validBody();
      if (m.value === '__delete__') {
        delete body[field];
      } else {
        body[field] = m.value;
      }
      return { body, expectedField: field, httpSafe: true };
    });
}

// Non-object bodies (string/number/array/null/boolean) -> field 'body'.
const nonObjectBodyCase: fc.Arbitrary<InvalidCase> = fc
  .oneof(
    fc.string(),
    fc.integer(),
    fc.double(),
    fc.boolean(),
    fc.constant(null),
    fc.array(fc.integer()),
  )
  .map((value): InvalidCase => ({ body: value, expectedField: 'body', httpSafe: false }));

const invalidCaseArb: fc.Arbitrary<InvalidCase> = fc.oneof(
  marketIdCase,
  allowedActionsContainerCase,
  allowedActionsEntryCase,
  ...BOUND_FIELDS.map(boundCase),
  nonObjectBodyCase,
);

// Object-shaped invalid bodies only — safe to POST through supertest.
const httpInvalidCaseArb = invalidCaseArb.filter((c) => c.httpSafe);

describe('Property 30: invalid API input is rejected (Req 15.4)', () => {
  it('validatePolicyDraft rejects every malformed body and names the offending field', () => {
    fc.assert(
      fc.property(invalidCaseArb, (testCase) => {
        const result = validatePolicyDraft(testCase.body, bounds);
        expect(result.ok).toBe(false);
        if (result.ok) {
          return; // unreachable; keeps the type narrow.
        }
        expect(result.error.field).toBe(testCase.expectedField);
        expect(typeof result.error.message).toBe('string');
        expect(result.error.message.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS * 2 },
    );
  });

  it('POST /api/policies/draft returns a descriptive 400 naming the field', async () => {
    await fc.assert(
      fc.asyncProperty(httpInvalidCaseArb, async (testCase) => {
        // Fresh app per run with a generous limit so rate limiting never
        // interferes with the validation assertion.
        const app = makeApp({ rateLimitMax: 1_000_000 });
        const res = await request(app).post('/api/policies/draft').send(testCase.body as object);

        expect(res.status).toBe(400);
        expect(res.body.error).toBe('invalid_input');
        expect(res.body.field).toBe(testCase.expectedField);
        expect(typeof res.body.message).toBe('string');
        expect(res.body.message.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Property 30: rate limit enforced (Req 15.5)', () => {
  it('passes the first `max` requests then rejects the (max+1)-th with HTTP 429', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (max) => {
        // Fresh app per run so each gets its own in-memory limiter bucket. A
        // large window keeps all requests inside one fixed window. We boot ONE
        // server per run and reuse it for every request in that run (rather
        // than letting supertest bind/teardown an ephemeral server per call),
        // which keeps socket churn bounded and the timing window stable.
        const app = makeApp({ rateLimitMax: max, rateLimitWindowMs: 60_000 });
        const server = app.listen(0);
        try {
          // The first `max` valid draft requests must all pass.
          for (let i = 0; i < max; i += 1) {
            const ok = await request(server).post('/api/policies/draft').send(validBody());
            expect(ok.status).toBe(200);
            expect(ok.body.draft.marketId).toBe('market-a');
          }

          // The (max+1)-th request within the same window is rejected.
          const limited = await request(server).post('/api/policies/draft').send(validBody());
          expect(limited.status).toBe(429);
          expect(limited.body.error).toBe('rate_limited');
          expect(limited.body.limit).toBe(max);
        } finally {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
