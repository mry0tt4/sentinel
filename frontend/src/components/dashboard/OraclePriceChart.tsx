import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import type { PricePoint } from '../../lib/dashboardTypes';
import { formatUsdPrice } from '../../lib/format';

export interface OraclePriceChartProps {
  data: PricePoint[];
}

/**
 * Oracle price chart for the selected market, driven by the oracle price in
 * each risk snapshot's feature vector. Prices arrive as Pyth fixed-point
 * integers, so the axis + tooltip render them as human USD amounts. (Req 3.4)
 */
export function OraclePriceChart({ data }: OraclePriceChartProps) {
  return (
    <div
      className="price-chart"
      data-testid="oracle-price-chart"
      style={{ width: '100%', height: 160 }}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data}>
          <XAxis dataKey="t" hide />
          <YAxis
            domain={['auto', 'auto']}
            width={72}
            tick={{ fontSize: 11 }}
            tickFormatter={(v: number) => formatUsdPrice(v)}
          />
          <Tooltip
            formatter={(value) => [formatUsdPrice(value as number), 'Price']}
            labelFormatter={() => 'Oracle price'}
          />
          <Line type="monotone" dataKey="price" stroke="#f59e0b" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
