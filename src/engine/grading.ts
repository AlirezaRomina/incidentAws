import type { Difficulty, Evidence, FixChoice, Incident, Pin, Submission } from './types';

export const MAX_POINTS: Record<Difficulty, number> = { beginner: 100, intermediate: 200, advanced: 300, expert: 400 };

export const WEIGHTS = {
  rootCause: 0.45,
  rootCausePartial: 0.2,
  evidence: 0.3,
  redHerring: 0.05,
  fix: 0.25,
  harmfulFix: 0.08,
  neutralFix: 0.03,
  hint: 0.1,
  timeBonus: 0.1,
};

export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';

export interface GradeResult {
  max: number;
  total: number;
  pct: number;
  grade: Grade;
  rootCause: { points: number; max: number; verdict: 'correct' | 'partial' | 'wrong'; chosenId: string; correctId: string };
  evidence: { points: number; max: number; found: Evidence[]; supporting: Evidence[]; missed: Evidence[]; herrings: Evidence[]; unrelated: Pin[] };
  fix: { points: number; max: number; chosen: FixChoice[]; missed: FixChoice[]; harmful: FixChoice[]; neutral: FixChoice[] };
  hints: { used: number; penalty: number };
  time: { elapsedMs: number; parMs: number; bonus: number };
}

export function gradeFor(pct: number): Grade {
  if (pct >= 95) return 'S';
  if (pct >= 85) return 'A';
  if (pct >= 70) return 'B';
  if (pct >= 50) return 'C';
  return 'D';
}

const round = (n: number) => Math.round(n);

export function gradeSubmission(incident: Incident, sub: Submission, pins: Pin[], hintsUsed: number, elapsedMs: number): GradeResult {
  const max = MAX_POINTS[incident.difficulty];

  // Root cause
  const correct = incident.rootCauses.find(c => c.correct)!;
  const chosen = incident.rootCauses.find(c => c.id === sub.rootCause);
  const verdict: GradeResult['rootCause']['verdict'] = chosen?.correct ? 'correct' : chosen?.partial ? 'partial' : 'wrong';
  const rcPts = verdict === 'correct' ? WEIGHTS.rootCause * max : verdict === 'partial' ? WEIGHTS.rootCausePartial * max : 0;

  // Evidence
  const selected = pins.filter(p => sub.evidenceKeys.includes(p.key));
  const matchedIds = new Set<string>();
  const unrelated: Pin[] = [];
  for (const p of selected) {
    const ev = incident.evidence.filter(e => e.match.test(p.text));
    if (!ev.length) unrelated.push(p);
    ev.forEach(e => matchedIds.add(e.id));
  }
  const keys = incident.evidence.filter(e => e.kind === 'key');
  const found = keys.filter(e => matchedIds.has(e.id));
  const supporting = incident.evidence.filter(e => e.kind === 'supporting' && matchedIds.has(e.id));
  const herrings = incident.evidence.filter(e => e.kind === 'red-herring' && matchedIds.has(e.id));
  const missed = keys.filter(e => !matchedIds.has(e.id));
  const evRatio = keys.length ? Math.min(1, (found.length + 0.5 * supporting.length) / keys.length) : 1;
  const evPts = Math.max(0, WEIGHTS.evidence * evRatio - WEIGHTS.redHerring * herrings.length) * max;

  // Fix
  const chosenFixes = incident.fixes.filter(f => sub.fixes.includes(f.id));
  const correctFixes = incident.fixes.filter(f => f.kind === 'correct');
  const nCorrect = chosenFixes.filter(f => f.kind === 'correct').length;
  const nPartial = chosenFixes.filter(f => f.kind === 'partial').length;
  const harmful = chosenFixes.filter(f => f.kind === 'harmful');
  const neutral = chosenFixes.filter(f => f.kind === 'neutral');
  const fixRatio = correctFixes.length ? Math.min(1, (nCorrect + 0.5 * nPartial) / correctFixes.length) : 1;
  const fixPts = Math.max(0, WEIGHTS.fix * fixRatio - WEIGHTS.harmfulFix * harmful.length - WEIGHTS.neutralFix * neutral.length) * max;

  // Hints & time
  const hintPenalty = WEIGHTS.hint * hintsUsed * max;
  const parMs = incident.parMinutes * 60_000;
  let timeFrac = 0;
  if (verdict === 'correct') {
    if (elapsedMs <= parMs) timeFrac = 1;
    else if (elapsedMs < 3 * parMs) timeFrac = 1 - (elapsedMs - parMs) / (2 * parMs);
  }
  const timeBonus = WEIGHTS.timeBonus * timeFrac * max;

  const total = Math.max(0, round(rcPts + evPts + fixPts - hintPenalty + timeBonus));
  const pct = Math.round((total / max) * 100);
  return {
    max,
    total,
    pct,
    grade: gradeFor(pct),
    rootCause: { points: round(rcPts), max: round(WEIGHTS.rootCause * max), verdict, chosenId: sub.rootCause, correctId: correct.id },
    evidence: { points: round(evPts), max: round(WEIGHTS.evidence * max), found, supporting, missed, herrings, unrelated },
    fix: { points: round(fixPts), max: round(WEIGHTS.fix * max), chosen: chosenFixes, missed: correctFixes.filter(f => !sub.fixes.includes(f.id)), harmful, neutral },
    hints: { used: hintsUsed, penalty: round(hintPenalty) },
    time: { elapsedMs, parMs, bonus: round(timeBonus) },
  };
}

export const RANKS: { min: number; title: string }[] = [
  { min: 0, title: 'Intern on shadow rotation' },
  { min: 150, title: 'Junior On-call Engineer' },
  { min: 600, title: 'On-call Engineer' },
  { min: 1300, title: 'Site Reliability Engineer' },
  { min: 2100, title: 'Senior SRE' },
  { min: 2700, title: 'Principal Incident Commander' },
];

export function rankFor(score: number) {
  let r = RANKS[0];
  let next: (typeof RANKS)[number] | undefined;
  for (let i = 0; i < RANKS.length; i++) {
    if (score >= RANKS[i].min) {
      r = RANKS[i];
      next = RANKS[i + 1];
    }
  }
  return { title: r.title, next };
}
