import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { ToolId } from '../../engine/types';
import { useIncidentSession, useProgress, type Session } from '../../state/progress';
import { Icon } from '../ui/Icon';

interface Step {
  /** data-tour attribute of the element to highlight; none = centered card */
  target?: string;
  title: string;
  body: ReactNode;
  /** tool to switch to when the step opens */
  tool?: ToolId;
  /** an action the player must do; the step completes when `done` returns true */
  task?: { label: string; done: (s: Session, start: Session) => boolean };
}

const STEPS: Step[] = [
  {
    title: 'Welcome to your first on-call shift',
    body: (
      <>
        <p>Something is broken in ShopFast's production system and you're the engineer on call. Your job is to find <b>why</b> it's broken and <b>how to fix it</b>, using the same kinds of tools real engineers use.</p>
        <p>This 2-minute tour shows you where everything is and how you're graded. Nothing you do here can break anything. Every system is simulated.</p>
      </>
    ),
  },
  {
    target: 'briefing-alert',
    tool: 'briefing',
    title: '1. Read the alert',
    body: (
      <p>
        This is the page that woke you up. It describes <b>symptoms</b> (what users see), never the cause. The chat messages below add context. Colleagues sometimes guess, and their guesses can be wrong.
      </p>
    ),
  },
  {
    target: 'rail',
    title: '2. Your investigation tools',
    body: (
      <>
        <p>
          <b>Observe</b>: graphs, logs and a terminal. <b>Infrastructure</b>: the servers, load balancer, database, network and DNS. <b>Security & change</b>: permissions, an audit log, and the list of recent deploys.
        </p>
        <p className="muted">A blue dot means you haven't opened that tool yet. Keys 1–9 switch tools.</p>
      </>
    ),
    task: { label: 'Click "CloudWatch" to continue', done: s => s.tool === 'cloudwatch' },
  },
  {
    target: 'cw-alarms',
    tool: 'cloudwatch',
    title: '3. What is alarming, and since when?',
    body: (
      <p>
        Red alarms are firing. Look at <b>when</b> they started. Timing is your best clue, because it tells you what to compare against: what changed at that moment?
      </p>
    ),
  },
  {
    target: 'cw-dashboard',
    tool: 'cloudwatch',
    title: '4. Read the graphs and pin evidence',
    body: (
      <>
        <p>Hover a graph to read exact values. Look for lines that suddenly jump or drop.</p>
        <p>
          When something looks important, click its <Icon name="pin" size={13} /> <b>pin</b> (top-right of each graph) to save it as evidence. Logs, terminal lines, table rows and policies can all be pinned the same way.
        </p>
      </>
    ),
    task: { label: 'Pin any graph to continue', done: (s, start) => s.pins.length > start.pins.length },
  },
  {
    target: 'notes',
    title: '5. Your case notes',
    body: (
      <>
        <p>
          Everything you pin lands here. Remove anything you change your mind about with <Icon name="x" size={12} />. Pins aren't graded until you submit, and then only the ones you choose.
        </p>
        <p>
          The <b>Notes</b> tab is a scratchpad. The <b>Hints</b> tab has 3 hints that get more specific, each costing 10% of the score.
        </p>
      </>
    ),
  },
  {
    target: 'rail-deploys',
    title: '6. Always ask "what changed?"',
    body: <p>Most real incidents start with a change: a deploy, a config edit, an infrastructure change. <b>Deploys & Changes</b> lists them with times and diffs, so match their times against your graphs.</p>,
  },
  {
    target: 'rail-terminal',
    title: '7. The terminal',
    body: <p>For details the consoles don't show, log into the servers. Real commands work and print realistic output.</p>,
    task: { label: 'Open the Terminal', done: s => s.tool === 'terminal' },
  },
  {
    target: 'term-input',
    tool: 'terminal',
    title: '8. Run a command',
    body: (
      <>
        <p>
          You start on a <b>bastion</b> (a jump host). Type <code>help</code> to see everything you can run. Then try <code>ssh app-1</code> and <code>df -h</code> or <code>top</code>.
        </p>
        <p className="muted">The cheatsheet on the right inserts commands for you. Hover any output line to pin it.</p>
      </>
    ),
    task: { label: 'Type help and press Enter', done: (s, start) => s.term.history.length > start.term.history.length },
  },
  {
    target: 'stats',
    title: '9. The clock and your score',
    body: (
      <p>
        The timer runs while you investigate. Finish under the <b>par time</b> with the right root cause to earn up to +10%. You can also see hints used, pins, and the maximum points for this case.
      </p>
    ),
  },
  {
    target: 'submit',
    title: '10. Submit your diagnosis',
    body: (
      <>
        <p>When you're confident, submit three things:</p>
        <ul className="tour-list">
          <li>
            <b>Root cause</b>, chosen from about 6 options <span className="muted">— 45%</span>
          </li>
          <li>
            <b>Evidence</b>, the pins that prove it <span className="muted">— 30%. Decoys cost 5% each</span>
          </li>
          <li>
            <b>Fix</b>, every action you'd take <span className="muted">— 25%. Harmful ones cost 8%</span>
          </li>
        </ul>
        <p>
          You get a grade from <b>S</b> to <b>D</b> and a debrief explaining what really happened. You can replay any case to improve.
        </p>
      </>
    ),
  },
];

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export function Tour({ onTool }: { onTool: (t: ToolId) => void }) {
  const { session } = useIncidentSession();
  const { setTutorialDone } = useProgress();
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const startRef = useRef<Session>(session);
  const cardRef = useRef<HTMLDivElement>(null);
  const [cardSize, setCardSize] = useState({ w: 380, h: 220 });
  const step = STEPS[i];
  const done = step.task ? step.task.done(session, startRef.current) : true;

  // when a step opens: remember the session state and switch tool if needed
  useEffect(() => {
    startRef.current = session;
    if (step.tool && session.tool !== step.tool) onTool(step.tool);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [i]);

  // auto-advance once an action step is completed
  useEffect(() => {
    if (step.task && done) {
      const t = setTimeout(() => setI(n => Math.min(n + 1, STEPS.length - 1)), 450);
      return () => clearTimeout(t);
    }
  }, [done, step.task]);

  // follow the target element (it can move when tools re-render or the page scrolls)
  useEffect(() => {
    let raf = 0;
    let scrolled = false;
    const tick = () => {
      const el = step.target ? (document.querySelector(`[data-tour="${step.target}"]`) as HTMLElement | null) : null;
      if (el) {
        if (!scrolled) {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          scrolled = true;
        }
        const r = el.getBoundingClientRect();
        const clipped = { top: Math.max(r.top, 0), left: r.left, width: r.width, height: Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0) };
        setRect(prev => (prev && Math.abs(prev.top - clipped.top) < 0.5 && Math.abs(prev.left - clipped.left) < 0.5 && Math.abs(prev.width - clipped.width) < 0.5 && Math.abs(prev.height - clipped.height) < 0.5 ? prev : clipped));
      } else setRect(null);
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step.target, i]);

  useLayoutEffect(() => {
    if (cardRef.current) setCardSize({ w: cardRef.current.offsetWidth, h: cardRef.current.offsetHeight });
  }, [i, rect === null]);

  const finish = () => setTutorialDone(true);

  // keyboard: Esc skips, Enter/→ goes next on info steps
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === 'Escape') finish();
      if ((e.key === 'ArrowRight' || (e.key === 'Enter' && !(e.target as HTMLElement)?.closest?.('input,textarea'))) && !step.task) {
        e.preventDefault();
        if (i === STEPS.length - 1) finish();
        else setI(i + 1);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  const pad = 6;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let pos: { top: number; left: number };
  if (!rect) pos = { top: vh / 2 - cardSize.h / 2, left: vw / 2 - cardSize.w / 2 };
  else {
    const gap = 16;
    const right = rect.left + rect.width + gap;
    const left = rect.left - gap - cardSize.w;
    const below = rect.top + rect.height + gap;
    if (right + cardSize.w < vw - 12) pos = { left: right, top: rect.top };
    else if (left > 12) pos = { left, top: rect.top };
    else if (below + cardSize.h < vh - 12) pos = { left: rect.left + rect.width / 2 - cardSize.w / 2, top: below };
    else pos = { left: rect.left + rect.width / 2 - cardSize.w / 2, top: rect.top - gap - cardSize.h };
    pos.top = Math.min(Math.max(12, pos.top), vh - cardSize.h - 12);
    pos.left = Math.min(Math.max(12, pos.left), vw - cardSize.w - 12);
  }

  return (
    <div className="tour" aria-live="polite">
      {rect ? (
        <div className="tour-spot" style={{ top: rect.top - pad, left: rect.left - pad, width: rect.width + pad * 2, height: rect.height + pad * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div ref={cardRef} className="tour-card" role="dialog" aria-label={step.title} style={{ top: pos.top, left: pos.left }}>
        <div className="tour-top">
          <span className="eyebrow" style={{ color: 'var(--accent-2)' }}>
            Tutorial · {i + 1}/{STEPS.length}
          </span>
          <span className="spacer" />
          <button className="btn btn-sm btn-ghost" onClick={finish}>
            Skip tour
          </button>
        </div>
        <h3>{step.title}</h3>
        <div className="tour-body">{step.body}</div>
        {step.task && (
          <div className={`tour-task ${done ? 'done' : ''}`}>
            <Icon name={done ? 'check' : 'arrowRight'} size={14} strokeWidth={2.4} /> {step.task.label}
          </div>
        )}
        <div className="tour-progress">
          {STEPS.map((_, k) => (
            <span key={k} className={k < i ? 'past' : k === i ? 'now' : ''} />
          ))}
        </div>
        <div className="tour-actions">
          {i > 0 && (
            <button className="btn btn-sm btn-ghost" onClick={() => setI(i - 1)}>
              Back
            </button>
          )}
          <span className="spacer" />
          {step.task && !done && (
            <button className="btn btn-sm btn-ghost" onClick={() => setI(i + 1)}>
              Skip this step
            </button>
          )}
          {!step.task &&
            (i === STEPS.length - 1 ? (
              <button className="btn btn-sm btn-primary" onClick={finish}>
                Start investigating <Icon name="arrowRight" size={13} />
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => setI(i + 1)}>
                {i === 0 ? 'Show me around' : 'Next'} <Icon name="arrowRight" size={13} />
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
