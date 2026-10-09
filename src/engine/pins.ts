import type {
  Alarm, Asg, Change, CloudTrailEvent, Ec2Instance, Environment, Evidence, HostedZone, DnsRecord, IamRole, LoadBalancer, LogEvent, LogGroup, MetricPanel, NatGateway, Pin, Pinnable,
  RdsEvent, RdsInstance, RouteTable, SecurityGroup, Subnet, TargetGroup, TargetHealth, ToolId, TopSql, Incident,
} from './types';
import { fmtNum, stats } from './timeseries';
import { hashString } from './rng';
import { isoSec, relative } from './time';
import { execute, initialTermState } from './terminal';

/**
 * Pin text builders. Views MUST use these so that what the player pins is
 * exactly what evidence regexes are written against (and what the integrity
 * tests check).
 */

const h = (s: string) => hashString(s).toString(36);

export function metricText(p: MetricPanel): string {
  const parts = p.series.map(s => {
    const st = stats(s.points);
    return `${p.series.length > 1 ? s.name + ': ' : ''}now ${fmtNum(st.latest)} ${p.unit}, max ${fmtNum(st.max)}, min ${fmtNum(st.min)}, baseline ${fmtNum(st.baseline)}`;
  });
  return `CloudWatch ${p.namespace} ${p.metric} [${p.resource}] (${p.stat}) — ${parts.join('; ')}`;
}

export const pinMetric = (p: MetricPanel): Pinnable => ({ key: `cw:${p.id}`, tool: 'cloudwatch', source: `CloudWatch · ${p.metric} · ${p.resource}`, text: metricText(p) });

export const alarmText = (a: Alarm) => `Alarm ${a.name} is ${a.state} — ${a.metric}: ${a.condition} (state changed ${relative(a.minutesAgo)})`;
export const pinAlarm = (a: Alarm): Pinnable => ({ key: `alarm:${a.name}`, tool: 'cloudwatch', source: 'CloudWatch · Alarms', text: alarmText(a) });

export const pinLog = (g: LogGroup | string, e: LogEvent): Pinnable => {
  const name = typeof g === 'string' ? g : g.name;
  return { key: `log:${name}:${e.ts}:${h(e.msg)}`, tool: 'logs', source: `Logs · ${name}${e.stream ? ' · ' + e.stream.split('/')[0] : ''}`, text: e.msg };
};

export const instanceText = (i: Ec2Instance) =>
  `EC2 ${i.id} (${i.name}${i.host ? ' / ' + i.host : ''}) ${i.type} ${i.state} in ${i.az}, ${i.privateIp}, AMI ${i.amiId}, launched ${i.launchTime}, ${i.statusChecks}, SGs ${i.sgIds.join(',')}, profile ${i.iamProfile ?? '-'}`;
export const pinInstance = (i: Ec2Instance): Pinnable => ({ key: `ec2:${i.id}`, tool: 'ec2', source: 'EC2 · Instances', text: instanceText(i) });

export const sgText = (sg: SecurityGroup) =>
  `Security group ${sg.id} (${sg.name}) inbound: ${sg.inbound.length ? sg.inbound.map(r => `${r.protocol}/${r.ports} from ${r.source}${r.description ? ' (' + r.description + ')' : ''}`).join('; ') : 'NO INBOUND RULES'} | outbound: ${sg.outbound.map(r => `${r.protocol}/${r.ports} to ${r.source}`).join('; ') || 'none'}`;
export const pinSg = (sg: SecurityGroup): Pinnable => ({ key: `sg:${sg.id}`, tool: 'ec2', source: 'EC2 · Security groups', text: sgText(sg) });

export const amiText = (a: { id: string; name: string; created: string; description: string }) => `AMI ${a.id} ${a.name} created ${a.created}: ${a.description}`;
export const pinAmi = (a: { id: string; name: string; created: string; description: string }): Pinnable => ({ key: `ami:${a.id}`, tool: 'ec2', source: 'EC2 · AMIs', text: amiText(a) });

