import { memo, useMemo, useState } from 'react';
import type { MetricPanel } from '../../engine/types';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { LineChart } from '../charts/LineChart';
import { PinButton } from '../ui/PinButton';
import { pinAlarm, pinMetric } from '../../engine/pins';
import { fmtNum, stats } from '../../engine/timeseries';
import { relative } from '../../engine/time';
import { Icon } from '../ui/Icon';

export function CloudWatch({ env }: ToolProps) {
  const [query, setQuery] = useState('');
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const featured = env.metrics.filter(m => m.featured);
  const groups = useMemo(() => {
    const g = new Map<string, MetricPanel[]>();
    for (const m of env.metrics) {
      if (query && !`${m.namespace} ${m.metric} ${m.resource} ${m.group}`.toLowerCase().includes(query.toLowerCase())) continue;
      g.set(m.group, [...(g.get(m.group) ?? []), m]);
    }
    return [...g.entries()];
  }, [env.metrics, query]);
  const alarms = [...env.alarms].sort((a, b) => (a.state === b.state ? a.minutesAgo - b.minutesAgo : a.state === 'ALARM' ? -1 : b.state === 'ALARM' ? 1 : 0));
  const inAlarm = alarms.filter(a => a.state === 'ALARM').length;

  return (
    <div className="tool">
      <ToolHeader title="CloudWatch" sub="Alarms and metrics for the ShopFast production account. Hover a chart to read values; pin anything that matters." />

      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-h">
          <h3>
            Alarms{' '}
            {inAlarm > 0 ? (
              <span className="badge crit" style={{ marginLeft: 6 }}>
                {inAlarm} in alarm
              </span>
            ) : (
              <span className="badge ok" style={{ marginLeft: 6 }}>
                all OK
              </span>
            )}
          </h3>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 110 }}>State</th>
              <th>Name</th>
              <th>Condition</th>
              <th style={{ width: 120 }}>Last change</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {alarms.map(a => (
              <tr key={a.name} className="pin-reveal">
                <td>
                  <span className={`badge ${a.state === 'ALARM' ? 'crit' : a.state === 'OK' ? 'ok' : 'warn'}`}>
                    {a.state === 'ALARM' && <span className="dot pulse" />}
                    {a.state === 'INSUFFICIENT_DATA' ? 'INSUFFICIENT' : a.state}
                  </span>
                </td>
                <td className="mono">{a.name}</td>
                <td className="muted">
                  <span className="mono">{a.metric}</span> · {a.condition}
                </td>
                <td className="muted">{relative(a.minutesAgo)}</td>
                <td className="pin-cell">
                  <PinButton item={pinAlarm(a)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {featured.length > 0 && (
        <>
          <div className="section-title">
            <h2>Dashboard · checkout-prod</h2>
            <span className="small faint">key metrics, last {Math.round((featured[0].series[0].points.length * featured[0].periodMinutes) / 60)}h</span>
          </div>
          <div className="metric-grid">
            {featured.map(m => (
              <MetricCard key={m.id} panel={m} now={env.now} />
            ))}
          </div>
        </>
      )}

      <div className="section-title">
        <h2>All metrics</h2>
        <span className="small faint">{env.metrics.length} panels</span>
        <span className="spacer" />
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Filter metrics (e.g. RDS, latency, app-2)…" value={query} onChange={e => setQuery(e.target.value)} />
        </div>
      </div>
      {groups.map(([group, panels]) => {
        const open = openGroups[group] ?? !!query;
        return (
          <div key={group} className="metric-group">
            <button className="metric-group-h" onClick={() => setOpenGroups(o => ({ ...o, [group]: !open }))}>
              <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
              <span>{group}</span>
              <span className="faint small">{panels.length} metrics</span>
              <span className="spacer" />
              {!open && (
                <span className="metric-group-peek">
                  {panels.slice(0, 4).map(p => (
                    <span key={p.id} className="mono small faint">
                      {p.metric}
                    </span>
                  ))}
                </span>
              )}
            </button>
            {open && (
              <div className="metric-grid">
                {panels.map(m => (
                  <MetricCard key={m.id} panel={m} now={env.now} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export const MetricCard = memo(function MetricCard({ panel, now, height = 150 }: { panel: MetricPanel; now: number; height?: number }) {
  const st = stats(panel.series[0].points);
  const breach = panel.threshold !== undefined && panel.series.some(s => s.points[s.points.length - 1] > panel.threshold!);
  return (
    <div className={`metric-card pin-reveal ${breach ? 'breach' : ''}`}>
      <div className="metric-h">
        <div style={{ minWidth: 0 }}>
          <div className="metric-name">
            {panel.metric} <span className="faint">· {panel.stat}</span>
          </div>
          <div className="metric-res mono">
            {panel.namespace} · {panel.resource}
          </div>
        </div>
        <div className="spacer" />
        {panel.series.length === 1 && (
          <div className="metric-now">
            <span className="mono">{fmtNum(st.latest)}</span>
            <span className="faint small"> {panel.unit === 'Count' ? '' : panel.unit}</span>
          </div>
        )}
        <PinButton item={pinMetric(panel)} />
      </div>
      {panel.series.length > 1 && (
        <div className="metric-legend">
          {panel.series.map((s, i) => (
            <span key={s.name} className="small">
              <span className="dot" style={{ color: `var(--series-${(i % 5) + 1})` }} /> {s.name} <span className="mono faint">{fmtNum(s.points[s.points.length - 1])}</span>
            </span>
          ))}
        </div>
      )}
      <LineChart series={panel.series} now={now} periodMinutes={panel.periodMinutes} unit={panel.unit} threshold={panel.threshold} height={height} />
    </div>
  );
});
