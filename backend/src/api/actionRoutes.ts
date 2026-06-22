/**
 * REST action endpoints (Req 15.2, 15.4, 15.5, 4.9).
 *
 * Mirrors {@link ./readRoutes.ts}: this module is self-contained and exports an
 * Express `Router` carrying ONLY the write/action-side routes plus the small
 * types/helpers they need. `createApp` mounts it under `/api` as a *second*
 * router, alongside the read router, without either editing or colliding with
 * the other.
 *
 * Endpoints (all POST):
 *   POST /api/policies/draft     — validate + draft a policy config; range-
 *                                  validates every policy bound (Req 4.9)
 *   POST /api/policies/simulate  — dry-run a policy deployment (Req 15.2)
 *   POST /api/actions/recommend  — run the Risk_Engine, return a recommendation
 *                                  which may be a refusal + reason (Req 6.7–6.10)
 *   POST /api/actions/execute    — run the full network+simulation-gated action
 *                                  flow via the injected ActionExecutor port
 *   POST /api/evidence/upload    — upload an Evidence_Bundle via the injected
 *                                  EvidenceService port (Req 10)
 *   POST /api/simulator/start    — start one of the nine named scenarios (14.1)
 *   POST /api/simulator/reset    — reset the demo market + scenario (Req 14.5)
 *
 * Every endpoint validates its input and returns a DESCRIPTIVE error (HTTP 400,
 * naming the invalid field) on bad input (Req 15.4); the policy endpoints
 * additionally range-validate all bounds and identify the invalid value
 * (Req 4.9). A configurable rate limiter (Req 15.5) is applied to the whole
 * router; excess requests get HTTP 429.
 *
 * Service collaborators are injected as narrow ports so HTTP tests drive the
 * router with fakes — no live RPC, database, or Walrus. (Req 15.2)
 */

import { Router, type Request, type RequestHandler, type Response } from 'express';

import type { ActionResult, ExecuteRequest } from '../action/actionExecutor.js';
import type { OverrideExecuteRequest, OverrideResult } from '../action/overrideExecutor.js';
import { VALID_OVERRIDE_OPERATIONS } from '../action/types.js';
import type { EvidenceBundle } from '../evidence/types.js';
import type {
  FailClosedGuardContext,
  GuardedRiskEvaluation,
} from '../risk/failClosedRiskEngine.js';
import type { FeatureVector } from '../risk/types.js';
import { createRateLimiter } from './rateLimiter.js';

// ---------------------------------------------------------------------------
// Injected service ports (narrowed for easy faking — no live infra). (Req 15.2)
// ---------------------------------------------------------------------------

/** Port over the (fail-closed) Risk_Engine used by `/api/actions/recommend`. */
export interface RiskRecommenderPort {
  recommend(input: {
    marketId: string;
    features: FeatureVector;
    guard?: FailClosedGuardContext;
  }): Promise<GuardedRiskEvaluation> | GuardedRiskEvaluation;
}

/** Port over {@link import('../action/actionExecutor.js').ActionExecutor.execute}. */
export interface ActionExecutorPort {
  execute(input: ExecuteRequest): Promise<ActionResult>;
}

/**
 * Port over {@link import('../action/overrideExecutor.js').OverrideExecutor.execute}.
 * Drives the DAO Override_Console operations (reverse / revoke / update / unpause).
 * (Req 11.4, 11.5, 11.6, 12.1)
 */
export interface OverrideExecutorPort {
  execute(input: OverrideExecuteRequest): Promise<OverrideResult>;
}

/** Port over {@link import('../evidence/evidenceService.js').EvidenceService.upload}. */
export interface EvidenceUploaderPort {
  upload(bundle: EvidenceBundle): Promise<{ blobId: string; evidenceHash: string }>;
}

/** Port over the Simulation_Lab for scenario start/reset. */
export interface SimulatorPort {
  start(scenarioId: string): Promise<unknown> | unknown;
  reset(): Promise<unknown> | unknown;
}

/**
 * Port that persists a deployed policy record (with its on-chain deployment tx
 * digest) after the wizard signs the `create_policy` PTB. (Req 4.10)
 */
