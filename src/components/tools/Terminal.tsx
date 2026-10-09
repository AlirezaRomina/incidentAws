import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ToolProps } from './ToolView';
import { complete, execute, initialTermState, promptFor, type TermState } from '../../engine/terminal';
import { useIncidentSession, type TermEntry } from '../../state/progress';
import { PinButton } from '../ui/PinButton';
import { pinTermBlock, pinTermLine } from '../../engine/pins';
import { Icon } from '../ui/Icon';

const CHEATSHEET: { title: string; cmds: string[] }[] = [
  { title: 'Get around', cmds: ['help', 'ssh app-1', 'ssh app-2', 'ssh app-3', 'ssh worker-1', 'exit'] },
  { title: 'Host health', cmds: ['top', 'free -m', 'df -h', 'uptime', 'dmesg -T | tail -n 30', 'ps aux'] },
  { title: 'Services & logs', cmds: ['systemctl status checkout-api', 'journalctl -u checkout-api -n 50', 'tail -n 50 /var/log/nginx/error.log', 'grep -c " 50[234] " /var/log/nginx/access.log', 'tail -n 30 /var/log/checkout-api/app.log', 'cat /etc/checkout-api/env'] },
  { title: 'Network', cmds: ['ss -s', 'ss -tanp', 'dig api.shopfast.io', 'curl -v http://localhost/health', 'nc -zv db.internal.shopfast.io 5432', 'ip route'] },
  { title: 'AWS CLI', cmds: ['aws sts get-caller-identity', 'aws ec2 describe-instances', 'aws elbv2 describe-target-groups', 'aws cloudtrail lookup-events --max-results 20', 'aws help'] },
  { title: 'Database', cmds: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', 'SELECT state, count(*) FROM pg_stat_activity GROUP BY state;', 'SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5;', '\\d orders', '\\q'] },
];

let nextId = Date.now();

export function Terminal({ env }: ToolProps) {
  const { session, update } = useIncidentSession();
  const term = session.term;
  const state: TermState = term.state ?? initialTermState(env);
  const [input, setInput] = useState('');
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [suggest, setSuggest] = useState<string[]>([]);
  const [showHelp, setShowHelp] = useState(true);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const prompt = promptFor(env, state);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [term.entries.length]);
  useEffect(() => inputRef.current?.focus(), []);

  const run = (raw: string) => {
    const cmd = raw.replace(/\s+$/, '');
    setSuggest([]);
    setHistIdx(null);
    setInput('');
    if (!cmd.trim()) {
      update(s => ({ ...s, term: { ...s.term, entries: [...s.term.entries, { id: nextId++, host: state.host, prompt, cmd: '', output: '' }] } }));
      return;
    }
    if (cmd.trim() === 'history') {
      const out = term.history.map((h, i) => `${String(i + 1).padStart(5)}  ${h}`).join('\n');
      update(s => ({ ...s, term: { ...s.term, history: [...s.term.history, cmd], entries: [...s.term.entries, { id: nextId++, host: state.host, prompt, cmd, output: out }] } }));
      return;
    }
    const r = execute(env, state, cmd);
    update(s => ({
      ...s,
      term: {
        state: r.state,
        history: s.term.history[s.term.history.length - 1] === cmd ? s.term.history : [...s.term.history, cmd],
        entries: r.clear ? [] : [...s.term.entries, { id: nextId++, host: state.mode === 'psql' ? `${state.host} · psql` : state.host, prompt, cmd, output: r.output }],
      },
    }));
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      run(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (!term.history.length) return;
      const i = histIdx === null ? term.history.length - 1 : Math.max(0, histIdx - 1);
      setHistIdx(i);
      setInput(term.history[i]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (histIdx === null) return;
      const i = histIdx + 1;
      if (i >= term.history.length) {
        setHistIdx(null);
        setInput('');
      } else {
        setHistIdx(i);
        setInput(term.history[i]);
      }
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const opts = complete(env, state, input);
      if (opts.length === 1) {
        const parts = input.split(/\s+/);
        parts[parts.length - 1] = opts[0];
        setInput(parts.join(' ') + (opts[0].endsWith('/') ? '' : ' '));
        setSuggest([]);
      } else if (opts.length > 1) {
        const parts = input.split(/\s+/);
        const pre = commonPrefix(opts);
        if (pre.length > parts[parts.length - 1].length) {
          parts[parts.length - 1] = pre;
          setInput(parts.join(' '));
        }
        setSuggest(opts.slice(0, 40));
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      update(s => ({ ...s, term: { ...s.term, entries: [] } }));
    } else if (e.key === 'c' && e.ctrlKey) {
      e.preventDefault();
      update(s => ({ ...s, term: { ...s.term, entries: [...s.term.entries, { id: nextId++, host: state.host, prompt, cmd: input + '^C', output: '' }] } }));
      setInput('');
    } else if (suggest.length) setSuggest([]);
  };

  const hostLabel = state.mode === 'psql' ? `psql · ${state.db}` : `${state.host} · ${env.hosts[state.host]?.ip}`;

  return (
    <div className="tool full term-tool">
      <div className="term-wrap">
        <div className="term-bar">
          <span className="term-dots">
            <i />
            <i />
            <i />
          </span>
          <span className="mono small">
            <Icon name="terminal" size={13} /> ec2-user@{hostLabel}
          </span>
          <span className="spacer" />
          <span className="small faint">read-only · hover a line to pin it</span>
          <button className="btn btn-sm btn-ghost" onClick={() => update(s => ({ ...s, term: { ...s.term, entries: [] } }))} title="Clear (Ctrl+L)">
            Clear
          </button>
          <button className={`btn btn-sm ${showHelp ? '' : 'btn-ghost'}`} onClick={() => setShowHelp(h => !h)}>
            <Icon name="book" size={13} /> Cheatsheet
          </button>
        </div>
        <div className="term-body">
          <div className="term-screen mono" ref={scrollRef} onMouseUp={() => !window.getSelection()?.toString() && inputRef.current?.focus()}>
            {term.entries.length === 0 && <Welcome env={env} />}
            {term.entries.map(e => (
              <Entry key={e.id} e={e} />
            ))}
            <div className="term-input-row">
              <span className="term-prompt">{prompt}</span>
              <input
                ref={inputRef}
                className="term-input"
                value={input}
                onChange={e => {
                  setInput(e.target.value);
                  setHistIdx(null);
                }}
                onKeyDown={onKey}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="off"
                aria-label="Terminal input"
              />
            </div>
            {suggest.length > 0 && <div className="term-suggest">{suggest.join('   ')}</div>}
          </div>
          {showHelp && (
            <div className="term-help">
              <div className="eyebrow" style={{ marginBottom: 8 }}>
                Click to insert
              </div>
              {CHEATSHEET.map(g => (
                <div key={g.title} className="cheat-group">
                  <div className="cheat-h">{g.title}</div>
                  {g.cmds.map(c => (
                    <button
                      key={c}
                      className="cheat mono"
                      onClick={() => {
                        setInput(c);
                        inputRef.current?.focus();
                      }}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              ))}
              <div className="small faint" style={{ marginTop: 10 }}>
                <span className="kbd">↑</span> <span className="kbd">↓</span> history · <span className="kbd">Tab</span> complete · <span className="kbd">Ctrl</span>+<span className="kbd">L</span> clear · pipes: <span className="mono">| grep | tail | wc -l</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function commonPrefix(xs: string[]) {
  let p = xs[0] ?? '';
  for (const x of xs) while (!x.startsWith(p)) p = p.slice(0, -1);
  return p;
}

function Welcome({ env }: { env: ToolProps['env'] }) {
  return (
    <div className="term-welcome">
      <div style={{ color: 'var(--accent-2)' }}>ShopFast production · bastion ({env.hosts[env.startHost].ip})</div>
      <div className="faint">Authorized access only. Sessions are recorded.</div>
      <div style={{ marginTop: 6 }}>
        Type <b>help</b> for what this shell can do. Hosts: {Object.keys(env.hosts).filter(h => h !== env.startHost).join(', ')}. The AWS CLI and psql are configured with read-only credentials.
      </div>
      <br />
    </div>
  );
}

const MAX_RENDER = 1500;

const Entry = memo(function Entry({ e }: { e: TermEntry }) {
  const lines = useMemo(() => (e.output ? e.output.split('\n') : []), [e.output]);
  const host = e.host.split(' ')[0];
  const shown = lines.length > MAX_RENDER ? lines.slice(-MAX_RENDER) : lines;
  const offset = lines.length - shown.length;
  return (
    <div className="term-entry">
      <div className="term-cmdline pin-reveal">
        <span className="term-prompt">{e.prompt}</span>
        <span className="term-cmd">{e.cmd}</span>
        {e.output && <PinButton item={pinTermBlock(host, e.cmd, e.output)} label="Pin the whole output" />}
      </div>
      {offset > 0 && <div className="faint">… {offset} earlier lines hidden (use head/grep to narrow the output)</div>}
      {shown.map((l, i) => (
        <div key={i} className={`term-line pin-reveal ${lineClass(l)}`}>
          <span className="term-text">{l || ' '}</span>
          {l.trim() && <PinButton item={pinTermLine(host, e.cmd, l, i + offset)} />}
        </div>
      ))}
    </div>
  );
});

function lineClass(l: string) {
  if (/\b(ERROR|FATAL|PANIC|crit|Killed process|Out of memory|No space left|Connection refused|timed out|TIMEOUT|NXDOMAIN|AccessDenied|blackhole|unhealthy|failed|EADDRNOTAVAIL|EAI_AGAIN|Signature expired|cannot execute|command not found)\b/i.test(l)) return 'tl-err';
  if (/\b(WARN|WARNING|warn)\b|"level":40/.test(l)) return 'tl-warn';
  if (/^\[simulation\]|^\[note\]|^hint:/.test(l)) return 'tl-note';
  return '';
}
