import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Pin, Pinnable, Submission, ToolId } from '../engine/types';
import type { TermState } from '../engine/terminal';
import { gradeSubmission, type Grade } from '../engine/grading';
import { incidentById } from '../incidents';
import { clearLiveElapsed, getLiveElapsed } from './timer';

/* ------------------------------------------------------------------ */
/* Persisted model (localStorage)                                      */
/* ------------------------------------------------------------------ */

export interface TermEntry {
  id: number;
  host: string;
  prompt: string;
  cmd: string;
  output: string;
}

export interface Session {
  startedAt: number;
  elapsedMs: number;
  hintsUsed: number;
  pins: Pin[];
  notes: string;
  visited: ToolId[];
  tool: ToolId;
  term: { history: string[]; entries: TermEntry[]; state?: TermState };
}

export interface Attempt {
  submission: Submission;
  pins: Pin[];
  hintsUsed: number;
  elapsedMs: number;
  at: number;
  score: number;
  max: number;
  grade: Grade;
}

export interface IncidentProgress {
  status: 'new' | 'in-progress' | 'solved';
  attempts: Attempt[];
  best?: { score: number; max: number; grade: Grade; at: number; elapsedMs: number };
  session?: Session;
}

export interface Progress {
  version: 1;
  incidents: Record<string, IncidentProgress>;
  createdAt: number;
  seenIntro?: boolean;
  /** guided tour finished or skipped */
  tutorialDone?: boolean;
}

const KEY = 'incident.progress.v1';
const MAX_TERM_ENTRIES = 60;
const MAX_OUTPUT_LINES = 400;

const empty = (): Progress => ({ version: 1, incidents: {}, createdAt: Date.now() });

export function loadProgress(): Progress {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return empty();
    const p = JSON.parse(raw) as Progress;
    if (p.version !== 1 || typeof p.incidents !== 'object') return empty();
    return p;
  } catch {
    return empty();
  }
}

function compact(p: Progress): Progress {
  // keep storage small: cap terminal scrollback
  const incidents: Record<string, IncidentProgress> = {};
  for (const [id, ip] of Object.entries(p.incidents)) {
    if (!ip.session) {
      incidents[id] = ip;
      continue;
    }
    const entries = ip.session.term.entries.slice(-MAX_TERM_ENTRIES).map(e => {
      const lines = e.output.split('\n');
      return lines.length > MAX_OUTPUT_LINES ? { ...e, output: lines.slice(-MAX_OUTPUT_LINES).join('\n') } : e;
    });
    incidents[id] = { ...ip, session: { ...ip.session, term: { ...ip.session.term, entries, history: ip.session.term.history.slice(-200) } } };
  }
  return { ...p, incidents };
}

export function saveProgress(p: Progress) {
  try {
    localStorage.setItem(KEY, JSON.stringify(compact(p)));
  } catch {
    /* storage full or unavailable: progress stays in memory */
  }
}

export const newSession = (): Session => ({
  startedAt: Date.now(),
  elapsedMs: 0,
  hintsUsed: 0,
  pins: [],
  notes: '',
  visited: ['briefing'],
  tool: 'briefing',
  term: { history: [], entries: [] },
});

/* ------------------------------------------------------------------ */
/* Context                                                              */
/* ------------------------------------------------------------------ */

interface Ctx {
  progress: Progress;
  get: (id: string) => IncidentProgress;
  ensureSession: (id: string) => Session;
  updateSession: (id: string, fn: (s: Session) => Session) => void;
  togglePin: (id: string, item: Pinnable) => void;
  submit: (id: string, sub: Submission) => Attempt;
  restart: (id: string) => void;
  resetAll: () => void;
  markIntroSeen: () => void;
  setTutorialDone: (done: boolean) => void;
}

const ProgressContext = createContext<Ctx | null>(null);

