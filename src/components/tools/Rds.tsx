import { useState } from 'react';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinRds, pinRdsEvent, pinTopSql } from '../../engine/pins';
import { KV } from './Ec2';
import { MetricCard } from './CloudWatch';
import { relative } from '../../engine/time';

export function Rds({ env }: ToolProps) {
  const [sel, setSel] = useState(env.rds.instances[0]?.id);
  const inst = env.rds.instances.find(i => i.id === sel) ?? env.rds.instances[0];
  const db = env.databases.find(d => d.instanceId === inst?.id);
  const topSql = env.rds.topSql[inst?.id ?? ''] ?? [];
  const maxAas = Math.max(0.01, ...topSql.map(q => q.loadAas));
  const panels = env.metrics.filter(m => m.namespace === 'AWS/RDS' && m.resource === inst?.id);
  const events = [...env.rds.events].sort((a, b) => a.minutesAgo - b.minutesAgo);
  const keyParams = ['max_connections', 'shared_buffers', 'work_mem', 'statement_timeout', 'log_min_duration_statement', 'max_standby_streaming_delay', 'hot_standby_feedback', 'idle_in_transaction_session_timeout'];

  return (
    <div className="tool">
      <ToolHeader title="RDS" sub="Amazon RDS for PostgreSQL. Use the terminal (psql from the bastion) for live session and query statistics." />
      <div className="card" style={{ marginBottom: 16 }}>
        <table className="tbl">
          <thead>
            <tr>
              <th>DB identifier</th>
              <th>Role</th>
              <th>Engine</th>
              <th>Class</th>
              <th>Status</th>
              <th>Storage</th>
              <th>AZ</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {env.rds.instances.map(i => (
              <tr key={i.id} className={`clickable pin-reveal ${i.id === inst?.id ? 'selected' : ''}`} onClick={() => setSel(i.id)}>
                <td>
                  <b>{i.id}</b>
                </td>
                <td>
                  <span className={`badge ${i.role === 'primary' ? 'info' : 'violet'}`}>{i.role === 'primary' ? 'Primary' : 'Replica'}</span>
                </td>
                <td className="mono">
                  {i.engine} {i.version}
                </td>
                <td className="mono">{i.class}</td>
                <td>
                  <span className={`badge ${i.status === 'available' ? 'ok' : 'warn'}`}>{i.status}</span>
                </td>
                <td className="mono">
                  {i.storage.type} · {i.storage.sizeGb} GiB{i.storage.iops ? ` · ${i.storage.iops.toLocaleString()} IOPS` : ''}
                </td>
                <td>
                  {i.az}
                  {i.multiAz ? ' (Multi-AZ)' : ''}
                </td>
                <td className="pin-cell">
                  <PinButton item={pinRds(i)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {inst && (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-h">
              <h3>{inst.id} — configuration</h3>
            </div>
            <div className="card-b">
              <div className="kv-grid">
                <KV k="Endpoint" v={inst.endpoint} mono />
                <KV k="vCPU / memory" v={`${inst.vCpu} vCPU · ${inst.memoryGb} GiB`} />
                <KV k="Storage" v={`${inst.storage.type}, ${inst.storage.sizeGb} GiB${inst.storage.iops ? `, ${inst.storage.iops} provisioned IOPS` : ' (no provisioned IOPS)'}${inst.storage.throughputMBps ? `, ${inst.storage.throughputMBps} MiB/s` : ''}`} />
                <KV k="Parameter group" v={inst.parameterGroup} mono />
                <KV k="max_connections" v={inst.maxConnections.toLocaleString()} mono />
                {inst.replicaOf && <KV k="Replicating from" v={inst.replicaOf} mono />}
              </div>
              {db && (
                <>
                  <div className="eyebrow" style={{ margin: '16px 0 6px' }}>
                    Key parameters ({inst.parameterGroup})
                  </div>
                  <div className="param-grid">
                    {keyParams
                      .filter(k => db.settings[k] !== undefined)
                      .map(k => (
                        <div key={k} className="param">
                          <span className="mono muted">{k}</span>
                          <span className="mono">{db.settings[k]}</span>
                        </div>
                      ))}
                  </div>
                </>
              )}
            </div>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-h">
              <h3>Performance Insights — top SQL by load</h3>
              <span className="small faint">average active sessions (AAS), last 5 minutes · vCPU line = {inst.vCpu}</span>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 180 }}>Load (AAS)</th>
                  <th>SQL</th>
                  <th style={{ width: 90 }}>Calls/min</th>
                  <th style={{ width: 90 }}>Avg ms</th>
                  <th style={{ width: 150 }}>Top wait</th>
                  <th className="pin-cell" />
                </tr>
              </thead>
              <tbody>
                {topSql.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted">
                      No significant load.
                    </td>
                  </tr>
                )}
                {topSql.map((q, k) => (
                  <tr key={k} className="pin-reveal">
                    <td>
                      <div className="aas">
                        <div className="aas-bar" style={{ width: `${Math.max(2, (q.loadAas / Math.max(maxAas, inst.vCpu)) * 100)}%` }} />
                        <div className="aas-cpu" style={{ left: `${(inst.vCpu / Math.max(maxAas, inst.vCpu)) * 100}%` }} />
                      </div>
                      <span className="mono small">{q.loadAas.toFixed(2)}</span>
                    </td>
                    <td className="mono small" style={{ wordBreak: 'break-word' }}>
                      {q.sql}
                    </td>
                    <td className="mono">{q.calls.toLocaleString()}</td>
                    <td className="mono" style={q.meanMs > 500 ? { color: 'var(--crit)' } : undefined}>
                      {q.meanMs.toLocaleString()}
                    </td>
                    <td className="mono small">{q.waitEvent}</td>
                    <td className="pin-cell">
                      <PinButton item={pinTopSql(inst.id, q)} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="section-title">
            <h2>Metrics · {inst.id}</h2>
          </div>
          <div className="metric-grid">
            {panels.map(p => (
              <MetricCard key={p.id} panel={p} now={env.now} height={120} />
            ))}
          </div>
        </>
      )}

      <div className="section-title">
        <h2>Recent events</h2>
      </div>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 120 }}>When</th>
              <th style={{ width: 200 }}>Source</th>
              <th>Message</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {events.map((e, k) => (
              <tr key={k} className="pin-reveal">
                <td className="muted">{relative(e.minutesAgo)}</td>
                <td className="mono">{e.source}</td>
                <td>{e.message}</td>
                <td className="pin-cell">
                  <PinButton item={pinRdsEvent(e)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
