/**
 * Simulation_Lab module public surface (task 18.1).
 *
 * Re-exports the scenario catalogue and the `SimulationService` so the server
 * can wire the service as the `SimulatorPort` behind `/api/simulator/*` while
 * keeping the service independently testable. (Req 14.1–14.5, 14.8, 14.9)
 */

export {
  DEMO_MARKET_BASELINE,
  SIMULATION_NOW_MS,
  SIMULATION_SCENARIOS,
  SIMULATION_SCENARIO_IDS,
  getScenario,
  featuresAtStep,
  type ScenarioStep,
  type SimulationScenario,
} from './scenarios.js';

export {
  SimulationService,
  UnknownScenarioError,
  createScenarioGuardianChecker,
  DEFAULT_SIMULATION_POLICY,
  type SimulationServiceOptions,
  type SimulationRiskEnginePort,
  type ActionExecutorPort,
  type DemoMarketResetPort,
  type GuardianAuthorization,
  type GuardianAuthorizationChecker,
  type SimulationDemoMarketConfig,
  type SimulationPolicyConfig,
  type StepRiskSummary,
  type ActionOutcome,
  type ScenarioStepOutcome,
  type ScenarioRunResult,
  type SimulationRunStatus,
  type SimulationState,
  type SimulationResetResult,
} from './simulationService.js';
