import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { fmtNum } from '../../engine/timeseries';
import { hm, MIN } from '../../engine/time';

const COLORS = ['var(--series-1)', 'var(--series-2)', 'var(--series-3)', 'var(--series-4)', 'var(--series-5)'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(120, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}

export interface ChartSeries {
  name: string;
  points: number[];
}

export const LineChart = memo(function LineChart({
  series,
  now,
  periodMinutes = 1,
  unit = '',
  threshold,
  height = 150,
  minY,
  maxY,
}: {
  series: ChartSeries[];
  now: number;
  periodMinutes?: number;
  unit?: string;
  threshold?: number;
  height?: number;
  minY?: number;
  maxY?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 44;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const n = Math.max(...series.map(s => s.points.length));
  const { lo, hi } = useMemo(() => {
    let max = -Infinity;
    let min = Infinity;
    for (const s of series) for (const p of s.points) {
      max = Math.max(max, p);
      min = Math.min(min, p);
    }
    if (threshold !== undefined && threshold < max * 3) max = Math.max(max, threshold);
    const lo0 = minY ?? (min >= 0 ? 0 : min);
    const hi0 = maxY ?? (unit === '%' && max > 60 ? 100 : niceMax(max * 1.08 || 1));
    return { lo: lo0, hi: hi0 === lo0 ? lo0 + 1 : hi0 };
  }, [series, threshold, minY, maxY, unit]);
  const iw = width - padL - padR;
  const ih = height - padT - padB;
  const x = (i: number) => padL + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => padT + ih - ((v - lo) / (hi - lo)) * ih;
  const tsAt = (i: number) => now - (n - 1 - i) * periodMinutes * MIN;
  const ticksY = [lo, lo + (hi - lo) / 2, hi];
  const ticksX = [0, Math.round((n - 1) / 3), Math.round((2 * (n - 1)) / 3), n - 1];
  const multiDay = periodMinutes * n > 24 * 60;
  const label = (i: number) => {
    const ts = tsAt(i);
    if (!multiDay) return hm(ts);
    const d = new Date(ts);
    return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()]} ${hm(ts)}`;
  };

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const i = Math.round(((px - padL) / iw) * (n - 1));
    setHover(i < 0 || i >= n ? null : i);
  };

  return (
    <div ref={ref} className="chart" style={{ height }}>
      <svg width={width} height={height} onMouseMove={onMove} onMouseLeave={() => setHover(null)} role="img">
        {ticksY.map((t, k) => (
          <g key={k}>
            <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeDasharray={k === 0 ? undefined : '3 4'} />
            <text x={padL - 6} y={y(t) + 4} textAnchor="end" className="chart-axis">
              {fmtNum(t)}
            </text>
          </g>
        ))}
        {ticksX.map((i, k) => (
          <text key={k} x={x(i)} y={height - 6} textAnchor={k === 0 ? 'start' : k === ticksX.length - 1 ? 'end' : 'middle'} className="chart-axis">
            {label(i)}
          </text>
        ))}
        {threshold !== undefined && threshold >= lo && threshold <= hi && (
          <g>
            <line x1={padL} x2={width - padR} y1={y(threshold)} y2={y(threshold)} stroke="var(--crit)" strokeOpacity={0.6} strokeDasharray="5 4" />
            <text x={width - padR - 2} y={y(threshold) - 4} textAnchor="end" className="chart-axis" fill="var(--crit)" style={{ fill: 'var(--crit)', opacity: 0.85 }}>
              threshold {fmtNum(threshold)}
            </text>
          </g>
        )}
        {series.map((s, k) => {
          const pts = s.points.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
          const color = COLORS[k % COLORS.length];
          return (
            <g key={s.name}>
              {series.length === 1 && <path d={`M${x(0)},${y(lo)} L${pts.join(' L')} L${x(s.points.length - 1)},${y(lo)} Z`} fill={color} opacity={0.08} />}
              <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.6} strokeLinejoin="round" />
            </g>
          );
        })}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} stroke="var(--text-3)" strokeDasharray="2 3" />
            {series.map((s, k) => (s.points[hover] !== undefined ? <circle key={k} cx={x(hover)} cy={y(s.points[hover])} r={3.2} fill={COLORS[k % COLORS.length]} stroke="var(--surface-1)" strokeWidth={1.5} /> : null))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="chart-tip" style={{ left: Math.min(width - 170, Math.max(0, x(hover) + 10)) }}>
          <div className="chart-tip-t">{label(hover)} UTC</div>
          {series.map((s, k) => (
            <div key={s.name} className="chart-tip-r">
              <span className="dot" style={{ color: COLORS[k % COLORS.length] }} />
              <span className="chart-tip-n">{s.name}</span>
              <span className="mono">
                {fmtNum(s.points[hover] ?? 0)}
                {unit && unit !== 'Count' ? ` ${unit}` : ''}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

export function Sparkline({ points, color = 'var(--series-1)', width = 120, height = 28 }: { points: number[]; color?: string; width?: number; height?: number }) {
  const max = Math.max(...points);
  const min = Math.min(...points, 0);
  const span = max - min || 1;
  const pts = points.map((v, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${(height - 2 - ((v - min) / span) * (height - 4)).toFixed(1)}`);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.4} />
    </svg>
  );
}

export const SERIES_COLORS = COLORS;
