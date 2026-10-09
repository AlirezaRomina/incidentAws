import { memo, useMemo, useState, type ReactNode } from 'react';
import type { LogEvent } from '../../engine/types';
import type { ToolProps } from './ToolView';
import { ToolHeader } from './ToolView';
import { PinButton } from '../ui/PinButton';
import { pinLog } from '../../engine/pins';
import { hms, MIN } from '../../engine/time';
import { Icon } from '../ui/Icon';

const RANGES = [
  { label: '15m', min: 15 },
  { label: '1h', min: 60 },
  { label: '3h', min: 180 },
  { label: 'All', min: Infinity },
];
const PAGE = 300;

/** CloudWatch-Logs-like filter: space separated terms (AND), "quoted phrases", -exclusions, case-insensitive. */
export function compileFilter(q: string): (s: string) => boolean {
  const terms: { t: string; neg: boolean }[] = [];
  const re = /(-?)"([^"]+)"|(-?)(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(q))) {
    if (m[2] !== undefined) terms.push({ t: m[2].toLowerCase(), neg: m[1] === '-' });
    else if (m[4] && m[4] !== '-') terms.push({ t: m[4].toLowerCase(), neg: m[3] === '-' });
  }
  if (!terms.length) return () => true;
  return s => {
    const l = s.toLowerCase();
    return terms.every(({ t, neg }) => l.includes(t) !== neg);
  };
}

export function Logs({ env }: ToolProps) {
  const groups = env.logGroups;
  const [groupName, setGroupName] = useState(groups.find(g => g.name === '/shopfast/checkout-api')?.name ?? groups[0]?.name);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState(180);
  const [stream, setStream] = useState('all');
  const [newestFirst, setNewestFirst] = useState(true);
  const [limit, setLimit] = useState(PAGE);
  const group = groups.find(g => g.name === groupName);

  const streams = useMemo(() => [...new Set(group?.events.map(e => e.stream).filter(Boolean) as string[])].sort(), [group]);
  const filtered = useMemo(() => {
    if (!group) return [];
    const f = compileFilter(query);
    const from = range === Infinity ? -Infinity : env.now - range * MIN;
    return group.events.filter(e => e.ts >= from && (stream === 'all' || e.stream === stream) && f(e.msg));
  }, [group, query, range, stream, env.now]);
  const shown = useMemo(() => (newestFirst ? [...filtered].reverse() : filtered).slice(0, limit), [filtered, newestFirst, limit]);

  // histogram
  const buckets = 60;
  const span = range === Infinity ? Math.max(1, (env.now - (group?.events[0]?.ts ?? env.now)) / MIN) : range;
  const hist = useMemo(() => {
    const h = new Array(buckets).fill(0);
    for (const e of filtered) {
      const minutesAgo = (env.now - e.ts) / MIN;
      const b = buckets - 1 - Math.floor((minutesAgo / span) * buckets);
      if (b >= 0 && b < buckets) h[b]++;
    }
    return h;
  }, [filtered, env.now, span]);
  const hmax = Math.max(1, ...hist);

  return (
    <div className="tool logs-tool">
      <ToolHeader title="Logs" sub="CloudWatch Logs. Filter with terms (AND), &quot;quoted phrases&quot; and -exclusions, e.g.  error -health  or  &quot;status&quot;:502" />
      <div className="logs-layout">
        <div className="log-groups">
          <div className="eyebrow" style={{ padding: '4px 10px 8px' }}>
            Log groups
          </div>
          {groups.map(g => (
            <button
              key={g.name}
              className={`log-group ${g.name === groupName ? 'active' : ''}`}
              onClick={() => {
                setGroupName(g.name);
                setStream('all');
                setLimit(PAGE);
              }}
              title={g.description}
            >
              <span className="mono">{g.name}</span>
              <span className="faint small">{g.events.length.toLocaleString()} events</span>
            </button>
          ))}
        </div>
        <div className="log-main card">
          <div className="log-controls">
            <div className="search" style={{ flex: 1 }}>
              <Icon name="search" size={14} />
              <input
                className="input"
                style={{ width: '100%' }}
                placeholder="Filter events…"
                value={query}
                onChange={e => {
                  setQuery(e.target.value);
                  setLimit(PAGE);
                }}
                autoFocus
              />
            </div>
            <select className="input" value={stream} onChange={e => setStream(e.target.value)} title="Log stream">
              <option value="all">All streams</option>
              {streams.map(s => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <div className="seg">
              {RANGES.map(r => (
                <button key={r.label} className={range === r.min ? 'on' : ''} onClick={() => setRange(r.min)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button className="btn btn-sm btn-ghost" onClick={() => setNewestFirst(n => !n)} title="Toggle sort order">
              {newestFirst ? 'Newest first' : 'Oldest first'}
            </button>
          </div>
          <div className="hist" title="Matching events over time">
            {hist.map((v, i) => (
              <span key={i} style={{ height: `${(v / hmax) * 100}%` }} className={v ? '' : 'zero'} />
            ))}
          </div>
          <div className="log-meta small muted">
            {filtered.length.toLocaleString()} matching events{group ? ` in ${group.name}` : ''} · {group?.description}
          </div>
          <div className="log-lines">
            {shown.length === 0 ? (
              <div className="empty" style={{ margin: 16 }}>
                No events match.
              </div>
            ) : (
              shown.map(e => <LogLine key={`${e.ts}-${e.stream}-${e.msg.length}-${e.msg.slice(-24)}`} e={e} group={group!.name} />)
            )}
            {filtered.length > shown.length && (
              <button className="btn btn-sm" style={{ margin: 12 }} onClick={() => setLimit(l => l + PAGE)}>
                Show {Math.min(PAGE, filtered.length - shown.length)} more
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function levelClass(msg: string): string {
  if (/"level":(50|60)|\[(crit|alert|emerg|error)\]|\bERROR\b|FATAL|PANIC|Out of memory|oom-kill|\bfailed\b/i.test(msg)) return 'l-err';
  if (/"level":40|\[warn\]|\bWARN(ING)?\b|"status(Code)?":5\d\d|" 5\d\d \d/.test(msg)) return 'l-warn';
  if (/" 4\d\d \d/.test(msg)) return 'l-4xx';
  return '';
}

function highlight(msg: string): ReactNode {
  // emphasise HTTP status in access logs and JSON keys
  const m = msg.match(/^(.*?" )(\d{3})( \d+ .*)$/);
  if (m) {
    const s = Number(m[2]);
    return (
      <>
        {m[1]}
        <span className={s >= 500 ? 'st-5' : s >= 400 ? 'st-4' : 'st-2'}>{m[2]}</span>
        {m[3]}
      </>
    );
  }
  return msg;
}

function prettyJson(s: string) {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

const LogLine = memo(function LogLine({ e, group }: { e: LogEvent; group: string }) {
  const [open, setOpen] = useState(false);
  const isJson = e.msg.startsWith('{');
  return (
    <div className={`log-line pin-reveal ${levelClass(e.msg)}`}>
      <span className="log-ts mono">{hms(e.ts)}</span>
      {e.stream && <span className="log-stream mono">{e.stream.split('/')[0]}</span>}
      <span className={`log-msg mono ${open ? 'open' : ''}`} onClick={() => setOpen(o => !o)}>
        {open && isJson ? prettyJson(e.msg) : highlight(e.msg)}
      </span>
      <PinButton item={pinLog(group, e)} />
    </div>
  );
});
