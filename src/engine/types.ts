// Core domain model for INCIDENT.
//
// Every incident starts from the same healthy "ShopFast" production environment
// (see src/env/base.ts) and mutates it in `build()` to inject the failure. All
// tools (consoles, logs, metrics, terminal) render from the Environment, so
// every tool works in every incident and healthy "noise" stays realistic.

export type Difficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export type ToolId =
  | 'briefing'
  | 'cloudwatch'
  | 'logs'
  | 'ec2'
  | 'alb'
  | 'rds'
  | 'vpc'
  | 'route53'
  | 'iam'
  | 'cloudtrail'
  | 'deploys'
  | 'terminal';

/* ------------------------------------------------------------------ */
/* Linux hosts                                                         */
/* ------------------------------------------------------------------ */

export interface Process {
  pid: number;
  user: string;
  cpu: number; // %CPU
  mem: number; // %MEM
  vszKb: number;
  rssKb: number;
  stat: string; // e.g. "Ssl"
  start: string; // e.g. "Oct08" or "14:02"
  time: string; // cumulative CPU time "12:41"
  command: string;
}

export interface Disk {
  fs: string; // /dev/nvme0n1p1
  type: string; // xfs
  sizeGb: number;
  usedGb: number;
  mount: string;
  inodesUsedPct?: number;
}

export interface ServiceStatus {
  name: string; // checkout-api
  description: string;
  active: string; // "active (running)" | "failed (Result: oom-kill)" | "activating (auto-restart)" ...
  since: string; // "Thu 2026-10-09 14:31:07 UTC; 21min ago"
  mainPid?: number;
  memory?: string; // "812.4M"
  tasks?: number;
  execStart?: string;
  restarts?: number;
  /** journalctl -u <name> lines (already formatted, oldest first) */
  journal: string[];
}

export interface Sockets {
  established: number;
  timeWait: number;
  closeWait: number;
  synSent?: number;
  orphaned?: number;
  /** listening sockets e.g. "0.0.0.0:80 nginx", "127.0.0.1:3000 node" */
  listen: { addr: string; process: string }[];
  /** sample of `ss -tanp` rows (state, recvQ, sendQ, local, peer, process) */
  sample: { state: string; local: string; peer: string; process?: string; recvQ?: number; sendQ?: number }[];
}

export interface Host {
  name: string; // app-1 (what you `ssh` to)
  hostname: string; // ip-10-0-10-23
  ip: string;
  role: 'bastion' | 'app' | 'worker';
  instanceId: string;
  user: string;
  os: string;
  kernel: string;
  uptime: string; // "12 days,  4:11"
  users: number;
  load: [number, number, number];
  cpu: { cores: number; user: number; system: number; iowait: number; steal: number; idle: number };
  memory: { totalMb: number; usedMb: number; freeMb: number; buffCacheMb: number; swapTotalMb: number; swapUsedMb: number };
  disks: Disk[];
  /** `du -sh` answers: path -> list of [size, path] rows */
  du: Record<string, [string, string][]>;
  processes: Process[];
  sockets: Sockets;
  sysctl: Record<string, string>;
  env: Record<string, string>;
  services: Record<string, ServiceStatus>;
  /** virtual filesystem: absolute path -> file content */
  files: Record<string, string>;
  /** fake `ls -l` metadata for files whose real size we only pretend (e.g. a 38G log) */
  fileMeta: Record<string, { size: number; mtime?: string }>;
  dmesg: string[];
  time: { offsetSeconds: number; ntpSynced: boolean; chronyRunning: boolean; timezone: string };
  iostat?: string; // full `iostat -x` output when relevant
  crontab?: string;
  /** Highest priority: regex against the full command line -> output. */
  commandOverrides: { match: RegExp; output: string | ((cmd: string) => string) }[];
}

/* ------------------------------------------------------------------ */
/* Observability                                                       */
/* ------------------------------------------------------------------ */

