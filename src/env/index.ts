import type { Environment, Incident } from '../engine/types';
import { createRng } from '../engine/rng';
import { MIN } from '../engine/time';
import { baseEnvironment } from './base';
import { finalizeEnvironment } from './finalize';

const cache = new Map<string, Environment>();

/** Build (and memoize) the simulated environment for an incident. Deterministic. */
export function createEnvironment(incident: Incident): Environment {
  const hit = cache.get(incident.id);
  if (hit) return hit;
  const now = Date.parse(incident.now);
  const env = baseEnvironment(now);
  const rng = createRng(incident.seed);
  incident.build(env, { rng, ago: (m: number) => now - m * MIN });
  finalizeEnvironment(env);
  cache.set(incident.id, env);
  return env;
}

export function clearEnvironmentCache() {
  cache.clear();
}
