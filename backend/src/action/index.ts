/**
 * Action Executor module — server-defined PTB templates, simulation, and
 * (task 11.4) the full network-gated execution flow.
 */

export {
  ActionExecutor,
  createSuiClientSimulator,
  assertValidActionRequest,
  TransactionSubmissionError,
  POLICY_MODULE,
  EXECUTE_GUARDIAN_ACTION,
  type ActionExecutorConfig,
  type ActionExecutorDeps,
  type TransactionSimulator,
  type TransactionSubmitter,
  type SubmitResponseLike,
  type NetworkVerifier,
  type EvidenceCoordinator,
  type DryRunResponseLike,
  type ActionResult,
  type ActionStage,
  type ExecuteRequest,
} from './actionExecutor.js';

export {
  ACTION_TYPE,
  VALID_ACTION_TYPE_CODES,
  FORBIDDEN_REQUEST_KEYS,
  ActionTemplateError,
  OVERRIDE_OPERATION,
  VALID_OVERRIDE_OPERATIONS,
  REVERSAL_OPERATIONS,
  OverrideRequestError,
  type ActionTypeName,
  type ActionTypeCode,
  type ByteInput,
  type PriceFeedUpdate,
  type BoundedActionRequest,
  type SimulationResult,
  type SubmitResult,
  type OverrideOperation,
  type OverrideOperationName,
  type OverrideActionRequest,
  type ReverseActionOverrideRequest,
  type RevokeGuardianOverrideRequest,
  type UpdateThresholdsOverrideRequest,
  type UnpauseMarketOverrideRequest,
} from './types.js';

export {
  ACTION_PRIORITY_ORDER,
  actionPriority,
  selectHighestPriorityAction,
  orderActionsByPriority,
} from './actionPriority.js';

export {
  OverrideExecutor,
  assertValidOverrideRequest,
  POLICY_MODULE as OVERRIDE_POLICY_MODULE,
  type OverrideExecutorConfig,
  type OverrideExecutorDeps,
  type OverrideActionRecorder,
  type OverrideActionRecord,
  type OverrideExecuteRequest,
  type OverrideRecordContext,
  type OverrideResult,
  type OverrideStage,
} from './overrideExecutor.js';