export interface MetricPanel {
  id: string; // stable id, e.g. "rds.checkout-db.cpu"
  group: string; // section heading in the CloudWatch view: "RDS", "Application Load Balancer"...
  namespace: string; // AWS/RDS
  metric: string; // CPUUtilization
  resource: string; // checkout-db
  unit: string; // "%", "ms", "Count", "MB", "Seconds", "Count/min"
  stat: string; // Average, Sum, p99, Maximum
  periodMinutes: number; // distance between points
  series: { name: string; points: number[] }[]; // last point == "now"
  threshold?: number;
  /** highlight in dashboards ("pinned" by the team), otherwise collapsed under "more metrics" */
  featured?: boolean;
}

export interface Alarm {
  name: string;
  state: 'ALARM' | 'OK' | 'INSUFFICIENT_DATA';
  metric: string;
  condition: string;
  minutesAgo: number; // last state change
  panelId?: string;
}

export interface LogEvent {
  ts: number; // epoch ms
  msg: string;
  stream?: string;
}

export interface LogGroup {
  name: string; // /shopfast/checkout-api
  description: string;
  retentionDays: number;
  events: LogEvent[]; // sorted oldest first
}

/* ------------------------------------------------------------------ */
/* AWS resources                                                       */
/* ------------------------------------------------------------------ */

export interface Ec2Instance {
  id: string;
  name: string;
  host?: string; // terminal host name if you can ssh to it
  type: string;
  state: 'running' | 'stopped' | 'pending' | 'terminated' | 'shutting-down';
  az: string;
  privateIp: string;
  publicIp?: string;
  amiId: string;
  launchTime: string; // ISO
  subnetId: string;
  sgIds: string[];
  iamProfile?: string;
  statusChecks: string; // "2/2 checks passed"
  asg?: string;
  tags: Record<string, string>;
}

export interface Ami {
  id: string;
  name: string;
  created: string;
  description: string;
}

export interface SgRule {
  protocol: string; // tcp, udp, -1
  ports: string; // "443", "0-65535", "All"
  source: string; // cidr or sg id
  description?: string;
}

export interface SecurityGroup {
  id: string;
  name: string;
  description: string;
  inbound: SgRule[];
  outbound: SgRule[];
}

export interface Asg {
  name: string;
  min: number;
  max: number;
  desired: number;
  launchTemplate: string;
  instances: string[];
  activities: { minutesAgo: number; status: string; description: string; cause: string }[];
}

export interface TargetHealth {
  id: string; // instance id
  port: number;
  az: string;
  state: 'healthy' | 'unhealthy' | 'draining' | 'initial' | 'unused';
  reason?: string; // Target.Timeout, Target.ResponseCodeMismatch ...
  description?: string;
}

export interface TargetGroup {
  name: string;
  arn: string;
  protocol: string;
  port: number;
  loadBalancer: string;
  healthCheck: { protocol: string; path: string; port: string; intervalSec: number; timeoutSec: number; healthyThreshold: number; unhealthyThreshold: number; matcher: string };
  targets: TargetHealth[];
}

export interface LoadBalancer {
  name: string;
  arn: string;
  dnsName: string;
  scheme: 'internet-facing' | 'internal';
  state: string;
  vpcId: string;
  azs: string[];
  sgIds: string[];
  created: string;
  listeners: { port: number; protocol: string; certificate?: string; action: string }[];
}

export interface RdsInstance {
  id: string;
  role: 'primary' | 'replica';
  replicaOf?: string;
  engine: string; // postgres
  version: string;
  class: string;
  status: string;
  endpoint: string;
  az: string;
  multiAz: boolean;
  storage: { type: string; sizeGb: number; iops?: number; throughputMBps?: number };
  parameterGroup: string;
  maxConnections: number;
  vCpu: number;
  memoryGb: number;
}

export interface RdsEvent {
  minutesAgo: number;
  source: string;
  message: string;
}

export interface TopSql {
  sql: string;
  calls: number;
  meanMs: number;
  loadAas: number; // average active sessions
  rowsPerCall: number;
  waitEvent: string; // CPU, IO:DataFileRead, Client:ClientRead, Lock:transactionid ...
}