export const asgActivityText = (g: Asg, a: Asg['activities'][number]) => `ASG ${g.name} activity (${relative(a.minutesAgo)}, ${a.status}): ${a.description}. Cause: ${a.cause}`;
export const pinAsgActivity = (g: Asg, a: Asg['activities'][number]): Pinnable => ({ key: `asg:${g.name}:${a.minutesAgo}:${h(a.description)}`, tool: 'ec2', source: 'EC2 · Auto Scaling activity', text: asgActivityText(g, a) });
export const asgText = (g: Asg) => `ASG ${g.name}: desired ${g.desired}, min ${g.min}, max ${g.max}, ${g.instances.length} instances, launch template ${g.launchTemplate}`;
export const pinAsg = (g: Asg): Pinnable => ({ key: `asgcfg:${g.name}`, tool: 'ec2', source: 'EC2 · Auto Scaling groups', text: asgText(g) });

export const targetText = (tg: TargetGroup, t: TargetHealth) => `Target ${t.id}:${t.port} (${t.az}) in ${tg.name} is ${t.state}${t.reason ? ` — ${t.reason}` : ''}${t.description ? `: ${t.description}` : ''}`;
export const pinTarget = (tg: TargetGroup, t: TargetHealth): Pinnable => ({ key: `tgt:${tg.name}:${t.id}`, tool: 'alb', source: `Load balancers · ${tg.name}`, text: targetText(tg, t) });
export const tgText = (tg: TargetGroup) => {
  const c = tg.healthCheck;
  return `Target group ${tg.name} ${tg.protocol}:${tg.port} health check ${c.protocol} ${c.path} port ${c.port}, interval ${c.intervalSec}s, timeout ${c.timeoutSec}s, healthy ${c.healthyThreshold}, unhealthy ${c.unhealthyThreshold}, success codes ${c.matcher}`;
};
export const pinTg = (tg: TargetGroup): Pinnable => ({ key: `tg:${tg.name}`, tool: 'alb', source: 'Load balancers · Target groups', text: tgText(tg) });
export const lbText = (lb: LoadBalancer) => `Load balancer ${lb.name} (${lb.scheme}, ${lb.state}) DNS ${lb.dnsName}, SGs ${lb.sgIds.join(',')}, listeners: ${lb.listeners.map(l => `${l.protocol}:${l.port} ${l.action}`).join('; ')}`;
export const pinLb = (lb: LoadBalancer): Pinnable => ({ key: `lb:${lb.name}`, tool: 'alb', source: 'Load balancers', text: lbText(lb) });

export const rdsText = (i: RdsInstance) =>
  `RDS ${i.id} (${i.role}${i.replicaOf ? ' of ' + i.replicaOf : ''}) ${i.class} ${i.engine} ${i.version} ${i.status}, ${i.vCpu} vCPU/${i.memoryGb} GiB, storage ${i.storage.type} ${i.storage.sizeGb} GiB${i.storage.iops ? ` ${i.storage.iops} IOPS` : ''}, max_connections ${i.maxConnections}, Multi-AZ ${i.multiAz ? 'yes' : 'no'}`;
export const pinRds = (i: RdsInstance): Pinnable => ({ key: `rds:${i.id}`, tool: 'rds', source: 'RDS · Databases', text: rdsText(i) });
export const rdsEventText = (e: RdsEvent) => `RDS event ${e.source} (${relative(e.minutesAgo)}): ${e.message}`;
export const pinRdsEvent = (e: RdsEvent): Pinnable => ({ key: `rdsev:${e.source}:${e.minutesAgo}:${h(e.message)}`, tool: 'rds', source: 'RDS · Events', text: rdsEventText(e) });
export const topSqlText = (db: string, q: TopSql) => `Performance Insights ${db}: ${q.loadAas.toFixed(2)} AAS, ${q.calls} calls/min, mean ${q.meanMs} ms, ${q.rowsPerCall} rows/call, wait ${q.waitEvent} — ${q.sql}`;
export const pinTopSql = (db: string, q: TopSql): Pinnable => ({ key: `pi:${db}:${h(q.sql)}`, tool: 'rds', source: `RDS · Performance Insights · ${db}`, text: topSqlText(db, q) });

