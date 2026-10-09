/**
 * Small helpers for incident authors. They throw on typos so mistakes surface
 * in the integrity tests instead of silently rendering a healthy environment.
 */
import type { Alarm, Database, Environment, Host, LogEvent, LogGroup, MetricPanel, TargetGroup } from '../engine/types';
import { MIN } from '../engine/time';

export function panel(env: Environment, id: string): MetricPanel {
  const p = env.metrics.find(m => m.id === id);
  if (!p) throw new Error(`unknown metric panel ${id}`);
  return p;
}

/** Replace the points of a panel's series (first series, or by name e.g. 'app-2'). */
export function setPoints(env: Environment, id: string, points: number[], seriesName?: string) {
  const p = panel(env, id);
  const s = seriesName ? p.series.find(x => x.name === seriesName) : p.series[0];
  if (!s) throw new Error(`panel ${id} has no series ${seriesName}`);
  s.points = points;
}

export function featurePanel(env: Environment, id: string, featured = true) {
  panel(env, id).featured = featured;
}

export function addPanel(env: Environment, p: MetricPanel) {
  env.metrics.push(p);
}

export function setAlarm(env: Environment, name: string, state: Alarm['state'], minutesAgo: number) {
  const a = env.alarms.find(x => x.name === name);
  if (!a) throw new Error(`unknown alarm ${name}`);
  a.state = state;
  a.minutesAgo = minutesAgo;
}

export function host(env: Environment, name: string): Host {
  const h = env.hosts[name];
  if (!h) throw new Error(`unknown host ${name}`);
  return h;
}

/** Add hand-written events to a host log file (merged with generated traffic, shipped to CloudWatch). */
export function injectLog(env: Environment, hostName: string, path: string, events: LogEvent[]) {
  host(env, hostName);
  env.hostLogs[hostName] ??= {};
  env.hostLogs[hostName][path] ??= [];
  env.hostLogs[hostName][path].push(...events);
}

/** Get or create a CloudWatch log group that is not backed by a host file. */
export function logGroup(env: Environment, name: string, description = '', retentionDays = 14): LogGroup {
  let g = env.logGroups.find(x => x.name === name);
  if (!g) {
    g = { name, description, retentionDays, events: [] };
    env.logGroups.push(g);
  }
  return g;
}

export function database(env: Environment, instanceId: string): Database {
  const d = env.databases.find(x => x.instanceId === instanceId);
  if (!d) throw new Error(`unknown database ${instanceId}`);
  return d;
}

export function targetGroup(env: Environment, name = 'checkout-api-tg'): TargetGroup {
  const t = env.elb.targetGroups.find(x => x.name === name);
  if (!t) throw new Error(`unknown target group ${name}`);
  return t;
}

/** Event helper: `ev(env, 12.5, 'line')` = an event 12.5 minutes before now. */
export const ev = (env: Environment, minutesAgo: number, msg: string, stream?: string): LogEvent => ({ ts: env.now - Math.round(minutesAgo * MIN), msg, stream });

/** Evenly spread repeated events between two points in time (minutes ago). */
export function spread(env: Environment, fromMinutesAgo: number, toMinutesAgo: number, count: number, make: (i: number, ts: number) => string): LogEvent[] {
  const out: LogEvent[] = [];
  for (let i = 0; i < count; i++) {
    const m = fromMinutesAgo - ((fromMinutesAgo - toMinutesAgo) * i) / Math.max(1, count - 1);
    const ts = env.now - Math.round(m * MIN) + ((i * 7919) % 23000);
    out.push({ ts: Math.min(ts, env.now), msg: make(i, Math.min(ts, env.now)) });
  }
  return out;
}

/**
 * Add a new EC2 host by cloning an existing one (e.g. an ASG scale-out or a
 * replacement instance). Clones the terminal host, the EC2 instance record,
 * ALB target registration and ASG membership. Returns the new Host.
 */
export function cloneHost(
  env: Environment,
  sourceName: string,
  newName: string,
  o: { hostname: string; ip: string; instanceId: string; az?: string; subnetId?: string; amiId?: string; launchTime?: string },
): Host {
  const src = host(env, sourceName);
  const h: Host = JSON.parse(JSON.stringify({ ...src, commandOverrides: [] }));
  h.commandOverrides = [];
  h.name = newName;
  h.hostname = o.hostname;
  h.ip = o.ip;
  h.instanceId = o.instanceId;
  for (const [p, c] of Object.entries(h.files)) h.files[p] = c.split(src.hostname).join(o.hostname).split(src.ip).join(o.ip);
  for (const s of Object.values(h.services)) s.journal = s.journal.map(l => l.split(src.hostname).join(o.hostname));
  h.sockets.sample = h.sockets.sample.map(r => ({ ...r, local: r.local.split(src.ip).join(o.ip) }));
  env.hosts[newName] = h;
  const inst = env.ec2.instances.find(i => i.host === sourceName);
  if (inst) {
    env.ec2.instances.push({ ...inst, id: o.instanceId, host: newName, privateIp: o.ip, az: o.az ?? inst.az, subnetId: o.subnetId ?? inst.subnetId, amiId: o.amiId ?? inst.amiId, launchTime: o.launchTime ?? inst.launchTime, tags: { ...inst.tags } });
    for (const tg of env.elb.targetGroups) {
      const t = tg.targets.find(x => x.id === inst.id);
      if (t) tg.targets.push({ ...t, id: o.instanceId, az: o.az ?? t.az });
    }
    for (const g of env.ec2.asgs) if (g.instances.includes(inst.id)) g.instances.push(o.instanceId);
  }
  return h;
}

/** Remove a host entirely (terminated instance). Also deregisters it from target groups and ASGs. */
export function removeHost(env: Environment, name: string) {
  const h = host(env, name);
  delete env.hosts[name];
  env.ec2.instances = env.ec2.instances.filter(i => i.id !== h.instanceId);
  for (const tg of env.elb.targetGroups) tg.targets = tg.targets.filter(t => t.id !== h.instanceId);
  for (const g of env.ec2.asgs) g.instances = g.instances.filter(id => id !== h.instanceId);
}