export interface PolicyPersisterPort {
  persist(input: DraftedPolicy & { txDigest: string }): Promise<{ id: string }>;
}

/** Port over a policy-deployment dry-run for `/api/policies/simulate`. */
export interface PolicyDeploymentSimulatorPort {
  simulate(draft: DraftedPolicy): Promise<unknown> | unknown;
}

/** The injectable services the action routes delegate to. All optional. */
export interface ActionRouteServices {
  recommend?: RiskRecommenderPort;
  execute?: ActionExecutorPort;
  overrideExecute?: OverrideExecutorPort;
  uploadEvidence?: EvidenceUploaderPort;
  simulator?: SimulatorPort;
  simulatePolicyDeployment?: PolicyDeploymentSimulatorPort;
  /** Persists a deployed policy record after the wizard signs. (Req 4.10) */
  persistPolicy?: PolicyPersisterPort;
}

// ---------------------------------------------------------------------------
// Policy bound ranges (Req 4.9). Configurable; sensible defaults provided.
// ---------------------------------------------------------------------------

/** Inclusive integer range for a policy bound. */
export interface IntegerRange {
  min: number;
  max: number;
}

/** Range specifications for each range-validated policy bound. (Req 4.9) */
export interface PolicyBoundsRanges {
  /** Max LTV delta, in basis points (0..10000 = 0..100%). */
  maxLtvDeltaBps: IntegerRange;
  /** Max maintenance-margin delta, in basis points. */
  maxMarginDeltaBps: IntegerRange;
  /** Pause-duration limit, in ms (0..30 days by default). */
  pauseDurationLimitMs: IntegerRange;
  /** Action cooldown, in ms (0..30 days by default). */
  cooldownMs: IntegerRange;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Default policy-bound ranges used when none are configured. (Req 4.9) */
export const DEFAULT_POLICY_BOUNDS: PolicyBoundsRanges = Object.freeze({
  maxLtvDeltaBps: { min: 0, max: 10_000 },
  maxMarginDeltaBps: { min: 0, max: 10_000 },
  pauseDurationLimitMs: { min: 0, max: THIRTY_DAYS_MS },
  cooldownMs: { min: 0, max: THIRTY_DAYS_MS },
});

/**
 * The autonomous mitigation action names a policy may permit, mirroring the
 * Risk_Engine {@link import('../risk/types.js').ActionType} set. An
 * `allowedActions` entry outside this set is rejected. (Req 4.9)
 */
export const VALID_POLICY_ACTIONS: readonly string[] = Object.freeze([
  'pause_new_borrows',
  'reduce_max_ltv',
  'enter_guarded_mode',
  'increase_maintenance_margin',
]);

/**
 * The nine Simulation_Lab scenarios (Req 14.1). A `/api/simulator/start`
 * request naming a scenario outside this set is rejected. (Req 15.4)
 */
export const SIMULATOR_SCENARIOS: readonly string[] = Object.freeze([
  'sui-flash-crash',
  'stablecoin-depeg',
  'oracle-staleness',
  'oracle-divergence',
  'liquidity-collapse',
  'liquidation-cascade',
  'high-utilization-spike',
  'false-positive-recovery',
  'guardian-revoked',
]);

/** The normalized, validated policy draft returned by `/api/policies/draft`. */
export interface DraftedPolicy {
  marketId: string;
  allowedActions: string[];
  maxLtvDeltaBps: number;
  maxMarginDeltaBps: number;
  pauseDurationLimitMs: number;
  cooldownMs: number;
  daoAddress?: string;
  riskThresholds?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Router options.
// ---------------------------------------------------------------------------

export interface ActionRouteOptions {
  /** Rate-limit bound, taken from app config. (Req 15.5) */
  rateLimit: { max: number; windowMs: number };
  /** Injected service ports; missing ports yield a 503 from their endpoint. */
  services?: ActionRouteServices;
  /** Range specs for policy bounds; defaults to {@link DEFAULT_POLICY_BOUNDS}. */
  policyBounds?: PolicyBoundsRanges;
  /**
   * Optional pre-built rate-limiter middleware (e.g. for deterministic tests).
   * When omitted one is built from {@link ActionRouteOptions.rateLimit}.
   */
  rateLimiter?: RequestHandler;
  /** Clock injected into the default rate limiter. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Validation helpers — every failure names the offending field. (Req 15.4)
// ---------------------------------------------------------------------------

interface FieldError {
  field: string;
  message: string;
}

type Validated<T> = { ok: true; value: T } | { ok: false; error: FieldError };

function fail(field: string, message: string): { ok: false; error: FieldError } {
  return { ok: false, error: { field, message } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Send a descriptive 400 naming the invalid field. (Req 15.4) */
function sendFieldError(res: Response, error: FieldError): void {
  res.status(400).json({ error: 'invalid_input', field: error.field, message: error.message });
}

/** Send a 503 when a required service port was not injected. */
function sendUnavailable(res: Response, service: string): void {
  res
    .status(503)
    .json({ error: 'service_unavailable', message: `The ${service} service is not configured` });
}

function requireString(
  body: Record<string, unknown>,
  field: string,
): Validated<string> {
  const value = body[field];
  if (typeof value !== 'string' || value.trim() === '') {
    return fail(field, `"${field}" is required and must be a non-empty string`);
  }
  return { ok: true, value };
}

function requireObject(
  body: Record<string, unknown>,
  field: string,
): Validated<Record<string, unknown>> {
  const value = body[field];
  if (!isPlainObject(value)) {
    return fail(field, `"${field}" is required and must be an object`);
  }
  return { ok: true, value };
}

/**
 * Validate that `value` is an integer within `[range.min, range.max]`, naming
 * the field and the offending value on failure. Used to range-validate every
 * policy bound. (Req 4.9)
 */
function validateIntegerInRange(
  value: unknown,
  field: string,
  range: IntegerRange,
): Validated<number> {
  if (value === undefined || value === null) {
    return fail(field, `"${field}" is required`);
  }
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return fail(field, `"${field}" must be an integer, got ${JSON.stringify(value)}`);
  }
  if (value < range.min || value > range.max) {
    return fail(
      field,
      `"${field}" must be between ${range.min} and ${range.max}, got ${value}`,
    );
  }
  return { ok: true, value };
}

/**
 * Validate + normalize a policy-draft body, range-validating every bound
 * (Req 4.9) and the allowed-action set. Returns a {@link DraftedPolicy} or a
 * descriptive field error.
 */
export function validatePolicyDraft(
  body: unknown,
  bounds: PolicyBoundsRanges,
): Validated<DraftedPolicy> {
  if (!isPlainObject(body)) {
    return fail('body', 'request body must be a JSON object');
  }

  const marketId = requireString(body, 'marketId');
  if (!marketId.ok) {
    return marketId;
  }

  // allowedActions: non-empty array drawn from the valid action set.
  const rawActions = body.allowedActions;
  if (!Array.isArray(rawActions) || rawActions.length === 0) {
    return fail('allowedActions', '"allowedActions" must be a non-empty array');
  }
  const allowedActions: string[] = [];
  for (const [i, action] of rawActions.entries()) {
    if (typeof action !== 'string' || !VALID_POLICY_ACTIONS.includes(action)) {
      return fail(
        `allowedActions[${i}]`,
        `"${String(action)}" is not a valid action; expected one of [${VALID_POLICY_ACTIONS.join(', ')}]`,
      );
    }
    allowedActions.push(action);
  }

  const ltv = validateIntegerInRange(body.maxLtvDeltaBps, 'maxLtvDeltaBps', bounds.maxLtvDeltaBps);
  if (!ltv.ok) {
    return ltv;
  }
  const margin = validateIntegerInRange(
    body.maxMarginDeltaBps,
    'maxMarginDeltaBps',
    bounds.maxMarginDeltaBps,
  );
  if (!margin.ok) {
    return margin;
  }
  const pause = validateIntegerInRange(
    body.pauseDurationLimitMs,
    'pauseDurationLimitMs',
    bounds.pauseDurationLimitMs,
  );
  if (!pause.ok) {
    return pause;
  }
  const cooldown = validateIntegerInRange(body.cooldownMs, 'cooldownMs', bounds.cooldownMs);
  if (!cooldown.ok) {
    return cooldown;
  }

  const draft: DraftedPolicy = {
    marketId: marketId.value,
    allowedActions,
    maxLtvDeltaBps: ltv.value,
    maxMarginDeltaBps: margin.value,
    pauseDurationLimitMs: pause.value,
    cooldownMs: cooldown.value,
  };

  // Optional pass-through fields, validated only for type when present.
  if (body.daoAddress !== undefined) {
    if (typeof body.daoAddress !== 'string' || body.daoAddress.trim() === '') {
      return fail('daoAddress', '"daoAddress" must be a non-empty string when provided');
    }
    draft.daoAddress = body.daoAddress;
  }
  if (body.riskThresholds !== undefined) {
    if (!isPlainObject(body.riskThresholds)) {
      return fail('riskThresholds', '"riskThresholds" must be an object when provided');
    }
    draft.riskThresholds = body.riskThresholds;
  }

  return { ok: true, value: draft };
}

/** Wrap an async route handler so rejected promises become a 500 response. */
function asyncHandler(
  handler: (req: Request, res: Response) => Promise<void>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

// ---------------------------------------------------------------------------
// Router factory.
// ---------------------------------------------------------------------------

/**
 * Build the action-endpoints router. Self-contained so it can be mounted on
 * `/api` alongside the read router. Applies the configurable rate limiter
 * (Req 15.5) to every route, then validates input (Req 15.4 / 4.9) before
 * delegating to the injected service ports (Req 15.2).
 */
export function createActionRouter(options: ActionRouteOptions): Router {
  const services = options.services ?? {};
  const bounds = options.policyBounds ?? DEFAULT_POLICY_BOUNDS;
  const limiter =
    options.rateLimiter ??
    createRateLimiter({
      max: options.rateLimit.max,
      windowMs: options.rateLimit.windowMs,
      now: options.now,
    });

  const router = Router();

  // Configurable rate limiter applied to every action route. (Req 15.5)
  router.use(limiter);

  // POST /api/policies/draft — validate + draft a policy config, range-
  // validating every bound. (Req 15.2, 4.9)
  router.post('/policies/draft', (req: Request, res: Response) => {
    const result = validatePolicyDraft(req.body, bounds);
    if (!result.ok) {
      sendFieldError(res, result.error);
      return;
    }
    res.status(200).json({ draft: result.value });
  });

  // POST /api/policies — persist a deployed policy record with its on-chain
  // deployment tx digest, after the wizard signs the create_policy PTB. (Req 4.10)
  router.post(
    '/policies',
    asyncHandler(async (req: Request, res: Response) => {
      const result = validatePolicyDraft(req.body, bounds);
      if (!result.ok) {
        sendFieldError(res, result.error);
        return;
      }
      const body = req.body as Record<string, unknown>;
      const txDigest = body.txDigest;
      if (typeof txDigest !== 'string' || txDigest.trim() === '') {
        sendFieldError(res, {
          field: 'txDigest',
          message: '"txDigest" is required and must be the deployment transaction digest',
        });
        return;
      }
      if (services.persistPolicy === undefined) {
        sendUnavailable(res, 'policy persistence');
        return;
      }
      try {
        const persisted = await services.persistPolicy.persist({ ...result.value, txDigest });
        res.status(201).json({ persisted: true, id: persisted.id, txDigest });
      } catch (err) {
        // A bad market reference / FK violation is a descriptive 400, not a 500.
        res.status(400).json({
          error: 'persist_failed',
          message: err instanceof Error ? err.message : 'Failed to persist the policy record',
        });
      }
    }),
  );

  // POST /api/policies/simulate — dry-run a policy deployment. (Req 15.2)
  router.post(
    '/policies/simulate',
    asyncHandler(async (req: Request, res: Response) => {
      const result = validatePolicyDraft(req.body, bounds);
      if (!result.ok) {
        sendFieldError(res, result.error);
        return;
      }
      if (services.simulatePolicyDeployment === undefined) {
        // No external dry-run wired: return a deterministic stub result so the
        // endpoint is usable without live infra. (stub/delegate ok)
        res.status(200).json({ simulated: true, draft: result.value });
        return;
      }
      const simulation = await services.simulatePolicyDeployment.simulate(result.value);
      res.status(200).json({ simulated: true, draft: result.value, result: simulation });
    }),
  );

  // POST /api/actions/recommend — run the Risk_Engine; may return refusal+reason.
  router.post(
    '/actions/recommend',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isPlainObject(body)) {
        sendFieldError(res, { field: 'body', message: 'request body must be a JSON object' });
        return;
      }
      const marketId = requireString(body, 'marketId');
      if (!marketId.ok) {
        sendFieldError(res, marketId.error);
        return;
      }
      const features = requireObject(body, 'features');
      if (!features.ok) {
        sendFieldError(res, features.error);
        return;
      }
      if (services.recommend === undefined) {
        sendUnavailable(res, 'risk recommendation');
        return;
      }
      const guard = isPlainObject(body.guard)
        ? (body.guard as unknown as FailClosedGuardContext)
        : undefined;
      const recommendation = await services.recommend.recommend({
        marketId: marketId.value,
        features: features.value as unknown as FeatureVector,
        guard,
      });
      res.status(200).json({ recommendation });
    }),
  );

