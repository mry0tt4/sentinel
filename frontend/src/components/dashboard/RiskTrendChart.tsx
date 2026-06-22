import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { RiskPoint } from '../../lib/dashboardTypes';

export interface RiskTrendChartProps {
  data: RiskPoint[];
}

/**
 * Risk_Score trend chart for the selected market. Scores are bounded to
 * [0, 100]. (Req 3.4)
 */
export function RiskTrendChart({ data }: RiskTrendChartProps) {
  return (
    <div
      className="trend-chart"
      data-testid="risk-trend-chart"
      style={{ width: '100%', height: 160 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="t" hide />
          <YAxis domain={[0, 100]} width={28} />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="#22d3ee" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
