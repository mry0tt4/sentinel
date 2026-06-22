import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { ScoreMovementPoint } from '../../lib/incidentTypes';

export interface ScoreMovementChartProps {
  data: ScoreMovementPoint[];
}

/**
 * Risk_Score movement chart across an incident's snapshot steps. Scores are
 * bounded to [0, 100]. Renders a chronological line of how the Risk_Score moved
 * over the incident window. (Req 13.1)
 */
export function ScoreMovementChart({ data }: ScoreMovementChartProps) {
  return (
    <div
      className="score-movement-chart"
      data-testid="score-movement-chart"
      style={{ width: '100%', height: 180 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="t" hide />
          <YAxis domain={[0, 100]} width={28} />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="#22d3ee" strokeWidth={2} dot />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
