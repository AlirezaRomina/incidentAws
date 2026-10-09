import { useState } from 'react';
import type { Environment, Incident } from '../../engine/types';
import { useIncidentSession } from '../../state/progress';
import { Icon } from '../ui/Icon';
import { TOOLS } from '../ui/meta';
import { MAX_POINTS } from '../../engine/grading';
import { inline } from '../ui/Rich';

export function CaseNotes({ incident, onSubmit }: { incident: Incident; env: Environment; onSubmit: () => void }) {
  const { session, togglePin, update } = useIncidentSession();
  const [tab, setTab] = useState<'evidence' | 'notes' | 'hints'>('evidence');
  const [confirmHint, setConfirmHint] = useState(false);
  const hintCost = Math.round(MAX_POINTS[incident.difficulty] * 0.1);
  const pins = [...session.pins].sort((a, b) => b.pinnedAt - a.pinnedAt);

  return (
    <div className="notes">
      <div className="tabs">
        <button className={`tab ${tab === 'evidence' ? 'active' : ''}`} onClick={() => setTab('evidence')}>
          <Icon name="pin" size={13} /> Evidence <span className="count">{session.pins.length}</span>
        </button>
        <button className={`tab ${tab === 'notes' ? 'active' : ''}`} onClick={() => setTab('notes')}>
          <Icon name="note" size={13} /> Notes
        </button>
        <button className={`tab ${tab === 'hints' ? 'active' : ''}`} onClick={() => setTab('hints')}>
          <Icon name="bulb" size={13} /> Hints <span className="count">{session.hintsUsed}/3</span>
        </button>
      </div>

      {tab === 'evidence' && (
        <div className="notes-body">
          {pins.length === 0 ? (
            <div className="empty small">
              <Icon name="pin" size={18} />
              <p style={{ margin: '8px 0 0' }}>
                Nothing pinned yet. Hover any log line, terminal output line, metric, table row or policy and click the <b>pin</b> to save it here as evidence.
              </p>
            </div>
          ) : (
            <ul className="pin-list">
              {pins.map(p => {
                const t = TOOLS.find(x => x.id === p.tool);
                return (
                  <li key={p.key} className="pin-item">
                    <div className="pin-src">
                      <Icon name={t?.icon ?? 'file'} size={12} />
                      <span>{p.source}</span>
                      <button className="icon-btn" style={{ marginLeft: 'auto', width: 22, height: 22 }} onClick={() => togglePin(p)} title="Remove">
                        <Icon name="x" size={12} />
                      </button>
                    </div>
                    <div className="pin-text mono">{p.text}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {tab === 'notes' && (
        <div className="notes-body">
          <textarea
            className="input notes-area"
            placeholder={'Scratchpad — hypotheses, timeline, things to check…\n\ne.g.\n19:00 latency jumps\n- DB CPU 96%?\n- what deployed at 19:00?'}
            value={session.notes}
            onChange={e => {
              const v = e.target.value;
              update(s => ({ ...s, notes: v }));
            }}
          />
          <p className="small faint">Notes are saved automatically and are not graded.</p>
        </div>
      )}

      {tab === 'hints' && (
        <div className="notes-body">
          <p className="small muted" style={{ marginTop: 0 }}>
            Stuck? Hints get more specific each time. Each one costs <b>{hintCost} points</b> (10% of the maximum).
          </p>
          {incident.hints.map((h, i) =>
            i < session.hintsUsed ? (
              <div key={i} className="hint revealed">
                <div className="hint-h">
                  <Icon name="bulb" size={13} /> Hint {i + 1}
                </div>
                <div>{inline(h)}</div>
              </div>
            ) : i === session.hintsUsed ? (
              <div key={i} className="hint locked">
                {confirmHint ? (
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <span className="small">Reveal hint {i + 1} for −{hintCost} pts?</span>
                    <span className="spacer" />
                    <button className="btn btn-sm btn-ghost" onClick={() => setConfirmHint(false)}>
                      Cancel
                    </button>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={() => {
                        update(s => ({ ...s, hintsUsed: Math.min(3, s.hintsUsed + 1) }));
                        setConfirmHint(false);
                      }}
                    >
                      Reveal
                    </button>
                  </div>
                ) : (
                  <button className="btn btn-sm" onClick={() => setConfirmHint(true)}>
                    <Icon name="bulb" size={13} /> Reveal hint {i + 1}
                  </button>
                )}
              </div>
            ) : (
              <div key={i} className="hint future">
                <Icon name="bulb" size={13} /> Hint {i + 1} — locked
              </div>
            ),
          )}
        </div>
      )}

      <div className="notes-foot">
        <div className="small muted">
          {session.pins.length === 0 ? 'Pin evidence while you investigate, then submit.' : `${session.pins.length} piece${session.pins.length === 1 ? '' : 's'} of evidence pinned.`}
        </div>
        <button className="btn btn-primary btn-sm" onClick={onSubmit}>
          <Icon name="flag" size={13} /> Submit
        </button>
      </div>
    </div>
  );
}
