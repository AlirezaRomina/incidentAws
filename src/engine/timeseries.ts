import { createRng, hashString } from './rng';

/**
 * Fluent builder for realistic metric series. Positions are expressed in
 * "minutes ago" (relative to the simulation's now) so incident authors can
 * write `.stepTo(42, 97)` = "from 42 minutes ago the value sits around 97".
 *
 *   series('rds-cpu', 22, { noise: 0.08 }).rampTo(45, 96, 6).build()
 */
export class SeriesBuilder {
  private base: number[];
  private noise: number;
  private rng: () => number;
  private ops: ((i: number, v: number) => number)[] = [];
  private minV = 0;
  private maxV = Number.POSITIVE_INFINITY;
  private decimals = 1;

  constructor(
    seed: string,
    baseline: number,
    private opts: { noise?: number; points?: number; periodMinutes?: number } = {},
  ) {
    const n = opts.points ?? 180;
    this.base = new Array(n).fill(baseline);
    this.noise = opts.noise ?? 0.06;
    this.rng = createRng(hashString(seed));
  }

  private get n() {
    return this.base.length;
  }
  private idx(minutesAgo: number) {
    const period = this.opts.periodMinutes ?? 1;
    return this.n - 1 - Math.round(minutesAgo / period);
  }

  /** Gentle diurnal/traffic wave on top of baseline. amplitude is a fraction of the value. */
  wave(amplitude = 0.1, periodMinutes = 180) {
    const period = this.opts.periodMinutes ?? 1;
    this.base = this.base.map((v, i) => v * (1 + amplitude * Math.sin((i * period * 2 * Math.PI) / periodMinutes)));
    return this;
  }

  /** From `minutesAgo` onwards, move to `value` (linear ramp over `rampMinutes`). */
  rampTo(minutesAgo: number, value: number, rampMinutes = 0) {
    const start = this.idx(minutesAgo);
    const period = this.opts.periodMinutes ?? 1;
    const rampPts = Math.max(0, Math.round(rampMinutes / period));
    this.base = this.base.map((v, i) => {
      if (i < start) return v;
      if (rampPts === 0 || i >= start + rampPts) return value;
      const t = (i - start) / rampPts;
      return v + (value - v) * t;
    });
    return this;
  }

  stepTo(minutesAgo: number, value: number) {
    return this.rampTo(minutesAgo, value, 0);
  }

  /** Recover back to `value` from minutesAgo (alias of rampTo, reads better). */
  recoverTo(minutesAgo: number, value: number, rampMinutes = 0) {
    return this.rampTo(minutesAgo, value, rampMinutes);
  }

  /** Short spike centred at minutesAgo */
  spike(minutesAgo: number, value: number, widthMinutes = 2) {
    const c = this.idx(minutesAgo);
    const period = this.opts.periodMinutes ?? 1;
    const w = Math.max(1, Math.round(widthMinutes / period));
    this.base = this.base.map((v, i) => (Math.abs(i - c) <= w / 2 ? value : v));
    return this;
  }

  /** Sawtooth between low and high with a given period, starting at minutesAgo (memory leak + restart pattern). */
  sawtooth(fromMinutesAgo: number, low: number, high: number, periodMinutes: number, phaseMinutes = 0) {
    const start = this.idx(fromMinutesAgo);
    const period = this.opts.periodMinutes ?? 1;
    const pts = Math.max(2, Math.round(periodMinutes / period));
    const phase = Math.round(phaseMinutes / period);
    this.base = this.base.map((v, i) => {
      if (i < start) return v;
      const k = (i - start + phase) % pts;
      return low + ((high - low) * k) / (pts - 1);
    });
    return this;
  }

  /** Repeating window each `everyMinutes` (e.g. nightly batch job) */
  repeatWindow(firstMinutesAgo: number, everyMinutes: number, durationMinutes: number, fn: (v: number, t: number) => number) {
    const period = this.opts.periodMinutes ?? 1;
    this.ops.push((i, v) => {
      const minutesAgo = (this.n - 1 - i) * period;
      // minutes since the most recent window start (windows start at firstMinutesAgo + k*every)
      const into = (((firstMinutesAgo - minutesAgo) % everyMinutes) + everyMinutes) % everyMinutes;
      return into < durationMinutes ? fn(v, into / durationMinutes) : v;
    });
    return this;
  }

  /** Arbitrary transform applied after the base shape (before noise). */
  map(fn: (v: number, minutesAgo: number) => number) {
    const period = this.opts.periodMinutes ?? 1;
    this.ops.push((i, v) => fn(v, (this.n - 1 - i) * period));
    return this;
  }

  setNoise(noise: number) {
    this.noise = noise;
    return this;
  }

  clamp(min: number, max = Number.POSITIVE_INFINITY) {
    this.minV = min;
    this.maxV = max;
    return this;
  }

  round(decimals: number) {
    this.decimals = decimals;
    return this;
  }

  build(): number[] {
    const f = 10 ** this.decimals;
    return this.base.map((v0, i) => {
      let v = v0;
      for (const op of this.ops) v = op(i, v);
      const jitter = (this.rng() * 2 - 1) * this.noise * Math.abs(v);
      v = Math.min(this.maxV, Math.max(this.minV, v + jitter));
      return Math.round(v * f) / f;
    });
  }
}

export const series = (seed: string, baseline: number, opts?: { noise?: number; points?: number; periodMinutes?: number }) =>
  new SeriesBuilder(seed, baseline, opts);

/** Summary stats used for pin text + chart legends. */
export function stats(points: number[]) {
  const n = points.length;
  const latest = points[n - 1];
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const p of points) {
    min = Math.min(min, p);
    max = Math.max(max, p);
    sum += p;
  }
  const firstHour = points.slice(0, Math.max(1, Math.floor(n / 3)));
  const baseline = firstHour.reduce((s, p) => s + p, 0) / firstHour.length;
  return { latest, min, max, avg: sum / n, baseline };
}

export function fmtNum(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toFixed(1) + 'G';
  if (a >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
  if (a >= 100) return Math.round(v).toString();
  if (a >= 10) return v.toFixed(1).replace(/\.0$/, '');
  return v.toFixed(2).replace(/\.?0+$/, '') || '0';
}
