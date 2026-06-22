/**
 * Model / prompt version registry with an admin approval gate (task 7.10).
 *
 * Sentinel's evidence is only reproducible if the exact risk-model version and
 * prompt/config version behind every gating evaluation are known *and* were
 * vetted before use. Req 16.10 makes that a hard rule:
 *
 *   "WHERE a risk model or prompt version changes, THE Backend SHALL require
 *    admin approval before the new version is used."
 *
 * This module is the gate. It persists every registered risk-model version and
 * prompt/config version together with an approval status, and exposes a guard
 * the Risk_Engine evaluation path calls *before* producing a gating evaluation.
 * If either configured version has not been approved by an admin, the guard
 * **blocks** — Sentinel fails closed and refuses to run on an unapproved version
 * rather than silently using it. (Req 16.10, 17.* fail-closed principle)
 *
 * Lifecycle of a version: `registered` → (admin approves) → `approved`.
 * Registering and approving are deliberately distinct steps: a version becoming
 * known to the system is *not* the same as an admin blessing it for use.
 *
 * Persistence is behind an injectable port ({@link VersionRegistryStore}) so it
 * can be backed by Postgres later; the in-memory default
 * ({@link InMemoryVersionRegistryStore}) is used in tests and for local runs.
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

/** Which kind of version a record describes. */
export type VersionKind = 'model' | 'prompt';

/**
 * Approval status of a version. A version is only usable in the gating path
 * once it reaches `approved`. (Req 16.10)
 */
export type VersionStatus = 'registered' | 'approved';

/** A persisted version record and its approval state. */
export interface VersionRecord {
  /** Whether this is a risk-model version or a prompt/config version. */
  kind: VersionKind;
  /** The version identifier, e.g. `sentinel-risk-engine@0.1.0`. */
  version: string;
  /** Current approval status. */
  status: VersionStatus;
  /** Epoch ms when the version was first registered. */
  registeredAtMs: number;
  /** Epoch ms when an admin approved the version, when approved. */
  approvedAtMs?: number;
  /** Identifier of the admin who approved the version, when approved. */
  approvedBy?: string;
  /** Optional free-form note (e.g. change summary, approval rationale). */
  notes?: string;
}

// ---------------------------------------------------------------------------
// Persistence port
// ---------------------------------------------------------------------------

/**
 * Persistence port for version records. Async so a Postgres-backed
 * implementation can drop in unchanged; the in-memory default below satisfies
 * the same contract for unit tests and local runs.
 */
export interface VersionRegistryStore {
  /** Fetch a record by its (kind, version) key, or `undefined` if absent. */
  get(kind: VersionKind, version: string): Promise<VersionRecord | undefined>;
  /** Insert or replace a record (keyed by kind + version). */
  put(record: VersionRecord): Promise<void>;
  /** Return all stored records (order unspecified). */
  list(): Promise<VersionRecord[]>;
}

/** Stable composite key for a (kind, version) pair. */
function keyOf(kind: VersionKind, version: string): string {
  return `${kind}::${version}`;
}

/**
 * Default in-memory {@link VersionRegistryStore}. Records are cloned on the way
 * in and out so callers cannot mutate persisted state by reference.
 */
export class InMemoryVersionRegistryStore implements VersionRegistryStore {
  private readonly records = new Map<string, VersionRecord>();

  async get(kind: VersionKind, version: string): Promise<VersionRecord | undefined> {
    const found = this.records.get(keyOf(kind, version));
    return found ? { ...found } : undefined;
  }

  async put(record: VersionRecord): Promise<void> {
    this.records.set(keyOf(record.kind, record.version), { ...record });
  }

  async list(): Promise<VersionRecord[]> {
    return Array.from(this.records.values(), (r) => ({ ...r }));
  }
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown by the guard when one or both configured versions are not approved.
 * Carries the offending versions so callers can surface a precise refusal.
 */
export class VersionNotApprovedError extends Error {
  constructor(
    message: string,
    readonly unapproved: UnapprovedVersion[],
  ) {
    super(message);
    this.name = 'VersionNotApprovedError';
  }
}

/** Thrown when approving a version that was never registered. */
export class UnknownVersionError extends Error {
  constructor(
    readonly kind: VersionKind,
    readonly version: string,
  ) {
    super(`cannot approve unknown ${kind} version "${version}"; register it first`);
    this.name = 'UnknownVersionError';
  }
}

// ---------------------------------------------------------------------------
// Gate result types
// ---------------------------------------------------------------------------

/** A version that blocked the gate, with why it is not usable. */
export interface UnapprovedVersion {
  kind: VersionKind;
  version: string;
  /** `unknown` when the version was never registered; otherwise its status. */
  status: VersionStatus | 'unknown';
}

/**
 * Typed result of checking a (modelVersion, promptConfigVersion) pair against
 * the registry. `approved` is true only when *both* versions are approved.
 */
export type VersionGateResult =
  | { approved: true }
  | { approved: false; reason: string; unapproved: UnapprovedVersion[] };

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Monotonic-ish clock seam so tests can pin timestamps. */
export type Clock = () => number;

/**
 * The version registry. Wraps a {@link VersionRegistryStore} with the
 * register → approve lifecycle and the approval-gate checks Req 16.10 requires.
 */
export class VersionRegistry {
  constructor(
    private readonly store: VersionRegistryStore = new InMemoryVersionRegistryStore(),
    private readonly clock: Clock = () => Date.now(),
  ) {}

