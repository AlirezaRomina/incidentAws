/** mulberry32 — tiny deterministic PRNG so every incident renders identically. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const pick = <T,>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)];

export function weighted<T>(rng: () => number, items: readonly [T, number][]): T {
  const total = items.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[items.length - 1][0];
}

export const randInt = (rng: () => number, min: number, max: number) => Math.floor(rng() * (max - min + 1)) + min;

export function hex(rng: () => number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += Math.floor(rng() * 16).toString(16);
  return s;
}

/** Log-normal-ish latency sample around a median. */
export function latency(rng: () => number, median: number, spread = 0.45): number {
  const u = Math.max(1e-9, rng());
  const v = rng();
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return Math.max(1, median * Math.exp(z * spread));
}
