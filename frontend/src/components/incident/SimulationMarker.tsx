export interface SimulationMarkerProps {
  /** Whether the incident originates from a simulation. (Req 13.6) */
  isSimulated: boolean;
  /** Scenario id when the incident is tied to a simulation scenario. */
  scenarioId?: string | null;
}

/**
 * Renders a "Simulation" marker when an incident originates from a simulation
 * (explicitly simulated or attached to a scenario); renders nothing for a live
 * incident. (Req 13.6)
 */
export function SimulationMarker({ isSimulated, scenarioId }: SimulationMarkerProps) {
  if (!isSimulated) return null;
  return (
    <span className="incident-sim-marker" data-testid="simulation-marker" role="status">
      Simulation
      {scenarioId ? (
        <span className="incident-sim-marker__scenario" data-testid="simulation-scenario">
          {scenarioId}
        </span>
      ) : null}
    </span>
  );
}