  /**
   * Register a version so the system knows about it. Idempotent: registering an
   * already-known version returns the existing record unchanged (so an
   * already-approved version is *not* silently reset to `registered`).
   * Registration alone does **not** make a version usable — an admin must still
   * approve it. (Req 16.10)
   */
  async register(kind: VersionKind, version: string, notes?: string): Promise<VersionRecord> {
    const existing = await this.store.get(kind, version);
    if (existing) return existing;

    const record: VersionRecord = {
      kind,
      version,
      status: 'registered',
      registeredAtMs: this.clock(),
      notes,
    };
    await this.store.put(record);
    return record;
  }

  /**
   * Approve a previously-registered version (the admin action). Throws
   * {@link UnknownVersionError} if the version was never registered — approving
   * and registering are distinct steps and an unknown version can never be
   * approved into existence. Idempotent for an already-approved version.
   * (Req 16.10)
   */
  async approve(kind: VersionKind, version: string, approvedBy: string, notes?: string): Promise<VersionRecord> {
    const existing = await this.store.get(kind, version);
    if (!existing) throw new UnknownVersionError(kind, version);
    if (existing.status === 'approved') return existing;

    const approved: VersionRecord = {
      ...existing,
      status: 'approved',
      approvedAtMs: this.clock(),
      approvedBy,
      notes: notes ?? existing.notes,
    };
    await this.store.put(approved);
    return approved;
  }

  /** Fetch the stored record for a version, or `undefined` if unknown. */
  async get(kind: VersionKind, version: string): Promise<VersionRecord | undefined> {
    return this.store.get(kind, version);
  }

  /** All stored version records. */
  async list(): Promise<VersionRecord[]> {
    return this.store.list();
  }

  /** Whether a single version is registered *and* approved. */
  async isApproved(kind: VersionKind, version: string): Promise<boolean> {
    const record = await this.store.get(kind, version);
    return record?.status === 'approved';
  }

  /**
   * Whether *both* the model version and the prompt/config version are
   * approved. This is the core Req 16.10 predicate — a true result is the only
   * condition under which the gating path may run on these versions.
   */
  async isPairApproved(modelVersion: string, promptConfigVersion: string): Promise<boolean> {
    const result = await this.checkPair(modelVersion, promptConfigVersion);
    return result.approved;
  }

  /**
   * Check a (modelVersion, promptConfigVersion) pair and return a typed result.
   * Unknown and `registered`-but-not-approved versions both block. (Req 16.10)
   */
  async checkPair(modelVersion: string, promptConfigVersion: string): Promise<VersionGateResult> {
    const unapproved: UnapprovedVersion[] = [];

    const modelRecord = await this.store.get('model', modelVersion);
    if (modelRecord?.status !== 'approved') {
      unapproved.push({ kind: 'model', version: modelVersion, status: modelRecord?.status ?? 'unknown' });
    }

    const promptRecord = await this.store.get('prompt', promptConfigVersion);
    if (promptRecord?.status !== 'approved') {
      unapproved.push({ kind: 'prompt', version: promptConfigVersion, status: promptRecord?.status ?? 'unknown' });
    }

    if (unapproved.length === 0) return { approved: true };

    const detail = unapproved
      .map((u) => `${u.kind} version "${u.version}" (${u.status})`)
      .join('; ');
    return {
      approved: false,
      reason: `blocked by version approval gate: ${detail} not approved by an admin`,
      unapproved,
    };
  }

  /**
   * Assert that both versions are approved, throwing
   * {@link VersionNotApprovedError} otherwise. The throwing form for callers
   * that prefer exceptions over branching on a result. (Req 16.10)
   */
  async assertPairApproved(modelVersion: string, promptConfigVersion: string): Promise<void> {
    const result = await this.checkPair(modelVersion, promptConfigVersion);
    if (!result.approved) {
      throw new VersionNotApprovedError(result.reason, result.unapproved);
    }
  }
}

// ---------------------------------------------------------------------------
// Engine guard
// ---------------------------------------------------------------------------

/**
 * The guard the Risk_Engine evaluation path calls *before* producing a gating
 * evaluation. It blocks (throws {@link VersionNotApprovedError}) when the
 * configured model or prompt/config version has not been admin-approved, so the
 * system fails closed rather than silently evaluating on an unapproved version.
 * (Req 16.10)
 *
 * @throws {VersionNotApprovedError} when either version is not approved.
 */
export async function guardApprovedVersions(
  registry: VersionRegistry,
  modelVersion: string,
  promptConfigVersion: string,
): Promise<void> {
  await registry.assertPairApproved(modelVersion, promptConfigVersion);
}
