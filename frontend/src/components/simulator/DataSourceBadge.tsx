import type { DataSourceLabel, LabeledDatum } from '../../lib/simulatorTypes';
import { explain } from '../../lib/glossary';
import { InfoHint } from '../InfoHint';

/** Map a data-source label to a stable CSS modifier + test id slug. */
const LABEL_SLUG: Record<DataSourceLabel, string> = {
  'live oracle data': 'live',
  'simulated scenario data': 'simulated',
  'real testnet transaction': 'testnet-tx',
  'Walrus evidence': 'walrus',
};

export interface DataSourceBadgeProps {
  source: DataSourceLabel;
}

/**
 * The provenance badge shown next to every Simulation Lab datum. Renders the
 * single data-source label that datum carries. (Req 14.6)
 */
export function DataSourceBadge({ source }: DataSourceBadgeProps) {
  const slug = LABEL_SLUG[source];
  return (
    <span
      className={`source-badge source-badge--${slug}`}
      data-testid={`source-badge-${slug}`}
      data-source={source}
      title={explain(source)}
    >
      {source}
    </span>
  );
}

export interface LabeledDatumRowProps {
  datum: LabeledDatum;
}

/**
 * Renders one labeled data element: its field name, value, and the single
 * data-source badge identifying its provenance. The `data-source` attribute
 * exposes the label for the Property 23 test. (Req 14.6, 14.7)
 */
export function LabeledDatumRow({ datum }: LabeledDatumRowProps) {
  return (
    <div
      className="labeled-datum"
      data-testid={`datum-${datum.key}`}
      data-source={datum.source}
    >
      <span className="labeled-datum__field">
        {datum.field}
        <InfoHint term={datum.field} />
      </span>
      <span className="labeled-datum__value" data-testid={`datum-${datum.key}-value`}>
        {datum.value}
      </span>
      <DataSourceBadge source={datum.source} />
    </div>
  );
}
