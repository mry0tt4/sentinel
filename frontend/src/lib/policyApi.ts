// Backend client abstraction for the policy wizard. The HTTP transport is
// injectable (a `fetch`-like function) so component tests can drive the wizard
// without a live backend. (Design: "Use a backend client abstraction.")
//
// Reuses the backend `/api/policies/draft` endpoint for server-side validation
// + range-validation of bounds (Req 4.9) and persists the deployed policy
// record on success (Req 4.10).

import type { PolicyDraftBody } from './policyWizard';

/** Minimal response shape compatible with the Fetch API `Response`. */
export interface BackendResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal `fetch`-like transport. The global `fetch` satisfies this shape. */
export type BackendFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<BackendResponse>;

/** Successful draft validation: the normalized server draft. */
export interface DraftOk {
  ok: true;
  draft: Record<string, unknown>;
}

/** Failed draft validation: the offending field + descriptive message. (Req 4.9) */
export interface DraftError {
  ok: false;
  field: string;
  message: string;
}

export type DraftResult = DraftOk | DraftError;

/** The persisted policy record, including the deployment transaction digest. (Req 4.10) */
export interface PersistedPolicy extends PolicyDraftBody {
  txDigest: string;
}

export interface PersistResult {
  ok: boolean;
  status: number;
}

/**
 * The policy backend surface the wizard depends on. {@link PolicyApiClient}
 * implements it; tests may supply a stub. (Design: injectable backend client.)
 */
export interface PolicyApi {
  draft(body: PolicyDraftBody): Promise<DraftResult>;
  persist(record: PersistedPolicy): Promise<PersistResult>;
}

/**
 * Thin client over the Sentinel backend policy endpoints. All network access
 * goes through the injected {@link BackendFetch}, keeping the wizard testable.
 */
export class PolicyApiClient implements PolicyApi {
  private readonly fetchFn: BackendFetch;
  private readonly baseUrl: string;

  constructor(fetchFn: BackendFetch, baseUrl = '') {
    this.fetchFn = fetchFn;
    // Normalize away a trailing slash so paths join cleanly.
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  /**
   * Validate + range-validate a policy draft via `POST /api/policies/draft`.
   * Returns the server-normalized draft, or the field + message of the first
   * invalid value. (Req 4.9)
   */
  async draft(body: PolicyDraftBody): Promise<DraftResult> {
    const res = await this.post('/api/policies/draft', body);
    const payload = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      return { ok: true, draft: (payload.draft as Record<string, unknown>) ?? {} };
    }
    return {
      ok: false,
      field: typeof payload.field === 'string' ? payload.field : 'unknown',
      message:
        typeof payload.message === 'string'
          ? payload.message
          : 'The policy configuration was rejected by the backend.',
    };
  }

  /**
   * Persist the deployed policy record (with its transaction digest) via
   * `POST /api/policies`. (Req 4.10)
   */
  async persist(record: PersistedPolicy): Promise<PersistResult> {
    const res = await this.post('/api/policies', record);
    return { ok: res.ok, status: res.status };
  }

  private post(path: string, body: unknown): Promise<BackendResponse> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

/** Build a {@link PolicyApiClient} from the global `fetch`, pointed at the backend. */
export function createDefaultPolicyApiClient(): PolicyApiClient {
  const baseUrl =
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_BACKEND_URL) || '';
  const transport: BackendFetch = (url, init) =>
    fetch(url, init) as unknown as Promise<BackendResponse>;
  return new PolicyApiClient(transport, baseUrl);
}