export function ProgressProvider({ children }: { children: ReactNode }) {
  const [progress, setProgress] = useState<Progress>(loadProgress);
  const ref = useRef(progress);
  ref.current = progress;

  // debounced persistence
  useEffect(() => {
    const t = setTimeout(() => saveProgress(progress), 400);
    return () => clearTimeout(t);
  }, [progress]);
  useEffect(() => {
    const flush = () => saveProgress(ref.current);
    window.addEventListener('beforeunload', flush);
    document.addEventListener('visibilitychange', flush);
    return () => {
      window.removeEventListener('beforeunload', flush);
      document.removeEventListener('visibilitychange', flush);
    };
  }, []);

  const get = useCallback((id: string): IncidentProgress => ref.current.incidents[id] ?? { status: 'new', attempts: [] }, []);

  const patch = useCallback((id: string, fn: (ip: IncidentProgress) => IncidentProgress) => {
    setProgress(p => {
      const cur = p.incidents[id] ?? { status: 'new' as const, attempts: [] };
      return { ...p, incidents: { ...p.incidents, [id]: fn(cur) } };
    });
  }, []);

  const ensureSession = useCallback(
    (id: string) => {
      const cur = ref.current.incidents[id];
      if (cur?.session) return cur.session;
      const s = newSession();
      patch(id, ip => ({ ...ip, status: ip.status === 'solved' ? 'solved' : 'in-progress', session: s }));
      return s;
    },
    [patch],
  );

  const updateSession = useCallback(
    (id: string, fn: (s: Session) => Session) => {
      // no-op when there is no active session (e.g. a late timer flush right after submitting)
      patch(id, ip => (ip.session ? { ...ip, session: fn(ip.session) } : ip));
    },
    [patch],
  );

  const togglePin = useCallback(
    (id: string, item: Pinnable) => {
      updateSession(id, s => {
        const exists = s.pins.some(p => p.key === item.key);
        return { ...s, pins: exists ? s.pins.filter(p => p.key !== item.key) : [...s.pins, { ...item, pinnedAt: Date.now() }] };
      });
    },
    [updateSession],
  );

  const submit = useCallback(
    (id: string, sub: Submission): Attempt => {
      const inc = incidentById(id)!;
      const s = ref.current.incidents[id]?.session ?? newSession();
      const elapsedMs = Math.max(s.elapsedMs, getLiveElapsed(id) ?? 0);
      clearLiveElapsed(id);
      const g = gradeSubmission(inc, sub, s.pins, s.hintsUsed, elapsedMs);
      const attempt: Attempt = { submission: sub, pins: s.pins, hintsUsed: s.hintsUsed, elapsedMs, at: Date.now(), score: g.total, max: g.max, grade: g.grade };
      patch(id, ip => {
        const better = !ip.best || attempt.score > ip.best.score;
        return {
          status: 'solved',
          attempts: [...ip.attempts, attempt].slice(-10),
          best: better ? { score: attempt.score, max: attempt.max, grade: attempt.grade, at: attempt.at, elapsedMs: attempt.elapsedMs } : ip.best,
          session: undefined,
        };
      });
      return attempt;
    },
    [patch],
  );

  const restart = useCallback(
    (id: string) => {
      clearLiveElapsed(id);
      patch(id, ip => ({ ...ip, status: ip.best ? 'solved' : 'in-progress', session: newSession() }));
    },
    [patch],
  );

  const resetAll = useCallback(() => {
    const p = empty();
    p.seenIntro = true;
    setProgress(p);
    saveProgress(p);
  }, []);

  const markIntroSeen = useCallback(() => setProgress(p => ({ ...p, seenIntro: true })), []);
  const setTutorialDone = useCallback((done: boolean) => setProgress(p => ({ ...p, seenIntro: true, tutorialDone: done })), []);

  const value = useMemo(() => ({ progress, get, ensureSession, updateSession, togglePin, submit, restart, resetAll, markIntroSeen, setTutorialDone }), [progress, get, ensureSession, updateSession, togglePin, submit, restart, resetAll, markIntroSeen, setTutorialDone]);
  return <ProgressContext.Provider value={value}>{children}</ProgressContext.Provider>;
}

export function useProgress() {
  const c = useContext(ProgressContext);
  if (!c) throw new Error('useProgress outside provider');
  return c;
}

/* ------------------------------------------------------------------ */
/* Per-incident convenience (used by tool views)                        */
/* ------------------------------------------------------------------ */

interface IncidentCtx {
  incidentId: string;
  session: Session;
  isPinned: (key: string) => boolean;
  togglePin: (item: Pinnable) => void;
  update: (fn: (s: Session) => Session) => void;
}

export const IncidentSessionContext = createContext<IncidentCtx | null>(null);

export function useIncidentSession() {
  const c = useContext(IncidentSessionContext);
  if (!c) throw new Error('useIncidentSession outside workspace');
  return c;
}
