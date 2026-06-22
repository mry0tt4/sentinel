// Backend client abstraction for the Simulation Lab. The HTTP transport is
// injectable (a `fetch`-like function) so component tests can drive the
// simulator without a live backend. Mirrors the pattern used by
// `dashboardApi.ts` and `policyApi.ts`. (Design: injectable backend client.)
//
// Wraps the backend action endpoints:
//   POST /api/simulator/start   body `{ scenario }`  (Req 14.1, 14.2)
//   POST /api/simulator/reset                        (Req 14.5)
//   POST /api/actions/override  body `{ request, evaluation, actionContext,
//                                       actionLogId, record }` (Req 11.4, 14.4)

import type { SimRunResult } from './simulatorTypes';

/** Minimal response shape compatible with the Fetch API `Response`. */
export interface BackendResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** Minimal `fetch`-like transport. The global `fetch` satisfies this shape. */
export type BackendFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<BackendResponse>;

/** Successful scenario start: the run result. (Req 14.2) */
export interface StartOk {
  ok: true;
  result: SimRunResult;
}

/** Failed scenario start: a descriptive error. (Req 15.4) */
export interface StartError {
  ok: false;
  field?: string;
  message: string;
}

export type StartResult = StartOk | StartError;

/** Result of a reset. (Req 14.5) */
export interface ResetResult {
  ok: boolean;
  message?: string;
}

/**
 * The DAO override request body for `POST /api/actions/override`. Mirrors the
 * backend `OverrideExecuteRequest` shape; structured/server-controlled — there
 * is no field accepting raw transaction structure. (Req 11.4, 16.4)
 */
export interface OverrideRequestBody {
  request: { operation: string; reason: string; [key: string]: unknown };
  evaluation: Record<string, unknown>;
  actionContext: Record<string, unknown>;
  actionLogId: string;
  record: { policyId: string; marketId: string; daoAddress: string; [key: string]: unknown };
}

/** Outcome of an override operation. Mirrors backend `OverrideResult`. */
export interface OverrideOutcome {
  ok: boolean;
  success?: boolean;
  stage?: string;
  operation?: string;
  txDigest?: string | null;
  blobId?: string | null;
  evidenceHash?: string | null;
  failureReason?: string | null;
  /** A descriptive validation error when the request was rejected. (Req 15.4) */
  field?: string;
  message?: string;
}

/**
 * The simulator backend surface. {@link SimulatorApiClient} implements it; tests
 * may supply a stub.
 */
export interface SimulatorApi {
  /** Start one of the nine named scenarios. (Req 14.1, 14.2) */
  start(scenario: string): Promise<StartResult>;
  /** Reset the Demo_Market + scenario inputs to their initial state. (Req 14.5) */
  reset(): Promise<ResetResult>;
  /** Apply a DAO override / reversal / revocation during a scenario. (Req 14.4) */
  override(body: OverrideRequestBody): Promise<OverrideOutcome>;
}

/**
 * Thin client over the Sentinel backend simulator + override endpoints. All
 * network access goes through the injected {@link BackendFetch}, keeping the
 * simulator testable.
 */
export class SimulatorApiClient implements SimulatorApi {
  private readonly fetchFn: BackendFetch;
  private readonly baseUrl: string;

  constructor(fetchFn: BackendFetch, baseUrl = '') {
    this.fetchFn = fetchFn;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async start(scenario: string): Promise<StartResult> {
    const res = await this.post('/api/simulator/start', { scenario });
    const payload = (await res.json()) as Record<string, unknown>;
    if (res.ok) {
      return { ok: true, result: payload.result as SimRunResult };
    }
    return {
      ok: false,
      field: typeof payload.field === 'string' ? payload.field : undefined,
      message:
        typeof payload.message === 'string'
          ? payload.message
          : `Failed to start scenario (status ${res.status})`,
    };
  }

  async reset(): Promise<ResetResult> {
    const res = await this.post('/api/simulator/reset', {});
    if (res.ok) {
      return { ok: true };
    }
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return {
      ok: false,
      message:
        typeof payload.message === 'string'
          ? payload.message
          : `Failed to reset simulator (status ${res.status})`,
    };
  }

  async override(body: OverrideRequestBody): Promise<OverrideOutcome> {
    const res = await this.post('/api/actions/override', body);
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return {
        ok: false,
        field: typeof payload.field === 'string' ? payload.field : undefined,
        message:
          typeof payload.message === 'string'
            ? payload.message
            : `Override rejected (status ${res.status})`,
      };
    }
    const result = (payload.result ?? {}) as Record<string, unknown>;
    return {
      ok: true,
      success: result.success === true,
      stage: typeof result.stage === 'string' ? result.stage : undefined,
      operation: typeof result.operation === 'string' ? result.operation : undefined,
      txDigest: (result.txDigest as string | null | undefined) ?? null,
      blobId: (result.blobId as string | null | undefined) ?? null,
      evidenceHash: (result.evidenceHash as string | null | undefined) ?? null,
      failureReason: (result.failureReason as string | null | undefined) ?? null,
    };
  }

  private post(path: string, body: unknown): Promise<BackendResponse> {
    return this.fetchFn(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
}

/** Build a {@link SimulatorApiClient} from the global `fetch`, pointed at the backend. */
export function createDefaultSimulatorApiClient(): SimulatorApiClient {
  const baseUrl =
    (typeof import.meta !== 'undefined' && import.meta.env?.PUBLIC_BACKEND_URL) || '';
  const transport: BackendFetch = (url, init) =>
    fetch(url, init) as unknown as Promise<BackendResponse>;
  return new SimulatorApiClient(transport, baseUrl);
}
