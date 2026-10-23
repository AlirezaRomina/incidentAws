import { useState } from 'react';
import { Modal } from '../ui/Modal';
import { Icon } from '../ui/Icon';
import { MAX_POINTS, RANKS } from '../../engine/grading';

type Tab = 'play' | 'scoring' | 'cases';

export function HowItWorks({ onClose, onStartTutorial, initialTab = 'play' }: { onClose: () => void; onStartTutorial: () => void; initialTab?: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  return (
    <Modal onClose={onClose} width={860}>
      <div className="modal-h">
        <Icon name="book" size={18} style={{ color: 'var(--accent)' }} />
        <div style={{ fontWeight: 700, fontSize: 16 }}>How INCIDENT works</div>
        <span className="spacer" />
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="x" size={16} />
        </button>
      </div>
      <div className="tabs" style={{ padding: '0 18px' }}>
        <button className={`tab ${tab === 'play' ? 'active' : ''}`} onClick={() => setTab('play')}>
          How to play
        </button>
        <button className={`tab ${tab === 'scoring' ? 'active' : ''}`} onClick={() => setTab('scoring')}>
          Scoring & grades
        </button>
        <button className={`tab ${tab === 'cases' ? 'active' : ''}`} onClick={() => setTab('cases')}>
          Where cases come from
        </button>
      </div>
      <div className="modal-b how">
        {tab === 'play' && (
          <>
            <p className="lead">
              Every case is a production outage at ShopFast, a fictional online shop running on AWS. You're the on-call engineer. Find <b>why</b> it's broken, <b>prove it</b>, and say <b>how you'd fix it</b>.
            </p>
            <ol className="how-steps">
              <li>
                <b>Read the briefing.</b> An alert plus messages from colleagues. Symptoms only, never the answer.
              </li>
              <li>
                <b>Investigate.</b> Use the tools on the left: graphs (CloudWatch), logs, a terminal where you can log into servers, and consoles for servers, load balancer, database, network, DNS, permissions, audit log and recent deploys. Many things you'll see are healthy and irrelevant, and that's on purpose.
              </li>
              <li>
                <b>Pin evidence.</b> Hover anything (a log line, graph, terminal output, table row) and click the <Icon name="pin" size={12} /> pin. It's saved in Case Notes on the right.
              </li>
              <li>
                <b>Submit your diagnosis</b> (top-right button): pick the root cause, tick the evidence that proves it, tick the fixes you'd apply.
              </li>
              <li>
                <b>Read the debrief.</b> Your grade, what really happened, what you missed and where it was, and the concepts behind it.
              </li>
            </ol>
            <div className="how-tip">
              <Icon name="bulb" size={15} />
              <div>
                <b>A good method for every case:</b> find <i>when</i> things went wrong (alarms and graphs), then find <i>what changed</i> at that moment (Deploys & Changes, CloudTrail), then confirm on the affected system (logs, terminal, consoles).
              </div>
            </div>
          </>
        )}

        {tab === 'scoring' && (
          <>
            <p className="lead">There's no pass/fail. Every submission is scored, and you can replay a case as often as you like. Only your best score counts.</p>
            <table className="tbl how-table">
              <thead>
                <tr>
                  <th>Part</th>
                  <th>Weight</th>
                  <th>How to get full marks</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>
                    <b>Root cause</b>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>45%</td>
                  <td>Pick the correct explanation. One "close but incomplete" option earns 20%.</td>
                </tr>
                <tr>
                  <td>
                    <b>Evidence</b>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>30%</td>
                  <td>Submit pins that prove each <i>key</i> fact. Supporting facts count half. Every decoy you submit costs 5%. Pins unrelated to the incident cost nothing.</td>
                </tr>
                <tr>
                  <td>
                    <b>Fix</b>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>25%</td>
                  <td>Tick all the correct actions (usually an immediate fix plus a prevention). Partly helpful ones count half. Harmful −8%, pointless −3%.</td>
                </tr>
                <tr>
                  <td>
                    <b>Hints</b>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>−10% each</td>
                  <td>Up to 3 per case, in Case Notes → Hints.</td>
                </tr>
                <tr>
                  <td>
                    <b>Speed bonus</b>
                  </td>
                  <td className="mono" style={{ whiteSpace: 'nowrap' }}>up to +10%</td>
                  <td>Only with the correct root cause. Full bonus at or under the par time, shrinking to 0 at 3× par.</td>
                </tr>
              </tbody>
            </table>
            <div className="how-grid">
              <div className="how-box">
                <div className="eyebrow">Grades</div>
                <div className="grade-row">
                  <span className="gpill g-S">S</span> 95%+ <span className="gpill g-A">A</span> 85%+ <span className="gpill g-B">B</span> 70%+ <span className="gpill g-C">C</span> 50%+ <span className="gpill g-D">D</span> below
                </div>
              </div>
              <div className="how-box">
                <div className="eyebrow">Points per case</div>
                <div className="small">
                  Beginner {MAX_POINTS.beginner} · Intermediate {MAX_POINTS.intermediate} · Advanced {MAX_POINTS.advanced} · Expert {MAX_POINTS.expert}
                </div>
              </div>
              <div className="how-box" style={{ gridColumn: '1 / -1' }}>
                <div className="eyebrow">Rank — total of your best score in each case</div>
                <div className="rank-ladder">
                  {RANKS.map(r => (
                    <span key={r.title}>
                      <b>{r.title}</b> <span className="faint mono">{r.min}+</span>
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </>
        )}

        {tab === 'cases' && (
          <>
            <div className="how-qa">
              <h4>Are the incidents random?</h4>
              <p>
                No. There are 12 fixed, hand-written cases. Every log line, graph and command output is generated from a fixed seed, so a case looks exactly the same every time you play it. That makes replays fair and lets you compare scores.
              </p>
            </div>
            <div className="how-qa">
              <h4>Are they based on reality?</h4>
              <p>
                Each case is modelled on a <b>common, real class of production failure</b> that engineers hit in practice: a disk filled by forgotten debug logging, a firewall rule changed by an infrastructure refactor, a database index dropped by a migration, a process killed by the Linux OOM killer, an over-tight IAM policy, a deleted NAT gateway, replica lag, port exhaustion, storage I/O credits running out, DNS rate limits.
              </p>
              <p>
                The company, people, IDs and numbers are made up, but the formats are real: nginx and PostgreSQL logs, Linux command output, AWS CLI responses and error messages, CloudWatch metric names. The mechanics (why the failure happens and how it shows up) follow how AWS, Linux and PostgreSQL actually behave.
              </p>
            </div>
            <div className="how-qa">
              <h4>How is each case built?</h4>
              <p>
                All cases start from the same healthy "ShopFast" environment: load balancer, three app servers, a worker, a PostgreSQL database with a replica, Redis, a NAT gateway, DNS and IAM roles. A case then injects one failure and its consequences everywhere an engineer would see them: graphs move, error lines appear in logs, a config shows the bad value, a deploy appears in the history. Unrelated systems stay healthy, and each case adds a few decoys that look suspicious but aren't the cause.
              </p>
            </div>
            <div className="how-qa">
              <h4>Who rates and ranks me?</h4>
              <p>
                Nobody. There's no AI and no person judging you. Each case ships with an answer key: the correct root cause, which facts count as key evidence, which are decoys, and which fixes are correct, partial, pointless or harmful. When you submit, the app compares your answers with that key using the fixed rules on the Scoring tab. Your rank is just the sum of your best scores. It all runs in your browser, and nothing is sent anywhere.
              </p>
            </div>
          </>
        )}
      </div>
      <div className="modal-f">
        <span className="small muted">New here? The guided tour walks you through your first case step by step.</span>
        <span className="spacer" />
        <button className="btn btn-primary" onClick={onStartTutorial}>
          <Icon name="play" size={14} /> Start the guided tutorial
        </button>
      </div>
    </Modal>
  );
}