  // POST /api/actions/execute — full network+simulation-gated action flow.
  router.post(
    '/actions/execute',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isPlainObject(body)) {
        sendFieldError(res, { field: 'body', message: 'request body must be a JSON object' });
        return;
      }
      const action = requireObject(body, 'action');
      if (!action.ok) {
        sendFieldError(res, action.error);
        return;
      }
      const evaluation = requireObject(body, 'evaluation');
      if (!evaluation.ok) {
        sendFieldError(res, evaluation.error);
        return;
      }
      const actionContext = requireObject(body, 'actionContext');
      if (!actionContext.ok) {
        sendFieldError(res, actionContext.error);
        return;
      }
      const actionLogId = requireString(body, 'actionLogId');
      if (!actionLogId.ok) {
        sendFieldError(res, actionLogId.error);
        return;
      }
      if (services.execute === undefined) {
        sendUnavailable(res, 'action execution');
        return;
      }
      const result = await services.execute.execute(body as unknown as ExecuteRequest);
      // The execution outcome (incl. a gated/failed flow) is data, not an HTTP
      // error: surface it with 200 and let the result.success flag describe it.
      res.status(200).json({ result });
    }),
  );

  // POST /api/actions/override — DAO Override_Console operations (reverse /
  // revoke / update-thresholds / unpause). Requires a non-empty override reason
  // (Req 11.6) and delegates to the injected OverrideExecutor port. (Req 11.4,
  // 11.5, 12.1)
  router.post(
    '/actions/override',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isPlainObject(body)) {
        sendFieldError(res, { field: 'body', message: 'request body must be a JSON object' });
        return;
      }
      const request = requireObject(body, 'request');
      if (!request.ok) {
        sendFieldError(res, request.error);
        return;
      }
      // The override operation must be one of the known DAO operations.
      const operation = request.value.operation;
      if (typeof operation !== 'string' || !VALID_OVERRIDE_OPERATIONS.includes(operation as never)) {
        sendFieldError(res, {
          field: 'request.operation',
          message: `"request.operation" must be one of [${VALID_OVERRIDE_OPERATIONS.join(', ')}]`,
        });
        return;
      }
      // An override reason is REQUIRED for every override operation (Req 11.6).
      const reason = request.value.reason;
      if (typeof reason !== 'string' || reason.trim() === '') {
        sendFieldError(res, {
          field: 'request.reason',
          message: 'an override reason is required and must be a non-empty string',
        });
        return;
      }
      const evaluation = requireObject(body, 'evaluation');
      if (!evaluation.ok) {
        sendFieldError(res, evaluation.error);
        return;
      }
      const actionContext = requireObject(body, 'actionContext');
      if (!actionContext.ok) {
        sendFieldError(res, actionContext.error);
        return;
      }
      // actionLogId is optional for overrides: the executor links evidence to
      // the freshly recorded off-chain action row, not this id. Operations such
      // as update_thresholds have no pre-existing action to reference.
      if (body.actionLogId === undefined || body.actionLogId === null) {
        body.actionLogId = '';
      } else if (typeof body.actionLogId !== 'string') {
        sendFieldError(res, {
          field: 'actionLogId',
          message: '"actionLogId" must be a string when provided',
        });
        return;
      }
      const recordCtx = requireObject(body, 'record');
      if (!recordCtx.ok) {
        sendFieldError(res, recordCtx.error);
        return;
      }
      for (const field of ['policyId', 'marketId', 'daoAddress'] as const) {
        const value = recordCtx.value[field];
        if (typeof value !== 'string' || value.trim() === '') {
          sendFieldError(res, {
            field: `record.${field}`,
            message: `"record.${field}" is required and must be a non-empty string`,
          });
          return;
        }
      }
      if (services.overrideExecute === undefined) {
        sendUnavailable(res, 'override execution');
        return;
      }
      const result = await services.overrideExecute.execute(
        body as unknown as OverrideExecuteRequest,
      );
      // The override outcome (incl. a gated/failed flow) is data, not an HTTP
      // error: surface it with 200 and let the result.success flag describe it.
      res.status(200).json({ result });
    }),
  );

  // POST /api/evidence/upload — upload an Evidence_Bundle via the port.
  router.post(
    '/evidence/upload',
    asyncHandler(async (req: Request, res: Response) => {
      const body = req.body;
      if (!isPlainObject(body)) {
        sendFieldError(res, { field: 'body', message: 'request body must be a JSON object' });
        return;
      }
      // Validate a representative subset of the Evidence_Bundle contract.
      const schemaVersion = requireString(body, 'schemaVersion');
      if (!schemaVersion.ok) {
        sendFieldError(res, schemaVersion.error);
        return;
      }
      const marketId = requireString(body, 'marketId');
      if (!marketId.ok) {
        sendFieldError(res, marketId.error);
        return;
      }
      const policyId = requireString(body, 'policyId');
      if (!policyId.ok) {
        sendFieldError(res, policyId.error);
        return;
      }
      if (typeof body.timestampMs !== 'number' || !Number.isFinite(body.timestampMs)) {
        sendFieldError(res, {
          field: 'timestampMs',
          message: '"timestampMs" is required and must be a finite number',
        });
        return;
      }
      if (services.uploadEvidence === undefined) {
        sendUnavailable(res, 'evidence upload');
        return;
      }
      const uploaded = await services.uploadEvidence.upload(body as unknown as EvidenceBundle);
      res.status(200).json(uploaded);
    }),
  );

  // POST /api/simulator/start — start one of the nine named scenarios. (14.1)
  router.post(
    '/simulator/start',
    asyncHandler(async (req: Request, res: Response) => {
      const body = isPlainObject(req.body) ? req.body : {};
      const scenario = body.scenario;
      if (typeof scenario !== 'string' || scenario.trim() === '') {
        sendFieldError(res, {
          field: 'scenario',
          message: '"scenario" is required and must be a non-empty string',
        });
        return;
      }
      if (!SIMULATOR_SCENARIOS.includes(scenario)) {
        sendFieldError(res, {
          field: 'scenario',
          message: `"${scenario}" is not a known scenario; expected one of [${SIMULATOR_SCENARIOS.join(', ')}]`,
        });
        return;
      }
      if (services.simulator === undefined) {
        sendUnavailable(res, 'simulator');
        return;
      }
      const started = await services.simulator.start(scenario);
      res.status(200).json({ started: true, scenario, result: started });
    }),
  );

  // POST /api/simulator/reset — reset the demo market + scenario. (Req 14.5)
  router.post(
    '/simulator/reset',
    asyncHandler(async (_req: Request, res: Response) => {
      if (services.simulator === undefined) {
        sendUnavailable(res, 'simulator');
        return;
      }
      const result = await services.simulator.reset();
      res.status(200).json({ reset: true, result });
    }),
  );

  return router;
}
