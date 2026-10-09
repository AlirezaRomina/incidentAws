import { describe, expect, it } from 'vitest';
import { gradeFor, gradeSubmission, MAX_POINTS, rankFor } from '../src/engine/grading';
import type { Incident, Pin } from '../src/engine/types';

const inc = {
  id: 't', difficulty: 'intermediate', parMinutes: 10,
  evidence: [
    { id: 'k1', kind: 'key', match: /KEY-ONE/ },
    { id: 'k2', kind: 'key', match: /KEY-TWO/ },
    { id: 's1', kind: 'supporting', match: /SUPPORT/ },
    { id: 'h1', kind: 'red-herring', match: /HERRING/ },
  ],
  rootCauses: [{ id: 'right', correct: true }, { id: 'close', partial: true }, { id: 'wrong' }],
  fixes: [{ id: 'f1', kind: 'correct' }, { id: 'f2', kind: 'correct' }, { id: 'p', kind: 'partial' }, { id: 'n', kind: 'neutral' }, { id: 'bad', kind: 'harmful' }],
} as unknown as Incident;

const pin = (key: string, text: string): Pin => ({ key, text, source: 's', tool: 'logs', pinnedAt: 0 });
const pins = [pin('a', 'KEY-ONE'), pin('b', 'KEY-TWO'), pin('c', 'SUPPORT'), pin('d', 'HERRING'), pin('e', 'noise')];
const max = MAX_POINTS.intermediate;

describe('grading', () => {
  it('perfect run within par = 110%', () => {
    const g = gradeSubmission(inc, { rootCause: 'right', evidenceKeys: ['a', 'b'], fixes: ['f1', 'f2'], writeup: '' }, pins, 0, 5 * 60_000);
    expect(g.total).toBe(Math.round(max * 1.1));
    expect(g.grade).toBe('S');
  });
  it('wrong root cause gets no root-cause points and no time bonus', () => {
    const g = gradeSubmission(inc, { rootCause: 'wrong', evidenceKeys: ['a', 'b'], fixes: ['f1', 'f2'], writeup: '' }, pins, 0, 60_000);
    expect(g.rootCause.points).toBe(0);
    expect(g.time.bonus).toBe(0);
    expect(g.total).toBe(Math.round(max * 0.55));
  });
  it('partial root cause gets partial credit', () => {
    const g = gradeSubmission(inc, { rootCause: 'close', evidenceKeys: [], fixes: [], writeup: '' }, pins, 0, 60_000);
    expect(g.rootCause.verdict).toBe('partial');
    expect(g.rootCause.points).toBe(Math.round(max * 0.2));
  });
  it('red herrings and harmful fixes cost points; missed evidence is reported', () => {
    const g = gradeSubmission(inc, { rootCause: 'right', evidenceKeys: ['a', 'd', 'e'], fixes: ['f1', 'bad', 'n'], writeup: '' }, pins, 0, 60 * 60_000);
    expect(g.evidence.missed.map(e => e.id)).toEqual(['k2']);
    expect(g.evidence.herrings.map(e => e.id)).toEqual(['h1']);
    expect(g.evidence.unrelated.map(p => p.key)).toEqual(['e']);
    expect(g.evidence.points).toBe(Math.round(max * (0.3 * 0.5 - 0.05)));
    expect(g.fix.points).toBe(Math.round(max * (0.25 * 0.5 - 0.08 - 0.03)));
    expect(g.time.bonus).toBe(0);
  });
  it('supporting evidence counts half', () => {
    const g = gradeSubmission(inc, { rootCause: 'right', evidenceKeys: ['a', 'c'], fixes: [], writeup: '' }, pins, 0, 60 * 60_000);
    expect(g.evidence.points).toBe(Math.round(max * 0.3 * 0.75));
  });
  it('hints cost 10% each and score never goes negative', () => {
    const g1 = gradeSubmission(inc, { rootCause: 'right', evidenceKeys: ['a', 'b'], fixes: ['f1', 'f2'], writeup: '' }, pins, 2, 60 * 60_000);
    expect(g1.total).toBe(Math.round(max * 0.8));
    const g2 = gradeSubmission(inc, { rootCause: 'wrong', evidenceKeys: [], fixes: ['bad'], writeup: '' }, pins, 3, 60_000);
    expect(g2.total).toBe(0);
  });
  it('time bonus decays linearly to zero at 3x par', () => {
    const at = (min: number) => gradeSubmission(inc, { rootCause: 'right', evidenceKeys: [], fixes: [], writeup: '' }, pins, 0, min * 60_000).time.bonus;
    expect(at(10)).toBe(Math.round(max * 0.1));
    expect(at(20)).toBe(Math.round(max * 0.05));
    expect(at(30)).toBe(0);
  });
  it('grade letters and ranks', () => {
    expect([gradeFor(99), gradeFor(90), gradeFor(75), gradeFor(55), gradeFor(10)]).toEqual(['S', 'A', 'B', 'C', 'D']);
    expect(rankFor(0).title).toMatch(/Intern/);
    expect(rankFor(5000).next).toBeUndefined();
  });
});