export const routeTableText = (rt: RouteTable) => `Route table ${rt.id} (${rt.name}) for ${rt.subnets.join(',')}: ${rt.routes.map(r => `${r.destination} → ${r.target} (${r.state})`).join('; ')}`;
export const pinRouteTable = (rt: RouteTable): Pinnable => ({ key: `rtb:${rt.id}`, tool: 'vpc', source: 'VPC · Route tables', text: routeTableText(rt) });
export const natText = (n: NatGateway) => `NAT gateway ${n.id} (${n.name}) in ${n.subnetId} is ${n.state}, public IP ${n.publicIp}, created ${n.created}`;
export const pinNat = (n: NatGateway): Pinnable => ({ key: `nat:${n.id}`, tool: 'vpc', source: 'VPC · NAT gateways', text: natText(n) });
export const subnetText = (s: Subnet) => `Subnet ${s.id} (${s.name}) ${s.cidr} ${s.az} ${s.public ? 'public' : 'private'}, route table ${s.routeTableId}, ${s.availableIps} free IPs`;
export const pinSubnet = (s: Subnet): Pinnable => ({ key: `subnet:${s.id}`, tool: 'vpc', source: 'VPC · Subnets', text: subnetText(s) });

export const recordText = (z: HostedZone, r: DnsRecord) => `Route 53 ${z.private ? 'private' : 'public'} zone ${z.name}: ${r.name} ${r.type} ${r.alias ? `ALIAS → ${r.alias.target}` : `TTL ${r.ttl} → ${r.values.join(', ')}`}`;
export const pinRecord = (z: HostedZone, r: DnsRecord): Pinnable => ({ key: `r53:${z.id}:${r.name}:${r.type}`, tool: 'route53', source: `Route 53 · ${z.name}`, text: recordText(z, r) });

export const policyText = (role: IamRole, p: IamRole['policies'][number]) => `IAM role ${role.name} ${p.type} policy ${p.name}: ${JSON.stringify(p.document)}`;
export const pinPolicy = (role: IamRole, p: IamRole['policies'][number]): Pinnable => ({ key: `iam:${role.name}:${p.name}`, tool: 'iam', source: `IAM · ${role.name}`, text: policyText(role, p) });
export const roleText = (role: IamRole) => `IAM role ${role.name} (${role.description}), instance profile ${role.instanceProfile ?? '-'}, last modified ${relative(role.lastModifiedMinutesAgo)}, trust ${JSON.stringify(role.trust.Statement)}`;
export const pinRole = (role: IamRole): Pinnable => ({ key: `role:${role.name}`, tool: 'iam', source: 'IAM · Roles', text: roleText(role) });

export const trailText = (e: CloudTrailEvent) =>
  `CloudTrail ${e.eventName} (${e.eventSource}) by ${e.user} from ${e.sourceIp} at ${relative(e.minutesAgo)} on ${e.resources}${e.errorCode ? ` [${e.errorCode}]` : ''}${e.request ? ' request ' + JSON.stringify(e.request) : ''}`;
export const pinTrail = (e: CloudTrailEvent): Pinnable => ({ key: `ct:${e.eventName}:${e.minutesAgo}:${h(e.resources)}`, tool: 'cloudtrail', source: 'CloudTrail · Event history', text: trailText(e) });

export const changeText = (c: Change) => `Change ${c.id} [${c.kind}] ${c.service}: ${c.title} by ${c.author}, ${c.status}, ${relative(c.minutesAgo)}. ${c.description}${c.diff ? '\n' + c.diff : ''}`;
export const pinChange = (c: Change): Pinnable => ({ key: `chg:${c.id}`, tool: 'deploys', source: 'Deploys & changes', text: changeText(c) });

export const pinTermLine = (host: string, cmd: string, line: string, idx: number): Pinnable => ({ key: `term:${host}:${h(cmd)}:${idx}:${h(line)}`, tool: 'terminal', source: `Terminal · ${host} · ${cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd}`, text: line });
export const pinTermBlock = (host: string, cmd: string, output: string): Pinnable => ({ key: `termblk:${host}:${h(cmd)}:${h(output)}`, tool: 'terminal', source: `Terminal · ${host} · ${cmd.length > 60 ? cmd.slice(0, 57) + '…' : cmd}`, text: `$ ${cmd}\n${output}` });

/* ------------------------------------------------------------------ */