/** A simulated PostgreSQL server you can reach with `psql`. */
export interface Database {
  host: string; // rds endpoint the psql -h matches against
  alias: string[]; // other names (db.internal.shopfast.io, checkout-db)
  instanceId: string;
  dbName: string;
  serverVersion: string;
  settings: Record<string, string>; // SHOW <name>
  activity: { pid: number; usename: string; application: string; client: string; state: string; waitEvent: string; queryStart: string; duration: string; query: string }[];
  statements: { query: string; calls: number; totalMs: number; meanMs: number; rows: number }[];
  /** `\d table` output keyed by table name */
  tables: Record<string, string>;
  /** EXPLAIN outputs: regex against the SQL -> plan text */
  explains: { match: RegExp; output: string }[];
  /** arbitrary SQL answers: regex against the SQL -> psql-formatted output */
  queries: { match: RegExp; output: string }[];
  isReplica: boolean;
  /** if set, `psql` fails to connect with this message (e.g. "FATAL:  sorry, too many clients already") */
  connectError?: string;
}

export interface Subnet {
  id: string;
  name: string;
  cidr: string;
  az: string;
  public: boolean;
  routeTableId: string;
  availableIps: number;
}

export interface RouteTable {
  id: string;
  name: string;
  subnets: string[];
  routes: { destination: string; target: string; state: 'active' | 'blackhole' }[];
}

export interface NatGateway {
  id: string;
  name: string;
  subnetId: string;
  state: 'available' | 'deleted' | 'deleting' | 'pending' | 'failed';
  publicIp: string;
  created: string;
}

export interface DnsRecord {
  name: string; // fully-qualified, no trailing dot
  type: 'A' | 'AAAA' | 'CNAME' | 'TXT' | 'MX' | 'NS' | 'SOA';
  ttl: number;
  values: string[];
  alias?: { target: string; evaluateHealth: boolean };
}

export interface HostedZone {
  id: string;
  name: string;
  private: boolean;
  records: DnsRecord[];
}

export interface PolicyDocument {
  Version: string;
  Statement: Record<string, unknown>[];
}

export interface IamRole {
  name: string;
  arn: string;
  description: string;
  instanceProfile?: string;
  trust: PolicyDocument;
  policies: { name: string; type: 'inline' | 'aws-managed' | 'customer-managed'; arn?: string; document: PolicyDocument }[];
  lastModifiedMinutesAgo: number;
}

export interface CloudTrailEvent {
  minutesAgo: number;
  eventName: string;
  eventSource: string; // ec2.amazonaws.com
  user: string; // arn-ish or name
  sourceIp: string;
  resources: string;
  errorCode?: string;
  request?: Record<string, unknown>;
}

export interface Change {
  id: string;
  minutesAgo: number;
  kind: 'deploy' | 'migration' | 'config' | 'infra' | 'ami' | 'feature-flag';
  service: string;
  title: string;
  author: string;
  status: 'succeeded' | 'failed' | 'rolled back' | 'in progress';
  version?: string;
  description: string;
  diff?: string; // unified diff
}

/* ------------------------------------------------------------------ */
/* Network behaviour                                                   */
/* ------------------------------------------------------------------ */

/** How an HTTP(S) request behaves for curl. First matching rule wins. */
export interface HttpRule {
  match: RegExp; // tested against the full URL (scheme://host[:port]/path)
  fromHosts?: string[]; // only when run from these terminal hosts
  behaviour: 'ok' | 'timeout' | 'refused' | 'reset' | 'dns-fail' | 'tls-error';
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  timeMs?: number;
  ip?: string;
  tlsError?: string;
}

export interface TrafficConfig {
  minutes: number; // how much history to generate
  rpmPerHost: number;
  p50Ms: number;
  /** per host & minute overrides. errorMsg/errorExtra shape the JSON app log for failed requests */
  profile?: (host: string, minutesAgo: number) => {
    rpm?: number;
    p50Ms?: number;
    errorRate?: number;
    errorStatus?: number;
    errorUpstream?: string;
    errorMsg?: string;
    errorExtra?: Record<string, unknown>;
  };
  /** hosts that serve traffic (default: all role=app hosts) */
  hosts?: string[];
}

/** DNS answers for names outside our hosted zones (AWS-generated names, third parties). */
export type ExternalDns = Record<string, string[] | 'NXDOMAIN' | 'SERVFAIL'>;

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

