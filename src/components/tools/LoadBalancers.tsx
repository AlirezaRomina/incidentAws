import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinLb, pinTarget, pinTg } from '../../engine/pins';
import { KV } from './Ec2';
import { MetricCard } from './CloudWatch';

export function LoadBalancers({ env }: ToolProps) {
  const albPanels = env.metrics.filter(m => ['alb.requests', 'alb.elb5xx', 'alb.healthy', 'alb.unhealthy'].includes(m.id));
  return (
    <div className="tool">
      <ToolHeader title="Load Balancers" sub="Application Load Balancers, listeners, target groups and target health." />
      <div className="stack">
        {env.elb.loadBalancers.map(lb => (
          <div key={lb.name} className="card">
            <div className="card-h pin-reveal">
              <h3>{lb.name}</h3>
              <span className={`badge ${lb.state === 'active' ? 'ok' : 'warn'}`}>{lb.state}</span>
              <span className="badge">{lb.scheme}</span>
              <span className="spacer" />
              <PinButton item={pinLb(lb)} />
            </div>
            <div className="card-b">
              <div className="kv-grid">
                <KV k="DNS name" v={lb.dnsName} mono />
                <KV k="Availability zones" v={lb.azs.join(', ')} />
                <KV k="Security groups" v={lb.sgIds.join(', ')} mono />
                <KV k="Created" v={lb.created.replace('T', ' ').replace('Z', ' UTC')} />
              </div>
              <div className="eyebrow" style={{ margin: '16px 0 6px' }}>
                Listeners
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Protocol:Port</th>
                    <th>Default action</th>
                    <th>Certificate</th>
                  </tr>
                </thead>
                <tbody>
                  {lb.listeners.map(l => (
                    <tr key={l.port}>
                      <td className="mono">
                        {l.protocol}:{l.port}
                      </td>
                      <td>{l.action}</td>
                      <td className="mono small muted">{l.certificate ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}

        {env.elb.targetGroups.map(tg => {
          const healthy = tg.targets.filter(t => t.state === 'healthy').length;
          return (
            <div key={tg.name} className="card">
              <div className="card-h pin-reveal">
                <h3>
                  Target group · {tg.name}
                </h3>
                <span className={`badge ${healthy === tg.targets.length ? 'ok' : healthy === 0 ? 'crit' : 'warn'}`}>
                  {healthy}/{tg.targets.length} healthy
                </span>
                <span className="muted small mono">
                  {tg.protocol}:{tg.port} → {tg.loadBalancer}
                </span>
                <span className="spacer" />
                <PinButton item={pinTg(tg)} />
              </div>
              <div className="card-b">
                <div className="kv-grid">
                  <KV k="Health check" v={`${tg.healthCheck.protocol} ${tg.healthCheck.path} (port: ${tg.healthCheck.port})`} mono />
                  <KV k="Interval / timeout" v={`${tg.healthCheck.intervalSec}s / ${tg.healthCheck.timeoutSec}s`} />
                  <KV k="Healthy / unhealthy threshold" v={`${tg.healthCheck.healthyThreshold} / ${tg.healthCheck.unhealthyThreshold}`} />
                  <KV k="Success codes" v={tg.healthCheck.matcher} mono />
                </div>
              </div>
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Port</th>
                    <th>AZ</th>
                    <th>Health status</th>
                    <th>Details</th>
                    <th className="pin-cell" />
                  </tr>
                </thead>
                <tbody>
                  {tg.targets.map(t => {
                    const inst = env.ec2.instances.find(i => i.id === t.id);
                    return (
                      <tr key={t.id} className="pin-reveal">
                        <td>
                          <span className="mono">{t.id}</span> {inst?.host && <span className="badge" style={{ marginLeft: 6 }}>{inst.host}</span>}
                        </td>
                        <td className="mono">{t.port}</td>
                        <td>{t.az}</td>
                        <td>
                          <span className={`badge ${t.state === 'healthy' ? 'ok' : t.state === 'unhealthy' ? 'crit' : 'warn'}`}>
                            <span className="dot" /> {t.state}
                          </span>
                        </td>
                        <td className="muted">
                          {t.reason && <span className="mono">{t.reason}</span>} {t.description}
                        </td>
                        <td className="pin-cell">
                          <PinButton item={pinTarget(tg, t)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })}

        <div className="metric-grid">
          {albPanels.map(p => (
            <MetricCard key={p.id} panel={p} now={env.now} height={120} />
          ))}
        </div>
      </div>
    </div>
  );
}
