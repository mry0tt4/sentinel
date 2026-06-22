import type { FeedMapping } from '../../lib/policyWizard';
import { FieldError, type StepProps } from './stepProps';

/** Step 3 — map market assets to Sui Testnet price feeds. (Req 4.4) */
export function FeedMappingStep({ state, errors, showErrors, onChange }: StepProps) {
  const update = (index: number, patch: Partial<FeedMapping>) => {
    const next = state.feedMappings.map((m, i) => (i === index ? { ...m, ...patch } : m));
    onChange({ feedMappings: next });
  };

  const addRow = () => {
    onChange({ feedMappings: [...state.feedMappings, { asset: '', feedId: '' }] });
  };

  const removeRow = (index: number) => {
    const next = state.feedMappings.filter((_, i) => i !== index);
    onChange({ feedMappings: next.length > 0 ? next : [{ asset: '', feedId: '' }] });
  };

  return (
    <fieldset className="wizard-step" data-testid="step-feed-mapping">
      <legend>Price feed mapping</legend>
      <p className="wizard-step__hint">Map each market asset to a Sui Testnet price feed.</p>

      {state.feedMappings.map((mapping, index) => (
        <div key={index} className="wizard-feed-row" data-testid={`feed-row-${index}`}>
          <input
            type="text"
            aria-label={`Asset ${index + 1}`}
            placeholder="Asset (e.g. SUI)"
            value={mapping.asset}
            onChange={(e) => update(index, { asset: e.target.value })}
          />
          <input
            type="text"
            aria-label={`Price feed ${index + 1}`}
            placeholder="Feed ID (e.g. 0x… Pyth feed)"
            value={mapping.feedId}
            onChange={(e) => update(index, { feedId: e.target.value })}
          />
          <button
            type="button"
            className="wizard-feed-remove"
            aria-label={`Remove mapping ${index + 1}`}
            onClick={() => removeRow(index)}
          >
            ×
          </button>
        </div>
      ))}

      <button type="button" className="wizard-secondary" onClick={addRow}>
        Add asset
      </button>

      <FieldError show={showErrors} message={errors.feedMappings} field="feedMappings" />
    </fieldset>
  );
}
