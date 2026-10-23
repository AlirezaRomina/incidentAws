import { useState } from 'react';
import type { Difficulty, Incident } from '../../engine/types';
import { INCIDENTS } from '../../incidents';
import { useProgress, type IncidentProgress } from '../../state/progress';
import { MAX_POINTS, rankFor } from '../../engine/grading';
import { navigate } from '../../router';
import { Icon } from '../ui/Icon';
import { DIFFICULTY } from '../ui/meta';
import { formatDuration } from '../../engine/time';
import { Modal } from '../ui/Modal';
import { HowItWorks } from '../tutorial/HowItWorks';

const LEVELS: Difficulty[] = ['beginner', 'intermediate', 'advanced', 'expert'];

export function Board() {
  const { progress, get, restart, resetAll, markIntroSeen, setTutorialDone } = useProgress();
  const [confirmReset, setConfirmReset] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const startTutorial = () => {
    setTutorialDone(false);
    navigate(`#/play/${INCIDENTS[0].id}`);
  };
  const all = INCIDENTS.map(i => ({ i, p: get(i.id) }));
  const total = all.reduce((s, { p }) => s + (p.best?.score ?? 0), 0);
  const maxTotal = INCIDENTS.reduce((s, i) => s + MAX_POINTS[i.difficulty], 0);
  const solved = all.filter(x => x.p.status === 'solved').length;
  const rank = rankFor(total);
  const hints = all.reduce((s, { p }) => s + p.attempts.reduce((a, t) => a + t.hintsUsed, 0), 0);
  const time = all.reduce((s, { p }) => s + p.attempts.reduce((a, t) => a + t.elapsedMs, 0), 0);
  const nextUp = all.find(x => x.p.status === 'in-progress') ?? all.find(x => x.p.status === 'new');

  return (
    <div className="page board">
      <header className="board-top">
        <div className="brand">
          <span className="brand-mark lg">
            <Icon name="alert" size={22} strokeWidth={2.4} />
          </span>
          <div>
            <div className="brand-name">INCIDENT</div>
            <div className="small muted">Production troubleshooting simulator · AWS · Linux · networking · databases</div>
          </div>
        </div>
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => setHowOpen(true)}>
          <Icon name="book" size={14} /> How it works
        </button>
        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmReset(true)}>
          <Icon name="trash" size={14} /> Reset progress
        </button>
      </header>

      {!progress.seenIntro && (
        <section className="intro card">
          <div className="intro-text">
            <div className="eyebrow" style={{ color: 'var(--accent-2)' }}>
              You're on call
            </div>
            <h2>Something is broken in production. Find out why.</h2>
            <p>
              Each incident drops you into ShopFast's AWS environment mid-outage. Nothing tells you the answer: dig through CloudWatch metrics, logs, consoles and a real-feeling terminal (ssh, top, df, ss, dig, curl, psql, aws CLI…). <b>Pin</b> the evidence that matters, then submit your root cause, evidence and fix. You'll be graded and walked through the real technical concepts.
            </p>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
              <button className="btn btn-primary" onClick={startTutorial}>
                <Icon name="play" size={14} /> Start the guided tutorial
              </button>
              <button className="btn" onClick={() => setHowOpen(true)}>
                <Icon name="book" size={14} /> How scoring works
              </button>
              <button className="btn btn-ghost" onClick={markIntroSeen}>
                Dismiss
              </button>
            </div>
          </div>
          <div className="intro-steps">
            {[
              ['pager', 'Read the page', 'Symptoms only — just like a real alert.'],
              ['search', 'Investigate', 'Metrics, logs, consoles and a terminal. Healthy systems included.'],
              ['pin', 'Pin evidence', 'Prove it. Red herrings cost points.'],
              ['flag', 'Diagnose & fix', 'Root cause + evidence + remediation, then a full debrief.'],
            ].map(([icon, t, d], k) => (
              <div key={t} className="intro-step">
                <span className="intro-n">{k + 1}</span>
                <Icon name={icon as never} size={16} />
                <div>
                  <b>{t}</b>
                  <div className="small muted">{d}</div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="stats-row">
        <div className="stat-card rank">
          <div className="eyebrow">Rank</div>
          <div className="stat-big">{rank.title}</div>
          {rank.next ? (
            <>
              <div className="rank-bar">
                <div style={{ width: `${Math.min(100, (total / rank.next.min) * 100)}%` }} />
              </div>
              <div className="small faint">
                {rank.next.min - total} pts to {rank.next.title}
              </div>
            </>
          ) : (
            <div className="small faint">Top rank reached.</div>
          )}
        </div>
        <div className="stat-card">
          <div className="eyebrow">Score</div>
          <div className="stat-big mono">
            {total}
            <span className="faint" style={{ fontSize: 14 }}>
              {' '}
              / {maxTotal}
            </span>
          </div>
          <div className="small faint">best score per incident</div>
        </div>
        <div className="stat-card">
          <div className="eyebrow">Solved</div>
          <div className="stat-big mono">
            {solved}
            <span className="faint" style={{ fontSize: 14 }}>
              {' '}
              / {INCIDENTS.length}
            </span>
          </div>
          <div className="small faint">incidents diagnosed</div>
        </div>
        <div className="stat-card">
          <div className="eyebrow">Time on call</div>
          <div className="stat-big mono">{formatDuration(time)}</div>
          <div className="small faint">
            {hints} hint{hints === 1 ? '' : 's'} used overall
          </div>
        </div>
        {nextUp && (
          <button className="stat-card next" onClick={() => navigate(`#/play/${nextUp.i.id}`)}>
            <div className="eyebrow" style={{ color: 'var(--accent-2)' }}>
              {nextUp.p.status === 'in-progress' ? 'Resume' : 'Up next'}
            </div>
            <div className="next-t">{nextUp.i.title}</div>
            <div className="small muted row">
              {nextUp.i.code} · {DIFFICULTY[nextUp.i.difficulty].label} <Icon name="arrowRight" size={14} />
            </div>
          </button>
        )}
      </section>

      {LEVELS.map(level => {
        const items = all.filter(x => x.i.difficulty === level);
        if (!items.length) return null;
        const d = DIFFICULTY[level];
        return (
          <section key={level}>
            <div className="section-title">
              <span className={`badge ${d.cls}`}>{d.label}</span>
              <h2 className="muted" style={{ fontWeight: 500, fontSize: 13.5 }}>
                {d.blurb}
              </h2>
              <span className="spacer" />
              <span className="small faint">{MAX_POINTS[level]} pts each</span>
            </div>
            <div className="inc-grid">
              {items.map(({ i, p }) => (
                <IncidentCard key={i.id} incident={i} progress={p} onReplay={() => {
                  restart(i.id);
                  navigate(`#/play/${i.id}`);
                }} />
              ))}
            </div>
          </section>
        );
      })}

      <footer className="board-foot small faint">
        Everything runs locally in your browser. Progress is saved in this browser's local storage. All companies, people and data are fictional.
      </footer>

      {howOpen && <HowItWorks onClose={() => setHowOpen(false)} onStartTutorial={startTutorial} />}

      {confirmReset && (
        <Modal onClose={() => setConfirmReset(false)} width={460}>
          <div className="modal-h">
            <Icon name="trash" size={18} style={{ color: 'var(--crit)' }} />
            <b>Reset all progress?</b>
          </div>
          <div className="modal-b">This deletes every score, attempt and in-progress investigation saved in this browser. It can't be undone.</div>
          <div className="modal-f">
            <span className="spacer" />
            <button className="btn btn-ghost" onClick={() => setConfirmReset(false)}>
              Cancel
            </button>
            <button
              className="btn btn-danger"
              onClick={() => {
                resetAll();
                setConfirmReset(false);
              }}
            >
              Reset everything
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IncidentCard({ incident: i, progress: p, onReplay }: { incident: Incident; progress: IncidentProgress; onReplay: () => void }) {
  const solved = p.status === 'solved';
  const inProgress = !!p.session && p.session.elapsedMs > 0;
  return (
    <article className={`inc-card ${solved ? 'solved' : ''}`} onClick={() => navigate(solved && !inProgress ? `#/debrief/${i.id}` : `#/play/${i.id}`)} tabIndex={0} onKeyDown={e => e.key === 'Enter' && navigate(`#/play/${i.id}`)}>
      <div className="inc-top">
        <span className="mono small faint">
          #{i.order} · {i.code}
        </span>
        <span className={`badge ${i.briefing.severity === 'SEV1' ? 'crit' : 'warn'}`} style={{ height: 20, fontSize: 10.5 }}>
          {i.briefing.severity}
        </span>
        <span className="spacer" />
        {solved && p.best ? (
          <span className={`gpill g-${p.best.grade}`} title={`Best: ${p.best.score}/${p.best.max}`}>
            {p.best.grade}
          </span>
        ) : inProgress ? (
          <span className="badge info">in progress · {formatDuration(p.session!.elapsedMs)}</span>
        ) : (
          <span className="badge">new</span>
        )}
      </div>
      <h3>{i.title}</h3>
      <p className="muted small">{i.teaser}</p>
      <div className="inc-tags">
        {i.tags.map(t => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </div>
      <div className="inc-foot">
        <span className="small faint row" style={{ gap: 5 }}>
          <Icon name="clock" size={12} /> par {i.parMinutes} min
        </span>
        <span className="small faint row" style={{ gap: 5 }}>
          <Icon name="trophy" size={12} /> {solved && p.best ? `${p.best.score}/${p.best.max}` : `${MAX_POINTS[i.difficulty]} pts`}
        </span>
        <span className="spacer" />
        {solved ? (
          <span className="row" style={{ gap: 6 }}>
            <button
              className="btn btn-sm btn-ghost"
              onClick={e => {
                e.stopPropagation();
                navigate(`#/debrief/${i.id}`);
              }}
            >
              Debrief
            </button>
            <button
              className="btn btn-sm"
              onClick={e => {
                e.stopPropagation();
                if (inProgress) navigate(`#/play/${i.id}`);
                else onReplay();
              }}
            >
              {inProgress ? 'Resume' : 'Replay'}
            </button>
          </span>
        ) : (
          <span className="btn btn-sm btn-primary">
            {inProgress ? 'Resume' : 'Respond'} <Icon name="arrowRight" size={13} />
          </span>
        )}
      </div>
    </article>
  );
}