/** Everything a tool can show (used by integrity tests and the debrief "where to find it"). */
export function pinnablesFor(env: Environment, tool: ToolId): Pinnable[] {
  switch (tool) {
    case 'cloudwatch':
      return [...env.metrics.map(pinMetric), ...env.alarms.map(pinAlarm)];
    case 'logs':
      return env.logGroups.flatMap(g => g.events.map(e => pinLog(g, e)));
    case 'ec2':
      return [...env.ec2.instances.map(pinInstance), ...env.ec2.securityGroups.map(pinSg), ...env.ec2.amis.map(pinAmi), ...env.ec2.asgs.flatMap(g => [pinAsg(g), ...g.activities.map(a => pinAsgActivity(g, a))])];
    case 'alb':
      return [...env.elb.loadBalancers.map(pinLb), ...env.elb.targetGroups.flatMap(tg => [pinTg(tg), ...tg.targets.map(t => pinTarget(tg, t))])];
    case 'rds':
      return [...env.rds.instances.map(pinRds), ...env.rds.events.map(pinRdsEvent), ...Object.entries(env.rds.topSql).flatMap(([db, qs]) => qs.map(q => pinTopSql(db, q)))];
    case 'vpc':
      return [...env.vpc.routeTables.map(pinRouteTable), ...env.vpc.natGateways.map(pinNat), ...env.vpc.subnets.map(pinSubnet)];
    case 'route53':
      return env.route53.zones.flatMap(z => z.records.map(r => pinRecord(z, r)));
    case 'iam':
      return env.iam.roles.flatMap(r => [pinRole(r), ...r.policies.map(p => pinPolicy(r, p))]);
    case 'cloudtrail':
      return env.cloudtrail.map(pinTrail);
    case 'deploys':
      return env.changes.map(pinChange);
    default:
      return [];
  }
}

/** Run a terminal command (or a sequence, e.g. psql then SQL) and return its output lines as pinnables. */
export function terminalPinnables(env: Environment, host: string, command: string | string[]): Pinnable[] {
  let state = initialTermState(env);
  if (host !== state.host) state = execute(env, state, `ssh ${host}`).state;
  const cmds = Array.isArray(command) ? command : [command];
  let out = '';
  for (const c of cmds) {
    const r = execute(env, state, c);
    state = r.state;
    out = r.output;
  }
  const last = cmds[cmds.length - 1];
  return [...out.split('\n').map((l, i) => pinTermLine(host, last, l, i)), pinTermBlock(host, last, out)];
}

/** Pinnables a given FoundBy points at. */
export function pinnablesForFoundBy(env: Environment, ev: Evidence): Pinnable[] {
  const f = ev.foundBy;
  if (f.tool === 'terminal') return terminalPinnables(env, f.host, f.command);
  if (f.tool === 'logs') return (env.logGroups.find(g => g.name === f.group)?.events ?? []).map(e => pinLog(f.group, e));
  if (f.tool === 'cloudwatch') {
    const p = env.metrics.find(m => m.id === f.panel);
    return p ? [pinMetric(p)] : [];
  }
  return pinnablesFor(env, f.tool);
}

export function evidenceFor(incident: Incident, pin: Pin | Pinnable): Evidence[] {
  return incident.evidence.filter(e => e.match.test(pin.text));
}

export function describeFoundBy(ev: Evidence): string {
  const f = ev.foundBy;
  switch (f.tool) {
    case 'terminal': {
      const cmds = Array.isArray(f.command) ? f.command : [f.command];
      return `Terminal on ${f.host}: ${cmds.map(c => '`' + c + '`').join(' then ')}`;
    }
    case 'logs':
      return `Logs → ${f.group}`;
    case 'cloudwatch':
      return `CloudWatch → metric panel ${f.panel}`;
    default:
      return `${TOOL_LABEL[f.tool]} console`;
  }
}

export const TOOL_LABEL: Record<ToolId, string> = {
  briefing: 'Briefing',
  cloudwatch: 'CloudWatch',
  logs: 'Logs',
  ec2: 'EC2',
  alb: 'Load Balancers',
  rds: 'RDS',
  vpc: 'VPC',
  route53: 'Route 53',
  iam: 'IAM',
  cloudtrail: 'CloudTrail',
  deploys: 'Deploys & Changes',
  terminal: 'Terminal',
};

export const nowLabel = (env: Environment) => isoSec(env.now);