export interface Environment {
  now: number; // epoch ms of "now" in the simulation
  region: string;
  accountId: string;
  hosts: Record<string, Host>;
  startHost: string;
  metrics: MetricPanel[];
  alarms: Alarm[];
  logGroups: LogGroup[];
  ec2: { instances: Ec2Instance[]; securityGroups: SecurityGroup[]; amis: Ami[]; asgs: Asg[] };
  elb: { loadBalancers: LoadBalancer[]; targetGroups: TargetGroup[] };
  rds: { instances: RdsInstance[]; events: RdsEvent[]; topSql: Record<string, TopSql[]> };
  databases: Database[];
  vpc: { id: string; cidr: string; subnets: Subnet[]; routeTables: RouteTable[]; natGateways: NatGateway[] };
  route53: { zones: HostedZone[]; external: ExternalDns };
  iam: { roles: IamRole[]; simulations: { match: RegExp; output: string }[] };
  cloudtrail: CloudTrailEvent[];
  changes: Change[];
  http: HttpRule[];
  /** Background traffic used to generate nginx/app logs on app hosts (see env/finalize.ts). */
  traffic: TrafficConfig;
  /** Extra hand-written events merged into host log files: host -> file path -> events */
  hostLogs: Record<string, Record<string, LogEvent[]>>;
  /** `aws ...` CLI overrides: regex against the full command -> output */
  awsCli: { match: RegExp; output: string }[];
}

/* ------------------------------------------------------------------ */
/* Incidents                                                           */
/* ------------------------------------------------------------------ */

export type FoundBy =
  | { tool: 'terminal'; host: string; command: string | string[] }
  | { tool: 'logs'; group: string }
  | { tool: 'cloudwatch'; panel: string }
  | { tool: Exclude<ToolId, 'terminal' | 'logs' | 'cloudwatch'> };

export interface Evidence {
  id: string;
  label: string; // "Root volume on app-2 is 100% full"
  kind: 'key' | 'supporting' | 'red-herring';
  /** Tested against the text of everything the player pins. */
  match: RegExp;
  foundBy: FoundBy;
  /** Shown in the debrief: why this matters (or why it's a distraction). */
  explanation: string;
}

export interface Choice {
  id: string;
  text: string;
  correct?: boolean;
  /** Close but incomplete/imprecise diagnosis: partial credit */
  partial?: boolean;
  explanation: string;
}

export interface FixChoice {
  id: string;
  text: string;
  kind: 'correct' | 'partial' | 'neutral' | 'harmful';
  explanation: string;
}

export interface Briefing {
  severity: 'SEV1' | 'SEV2' | 'SEV3';
  alert: { source: string; title: string; details: string; minutesAgo: number };
  reports: { from: string; role: string; channel: string; message: string; minutesAgo: number }[];
  impact: string;
  services: string[];
}

export interface Debrief {
  /** Paragraphs separated by blank lines. Supports `code` and **bold**. */
  summary: string;
  timeline: { minutesAgo: number; event: string }[];
  concepts: { title: string; body: string }[];
  commands: { cmd: string; why: string }[];
  prevention: string[];
  reading?: { title: string; url: string }[];
}

export interface BuildKit {
  /** Seeded RNG in [0,1) */
  rng: () => number;
  /** epoch ms for N minutes before "now" */
  ago: (minutes: number) => number;
}

export interface Incident {
  id: string; // slug
  code: string; // INC-4127
  order: number;
  title: string;
  teaser: string; // one-liner for the incident board
  difficulty: Difficulty;
  tags: string[];
  parMinutes: number;
  seed: number;
  /** ISO timestamp of "now" inside the simulation */
  now: string;
  briefing: Briefing;
  build: (env: Environment, kit: BuildKit) => void;
  evidence: Evidence[];
  rootCauses: Choice[];
  fixes: FixChoice[];
  hints: [string, string, string];
  debrief: Debrief;
}

/* ------------------------------------------------------------------ */
/* Player state                                                        */
/* ------------------------------------------------------------------ */

export interface Pinnable {
  /** stable identity of the pinned thing */
  key: string;
  source: string; // "Terminal · app-2 · df -h"
  tool: ToolId;
  text: string;
}

export interface Pin extends Pinnable {
  pinnedAt: number;
}

export interface Submission {
  rootCause: string;
  evidenceKeys: string[];
  fixes: string[];
  writeup: string;
}
