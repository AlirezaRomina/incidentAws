import { Fragment, useMemo, useState } from 'react';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinChange, pinPolicy, pinRole, pinTrail } from '../../engine/pins';
import { DiffView, JsonView } from '../ui/Code';
import { hm, MIN, relative } from '../../engine/time';
import { Icon } from '../ui/Icon';

export function IamView({ env }: ToolProps) {
  const [sel, setSel] = useState(env.iam.roles[0]?.name);
  const role = env.iam.roles.find(r => r.name === sel) ?? env.iam.roles[0];
  return (
    <div className="tool">
      <ToolHeader title="IAM" sub="Roles used by ShopFast workloads. Read the policies carefully — ARNs matter." />
      <div className="split">
        <div className="card list-card">
          {env.iam.roles.map(r => (
            <button key={r.name} className={`list-item ${r.name === role?.name ? 'active' : ''}`} onClick={() => setSel(r.name)}>
              <Icon name="shield" size={14} />
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 12.5 }}>
                  {r.name}
                </div>
                <div className="small faint">{r.description}</div>
              </div>
            </button>
          ))}
        </div>
        {role && (
          <div className="stack" style={{ minWidth: 0 }}>
            <div className="card">
              <div className="card-h pin-reveal">
                <h3>{role.name}</h3>
                <span className="small muted">modified {relative(role.lastModifiedMinutesAgo)}</span>
                <span className="spacer" />
                <PinButton item={pinRole(role)} />
              </div>
              <div className="card-b">
                <div className="kv-grid">
                  <div className="kv">
                    <div className="kv-k">ARN</div>
                    <div className="kv-v mono">{role.arn}</div>
                  </div>
                  <div className="kv">
                    <div className="kv-k">Instance profile</div>
                    <div className="kv-v mono">{role.instanceProfile ?? '—'}</div>
                  </div>
                </div>
                <div className="eyebrow" style={{ margin: '14px 0 6px' }}>
                  Trust policy
                </div>
                <JsonView value={role.trust} />
              </div>
            </div>
            {role.policies.map(p => (
              <div key={p.name} className="card">
                <div className="card-h pin-reveal">
                  <h3 className="mono">{p.name}</h3>
                  <span className={`badge ${p.type === 'inline' ? 'accent' : p.type === 'aws-managed' ? '' : 'info'}`}>{p.type}</span>
                  {p.arn && <span className="mono small faint">{p.arn}</span>}
                  <span className="spacer" />
                  <PinButton item={pinPolicy(role, p)} />
                </div>
                <div className="card-b">
                  <JsonView value={p.document} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function CloudTrailView({ env }: ToolProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const events = useMemo(
    () => [...env.cloudtrail].sort((a, b) => a.minutesAgo - b.minutesAgo).filter(e => !q || `${e.eventName} ${e.user} ${e.resources} ${e.eventSource} ${e.errorCode ?? ''}`.toLowerCase().includes(q.toLowerCase())),
    [env.cloudtrail, q],
  );
  return (
    <div className="tool">
      <ToolHeader title="CloudTrail" sub="Management API events in this account (who changed what, when).">
        <div className="search">
          <Icon name="search" size={14} />
          <input className="input" placeholder="Filter by event, user, resource…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
      </ToolHeader>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 130 }}>Event time</th>
              <th>Event name</th>
              <th>User</th>
              <th>Source</th>
              <th>Resources</th>
              <th style={{ width: 120 }}>Error</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {events.map((e, k) => (
              <Fragment key={k}>
                <tr className={`clickable pin-reveal ${open === k ? 'selected' : ''}`} onClick={() => setOpen(open === k ? null : k)}>
                  <td className="mono small">
                    {hm(env.now - e.minutesAgo * MIN)} <span className="faint">({relative(e.minutesAgo)})</span>
                  </td>
                  <td className="mono">
                    <b>{e.eventName}</b>
                  </td>
                  <td className="mono small">{e.user}</td>
                  <td className="mono small muted">{e.eventSource.replace('.amazonaws.com', '')}</td>
                  <td className="mono small" style={{ wordBreak: 'break-all' }}>
                    {e.resources}
                  </td>
                  <td>{e.errorCode ? <span className="badge crit">{e.errorCode}</span> : <span className="faint">—</span>}</td>
                  <td className="pin-cell">
                    <PinButton item={pinTrail(e)} />
                  </td>
                </tr>
                {open === k && (
                  <tr>
                    <td colSpan={7} style={{ background: 'var(--surface-0)' }}>
                      <JsonView value={{ eventName: e.eventName, eventSource: e.eventSource, userIdentity: { arn: e.user }, sourceIPAddress: e.sourceIp, ...(e.errorCode ? { errorCode: e.errorCode } : {}), requestParameters: e.request ?? null, resources: e.resources }} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const KIND_CLS: Record<string, string> = { deploy: 'info', migration: 'violet', config: 'warn', infra: 'accent', ami: 'violet', 'feature-flag': 'ok' };

export function DeploysView({ env }: ToolProps) {
  const [open, setOpen] = useState<string | null>(null);
  const changes = [...env.changes].sort((a, b) => a.minutesAgo - b.minutesAgo);
  return (
    <div className="tool">
      <ToolHeader title="Deploys & changes" sub="Everything that changed recently: deploys, migrations, config, infrastructure and feature flags. Most incidents start with a change." />
      <div className="timeline">
        {changes.map(c => (
          <div key={c.id} className="tl-item">
            <div className="tl-time">
              <div className="mono">{hm(env.now - c.minutesAgo * MIN)}</div>
              <div className="small faint">{relative(c.minutesAgo)}</div>
            </div>
            <div className="tl-dot" />
            <div className="card tl-card pin-reveal">
              <div className="card-h" style={{ cursor: c.diff ? 'pointer' : undefined }} onClick={() => c.diff && setOpen(open === c.id ? null : c.id)}>
                <span className={`badge ${KIND_CLS[c.kind] ?? ''}`}>{c.kind}</span>
                <h3 style={{ minWidth: 0 }}>{c.title}</h3>
                <span className="spacer" />
                <span className={`badge ${c.status === 'succeeded' ? 'ok' : c.status === 'failed' ? 'crit' : 'warn'}`}>{c.status}</span>
                <PinButton item={pinChange(c)} />
              </div>
              <div className="card-b">
                <div className="small muted" style={{ marginBottom: 6 }}>
                  <span className="mono">{c.id}</span> · {c.service}
                  {c.version ? ` · v${c.version}` : ''} · by {c.author}
                </div>
                <div>{c.description}</div>
                {c.diff && (
                  <button className="btn btn-sm btn-ghost" style={{ marginTop: 8, paddingLeft: 0 }} onClick={() => setOpen(open === c.id ? null : c.id)}>
                    <Icon name={open === c.id ? 'chevronDown' : 'chevronRight'} size={13} /> {open === c.id ? 'Hide diff' : 'View diff'}
                  </button>
                )}
                {open === c.id && c.diff && (
                  <div style={{ marginTop: 8 }}>
                    <DiffView diff={c.diff} />
                  </div>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
