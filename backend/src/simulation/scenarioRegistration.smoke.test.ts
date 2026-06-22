/**
 * Smoke test for Simulation_Lab scenario registration (task 18.4, Req 14.1).
 *
 * A focused guard that the Simulation_Lab registers EXACTLY NINE scenarios and
 * that the registered set is precisely the nine canonical ids the requirement
 * enumerates. Assertions run against the authoritative registry exports
 * ({@link SIMULATION_SCENARIOS} / {@link SIMULATION_SCENARIO_IDS} and
 * {@link SimulationService.scenarioIds}) — never a hand-copied list — so the
 * test fails fast if a scenario is ever added, removed, renamed, or duplicated.
 * It also cross-checks the registry against the REST allow-list
 * ({@link SIMULATOR_SCENARIOS}) used by `/api/simulator/start`, ensuring the
 * service and the API accept an identical scenario set.
 */

import { describe, it, expect } from 'vitest';

import { SIMULATOR_SCENARIOS } from '../api/actionRoutes.js';
import {
  SIMULATION_SCENARIOS,
  SIMULATION_SCENARIO_IDS,
} from './scenarios.js';
import { SimulationService } from './simulationService.js';

/** The nine canonical scenario ids enumerated by Req 14.1. */
const EXPECTED_SCENARIO_IDS = [
  'sui-flash-crash',
  'stablecoin-depeg',
  'oracle-staleness',
  'oracle-divergence',
  'liquidity-collapse',
  'liquidation-cascade',
  'high-utilization-spike',
  'false-positive-recovery',
  'guardian-revoked',
] as const;

describe('Simulation_Lab scenario registration smoke test (Req 14.1)', () => {
  it('registers exactly nine scenarios', () => {
    expect(SIMULATION_SCENARIOS).toHaveLength(9);
    expect(SIMULATION_SCENARIO_IDS).toHaveLength(9);
    expect(SimulationService.scenarioIds()).toHaveLength(9);
    expect(SimulationService.scenarios()).toHaveLength(9);
  });

  it('registers precisely the nine canonical scenario ids', () => {
    // Set equality guards against missing/extra ids regardless of order.
    expect(new Set(SIMULATION_SCENARIO_IDS)).toEqual(new Set(EXPECTED_SCENARIO_IDS));
    // The registry ids derive from the scenario objects (no drift between them).
    expect(SIMULATION_SCENARIOS.map((s) => s.id)).toEqual([...SIMULATION_SCENARIO_IDS]);
  });

  it('exposes the same ids through the SimulationService static accessors', () => {
    expect(new Set(SimulationService.scenarioIds())).toEqual(new Set(EXPECTED_SCENARIO_IDS));
    expect(SimulationService.scenarios().map((s) => s.id)).toEqual([...SIMULATION_SCENARIO_IDS]);
  });

  it('registers a unique set of ids (no duplicates)', () => {
    expect(new Set(SIMULATION_SCENARIO_IDS).size).toBe(SIMULATION_SCENARIO_IDS.length);
  });

  it('matches the REST allow-list accepted by /api/simulator/start', () => {
    expect(SIMULATOR_SCENARIOS).toHaveLength(9);
    expect(new Set(SIMULATION_SCENARIO_IDS)).toEqual(new Set(SIMULATOR_SCENARIOS));
  });
});
