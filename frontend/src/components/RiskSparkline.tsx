import { Line, LineChart, ResponsiveContainer, Tooltip, YAxis } from 'recharts';

export interface RiskPoint {
  t: number;
  score: number;
}

export interface RiskSparklineProps {
  data: RiskPoint[];
}

/**
 * Minimal risk-score trend chart used to verify the charting library is wired
 * up. Real dashboard charts (risk trend + oracle price) are built in later
 * tasks. (Requirement 3.4)
 */
export function RiskSparkline({ data }: RiskSparklineProps) {
  return (
    <div style={{ width: '100%', height: 120 }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <YAxis domain={[0, 100]} hide />
          <Tooltip />
          <Line type="monotone" dataKey="score" stroke="#22d3ee" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
