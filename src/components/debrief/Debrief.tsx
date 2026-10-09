import { useMemo } from 'react';
import type { Incident } from '../../engine/types';
import { gradeSubmission } from '../../engine/grading';
import { describeFoundBy, evidenceFor } from '../../engine/pins';
import { useProgress } from '../../state/progress';
import { navigate } from '../../router';
import { Icon } from '../ui/Icon';
import { Rich, inline } from '../ui/Rich';
import { DIFFICULTY } from '../ui/meta';
import { formatDuration, hm, MIN } from '../../engine/time';
import { INCIDENTS } from '../../incidents';

const GRADE_COPY: Record<string, string> = {
  S: 'Textbook incident response.',
  A: 'Excellent diagnosis.',
  B: 'Solid work — a few gaps.',
  C: 'Partially there.',
  D: 'Not quite — study the debrief and try again.',
};

const FIX_LABEL: Record<string, { label: string; cls: string }> = {
  correct: { label: 'Correct', cls: 'ok' },
  partial: { label: 'Partial', cls: 'warn' },
  neutral: { label: 'No effect', cls: '' },
  harmful: { label: 'Harmful', cls: 'crit' },
};

export function DebriefPage({ incident, attemptIndex }: { incident: Incident; attemptIndex?: number }) {
  const { get, restart } = useProgress();
  const ip = get(incident.id);
  const attempt = attemptIndex !== undefined ? ip.attempts[attemptIndex] : ip.attempts[ip.attempts.length - 1];
  const result = useMemo(() => (attempt ? gradeSubmission(incident, attempt.submission, attempt.pins, attempt.hintsUsed, attempt.elapsedMs) : null), [incident, attempt]);
  const nextInc = INCIDENTS.find(i => i.order > incident.order && get(i.id).status !== 'solved') ?? INCIDENTS.find(i => i.order > incident.order);
  const d = incident.debrief;
  const now = Date.parse(incident.now);

  if (!attempt || !result) {
    return (
      <div className="page">
        <div className="empty" style={{ maxWidth: 520, margin: '80px auto' }}>
          <p>You haven't submitted a diagnosis for this incident yet.</p>
          <button className="btn btn-primary" onClick={() => navigate(`#/play/${incident.id}`)}>
            Start investigating
          </button>
        </div>
      </div>
    );
  }

  const chosenRc = incident.rootCauses.find(c => c.id === attempt.submission.rootCause);
  const correctRc = incident.rootCauses.find(c => c.correct)!;
  const selectedPins = attempt.pins.filter(p => attempt.submission.evidenceKeys.includes(p.key));
  const parts = [
    { label: 'Root cause', pts: result.rootCause.points, max: result.rootCause.max },
    { label: 'Evidence', pts: result.evidence.points, max: result.evidence.max },
    { label: 'Fix', pts: result.fix.points, max: result.fix.max },
  ];

  return (
    <div className="page debrief">
      <header className="page-top-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => navigate('#/')}>
          <Icon name="arrowLeft" size={14} /> Incident board
        </button>
        <span className="spacer" />
        <button
          className="btn btn-sm"
          onClick={() => {
            restart(incident.id);
            navigate(`#/play/${incident.id}`);
          }}
        >
          <Icon name="refresh" size={14} /> Replay incident
        </button>
        {nextInc && nextInc.id !== incident.id && (
          <button className="btn btn-primary btn-sm" onClick={() => navigate(`#/play/${nextInc.id}`)}>
            Next: {nextInc.title} <Icon name="arrowRight" size={14} />
          </button>
        )}
      </header>

      <section className="db-hero">
        <div className={`grade-badge g-${result.grade}`}>{result.grade}</div>
        <div style={{ minWidth: 0 }}>
          <div className="row small muted" style={{ gap: 8 }}>
            <span className="mono">{incident.code}</span>
            <span className={`badge ${DIFFICULTY[incident.difficulty].cls}`}>{DIFFICULTY[incident.difficulty].label}</span>
            <span>Resolved · post-incident review</span>
          </div>
          <h1>{incident.title}</h1>
          <div className="db-score">
            <span className="db-big mono">{result.total}</span>
            <span className="muted"> / {result.max} pts</span>
            <span className="db-copy">{GRADE_COPY[result.grade]}</span>
          </div>
        </div>
        <div className="db-meta">
          <div>
            <Icon name="clock" size={14} /> {formatDuration(attempt.elapsedMs)} <span className="faint">(par {incident.parMinutes}:00)</span>
          </div>
          <div>
            <Icon name="bulb" size={14} /> {attempt.hintsUsed} hint{attempt.hintsUsed === 1 ? '' : 's'} used
          </div>
          <div>
            <Icon name="pin" size={14} /> {selectedPins.length} evidence submitted
          </div>
        </div>
      </section>

      <section className="db-breakdown card">
        {parts.map(p => (
          <div key={p.label} className="bd">
            <div className="bd-h">
              <span>{p.label}</span>
              <span className="mono">
                {p.pts}/{p.max}
              </span>
            </div>
            <div className="bd-bar">
              <div style={{ width: `${p.max ? (p.pts / p.max) * 100 : 0}%` }} className={p.pts >= p.max * 0.9 ? 'good' : p.pts >= p.max * 0.4 ? 'mid' : 'bad'} />
            </div>
          </div>
        ))}
        <div className="bd small">
          <div className="bd-h">
            <span>Hints</span>
            <span className="mono" style={{ color: result.hints.penalty ? 'var(--crit)' : undefined }}>−{result.hints.penalty}</span>
          </div>
          <div className="bd-h">
            <span>Time bonus</span>
            <span className="mono" style={{ color: result.time.bonus ? 'var(--ok)' : undefined }}>+{result.time.bonus}</span>
          </div>
        </div>
      </section>

      <div className="db-grid">
        <div className="db-main">
          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="target" size={15} /> Root cause
              </h3>
              <span className={`badge ${result.rootCause.verdict === 'correct' ? 'ok' : result.rootCause.verdict === 'partial' ? 'warn' : 'crit'}`}>
                {result.rootCause.verdict === 'correct' ? 'Correct' : result.rootCause.verdict === 'partial' ? 'Partially correct' : 'Incorrect'}
              </span>
            </div>
            <div className="card-b">
              {result.rootCause.verdict !== 'correct' && chosenRc && (
                <div className="verdict wrong">
                  <div className="eyebrow">You said</div>
                  <div>{chosenRc.text}</div>
                  <div className="small muted" style={{ marginTop: 6 }}>
                    {inline(chosenRc.explanation)}
                  </div>
                </div>
              )}
              <div className="verdict right">
                <div className="eyebrow">Actual root cause</div>
                <div>{correctRc.text}</div>
                <div className="small muted" style={{ marginTop: 6 }}>
                  {inline(correctRc.explanation)}
                </div>
              </div>
              <details className="others">
                <summary className="small muted">Why the other explanations don't fit</summary>
                {incident.rootCauses
                  .filter(c => !c.correct && c.id !== chosenRc?.id)
                  .map(c => (
                    <div key={c.id} className="other">
                      <div>{c.text}</div>
                      <div className="small muted">{inline(c.explanation)}</div>
                    </div>
                  ))}
              </details>
            </div>
          </section>

          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="pin" size={15} /> Evidence
              </h3>
              <span className="small muted">
                {result.evidence.found.length}/{result.evidence.found.length + result.evidence.missed.length} key items found
              </span>
            </div>
            <div className="card-b">
              <ul className="ev-list">
                {incident.evidence
                  .filter(e => e.kind !== 'red-herring')
                  .map(e => {
                    const found = result.evidence.found.includes(e) || result.evidence.supporting.includes(e);
                    return (
                      <li key={e.id} className={found ? 'found' : e.kind === 'key' ? 'missed' : 'skipped'}>
                        <span className="ev-icon">{found ? <Icon name="check" size={13} strokeWidth={3} /> : <Icon name="x" size={13} strokeWidth={2.5} />}</span>
                        <div>
                          <div>
                            {inline(e.label)} <span className={`badge ${e.kind === 'key' ? 'accent' : ''}`}>{e.kind === 'key' ? 'key' : 'supporting'}</span>
                          </div>
                          <div className="small muted">{inline(e.explanation)}</div>
                          {!found && <div className="small where">Where: {inline(describeFoundBy(e))}</div>}
                        </div>
                      </li>
                    );
                  })}
              </ul>
              {result.evidence.herrings.length > 0 && (
                <>
                  <div className="eyebrow" style={{ margin: '16px 0 8px' }}>
                    Red herrings you submitted
                  </div>
                  <ul className="ev-list">
                    {result.evidence.herrings.map(e => (
                      <li key={e.id} className="herring">
                        <span className="ev-icon">
                          <Icon name="alert" size={13} />
                        </span>
                        <div>
                          <div>{inline(e.label)}</div>
                          <div className="small muted">{inline(e.explanation)}</div>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {result.evidence.unrelated.length > 0 && (
                <details className="others">
                  <summary className="small muted">{result.evidence.unrelated.length} submitted item(s) were neutral noise (no penalty)</summary>
                  {result.evidence.unrelated.map(p => (
                    <div key={p.key} className="other mono small ev-text">
                      {p.text}
                    </div>
                  ))}
                </details>
              )}
              {incident.evidence.some(e => e.kind === 'red-herring' && !result.evidence.herrings.includes(e)) && (
                <details className="others">
                  <summary className="small muted">Distractions in this incident (you avoided these)</summary>
                  {incident.evidence
                    .filter(e => e.kind === 'red-herring' && !result.evidence.herrings.includes(e))
                    .map(e => (
                      <div key={e.id} className="other">
                        <div>{inline(e.label)}</div>
                        <div className="small muted">{inline(e.explanation)}</div>
                      </div>
                    ))}
                </details>
              )}
              {selectedPins.length > 0 && <PinMatches incident={incident} pins={selectedPins} />}
            </div>
          </section>

          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="wrench" size={15} /> Remediation
              </h3>
            </div>
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>You</th>
                  <th>Action</th>
                  <th style={{ width: 110 }}>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {incident.fixes.map(f => {
                  const chosen = attempt.submission.fixes.includes(f.id);
                  const good = (chosen && (f.kind === 'correct' || f.kind === 'partial')) || (!chosen && (f.kind === 'harmful' || f.kind === 'neutral'));
                  return (
                    <tr key={f.id}>
                      <td>{chosen ? <span className={`badge ${good ? 'ok' : 'crit'}`}>chosen</span> : f.kind === 'correct' ? <span className="badge warn">missed</span> : <span className="faint small">—</span>}</td>
                      <td>
                        <div>{f.text}</div>
                        <div className="small muted">{inline(f.explanation)}</div>
                      </td>
                      <td>
                        <span className={`badge ${FIX_LABEL[f.kind].cls}`}>{FIX_LABEL[f.kind].label}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="book" size={15} /> What happened
              </h3>
            </div>
            <div className="card-b">
              <Rich text={d.summary} className="db-summary" />
            </div>
          </section>

          <section className="db-sec">
            <div className="section-title" style={{ marginTop: 6 }}>
              <h2>Concepts to take away</h2>
            </div>
            <div className="concepts">
              {d.concepts.map(c => (
                <div key={c.title} className="card concept">
                  <div className="concept-t">
                    <Icon name="sparkle" size={14} /> {c.title}
                  </div>
                  <Rich text={c.body} className="small" />
                </div>
              ))}
            </div>
          </section>
        </div>

        <aside className="db-side">
          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="clock" size={15} /> Timeline (UTC)
              </h3>
            </div>
            <div className="card-b">
              <ol className="mini-tl">
                {[...d.timeline]
                  .sort((a, b) => b.minutesAgo - a.minutesAgo)
                  .map((t, i) => (
                    <li key={i}>
                      <span className="mono small">{hm(now - t.minutesAgo * MIN)}</span>
                      <span className="small">{inline(t.event)}</span>
                    </li>
                  ))}
              </ol>
            </div>
          </section>
          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="terminal" size={15} /> Commands worth knowing
              </h3>
            </div>
            <div className="card-b cmds">
              {d.commands.map(c => (
                <div key={c.cmd} className="cmd">
                  <code className="cmd-c">{c.cmd}</code>
                  <div className="small muted">{inline(c.why)}</div>
                </div>
              ))}
            </div>
          </section>
          <section className="card db-sec">
            <div className="card-h">
              <h3>
                <Icon name="shield" size={15} /> Prevent it next time
              </h3>
            </div>
            <div className="card-b">
              <ul className="check-list">
                {d.prevention.map(p => (
                  <li key={p}>
                    <Icon name="check" size={13} strokeWidth={2.6} /> <span>{inline(p)}</span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
          {d.reading && d.reading.length > 0 && (
            <section className="card db-sec">
              <div className="card-h">
                <h3>
                  <Icon name="external" size={15} /> Further reading
                </h3>
              </div>
              <div className="card-b">
                {d.reading.map(r => (
                  <div key={r.url} style={{ marginBottom: 6 }}>
                    <a href={r.url} target="_blank" rel="noreferrer">
                      {r.title}
                    </a>
                  </div>
                ))}
              </div>
            </section>
          )}
          {attempt.submission.writeup && (
            <section className="card db-sec">
              <div className="card-h">
                <h3>
                  <Icon name="note" size={15} /> Your write-up
                </h3>
              </div>
              <div className="card-b small" style={{ whiteSpace: 'pre-wrap' }}>
                {attempt.submission.writeup}
              </div>
            </section>
          )}
          {ip.attempts.length > 1 && (
            <section className="card db-sec">
              <div className="card-h">
                <h3>Attempts</h3>
              </div>
              <div className="card-b">
                {ip.attempts.map((a, i) => (
                  <button key={a.at} className="attempt-row" onClick={() => navigate(`#/debrief/${incident.id}/${i}`)}>
                    <span className={`gpill g-${a.grade}`}>{a.grade}</span>
                    <span className="mono small">
                      {a.score}/{a.max}
                    </span>
                    <span className="small faint">{new Date(a.at).toLocaleString()}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function PinMatches({ incident, pins }: { incident: Incident; pins: { key: string; text: string; source: string; tool: string }[] }) {
  const rows = pins.map(p => ({ p, ev: evidenceFor(incident, p as never) }));
  return (
    <details className="others">
      <summary className="small muted">How each item you submitted was scored</summary>
      {rows.map(({ p, ev }) => (
        <div key={p.key} className="other">
          <div className="small muted">{p.source}</div>
          <div className="mono small ev-text">{p.text}</div>
          <div className="small" style={{ marginTop: 3 }}>
            {ev.length === 0 ? (
              <span className="faint">neutral — not related to the root cause</span>
            ) : (
              ev.map(e => (
                <span key={e.id} className={`badge ${e.kind === 'key' ? 'ok' : e.kind === 'supporting' ? 'info' : 'crit'}`} style={{ marginRight: 6 }}>
                  {e.kind}: {e.label.replace(/`/g, '')}
                </span>
              ))
            )}
          </div>
        </div>
      ))}
    </details>
  );
}
