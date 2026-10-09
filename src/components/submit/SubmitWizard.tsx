import { useMemo, useState } from 'react';
import type { Incident } from '../../engine/types';
import { useIncidentSession, useProgress } from '../../state/progress';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { TOOLS } from '../ui/meta';
import { navigate } from '../../router';
import { createRng, hashString } from '../../engine/rng';

const STEPS = ['Root cause', 'Evidence', 'Fix', 'Review'] as const;

function shuffled<T>(items: T[], seed: string): T[] {
  const rng = createRng(hashString(seed));
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function SubmitWizard({ incident, onClose }: { incident: Incident; onClose: () => void }) {
  const { session } = useIncidentSession();
  const { submit, get } = useProgress();
  const [step, setStep] = useState(0);
  const [rootCause, setRootCause] = useState<string>('');
  const [evidence, setEvidence] = useState<string[]>(session.pins.map(p => p.key));
  const [fixes, setFixes] = useState<string[]>([]);
  const [writeup, setWriteup] = useState('');
  const attempts = get(incident.id).attempts.length;
  const causes = useMemo(() => shuffled(incident.rootCauses, `${incident.id}-rc-${attempts}`), [incident, attempts]);
  const fixOpts = useMemo(() => shuffled(incident.fixes, `${incident.id}-fx-${attempts}`), [incident, attempts]);

  const canNext = step === 0 ? !!rootCause : step === 2 ? fixes.length > 0 : true;
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter(x => x !== id) : [...list, id]);

  const doSubmit = () => {
    submit(incident.id, { rootCause, evidenceKeys: evidence, fixes, writeup });
    onClose();
    navigate(`#/debrief/${incident.id}`);
  };

  return (
    <Modal onClose={onClose}>
      <div className="modal-h">
        <Icon name="flag" size={18} style={{ color: 'var(--accent)' }} />
        <div>
          <div style={{ fontWeight: 700, fontSize: 16 }}>Submit your diagnosis</div>
          <div className="small muted">
            {incident.code} · {incident.title}
          </div>
        </div>
        <div className="spacer" />
        <div className="steps">
          {STEPS.map((s, i) => (
            <button key={s} className={`step ${i === step ? 'on' : ''} ${i < step ? 'done' : ''}`} onClick={() => i < step && setStep(i)} disabled={i > step}>
              <span className="step-n">{i < step ? <Icon name="check" size={11} strokeWidth={3} /> : i + 1}</span>
              {s}
            </button>
          ))}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>

      <div className="modal-b">
        {step === 0 && (
          <>
            <h3 className="wiz-q">What is the root cause?</h3>
            <p className="muted small">Pick the statement that best explains the incident — the underlying cause, not just the symptom.</p>
            <div className="choice-list">
              {causes.map(c => (
                <label key={c.id} className={`choice ${rootCause === c.id ? 'on' : ''}`}>
                  <input type="radio" name="rc" checked={rootCause === c.id} onChange={() => setRootCause(c.id)} />
                  <span className="choice-mark" />
                  <span>{c.text}</span>
                </label>
              ))}
            </div>
          </>
        )}

        {step === 1 && (
          <>
            <h3 className="wiz-q">Which evidence supports your diagnosis?</h3>
            <p className="muted small">
              Select the pinned items that prove the root cause. Key evidence earns points; pinned distractions cost points. You can go back to the investigation and pin more first.
            </p>
            {session.pins.length === 0 ? (
              <div className="empty">
                You haven't pinned any evidence. You can still submit, but evidence is 30% of the score.
                <div style={{ marginTop: 10 }}>
                  <button className="btn btn-sm" onClick={onClose}>
                    Back to investigating
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="row" style={{ marginBottom: 10 }}>
                  <span className="small muted">
                    {evidence.length} of {session.pins.length} selected
                  </span>
                  <span className="spacer" />
                  <button className="btn btn-sm btn-ghost" onClick={() => setEvidence(session.pins.map(p => p.key))}>
                    Select all
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEvidence([])}>
                    Clear
                  </button>
                </div>
                <div className="choice-list">
                  {session.pins.map(p => (
                    <label key={p.key} className={`choice check ${evidence.includes(p.key) ? 'on' : ''}`}>
                      <input type="checkbox" checked={evidence.includes(p.key)} onChange={() => toggle(evidence, setEvidence, p.key)} />
                      <span className="choice-mark" />
                      <span style={{ minWidth: 0 }}>
                        <span className="small muted row" style={{ gap: 6 }}>
                          <Icon name={TOOLS.find(t => t.id === p.tool)?.icon ?? 'file'} size={12} /> {p.source}
                        </span>
                        <span className="mono ev-text">{p.text}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}

        {step === 2 && (
          <>
            <h3 className="wiz-q">What should we do?</h3>
            <p className="muted small">Select every action you would take — immediate mitigation and the durable fix. Harmful or pointless actions cost points.</p>
            <div className="choice-list">
              {fixOpts.map(f => (
                <label key={f.id} className={`choice check ${fixes.includes(f.id) ? 'on' : ''}`}>
                  <input type="checkbox" checked={fixes.includes(f.id)} onChange={() => toggle(fixes, setFixes, f.id)} />
                  <span className="choice-mark" />
                  <span>{f.text}</span>
                </label>
              ))}
            </div>
            <div style={{ marginTop: 18 }}>
              <div className="eyebrow" style={{ marginBottom: 6 }}>
                Incident summary in your own words (optional, not graded)
              </div>
              <textarea className="input" rows={4} style={{ width: '100%' }} placeholder="What happened, how you proved it, and what you'd change…" value={writeup} onChange={e => setWriteup(e.target.value)} />
            </div>
          </>
        )}

        {step === 3 && (
          <div className="review">
            <div className="review-block">
              <div className="eyebrow">Root cause</div>
              <div>{incident.rootCauses.find(c => c.id === rootCause)?.text}</div>
            </div>
            <div className="review-block">
              <div className="eyebrow">Evidence ({evidence.length})</div>
              {evidence.length === 0 ? (
                <div className="muted">None selected</div>
              ) : (
                <ul>
                  {session.pins
                    .filter(p => evidence.includes(p.key))
                    .map(p => (
                      <li key={p.key} className="mono small ev-text">
                        {p.text}
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div className="review-block">
              <div className="eyebrow">Actions ({fixes.length})</div>
              <ul>
                {incident.fixes
                  .filter(f => fixes.includes(f.id))
                  .map(f => (
                    <li key={f.id}>{f.text}</li>
                  ))}
              </ul>
            </div>
            <div className="small muted">Submitting ends this attempt. Your best score is kept and you can replay the incident any time.</div>
          </div>
        )}
      </div>

      <div className="modal-f">
        <button className="btn btn-ghost" onClick={() => (step === 0 ? onClose() : setStep(step - 1))}>
          {step === 0 ? 'Keep investigating' : 'Back'}
        </button>
        <span className="spacer" />
        {step < 3 ? (
          <button className="btn btn-primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next <Icon name="arrowRight" size={14} />
          </button>
        ) : (
          <button className="btn btn-primary btn-lg" onClick={doSubmit}>
            <Icon name="send" size={15} /> Submit diagnosis
          </button>
        )}
      </div>
    </Modal>
  );
}
