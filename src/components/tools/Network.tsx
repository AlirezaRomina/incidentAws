import { useState } from 'react';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinNat, pinRecord, pinRouteTable, pinSubnet } from '../../engine/pins';
import { MetricCard } from './CloudWatch';

export function VpcView({ env }: ToolProps) {
  const natPanels = env.metrics.filter(m => m.namespace === 'AWS/NATGateway');
  const subnetName = (id: string) => env.vpc.subnets.find(s => s.id === id)?.name ?? id;
  return (
    <div className="tool">
      <ToolHeader title="VPC" sub={`${env.vpc.id} · ${env.vpc.cidr}`} />
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Route tables</h2>
      </div>
      <div className="stack">
        {env.vpc.routeTables.map(rt => (
          <div key={rt.id} className="card">
            <div className="card-h pin-reveal">
              <h3>
                {rt.name} <span className="mono faint" style={{ fontWeight: 400 }}>{rt.id}</span>
              </h3>
              <span className="small muted">associated: {rt.subnets.map(subnetName).join(', ')}</span>
              <span className="spacer" />
              <PinButton item={pinRouteTable(rt)} />
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th>Destination</th>
                  <th>Target</th>
                  <th style={{ width: 130 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {rt.routes.map((r, k) => (
                  <tr key={k}>
                    <td className="mono">{r.destination}</td>
                    <td className="mono">{r.target}</td>
                    <td>
                      <span className={`badge ${r.state === 'active' ? 'ok' : 'crit'}`}>{r.state === 'active' ? 'Active' : 'Blackhole'}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <div className="section-title">
        <h2>NAT gateways</h2>
      </div>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>ID</th>
              <th>State</th>
              <th>Subnet</th>
              <th>Elastic IP</th>
              <th>Created</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {env.vpc.natGateways.map(n => (
              <tr key={n.id} className="pin-reveal">
                <td>{n.name}</td>
                <td className="mono">{n.id}</td>
                <td>
                  <span className={`badge ${n.state === 'available' ? 'ok' : n.state === 'pending' ? 'warn' : 'crit'}`}>{n.state}</span>
                </td>
                <td className="mono small">{subnetName(n.subnetId)}</td>
                <td className="mono">{n.publicIp}</td>
                <td className="muted small">{n.created.replace('T', ' ').replace('Z', '')}</td>
                <td className="pin-cell">
                  <PinButton item={pinNat(n)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {natPanels.length > 0 && (
        <div className="metric-grid" style={{ marginTop: 16 }}>
          {natPanels.map(p => (
            <MetricCard key={p.id} panel={p} now={env.now} height={110} />
          ))}
        </div>
      )}

      <div className="section-title">
        <h2>Subnets</h2>
      </div>
      <div className="card">
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Subnet ID</th>
              <th>CIDR</th>
              <th>AZ</th>
              <th>Type</th>
              <th>Route table</th>
              <th>Free IPs</th>
              <th className="pin-cell" />
            </tr>
          </thead>
          <tbody>
            {env.vpc.subnets.map(s => (
              <tr key={s.id} className="pin-reveal">
                <td>{s.name}</td>
                <td className="mono">{s.id}</td>
                <td className="mono">{s.cidr}</td>
                <td>{s.az}</td>
                <td>
                  <span className={`badge ${s.public ? 'info' : ''}`}>{s.public ? 'public' : 'private'}</span>
                </td>
                <td className="mono small">{s.routeTableId}</td>
                <td className="mono">{s.availableIps}</td>
                <td className="pin-cell">
                  <PinButton item={pinSubnet(s)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function Route53View({ env }: ToolProps) {
  const [zoneId, setZoneId] = useState(env.route53.zones[0]?.id);
  const zone = env.route53.zones.find(z => z.id === zoneId) ?? env.route53.zones[0];
  return (
    <div className="tool">
      <ToolHeader title="Route 53" sub="Hosted zones and records. Try `dig` in the terminal to see what clients actually resolve." />
      <div className="tabs" style={{ marginBottom: 16 }}>
        {env.route53.zones.map(z => (
          <button key={z.id} className={`tab ${z.id === zone?.id ? 'active' : ''}`} onClick={() => setZoneId(z.id)}>
            {z.name} <span className="count">{z.private ? 'private' : 'public'}</span>
          </button>
        ))}
      </div>
      {zone && (
        <div className="card">
          <div className="card-h">
            <h3>{zone.name}</h3>
            <span className="mono small faint">{zone.id}</span>
            <span className="badge">{zone.records.length} records</span>
          </div>
          <table className="tbl">
            <thead>
              <tr>
                <th>Record name</th>
                <th style={{ width: 80 }}>Type</th>
                <th style={{ width: 80 }}>Routing</th>
                <th style={{ width: 80 }}>TTL</th>
                <th>Value / route traffic to</th>
                <th className="pin-cell" />
              </tr>
            </thead>
            <tbody>
              {zone.records.map((r, k) => (
                <tr key={k} className="pin-reveal">
                  <td className="mono">{r.name}</td>
                  <td>
                    <span className="badge">{r.type}</span>
                  </td>
                  <td className="muted">Simple</td>
                  <td className="mono">{r.alias ? '—' : r.ttl}</td>
                  <td className="mono small" style={{ wordBreak: 'break-all' }}>
                    {r.alias ? (
                      <>
                        <span className="badge info" style={{ marginRight: 6 }}>
                          Alias
                        </span>
                        {r.alias.target}
                      </>
                    ) : (
                      r.values.map((v, i) => <div key={i}>{v}</div>)
                    )}
                  </td>
                  <td className="pin-cell">
                    <PinButton item={pinRecord(zone, r)} />
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
