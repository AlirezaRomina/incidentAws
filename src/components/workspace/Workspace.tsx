import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Incident, Pinnable, ToolId } from '../../engine/types';
import { createEnvironment } from '../../env';
import { IncidentSessionContext, useProgress, type Session } from '../../state/progress';
import { formatDuration } from '../../engine/time';
import { navigate } from '../../router';
import { Icon } from '../ui/Icon';
import { DIFFICULTY, TOOLS } from '../ui/meta';
import { CaseNotes } from './CaseNotes';
import { ToolView } from '../tools/ToolView';
import { SubmitWizard } from '../submit/SubmitWizard';
import { MAX_POINTS } from '../../engine/grading';
import { setLiveElapsed } from '../../state/timer';

const MemoToolView = memo(ToolView);

/** Ticks once per second in isolation; persists to the session every 10 s and on unmount. */
function TimerStat({ incidentId, initial, parMinutes, paused, onFlush }: { incidentId: string; initial: number; parMinutes: number; paused: boolean; onFlush: (ms: number) => void }) {
  const [ms, setMs] = useState(initial);
  const msRef = useRef(initial);
  const flushRef = useRef(onFlush);
  flushRef.current = onFlush;
  useEffect(() => {
    let last = Date.now();
    let sinceFlush = 0;
    const t = setInterval(() => {
      const now = Date.now();
      const dt = Math.min(now - last, 5000);
      last = now;
      if (document.visibilityState !== 'visible' || paused) return;
      msRef.current += dt;
      sinceFlush += dt;
      setLiveElapsed(incidentId, msRef.current);
      setMs(msRef.current);
      if (sinceFlush >= 10_000) {
        sinceFlush = 0;
        flushRef.current(msRef.current);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [incidentId, paused]);
  useEffect(() => () => flushRef.current(msRef.current), []);
  useEffect(() => {
    if (paused) flushRef.current(msRef.current);
  }, [paused]);
  const over = ms > parMinutes * 60_000;
  return (
    <div className={`stat ${over ? 'over' : ''}`} title={`Par time ${parMinutes} min — finishing under par earns a time bonus`}>
      <Icon name="clock" size={14} />
      <span className="mono">{formatDuration(ms)}</span>
      <span className="faint small">/ {parMinutes}:00</span>
    </div>
  );
}

export function Workspace({ incident }: { incident: Incident }) {
  const { get, ensureSession, updateSession, togglePin } = useProgress();
  const env = useMemo(() => createEnvironment(incident), [incident]);
  const [submitting, setSubmitting] = useState(false);
  const [notesOpen, setNotesOpen] = useState(true);

  useEffect(() => {
    ensureSession(incident.id);
  }, [incident.id, ensureSession]);

  const session: Session | undefined = get(incident.id).session;

  const setTool = useCallback(
    (tool: ToolId) => updateSession(incident.id, s => ({ ...s, tool, visited: s.visited.includes(tool) ? s.visited : [...s.visited, tool] })),
    [incident.id, updateSession],
  );

  const ctx = useMemo(
    () =>
      session && {
        incidentId: incident.id,
        session,
        isPinned: (key: string) => session.pins.some(p => p.key === key),
        togglePin: (item: Pinnable) => togglePin(incident.id, item),
        update: (fn: (s: Session) => Session) => updateSession(incident.id, fn),
      },
    [session, incident.id, togglePin, updateSession],
  );

  // keyboard: 1..9 switch tools when not typing
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el?.closest?.('input, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      const idx = Number(e.key) - 1;
      if (idx >= 0 && idx < 9 && TOOLS[idx]) {
        e.preventDefault(); // don't type the digit into the tool that receives focus
        setTool(TOOLS[idx].id);
      }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [setTool]);

  if (!session || !ctx) return null;
  const d = DIFFICULTY[incident.difficulty];

  return (
    <IncidentSessionContext.Provider value={ctx}>
      <div className={`ws ${notesOpen ? '' : 'notes-closed'}`}>
        <header className="ws-top">
          <button className="brand-mini" onClick={() => navigate('#/')} title="Back to incident board">
            <span className="brand-mark">
              <Icon name="alert" size={15} strokeWidth={2.4} />
            </span>
            INCIDENT
          </button>
          <div className="ws-title">
            <span className={`badge ${incident.briefing.severity === 'SEV1' ? 'crit' : 'warn'}`}>
              <span className="dot pulse" /> {incident.briefing.severity}
            </span>
            <span className="mono faint">{incident.code}</span>
            <h1>{incident.title}</h1>
            <span className={`badge ${d.cls}`}>{d.label}</span>
          </div>
          <div className="spacer" />
          <div className="ws-stats">
            <TimerStat incidentId={incident.id} initial={session.elapsedMs} parMinutes={incident.parMinutes} paused={submitting} onFlush={ms => updateSession(incident.id, s => ({ ...s, elapsedMs: Math.max(s.elapsedMs, ms) }))} />
            <div className="stat" title="Hints used (each costs 10% of max score)">
              <Icon name="bulb" size={14} />
              <span className="mono">{session.hintsUsed}/3</span>
            </div>
            <div className="stat" title="Pinned evidence">
              <Icon name="pin" size={14} />
              <span className="mono">{session.pins.length}</span>
            </div>
            <div className="stat" title="Maximum score for this incident">
              <Icon name="trophy" size={14} />
              <span className="mono">{MAX_POINTS[incident.difficulty]}</span>
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setNotesOpen(o => !o)} title="Toggle case notes">
            <Icon name="note" size={14} /> {notesOpen ? 'Hide notes' : 'Case notes'}
          </button>
          <button className="btn btn-primary" onClick={() => setSubmitting(true)}>
            <Icon name="flag" size={15} /> Submit diagnosis
          </button>
        </header>

        <nav className="ws-rail" aria-label="Investigation tools">
          {['Incident', 'Observe', 'Infrastructure', 'Security & change'].map(group => (
            <div key={group} className="rail-group">
              <div className="rail-h">{group}</div>
              {TOOLS.filter(t => t.group === group).map(t => {
                const idx = TOOLS.findIndex(x => x.id === t.id);
                const pins = session.pins.filter(p => p.tool === t.id).length;
                return (
                  <button key={t.id} className={`rail-item ${session.tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)}>
                    <Icon name={t.icon} size={16} />
                    <span>{t.label}</span>
                    {pins > 0 && <span className="rail-pins">{pins}</span>}
                    {!session.visited.includes(t.id) && <span className="rail-new" title="Not opened yet" />}
                    {idx < 9 && <span className="rail-key">{idx + 1}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          <div className="rail-foot">
            <div className="small faint">Simulated time</div>
            <div className="mono small">{new Date(env.now).toISOString().replace('T', ' ').slice(0, 16)} UTC</div>
          </div>
        </nav>

        <main className="ws-main">
          <MemoToolView tool={session.tool} env={env} incident={incident} onNavigate={setTool} />
        </main>

        {notesOpen && (
          <aside className="ws-notes">
            <CaseNotes incident={incident} env={env} onSubmit={() => setSubmitting(true)} />
          </aside>
        )}
      </div>
      {submitting && <SubmitWizard incident={incident} onClose={() => setSubmitting(false)} />}
    </IncidentSessionContext.Provider>
  );
}
