import { describe, expect, it } from 'vitest';
import { INCIDENTS as ALL } from '../src/incidents';
import { createEnvironment } from '../src/env';
import { pinnablesForFoundBy } from '../src/engine/pins';
import { execute, initialTermState } from '../src/engine/terminal';
import { gradeSubmission } from '../src/engine/grading';
import type { Incident } from '../src/engine/types';

// INCIDENT_FILE=src/incidents/foo.ts npx vitest run tests/incidents.integrity.test.ts  → test a single incident file
const single = process.env.INCIDENT_FILE;
const INCIDENTS: Incident[] = single ? [(await import(/* @vite-ignore */ '../' + single.replace(/^\.\//, ''))).default] : ALL;

const perfectSubmission = (inc: Incident) => {
  const env = createEnvironment(inc);
  const pins = inc.evidence
    .filter(e => e.kind === 'key')
    .map(e => {
      const p = pinnablesForFoundBy(env, e).find(x => e.match.test(x.text))!;
      return { ...p, pinnedAt: 0 };
    });
  return {
    pins,
    sub: { rootCause: inc.rootCauses.find(r => r.correct)!.id, evidenceKeys: pins.map(p => p.key), fixes: inc.fixes.filter(f => f.kind === 'correct').map(f => f.id), writeup: '' },
  };
};

describe.skipIf(!!single)('incident catalogue', () => {
  it('has at least 10 incidents with unique ids, codes and orders', () => {
    expect(INCIDENTS.length).toBeGreaterThanOrEqual(10);
    expect(new Set(INCIDENTS.map(i => i.id)).size).toBe(INCIDENTS.length);
    expect(new Set(INCIDENTS.map(i => i.code)).size).toBe(INCIDENTS.length);
    expect(new Set(INCIDENTS.map(i => i.order)).size).toBe(INCIDENTS.length);
  });
  it('covers every difficulty', () => {
    const d = new Set(INCIDENTS.map(i => i.difficulty));
    for (const lvl of ['beginner', 'intermediate', 'advanced', 'expert']) expect(d.has(lvl as never)).toBe(true);
  });
});

describe.each(INCIDENTS.map(i => [i.id, i] as const))('incident %s', (_id, inc) => {
  const env = createEnvironment(inc);

  it('is well formed', () => {
    expect(inc.rootCauses.filter(r => r.correct)).toHaveLength(1);
    expect(inc.rootCauses.length).toBeGreaterThanOrEqual(4);
    expect(new Set(inc.rootCauses.map(r => r.id)).size).toBe(inc.rootCauses.length);
    expect(inc.fixes.filter(f => f.kind === 'correct').length).toBeGreaterThanOrEqual(1);
    expect(inc.fixes.some(f => f.kind === 'harmful')).toBe(true);
    expect(new Set(inc.fixes.map(f => f.id)).size).toBe(inc.fixes.length);
    expect(inc.hints).toHaveLength(3);
    expect(inc.evidence.filter(e => e.kind === 'key').length).toBeGreaterThanOrEqual(2);
    expect(inc.evidence.some(e => e.kind === 'red-herring')).toBe(true);
    expect(new Set(inc.evidence.map(e => e.id)).size).toBe(inc.evidence.length);
    expect(inc.debrief.summary.length).toBeGreaterThan(200);
    expect(inc.debrief.concepts.length).toBeGreaterThanOrEqual(3);
    expect(inc.debrief.commands.length).toBeGreaterThanOrEqual(3);
    expect(inc.debrief.prevention.length).toBeGreaterThanOrEqual(3);
    expect(Number.isNaN(Date.parse(inc.now))).toBe(false);
  });

  it.each(inc.evidence.map(e => [e.id, e] as const))('evidence %s is discoverable where foundBy says', (_eid, e) => {
    const items = pinnablesForFoundBy(env, e);
    const hit = items.some(p => e.match.test(p.text));
    if (!hit) {
      const sample = items.slice(0, 40).map(p => p.text.slice(0, 200)).join('\n');
      throw new Error(`evidence ${e.id} (${String(e.match)}) not found via ${JSON.stringify(e.foundBy)}. First outputs:\n${sample}`);
    }
  });

  it('red herrings do not match key evidence text', () => {
    const keys = inc.evidence.filter(e => e.kind === 'key');
    const herrings = inc.evidence.filter(e => e.kind === 'red-herring');
    for (const k of keys) {
      const p = pinnablesForFoundBy(env, k).find(x => k.match.test(x.text))!;
      for (const h of herrings) expect(h.match.test(p.text), `${h.id} matches key ${k.id} text`).toBe(false);
    }
  });

  it('a perfect investigation scores an S', () => {
    const { pins, sub } = perfectSubmission(inc);
    const g = gradeSubmission(inc, sub, pins, 0, 60_000);
    expect(g.rootCause.verdict).toBe('correct');
    expect(g.evidence.missed).toHaveLength(0);
    expect(g.grade).toBe('S');
  });

  it('terminal survives every debrief command and common commands on every host', () => {
    for (const host of Object.keys(env.hosts)) {
      let st = initialTermState(env);
      st = execute(env, st, `ssh ${host}`).state;
      for (const c of ['top', 'ps aux', 'df -h', 'free -m', 'ss -s', 'ss -tanp', 'journalctl -n 20', 'systemctl list-units', 'dmesg -T', 'timedatectl', 'cat /etc/checkout-api/env', 'tail -n 50 /var/log/messages', 'ls -l /var/log', 'aws sts get-caller-identity']) {
        const r = execute(env, st, c);
        expect(typeof r.output).toBe('string');
      }
    }
  });
});
