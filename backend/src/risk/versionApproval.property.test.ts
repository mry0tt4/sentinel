// Feature: sentinel-risk-guardian, Property 31: Model/prompt version requires approval before use
//
// For any (modelVersion, promptConfigVersion) pair and any sequence of
// register/approve operations, the approval gate is exactly equivalent to
// "both versions are admin-approved":
//   (a) an unregistered OR registered-but-not-approved version BLOCKS use
//       (guardApprovedVersions / assertPairApproved throws, isPairApproved false);
//   (b) once BOTH versions are approved, use is allowed (no throw, true);
//   (c) registering without approving never allows use.
// The gate decision matches approved-set membership exactly. (Req 16.10)
//
// Validates: Requirements 16.10

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemoryVersionRegistryStore,
  VersionNotApprovedError,
  VersionRegistry,
  guardApprovedVersions,
} from './versionRegistry.js';

/** A fresh registry backed by an in-memory store with a pinned clock. */
function makeRegistry(): VersionRegistry {
  return new VersionRegistry(new InMemoryVersionRegistryStore(), () => 1_000);
}

/** Lifecycle state a version can be placed into before the gate is checked. */
type VersionState = 'absent' | 'registered' | 'approved';

const versionStateArb: fc.Arbitrary<VersionState> = fc.constantFrom(
  'absent',
  'registered',
  'approved',
);

/**
 * Arbitrary version identifiers: includes empty strings, unicode, duplicates,
 * and registry-key-like separators (`::`) to probe key collisions.
 */
const versionNameArb: fc.Arbitrary<string> = fc.oneof(
  fc.string(),
  fc.constantFrom('', '::', 'a::b', 'sentinel-risk-engine@0.1.0', 'sentinel-prompt-config@0.1.0'),
  fc.fullUnicodeString(),
);

/**
 * Drive a single version into the requested lifecycle state. Returns whether the
 * version ends up admin-approved (the only state the gate accepts).
 */
async function applyState(
  registry: VersionRegistry,
  kind: 'model' | 'prompt',
  version: string,
  state: VersionState,
): Promise<boolean> {
  if (state === 'absent') return false;
  await registry.register(kind, version);
  if (state === 'registered') return false;
  await registry.approve(kind, version, 'admin-test');
  return true;
}

describe('Property 31: Model/prompt version requires approval before use', () => {
  it('the gate is allowed iff BOTH versions are admin-approved', async () => {
    await fc.assert(
      fc.asyncProperty(
        versionNameArb,
        versionNameArb,
        versionStateArb,
        versionStateArb,
        async (modelVersion, promptVersion, modelState, promptState) => {
          const registry = makeRegistry();

          const modelApproved = await applyState(registry, 'model', modelVersion, modelState);
          const promptApproved = await applyState(registry, 'prompt', promptVersion, promptState);

          const shouldAllow = modelApproved && promptApproved;

          // (a)/(b): isPairApproved tracks approved-set membership exactly.
          expect(await registry.isPairApproved(modelVersion, promptVersion)).toBe(shouldAllow);

          // checkPair agrees with the boolean predicate.
          const result = await registry.checkPair(modelVersion, promptVersion);
          expect(result.approved).toBe(shouldAllow);

          // The throwing guards mirror the same decision.
          if (shouldAllow) {
            await expect(
              guardApprovedVersions(registry, modelVersion, promptVersion),
            ).resolves.toBeUndefined();
            await expect(
              registry.assertPairApproved(modelVersion, promptVersion),
            ).resolves.toBeUndefined();
          } else {
            await expect(
              guardApprovedVersions(registry, modelVersion, promptVersion),
            ).rejects.toBeInstanceOf(VersionNotApprovedError);
            await expect(
              registry.assertPairApproved(modelVersion, promptVersion),
            ).rejects.toBeInstanceOf(VersionNotApprovedError);

            // (c): an unapproved version is reported as the blocking cause, and
            // its reported status is never "approved".
            if (!result.approved) {
              expect(result.unapproved.length).toBeGreaterThan(0);
              for (const u of result.unapproved) {
                expect(u.status).not.toBe('approved');
              }
            }
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('registering versions without approving NEVER allows use', async () => {
    await fc.assert(
      fc.asyncProperty(versionNameArb, versionNameArb, async (modelVersion, promptVersion) => {
        const registry = makeRegistry();

        // Register both kinds but approve neither.
        await registry.register('model', modelVersion);
        await registry.register('prompt', promptVersion);

        expect(await registry.isPairApproved(modelVersion, promptVersion)).toBe(false);
        await expect(
          guardApprovedVersions(registry, modelVersion, promptVersion),
        ).rejects.toBeInstanceOf(VersionNotApprovedError);
      }),
      { numRuns: 150 },
    );
  });

  it('gate over a universe of versions matches approved-set membership exactly', async () => {
    await fc.assert(
      fc.asyncProperty(
        // A pool of distinct model and prompt version names...
        fc.uniqueArray(versionNameArb, { minLength: 1, maxLength: 6 }),
        fc.uniqueArray(versionNameArb, { minLength: 1, maxLength: 6 }),
        // ...with random subsets (by index) chosen to register and to approve.
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        fc.array(fc.nat(), { maxLength: 12 }),
        async (
          models,
          prompts,
          modelRegIdx,
          modelAppIdx,
          promptRegIdx,
          promptAppIdx,
        ) => {
          const registry = makeRegistry();

          const pick = (pool: string[], idxs: number[]): Set<string> =>
            new Set(idxs.map((i) => pool[i % pool.length]));

          const registeredModels = pick(models, modelRegIdx);
          // Approval only takes effect for versions that were registered.
          const approvedModels = new Set(
            [...pick(models, modelAppIdx)].filter((v) => registeredModels.has(v)),
          );
          const registeredPrompts = pick(prompts, promptRegIdx);
          const approvedPrompts = new Set(
            [...pick(prompts, promptAppIdx)].filter((v) => registeredPrompts.has(v)),
          );

          for (const v of registeredModels) await registry.register('model', v);
          for (const v of approvedModels) await registry.approve('model', v, 'admin-test');
          for (const v of registeredPrompts) await registry.register('prompt', v);
          for (const v of approvedPrompts) await registry.approve('prompt', v, 'admin-test');

          // For every (model, prompt) pair in the universe, the gate decision
          // must equal membership in both approved sets — nothing more, nothing less.
          for (const m of models) {
            for (const p of prompts) {
              const expected = approvedModels.has(m) && approvedPrompts.has(p);
              expect(await registry.isPairApproved(m, p)).toBe(expected);

              if (expected) {
                await expect(guardApprovedVersions(registry, m, p)).resolves.toBeUndefined();
              } else {
                await expect(guardApprovedVersions(registry, m, p)).rejects.toBeInstanceOf(
                  VersionNotApprovedError,
                );
              }
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
