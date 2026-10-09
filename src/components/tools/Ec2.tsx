import { Fragment, useState } from 'react';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinAmi, pinAsg, pinAsgActivity, pinInstance, pinSg } from '../../engine/pins';
import { relative } from '../../engine/time';

type Tab = 'instances' | 'sgs' | 'asg' | 'amis';

export function Ec2({ env }: ToolProps) {
  const [tab, setTab] = useState<Tab>('instances');
  const [open, setOpen] = useState<string | null>(null);
  const sgName = (id: string) => env.ec2.securityGroups.find(s => s.id === id)?.name ?? id;
  return (
    <div className="tool">
      <ToolHeader title="EC2" sub="Instances, security groups, Auto Scaling and images in us-east-1." />
      <div className="tabs" style={{ marginBottom: 16 }}>
        {(
          [
            ['instances', `Instances`, env.ec2.instances.length],
            ['sgs', 'Security groups', env.ec2.securityGroups.length],
            ['asg', 'Auto Scaling', env.ec2.asgs.length],
            ['amis', 'AMIs', env.ec2.amis.length],
          ] as [Tab, string, number][]
        ).map(([id, label, n]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label} <span className="count">{n}</span>
          </button>
        ))}
      </div>

      {tab === 'instances' && (
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>Name</th>
                <th>Instance ID</th>
                <th>State</th>
                <th>Type</th>
                <th>AZ</th>
                <th>Private IP</th>
                <th>Status checks</th>
                <th>Launched</th>
                <th className="pin-cell" />
              </tr>
            </thead>
            <tbody>
              {env.ec2.instances.map(i => (
                <Fragment key={i.id}>
                  <tr className={`clickable pin-reveal ${open === i.id ? 'selected' : ''}`} onClick={() => setOpen(open === i.id ? null : i.id)}>
                    <td>
                      <b>{i.name}</b> {i.host && <span className="badge" style={{ marginLeft: 6 }}>{i.host}</span>}
                    </td>
                    <td className="mono">{i.id}</td>
                    <td>
                      <span className={`badge ${i.state === 'running' ? 'ok' : i.state === 'pending' ? 'warn' : 'crit'}`}>
                        <span className="dot" /> {i.state}
                      </span>
                    </td>
                    <td className="mono">{i.type}</td>
                    <td>{i.az}</td>
                    <td className="mono">{i.privateIp}</td>
                    <td className={i.statusChecks.startsWith('2/2') ? 'muted' : ''} style={i.statusChecks.startsWith('2/2') ? undefined : { color: 'var(--warn)' }}>
                      {i.statusChecks}
                    </td>
                    <td className="muted small">{i.launchTime.replace('T', ' ').replace('Z', '')}</td>
                    <td className="pin-cell">
                      <PinButton item={pinInstance(i)} />
                    </td>
                  </tr>
                  {open === i.id && (
                    <tr>
                      <td colSpan={9} style={{ background: 'var(--surface-0)' }}>
                        <div className="kv-grid">
                          <KV k="AMI" v={i.amiId} mono />
                          <KV k="Subnet" v={i.subnetId} mono />
                          <KV k="IAM instance profile" v={i.iamProfile ?? '—'} mono />
                          <KV k="Auto Scaling group" v={i.asg ?? '—'} mono />
                          <KV k="Public IP" v={i.publicIp ?? '—'} mono />
                          <KV k="Security groups" v={i.sgIds.map(s => `${s} (${sgName(s)})`).join(', ')} mono />
                          <KV k="Tags" v={Object.entries(i.tags).map(([k, v]) => `${k}=${v}`).join('  ·  ')} mono />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'sgs' && (
        <div className="stack">
          {env.ec2.securityGroups.map(sg => (
            <div key={sg.id} className="card pin-reveal">
              <div className="card-h">
                <h3>
                  {sg.name} <span className="mono faint" style={{ fontWeight: 400 }}>{sg.id}</span>
                </h3>
                <span className="muted small">{sg.description}</span>
                <span className="spacer" />
                <PinButton item={pinSg(sg)} />
              </div>
              <div className="sg-cols">
                {(['inbound', 'outbound'] as const).map(dir => (
                  <div key={dir}>
                    <div className="eyebrow" style={{ padding: '10px 12px 4px' }}>
                      {dir} rules
                    </div>
                    <table className="tbl">
                      <thead>
                        <tr>
                          <th>Protocol</th>
                          <th>Ports</th>
                          <th>{dir === 'inbound' ? 'Source' : 'Destination'}</th>
                          <th>Description</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sg[dir].length === 0 && (
                          <tr>
                            <td colSpan={4} className="muted">
                              No rules
                            </td>
                          </tr>
                        )}
                        {sg[dir].map((r, k) => (
                          <tr key={k}>
                            <td className="mono">{r.protocol === '-1' ? 'All' : r.protocol.toUpperCase()}</td>
                            <td className="mono">{r.ports}</td>
                            <td className="mono">
                              {r.source}
                              {r.source.startsWith('sg-') && <span className="faint"> ({sgName(r.source)})</span>}
                            </td>
                            <td className="muted">{r.description ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'asg' && (
        <div className="stack">
          {env.ec2.asgs.map(g => (
            <div key={g.name} className="card">
              <div className="card-h pin-reveal">
                <h3>{g.name}</h3>
                <span className="badge">desired {g.desired}</span>
                <span className="badge">min {g.min}</span>
                <span className="badge">max {g.max}</span>
                <span className="muted small mono">{g.launchTemplate}</span>
                <span className="spacer" />
                <PinButton item={pinAsg(g)} />
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th style={{ width: 120 }}>When</th>
                    <th style={{ width: 100 }}>Status</th>
                    <th>Activity</th>
                    <th className="pin-cell" />
                  </tr>
                </thead>
                <tbody>
                  {[...g.activities]
                    .sort((a, b) => a.minutesAgo - b.minutesAgo)
                    .map((a, k) => (
                      <tr key={k} className="pin-reveal">
                        <td className="muted">{relative(a.minutesAgo)}</td>
                        <td>
                          <span className={`badge ${a.status === 'Successful' ? 'ok' : a.status === 'Failed' ? 'crit' : 'warn'}`}>{a.status}</span>
                        </td>
                        <td>
                          <div>{a.description}</div>
                          <div className="small muted">{a.cause}</div>
                        </td>
                        <td className="pin-cell">
                          <PinButton item={pinAsgActivity(g, a)} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}

      {tab === 'amis' && (
        <div className="card">
          <table className="tbl">
            <thead>
              <tr>
                <th>AMI ID</th>
                <th>Name</th>
                <th>Created</th>
                <th>Description</th>
                <th className="pin-cell" />
              </tr>
            </thead>
            <tbody>
              {env.ec2.amis.map(a => (
                <tr key={a.id} className="pin-reveal">
                  <td className="mono">{a.id}</td>
                  <td className="mono">{a.name}</td>
                  <td className="muted small">{a.created.replace('T', ' ').replace('Z', '')}</td>
                  <td className="muted">{a.description}</td>
                  <td className="pin-cell">
                    <PinButton item={pinAmi(a)} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function KV({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="kv">
      <div className="kv-k">{k}</div>
      <div className={`kv-v ${mono ? 'mono' : ''}`}>{v}</div>
    </div>
  );
}
