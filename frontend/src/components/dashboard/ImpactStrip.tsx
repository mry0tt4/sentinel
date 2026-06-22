import type { ImpactMetrics } from '../../lib/dashboardTypes';
import { formatUsdCompact } from '../../lib/format';
import { InfoHint } from '../InfoHint';

export interface ImpactStripProps {
  impact?: ImpactMetrics | null;
}

/**
 * Headline real-world impact: the USD value the agent protects, the exposure at
 * risk, and the value preserved by an active mitigation. All figures derive
 * from the REAL on-chain exposure priced with the live Pyth oracle. (Real-World
 * Application)
 */
export function ImpactStrip({ impact }: ImpactStripProps) {
  if (!impact) return null;
  return (
    <div className="impact-strip" data-testid="impact-strip">
      <div className="impact-stat">
        <span className="impact-stat__label">Protected value (TVL)<InfoHint term="Protected value (TVL)" /></span>
        <span className="impact-stat__value" data-testid="impact-protected">
          {formatUsdCompact(impact.protectedValueUsd)}
        </span>
      </div>
      <div className="impact-stat">
        <span className="impact-stat__label">Exposure at risk<InfoHint term="Exposure at risk" /></span>
        <span className="impact-stat__value" data-testid="impact-exposure">
          {formatUsdCompact(impact.exposureUsd)}
        </span>
      </div>
      <div className={`impact-stat${impact.lossPreventedUsd > 0 ? ' impact-stat--active' : ''}`}>
        <span className="impact-stat__label">Loss prevented<InfoHint term="Loss prevented" /></span>
        <span className="impact-stat__value" data-testid="impact-loss-prevented">
          {formatUsdCompact(impact.lossPreventedUsd)}
        </span>
      </div>
    </div>
  );
}
