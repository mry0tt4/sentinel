import { SCENARIO_OPTIONS } from '../../lib/simulatorTypes';

export interface ScenarioPickerProps {
  /** Currently selected scenario id, or null when none chosen. */
  selectedId: string | null;
  /** Whether a scenario is currently running (disables controls). */
  running: boolean;
  onSelect: (scenarioId: string) => void;
  onStart: () => void;
  onReset: () => void;
}

/**
 * Scenario picker for the Simulation Lab: lists the nine predefined scenarios
 * (Req 14.1) and exposes start/reset controls (Req 14.2, 14.5). All inputs are
 * simulated scenario inputs — the picker selects which simulated scenario to
 * feed the Risk_Engine.
 */
export function ScenarioPicker({
  selectedId,
  running,
  onSelect,
  onStart,
  onReset,
}: ScenarioPickerProps) {
  return (
    <section className="scenario-picker" data-testid="scenario-picker">
      <h3 className="scenario-picker__heading">Scenarios</h3>
      <ul className="scenario-picker__list">
        {SCENARIO_OPTIONS.map((scenario) => {
          const selected = scenario.id === selectedId;
          return (
            <li key={scenario.id}>
              <button
                type="button"
                className={`scenario-picker__item${selected ? ' scenario-picker__item--selected' : ''}`}
                data-testid={`scenario-option-${scenario.id}`}
                aria-pressed={selected}
                disabled={running}
                onClick={() => onSelect(scenario.id)}
              >
                <span className="scenario-picker__title">{scenario.title}</span>
                <span className="scenario-picker__desc">{scenario.description}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <div className="scenario-picker__actions">
        <button
          type="button"
          className="scenario-picker__start"
          data-testid="scenario-start"
          disabled={running || selectedId === null}
          onClick={onStart}
        >
          {running ? 'Running…' : 'Start scenario'}
        </button>
        <button
          type="button"
          className="scenario-picker__reset"
          data-testid="scenario-reset"
          disabled={running}
          onClick={onReset}
        >
          Reset
        </button>
      </div>
    </section>
  );
}
