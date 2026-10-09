import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { Icon } from '../ui/Icon';
import { hm, human, MIN } from '../../engine/time';
import { inline } from '../ui/Rich';
import { MAX_POINTS } from '../../engine/grading';

const AVATAR_COLORS = ['#4da3ff', '#f5b84b', '#3ecf8e', '#c084fc', '#ff7eb6'];

export function Briefing({ env, incident, onNavigate }: ToolProps) {
  const b = incident.briefing;
  const reports = [...b.reports].sort((x, y) => y.minutesAgo - x.minutesAgo);
  return (
    <div className="tool">
      <ToolHeader title="Incident briefing" sub={`You are the on-call engineer. It is ${human(env.now)}.`} />
      <div className="brief-grid">
        <div className="brief-col">
          <div className="page-card">
            <div className="page-top">
              <span className="page-src">
                <Icon name="bell" size={14} /> {b.alert.source}
              </span>
              <span className={`badge ${b.severity === 'SEV1' ? 'crit' : 'warn'}`}>
                <span className="dot pulse" /> TRIGGERED · {b.severity}
              </span>
              <span className="spacer" />
              <span className="mono small faint">{hm(env.now - b.alert.minutesAgo * MIN)} UTC</span>
            </div>
            <div className="page-title">{b.alert.title}</div>
            <div className="page-details">{b.alert.details}</div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>
                <span className="mono faint">#</span> {b.reports[0]?.channel.replace('#', '') ?? 'incident'}
              </h3>
              <span className="small faint">{reports.length} messages</span>
            </div>
            <div className="chat">
              {reports.map((r, i) => (
                <div key={i} className="msg">
                  <div className="avatar" style={{ background: AVATAR_COLORS[i % AVATAR_COLORS.length] }}>
                    {r.from
                      .split(' ')
                      .map(s => s[0])
                      .join('')
                      .slice(0, 2)}
                  </div>
                  <div>
                    <div className="msg-h">
                      <b>{r.from}</b>
                      <span className="small faint">{r.role}</span>
                      <span className="small faint mono">{hm(env.now - r.minutesAgo * MIN)}</span>
                    </div>
                    <div className="msg-b">{inline(r.message)}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="brief-col">
          <div className="card">
            <div className="card-h">
              <h3>Impact</h3>
            </div>
            <div className="card-b">
              <p style={{ margin: 0 }}>{b.impact}</p>
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 12 }}>
                {b.services.map(s => (
                  <span key={s} className="badge">
                    {s}
                  </span>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>Your mission</h3>
              <span className="badge accent">{MAX_POINTS[incident.difficulty]} pts max</span>
            </div>
            <div className="card-b mission">
              <ol>
                <li>
                  <b>Investigate.</b> Use the tools on the left. Everything is simulated but behaves like the real thing — including healthy systems that are <i>not</i> the problem.
                </li>
                <li>
                  <b>Pin evidence.</b> Hover a log line, terminal line, metric or resource and click <Icon name="pin" size={12} /> to add it to your case notes.
                </li>
                <li>
                  <b>Submit a diagnosis:</b> root cause, supporting evidence and a fix. You'll be graded and get a full debrief.
                </li>
              </ol>
              <div className="row small muted" style={{ gap: 14, flexWrap: 'wrap' }}>
                <span>
                  <Icon name="clock" size={12} /> Par {incident.parMinutes} min (time bonus)
                </span>
                <span>
                  <Icon name="bulb" size={12} /> Hints cost 10% each
                </span>
                <span>
                  <span className="kbd">1</span>–<span className="kbd">9</span> switch tools
                </span>
              </div>
              <div className="row" style={{ marginTop: 14, gap: 8 }}>
                <button className="btn btn-sm" onClick={() => onNavigate('cloudwatch')}>
                  <Icon name="chart" size={13} /> Open CloudWatch
                </button>
                <button className="btn btn-sm" onClick={() => onNavigate('terminal')}>
                  <Icon name="terminal" size={13} /> Open terminal
                </button>
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-h">
              <h3>ShopFast production (us-east-1)</h3>
            </div>
            <div className="card-b">
              <Architecture />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Box({ x, y, w = 120, h = 40, title, sub, tone = 'default' }: { x: number; y: number; w?: number; h?: number; title: string; sub?: string; tone?: 'default' | 'ext' | 'data' }) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={8} className={`arch-box ${tone}`} />
      <text x={x + w / 2} y={y + (sub ? 17 : 24)} textAnchor="middle" className="arch-t">
        {title}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + 31} textAnchor="middle" className="arch-s">
          {sub}
        </text>
      )}
    </g>
  );
}

function Architecture() {
  const line = (x1: number, y1: number, x2: number, y2: number, dashed = false) => <line x1={x1} y1={y1} x2={x2} y2={y2} className={`arch-l ${dashed ? 'dashed' : ''}`} markerEnd="url(#arr)" />;
  return (
    <svg viewBox="0 0 520 330" className="arch" role="img" aria-label="Architecture diagram">
      <defs>
        <marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" className="arch-arrow" />
        </marker>
      </defs>
      <rect x={8} y={58} width={504} height={264} rx={12} className="arch-vpc" />
      <text x={20} y={76} className="arch-s" style={{ textAnchor: 'start' }}>
        VPC 10.0.0.0/16 — public + private subnets in us-east-1a/b
      </text>
      <Box x={8} y={6} w={150} title="Users / mobile apps" sub="api.shopfast.io" tone="ext" />
      <Box x={190} y={6} w={120} title="Route 53" sub="shopfast.io zones" tone="ext" />
      <Box x={190} y={90} w={140} title="ALB" sub="shopfast-prod-alb :443" />
      <Box x={22} y={90} w={130} title="Bastion" sub="10.0.0.12 (you)" />
      {line(158, 26, 190, 26)}
      {line(250, 46, 255, 90)}
      <Box x={150} y={166} w={220} h={52} title="checkout-api ASG ×3" sub="app-1..3 · nginx :80 → node :3000" />
      {line(260, 130, 260, 166)}
      <Box x={22} y={170} w={110} title="worker-1" sub="queue consumer" />
      <Box x={150} y={256} w={130} title="RDS PostgreSQL" sub="checkout-db (+replica)" tone="data" />
      <Box x={296} y={256} w={100} title="ElastiCache" sub="Redis" tone="data" />
      {line(230, 218, 220, 256)}
      {line(320, 218, 340, 256)}
      {line(132, 200, 160, 256, true)}
      <Box x={392} y={90} w={110} title="NAT gateway" sub="egress" />
      <Box x={392} y={170} w={110} title="S3 · SQS" sub="invoices, orders" tone="ext" />
      <Box x={408} y={6} w={100} title="PayBridge" sub="payments API" tone="ext" />
      {line(370, 180, 392, 130)}
      {line(447, 90, 455, 46)}
      {line(370, 200, 392, 196, true)}
    </svg>
  );
}
