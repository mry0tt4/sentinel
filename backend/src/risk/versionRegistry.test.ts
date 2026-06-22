import { describe, expect, it } from 'vitest';

import {
  InMemoryVersionRegistryStore,
  UnknownVersionError,
  VersionNotApprovedError,
  VersionRegistry,
  guardApprovedVersions,
} from './versionRegistry.js';
import { DEFAULT_SCORING_CONFIG } from './scoringEngine.js';

/** A registry backed by a fresh in-memory store with a fixed clock. */
function makeRegistry(now = 1_000): VersionRegistry {
  return new VersionRegistry(new InMemoryVersionRegistryStore(), () => now);
}

const MODEL = DEFAULT_SCORING_CONFIG.modelVersion; // sentinel-risk-engine@0.1.0
const PROMPT = DEFAULT_SCORING_CONFIG.promptConfigVersion; // sentinel-prompt-config@0.1.0

describe('VersionRegistry — register vs approve are distinct', () => {
  it('registering a version leaves it unapproved (registered status)', async () => {
    const registry = makeRegistry();
    const record = await registry.register('model', MODEL);

    expect(record.status).toBe('registered');
    expect(record.registeredAtMs).toBe(1_000);
    expect(record.approvedAtMs).toBeUndefined();
    expect(await registry.isApproved('model', MODEL)).toBe(false);
  });

  it('approving transitions a registered version to approved and records the admin', async () => {
    const registry = makeRegistry(2_000);
    await registry.register('model', MODEL);

    const approved = await registry.approve('model', MODEL, 'admin-alice');

    expect(approved.status).toBe('approved');
    expect(approved.approvedAtMs).toBe(2_000);
    expect(approved.approvedBy).toBe('admin-alice');
    expect(await registry.isApproved('model', MODEL)).toBe(true);
  });

  it('register is idempotent and does not reset an approved version', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    await registry.approve('model', MODEL, 'admin-alice');

    const again = await registry.register('model', MODEL);

    expect(again.status).toBe('approved');
    expect(await registry.isApproved('model', MODEL)).toBe(true);
  });

  it('approve is idempotent for an already-approved version', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    const first = await registry.approve('model', MODEL, 'admin-alice');
    const second = await registry.approve('model', MODEL, 'admin-bob');

    // Stays approved; the original approval metadata is preserved.
    expect(second.status).toBe('approved');
    expect(second.approvedBy).toBe(first.approvedBy);
  });
});

describe('VersionRegistry — unknown versions are blocked', () => {
  it('isApproved is false for a version that was never registered', async () => {
    const registry = makeRegistry();
    expect(await registry.isApproved('model', 'never-seen@9.9.9')).toBe(false);
  });

  it('approving an unregistered version throws UnknownVersionError', async () => {
    const registry = makeRegistry();
    await expect(registry.approve('prompt', 'ghost@1.0.0', 'admin-alice')).rejects.toBeInstanceOf(
      UnknownVersionError,
    );
  });

  it('checkPair reports unknown versions with status "unknown"', async () => {
    const registry = makeRegistry();
    const result = await registry.checkPair(MODEL, PROMPT);

    expect(result.approved).toBe(false);
    if (!result.approved) {
      expect(result.unapproved).toEqual([
        { kind: 'model', version: MODEL, status: 'unknown' },
        { kind: 'prompt', version: PROMPT, status: 'unknown' },
      ]);
    }
  });
});

describe('VersionRegistry — pair approval gate (Req 16.10)', () => {
  it('blocks until both versions are approved, then allows', async () => {
    const registry = makeRegistry();

    // Nothing registered → blocked.
    expect(await registry.isPairApproved(MODEL, PROMPT)).toBe(false);

    // Registered but not approved → still blocked.
    await registry.register('model', MODEL);
    await registry.register('prompt', PROMPT);
    expect(await registry.isPairApproved(MODEL, PROMPT)).toBe(false);

    // Only the model approved → still blocked (prompt outstanding).
    await registry.approve('model', MODEL, 'admin-alice');
    expect(await registry.isPairApproved(MODEL, PROMPT)).toBe(false);
    const partial = await registry.checkPair(MODEL, PROMPT);
    expect(partial.approved).toBe(false);
    if (!partial.approved) {
      expect(partial.unapproved).toEqual([{ kind: 'prompt', version: PROMPT, status: 'registered' }]);
    }

    // Both approved → allowed.
    await registry.approve('prompt', PROMPT, 'admin-alice');
    expect(await registry.isPairApproved(MODEL, PROMPT)).toBe(true);
    expect(await registry.checkPair(MODEL, PROMPT)).toEqual({ approved: true });
  });
});

describe('guardApprovedVersions — fail-closed engine guard (Req 16.10)', () => {
  it('throws VersionNotApprovedError for an unapproved configuration', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    await registry.register('prompt', PROMPT);
    // Neither approved.

    await expect(guardApprovedVersions(registry, MODEL, PROMPT)).rejects.toBeInstanceOf(
      VersionNotApprovedError,
    );
  });

  it('carries the offending versions on the thrown error', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    await registry.approve('model', MODEL, 'admin-alice');
    // Prompt never registered.

    await expect(guardApprovedVersions(registry, MODEL, PROMPT)).rejects.toMatchObject({
      name: 'VersionNotApprovedError',
      unapproved: [{ kind: 'prompt', version: PROMPT, status: 'unknown' }],
    });
  });

  it('passes (does not throw) once both versions are approved', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    await registry.register('prompt', PROMPT);
    await registry.approve('model', MODEL, 'admin-alice');
    await registry.approve('prompt', PROMPT, 'admin-alice');

    await expect(guardApprovedVersions(registry, MODEL, PROMPT)).resolves.toBeUndefined();
  });

  it('assertPairApproved resolves for approved versions and rejects otherwise', async () => {
    const registry = makeRegistry();
    await registry.register('model', MODEL);
    await registry.approve('model', MODEL, 'admin-alice');
    await registry.register('prompt', PROMPT);
    await registry.approve('prompt', PROMPT, 'admin-alice');

    await expect(registry.assertPairApproved(MODEL, PROMPT)).resolves.toBeUndefined();
    await expect(registry.assertPairApproved(MODEL, 'other-prompt@2.0.0')).rejects.toBeInstanceOf(
      VersionNotApprovedError,
    );
  });
});
