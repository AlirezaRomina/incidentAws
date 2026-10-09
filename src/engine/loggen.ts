import type { LogEvent } from './types';
import { createRng, hashString, hex, latency, pick, weighted } from './rng';
import { MIN, iso, nginxTime } from './time';

/**
 * Background traffic generators. They give every incident realistic, seeded
 * "noise" that the interesting lines are mixed into.
 */

export interface TrafficProfile {
  rpm?: number; // requests per minute in this log
  p50Ms?: number; // median latency
  errorRate?: number; // 0..1 fraction of requests that fail
  errorStatus?: number; // which status failing requests get (500, 502, 503, 504)
  /** override upstream_response_time text for failing requests e.g. "-" */
  errorUpstream?: string;
}

export const ROUTES: [string, string, number][] = [
  ['GET', '/api/v1/products', 30],
  ['GET', '/api/v1/products/{sku}', 22],
  ['GET', '/api/v1/cart', 14],
  ['POST', '/api/v1/cart/items', 8],
  ['POST', '/api/v1/checkout', 5],
  ['GET', '/api/v1/orders', 5],
  ['GET', '/api/v1/orders/{id}', 4],
  ['POST', '/api/v1/invoices', 1],
  ['GET', '/health', 6],
];

const UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
  'ShopFast-iOS/5.12.0 (iPhone15,2; iOS 18.0)',
  'ShopFast-Android/5.12.1 (Pixel 8; Android 15)',
  'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
];

const fillRoute = (rng: () => number, path: string) =>
  path
    .replace('{sku}', `SKU-${Math.floor(rng() * 90000 + 10000)}`)
    .replace('{id}', `ord_${hex(rng, 12)}`);

export interface AccessLogOptions {
  seed: string;
  now: number;
  minutes: number; // how far back to generate
  rpm: number; // baseline requests/min in this file (keep 4-12 for readability)
  p50Ms: number;
  /** Per-minute overrides; minutesAgo -> profile */
  profile?: (minutesAgo: number) => TrafficProfile;
  /** restrict to routes (default ROUTES) */
  routes?: [string, string, number][];
  clientIps?: string[];
  /** ALB health checker lines (ELB-HealthChecker/2.0) */
  healthChecks?: boolean;
}

/** nginx combined log with timing fields, as configured on ShopFast app hosts. */
export function nginxAccess(o: AccessLogOptions): LogEvent[] {
  const rng = createRng(hashString(o.seed));
  const out: LogEvent[] = [];
  const routes = o.routes ?? ROUTES;
  const ips = o.clientIps ?? ['10.0.0.71', '10.0.1.163', '10.0.0.204', '10.0.1.38'];
  for (let m = o.minutes; m >= 0; m--) {
    const p = { rpm: o.rpm, p50Ms: o.p50Ms, errorRate: 0.002, errorStatus: 500, ...(o.profile?.(m) ?? {}) };
    const count = Math.max(0, Math.round(p.rpm! * (0.75 + rng() * 0.5)));
    for (let k = 0; k < count; k++) {
      const ts = o.now - m * MIN + Math.floor(rng() * MIN);
      if (ts > o.now) continue;
      const [method, rpath] = weighted(rng, routes.map(r => [[r[0], r[1]], r[2]] as [[string, string], number]));
      if (rpath === '/health') {
        if (o.healthChecks === false) continue;
      }
      const path = fillRoute(rng, rpath);
      const isHealth = rpath === '/health';
      const failed = !isHealth && rng() < (p.errorRate ?? 0);
      const status = failed ? p.errorStatus! : method === 'POST' && rpath === '/api/v1/cart/items' ? 201 : 200;
      const ms = isHealth ? latency(rng, 2, 0.3) : latency(rng, p.p50Ms!, 0.5);
      const rt = (ms / 1000).toFixed(3);
      const urt = failed && p.errorUpstream !== undefined ? p.errorUpstream : (Math.max(0.001, ms / 1000 - 0.001)).toFixed(3);
      const bytes = status >= 500 ? pick(rng, [157, 166, 183, 497]) : Math.floor(200 + rng() * 4800);
      const ua = isHealth ? 'ELB-HealthChecker/2.0' : pick(rng, UAS);
      const ip = pick(rng, ips);
      const rid = hex(rng, 32);
      out.push({
        ts,
        msg: `${ip} - - [${nginxTime(ts)}] "${method} ${path} HTTP/1.1" ${status} ${bytes} "-" "${ua}" rt=${rt} uct=0.000 urt=${urt} rid=${rid}`,
      });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export interface AppLogOptions {
  seed: string;
  now: number;
  minutes: number;
  rpm: number;
  p50Ms: number;
  hostname: string;
  pid: number;
  version?: string;
  profile?: (minutesAgo: number) => TrafficProfile & { errorMsg?: string; errorExtra?: Record<string, unknown> };
}

/** pino-style JSON request logs from checkout-api (Node.js). */
export function appJson(o: AppLogOptions): LogEvent[] {
  const rng = createRng(hashString(o.seed));
  const out: LogEvent[] = [];
  const routes = ROUTES.filter(r => r[1] !== '/health');
  for (let m = o.minutes; m >= 0; m--) {
    const p = { rpm: o.rpm, p50Ms: o.p50Ms, errorRate: 0.002, errorStatus: 500, ...(o.profile?.(m) ?? {}) };
    const count = Math.max(0, Math.round(p.rpm! * (0.75 + rng() * 0.5)));
    for (let k = 0; k < count; k++) {
      const ts = o.now - m * MIN + Math.floor(rng() * MIN);
      if (ts > o.now) continue;
      const [method, rpath] = weighted(rng, routes.map(r => [[r[0], r[1]], r[2]] as [[string, string], number]));
      const url = fillRoute(rng, rpath);
      const failed = rng() < (p.errorRate ?? 0);
      const ms = latency(rng, p.p50Ms!, 0.5);
      const reqId = `req-${hex(rng, 8)}`;
      const base = {
        level: failed ? 50 : 30,
        time: iso(ts),
        pid: o.pid,
        hostname: o.hostname,
        reqId,
      };
      const line = failed
        ? {
            ...base,
            err: { type: 'Error', message: (p as { errorMsg?: string }).errorMsg ?? 'Internal Server Error' },
            ...((p as { errorExtra?: Record<string, unknown> }).errorExtra ?? {}),
            req: { method, url },
            res: { statusCode: p.errorStatus },
            responseTime: Math.round(ms * 10) / 10,
            msg: 'request errored',
          }
        : {
            ...base,
            req: { method, url },
            res: { statusCode: method === 'POST' && rpath === '/api/v1/cart/items' ? 201 : 200 },
            responseTime: Math.round(ms * 10) / 10,
            msg: 'request completed',
          };
      out.push({ ts, msg: JSON.stringify(line) });
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/** Merge several sorted (or unsorted) event arrays into one sorted array. */
export function merge(...lists: LogEvent[][]): LogEvent[] {
  return lists.flat().sort((a, b) => a.ts - b.ts);
}

/** Helper for hand-written key lines. */
export function at(now: number, minutesAgo: number, msg: string, stream?: string): LogEvent {
  return { ts: now - Math.round(minutesAgo * MIN), msg, stream };
}

/** Render events to a file body (one line per event). */
export const toFile = (events: LogEvent[]) => events.map(e => e.msg).join('\n') + (events.length ? '\n' : '');
