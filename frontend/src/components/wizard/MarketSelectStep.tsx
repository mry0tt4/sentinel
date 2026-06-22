import { FieldError, type StepProps } from './stepProps';

/** A selectable existing demo market. */
export interface DemoMarketOption {
  id: string;
  name: string;
}

export interface MarketSelectStepProps extends StepProps {
  /** Existing demo markets to choose from. (Req 4.3) */
  demoMarkets?: DemoMarketOption[];
}

/** Step 2 — select an existing demo market or create a new one. (Req 4.3) */
export function MarketSelectStep({
  state,
  errors,
  showErrors,
  onChange,
  demoMarkets = [],
}: MarketSelectStepProps) {
  return (
    <fieldset className="wizard-step" data-testid="step-market-select">
      <legend>Demo market</legend>

      <div className="wizard-options" role="radiogroup" aria-label="Market source">
        <label className="wizard-option">
          <input
            type="radio"
            name="marketMode"
            value="select"
            checked={state.marketMode === 'select'}
            onChange={() => onChange({ marketMode: 'select' })}
          />
          <span>Select existing</span>
        </label>
        <label className="wizard-option">
          <input
            type="radio"
            name="marketMode"
            value="create"
            checked={state.marketMode === 'create'}
            onChange={() => onChange({ marketMode: 'create' })}
          />
          <span>Create new</span>
        </label>
      </div>

      {state.marketMode === 'select' ? (
        demoMarkets.length > 0 ? (
          <label className="wizard-field">
            <span>Existing demo market</span>
            <select
              aria-label="Existing demo market"
              value={state.selectedMarketId}
              onChange={(e) => onChange({ selectedMarketId: e.target.value })}
            >
              <option value="">— select a market —</option>
              {demoMarkets.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="wizard-field">
            <span>Existing demo market ID</span>
            <input
              type="text"
              aria-label="Existing demo market ID"
              value={state.selectedMarketId}
              placeholder="0x… or market id"
              onChange={(e) => onChange({ selectedMarketId: e.target.value })}
            />
          </label>
        )
      ) : (
        <label className="wizard-field">
          <span>New demo market name</span>
          <input
            type="text"
            aria-label="New demo market name"
            value={state.newMarketName}
            placeholder="e.g. SUI-USDC demo"
            onChange={(e) => onChange({ newMarketName: e.target.value })}
          />
        </label>
      )}

      <FieldError show={showErrors} message={errors.market} field="market" />
    </fieldset>
  );
}
