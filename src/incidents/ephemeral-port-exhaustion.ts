import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { hex } from '../engine/rng';
import { MIN, iso, nginxTime, syslogTime, systemdTime } from '../engine/time';
import { curl } from '../engine/terminal/net';
import { tokenize } from '../engine/terminal/shell';
import { addPanel, host, injectLog, panel, setPoints } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4290 — ephemeral port exhaustion on the app hosts.
 * checkout-api 2.16.0 creates a new undici Agent with keep-alive disabled for every
 * fraud-svc call. Every call is a new TCP connection to the same NLB address
 * 10.0.12.40:8080; the client closes first, so each socket spends 60 s in TIME-WAIT on
 * the app host. 32768–60999 = 28,232 local ports per destination ip:port →
 * ~470 new connections/s per host is the ceiling. Above it: connect() EADDRNOTAVAIL.
 */

const DEPLOY = 2 * 1440 + 583; // Oct 4 10:12 UTC — checkout-api 2.16.0
const FRAUD_IP = '10.0.12.40';
const NLB_NAME = 'fraud-svc-nlb';
const NLB_DNS = 'fraud-svc-nlb-5f2a9c1e7b3d4a60.elb.us-east-1.amazonaws.com';
const PORTS = 60999 - 32768 + 1; // 28,232
const CAP_HOST_PER_MIN = PORTS - 80; // a few ports are held by ESTABLISHED sockets
const SHARE: Record<string, number> = { 'app-1': 0.336, 'app-2': 0.331, 'app-3': 0.333 };
const OTHER_TW = [241, 212, 236]; // TIME-WAIT to other peers (ALB, health checks)

/** Diurnal traffic shape: peak at 20:00 UTC (US evening), trough ~ 08:00 UTC. */
const shape = (ts: number) => {
  const d = new Date(ts);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  const dist = Math.min(Math.abs(h - 20), 24 - Math.abs(h - 20));
  return 0.35 + 0.65 * Math.exp(-((dist / 3.2) ** 2));
};
const DAY_PEAK: Record<number, number> = { 2: 86000, 3: 88200, 4: 89100, 5: 90400, 6: 92500 };
/** ALB requests per minute at time ts (every API request makes one fraud-svc call). */
const demand = (ts: number) => (DAY_PEAK[new Date(ts).getUTCDate()] ?? 90000) * shape(ts);

const FRAUD_ERR = (address: string) => ({
  type: 'Error',
  message: `connect EADDRNOTAVAIL ${address}:8080 - Local (0.0.0.0:0)`,
  stack: `Error: connect EADDRNOTAVAIL ${address}:8080 - Local (0.0.0.0:0)\n    at internalConnect (node:net:1094:16)\n    at defaultTriggerAsyncIdScope (node:internal/async_hooks:464:18)\n    at GetAddrInfoReqWrap.emitLookup [as callback] (node:net:1494:9)\n    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:132:8)`,
  errno: -99,
  code: 'EADDRNOTAVAIL',
  syscall: 'connect',
  address,
  port: 8080,
});

const incident: Incident = {
  id: 'ephemeral-port-exhaustion',
  code: 'INC-4290',
  order: 10,
  title: '"Fraud check unavailable" — but only at peak',
  teaser: 'Every evening ~8% of checkouts fail instantly with "fraud check unavailable". At night it heals itself. The fraud team says they are fine.',
  difficulty: 'advanced',
  tags: ['Linux', 'TCP', 'TIME_WAIT', 'Ephemeral ports', 'Connection pooling', 'Node.js'],
  parMinutes: 20,
  seed: 4290,
  now: '2026-10-06T19:55:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-fraud-errors-high — FraudClientErrors > 500 per minute',
      details: 'ShopFast/Checkout FraudClientErrors has been above 500/min for 5 consecutive minutes (current 7,9k). Runbook: https://wiki.shopfast.internal/runbooks/fraud-check',
      minutesAgo: 52,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4290', message: 'Customers get "We couldn\'t verify your payment (fraud check unavailable), please try again" on checkout. It\'s instant, not a long spinner, and trying again usually works. Same thing happened last night around this time and the night before.', minutesAgo: 41 },
      { from: 'Nadia Haddad', role: 'Fraud Platform Engineer', channel: '#incident-4290', message: 'fraud-svc is green: p99 18 ms, 4/4 targets healthy, zero 5xx. We shipped fraud-service 3.8.0 (new risk model) at 17:20 but that\'s unrelated, it was fine for two hours. Honestly we see FEWER requests than we should — whatever fails never reaches us.', minutesAgo: 33 },
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-4290', message: 'App CPU is ~45%, memory flat, no restarts. It only starts around 18:45 when traffic ramps and stops after ~22:00. Last two nights on-call closed it as "fraud-svc blip". Could the NLB be throttling us?', minutesAgo: 24 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4290', message: 'You\'re IC. 8% of checkouts at peak is real money, three nights in a row. I want to know why it only happens when we\'re busy.', minutesAgo: 18 },
    ],
    impact: '~8% of checkouts fail at evening peak (and a similar share of risk-signal calls is silently dropped). Retrying usually succeeds. Overnight traffic is unaffected.',
    services: ['checkout-api', 'fraud-svc (internal NLB fraud-svc.internal.shopfast.io)', 'app hosts app-1..3'],
  },

  build(env, kit) {
    const rng = kit.rng;
    const at = (m: number) => env.now - Math.round(m * MIN);

    // ---------------- fraud-svc: DNS, subnet, NLB ----------------
    env.vpc.subnets.push({ id: 'subnet-0a77b88c99d0e1f22', name: 'shopfast-services-a', cidr: '10.0.12.0/24', az: 'us-east-1a', public: false, routeTableId: IDS.rtbPrivateA, availableIps: 231 });
    env.vpc.routeTables.find(r => r.id === IDS.rtbPrivateA)!.subnets.push('subnet-0a77b88c99d0e1f22');
    env.route53.zones.find(z => z.name === 'internal.shopfast.io')!.records.push({ name: 'fraud-svc.internal.shopfast.io', type: 'CNAME', ttl: 60, values: [NLB_DNS] });
    env.route53.external[NLB_DNS] = [FRAUD_IP];
    env.elb.loadBalancers.push({
      name: NLB_NAME,
      arn: `arn:aws:elasticloadbalancing:us-east-1:${IDS.account}:loadbalancer/net/${NLB_NAME}/5f2a9c1e7b3d4a60`,
      dnsName: NLB_DNS,
      scheme: 'internal',
      state: 'active',
      vpcId: IDS.vpc,
      azs: ['us-east-1a'],
      sgIds: [],
      created: '2025-11-03T09:41:12Z',
      listeners: [{ port: 8080, protocol: 'TCP', action: 'forward → fraud-svc-tg' }],
    });
    env.elb.targetGroups.push({
      name: 'fraud-svc-tg',
      arn: `arn:aws:elasticloadbalancing:us-east-1:${IDS.account}:targetgroup/fraud-svc-tg/0b9e8d7c6a5f4e31`,
      protocol: 'TCP',
      port: 8080,
      loadBalancer: NLB_NAME,
      healthCheck: { protocol: 'HTTP', path: '/health', port: 'traffic-port', intervalSec: 10, timeoutSec: 6, healthyThreshold: 3, unhealthyThreshold: 3, matcher: '200-399' },
      targets: ['10.0.12.71', '10.0.12.118', '10.0.12.164', '10.0.12.203'].map(ip => ({ id: ip, port: 8080, az: 'us-east-1a', state: 'healthy' as const })),
    });
    env.http.unshift({ match: /fraud-svc\.internal\.shopfast\.io|10\.0\.12\.40|fraud-svc-nlb/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json', 'X-Fraud-Version': '3.8.0' }, body: '{"status":"ok","service":"fraud-svc","version":"3.8.0","model":"risk-v42"}', timeMs: 4 });

    // ---------------- App hosts ----------------
    for (const [i, h] of APP_HOSTS.entries()) {
      const hh = host(env, h);
      const svc = hh.services['checkout-api'];
      Object.assign(hh.env, { APP_VERSION: '2.16.0', FRAUD_URL: 'http://fraud-svc.internal.shopfast.io:8080', FRAUD_TIMEOUT_MS: '800' });
      hh.files['/opt/checkout-api/package.json'] = hh.files['/opt/checkout-api/package.json'].replace('"version": "2.13.1"', '"version": "2.16.0"');
      const started = at(DEPLOY - 3 - i * 2);
      svc.since = `${systemdTime(started)}; 2 days ago`;
      svc.journal = svc.journal.map(l => l.replace('v2.13.1', 'v2.16.0'));
      svc.journal.push(`${syslogTime(started + 1500)} ${hh.hostname} node[${svc.mainPid}]: {"level":30,"msg":"fraud client ready","url":"http://fraud-svc.internal.shopfast.io:8080","mode":"per-request-agent"}`);
      hh.cpu = { ...hh.cpu, user: 36.8 + i * 1.9, system: 8.4 + i * 0.3, idle: 100 - 36.8 - i * 1.9 - 8.4 - i * 0.3 - 0.2 };
      hh.load = [1.21 + i * 0.07, 1.14, 0.98];
      const app = hh.processes.find(p => p.command.includes('checkout-api'))!;
      app.cpu = 71.4 + i * 3.1;

      const tw = Math.round(CAP_HOST_PER_MIN - 10 + i * 9) + OTHER_TW[i];
      hh.sockets.timeWait = tw;
      hh.sockets.established = 163 + i * 7;
      const ports = new Set<number>();
      while (ports.size < 30) ports.add(32768 + Math.floor(rng() * PORTS));
      hh.sockets.sample = [
        ...hh.sockets.sample.filter(r => r.state !== 'TIME-WAIT'),
        { state: 'ESTAB', local: `${hh.ip}:${32768 + Math.floor(rng() * PORTS)}`, peer: `${FRAUD_IP}:8080`, process: 'node' },
        { state: 'ESTAB', local: `${hh.ip}:${32768 + Math.floor(rng() * PORTS)}`, peer: `${FRAUD_IP}:8080`, process: 'node' },
        { state: 'SYN-SENT', local: `${hh.ip}:${32768 + Math.floor(rng() * PORTS)}`, peer: `${FRAUD_IP}:8080`, process: 'node' },
        ...[...ports].map(p => ({ state: 'TIME-WAIT', local: `${hh.ip}:${p}`, peer: `${FRAUD_IP}:8080` })),
        { state: 'TIME-WAIT', local: `${hh.ip}:80`, peer: '10.0.0.204:61002' },
      ];
      hh.sysctl['net.netfilter.nf_conntrack_count'] = String(61420 + i * 812);
      hh.sysctl['net.ipv4.tcp_max_tw_buckets'] = '262144';
      hh.sysctl['net.ipv4.tcp_timestamps'] = '1';
      hh.files['/proc/sys/net/ipv4/ip_local_port_range'] = '32768\t60999\n';
      hh.files['/proc/sys/net/ipv4/tcp_tw_reuse'] = '2\n';
      hh.files['/proc/sys/net/ipv4/tcp_fin_timeout'] = '60\n';
      hh.files['/proc/net/sockstat'] = `sockets: used 841\nTCP: inuse ${hh.sockets.established + 34} orphan 0 tw ${tw} alloc ${hh.sockets.established + 52} mem 61\nUDP: inuse 4 mem 2\nUDPLITE: inuse 0\nRAW: inuse 0\nFRAG: inuse 0 memory 0\n`;

      // `ss ... state time-wait`: only the TIME-WAIT rows
      hh.commandOverrides.push({
        match: /^ss\s.*state\s+time-wait/,
        output: () => {
          const rows = hh.sockets.sample.filter(r => r.state === 'TIME-WAIT');
          return [
            'Recv-Q Send-Q      Local Address:Port        Peer Address:Port Process',
            ...rows.map(r => `0      0      ${r.local.padStart(18)}  ${r.peer.padStart(18)}`),
            `... ${tw - rows.length} more TIME-WAIT sockets (${tw - OTHER_TW[i] - rows.length + 1} of them to ${FRAUD_IP}:8080) — use \`ss -s\` or /proc/net/sockstat for totals`,
          ].join('\n');
        },
      });
      // curl to fraud-svc from an app host fails intermittently with the same error
      let calls = 0;
      hh.commandOverrides.push({
        match: /^curl\b.*(fraud-svc|10\.0\.12\.40)/,
        output: (cmd: string) => {
          calls++;
          const args = tokenize(cmd).slice(1);
          if (calls % 3 !== 2) return curl({ env, host: hh, cwd: '/home/ec2-user' }, args);
          const verbose = args.some(a => a === '-v' || a === '--verbose' || /^-[a-zA-Z]*v/.test(a));
          const name = /10\.0\.12\.40/.test(cmd) ? FRAUD_IP : 'fraud-svc.internal.shopfast.io';
          const last = `curl: (7) Failed to connect to ${name} port 8080 after 0 ms: Couldn't connect to server`;
          return verbose
            ? [`*   Trying ${FRAUD_IP}:8080...`, `* Immediate connect fail for ${FRAUD_IP}: Cannot assign requested address`, `* Failed to connect to ${name} port 8080 after 0 ms: Couldn't connect to server`, '* Closing connection', last].join('\n')
            : last;
        },
      });
    }

    // ---------------- Changes ----------------
    env.changes = env.changes.filter(c => c.id !== 'chg-8790' && c.id !== 'chg-8751');
    env.changes.push(
      { id: 'chg-8880', minutesAgo: 6 * 1440 + 200, kind: 'deploy', service: 'checkout-api', title: 'checkout-api 2.15.4 — PayBridge webhook retries', author: 'li.wang', status: 'succeeded', version: '2.15.4', description: 'Retries PayBridge webhooks with jittered backoff.' },
    );
    env.changes.unshift(
      {
        id: 'chg-8925',
        minutesAgo: 155,
        kind: 'deploy',
        service: 'fraud-service',
        title: 'fraud-service 3.8.0 — risk model v42',
        author: 'nadia.haddad',
        status: 'succeeded',
        version: '3.8.0',
        description: 'New gradient-boosted risk model (v42), +3 features (device age, BIN country mismatch, velocity 15m). Shadow-scored for 7 days; p99 inference latency 11 ms → 12 ms. ECS rolling deploy, 4 tasks behind fraud-svc-nlb.',
      },
      {
        id: 'chg-8910',
        minutesAgo: DEPLOY,
        kind: 'deploy',
        service: 'checkout-api',
        title: 'checkout-api 2.16.0 — fraud client: fix stale-socket ECONNRESETs (FRAUD-212)',
        author: 'arjun.mehta',
        status: 'succeeded',
        version: '2.16.0',
        description: 'After every fraud-svc deploy we saw a burst of "socket hang up / ECONNRESET" on pooled keep-alive connections whose targets had been deregistered. Fix: use a fresh connection per fraud call so a dead socket can never be reused. Load-tested at 150 req/s on staging (1 host). Rolling deploy ✔.',
        diff: `diff --git a/src/clients/fraud.ts b/src/clients/fraud.ts
--- a/src/clients/fraud.ts
+++ b/src/clients/fraud.ts
@@ -1,27 +1,31 @@
-import { Pool } from 'undici';
+import { Agent, request } from 'undici';
 import { config } from '../config';

-// One keep-alive pool per process, shared by all requests.
-const pool = new Pool(config.FRAUD_URL, {
-  connections: 64,
-  keepAliveTimeout: 30_000,
-});
+// FRAUD-212: never reuse a socket — a fresh connection per call means we can't
+// hit a keep-alive socket the NLB target already closed.
+function freshAgent() {
+  return new Agent({ pipelining: 0, keepAliveTimeout: 1, connect: { timeout: 500 } });
+}

 export async function score(input: ScoreInput): Promise<ScoreResult> {
-  const res = await pool.request({
-    path: '/v1/score',
-    method: 'POST',
-    headers: { 'content-type': 'application/json' },
-    body: JSON.stringify(input),
-    headersTimeout: config.FRAUD_TIMEOUT_MS,
-  });
-  return (await res.body.json()) as ScoreResult;
+  const dispatcher = freshAgent();
+  try {
+    const res = await request(\`\${config.FRAUD_URL}/v1/score\`, {
+      dispatcher,
+      method: 'POST',
+      headers: { 'content-type': 'application/json' },
+      body: JSON.stringify(input),
+      headersTimeout: config.FRAUD_TIMEOUT_MS,
+    });
+    return (await res.body.json()) as ScoreResult;
+  } finally {
+    await dispatcher.close();
+  }
 }

 export async function signal(event: RiskSignal): Promise<void> {
-  await pool.request({ path: '/v1/signals', method: 'POST', body: JSON.stringify(event) });
+  const dispatcher = freshAgent();
+  try {
+    await request(\`\${config.FRAUD_URL}/v1/signals\`, { dispatcher, method: 'POST', body: JSON.stringify(event) });
+  } finally {
+    await dispatcher.close();
+  }
 }`,
      },
    );
    env.cloudtrail.push(
      { minutesAgo: 155, eventName: 'UpdateService', eventSource: 'ecs.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'fraud-svc (cluster shopfast-services)', request: { service: 'fraud-svc', taskDefinition: 'fraud-svc:118' } },
      { minutesAgo: DEPLOY - 1, eventName: 'SendCommand', eventSource: 'ssm.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'AWS-RunShellScript (deploy checkout-api 2.16.0)', request: { documentName: 'AWS-RunShellScript', targets: [{ key: 'tag:service', values: ['checkout-api'] }], maxConcurrency: '1' } },
    );

    // ---------------- Metrics (1-minute, last 3 h) ----------------
    const N = 180;
    const mins = Array.from({ length: N }, (_, k) => N - 1 - k); // minutesAgo per index
    const jitter = (seed: number) => 1 + (((Math.sin(seed * 12.9898) * 43758.5453) % 1) - 0.5) * 0.04;
    const req = mins.map(m => Math.round(demand(at(m)) * jitter(m + 1)));
    const perHost = (h: string) => req.map(r => (r * SHARE[h]));
    const errs = mins.map((_, k) => Math.round(APP_HOSTS.reduce((s, h) => s + Math.max(0, perHost(h)[k] - CAP_HOST_PER_MIN), 0)));
    setPoints(env, 'alb.requests', req);
    addPanel(env, { id: 'app.fraudErrors', group: 'Application (ShopFast/Checkout)', namespace: 'ShopFast/Checkout', metric: 'FraudClientErrors', resource: 'checkout-api', unit: 'Count', stat: 'Sum', periodMinutes: 1, featured: true, threshold: 500, series: [{ name: 'checkout-api', points: errs }] });
    addPanel(env, {
      id: 'net.timewait',
      group: 'EC2',
      namespace: 'CWAgent',
      metric: 'netstat_tcp_time_wait',
      resource: 'shopfast-checkout-asg',
      unit: 'Count',
      stat: 'Maximum',
      periodMinutes: 1,
      featured: true,
      series: APP_HOSTS.map((h, i) => ({ name: h, points: perHost(h).map(v => Math.round(Math.min(v, CAP_HOST_PER_MIN - 10 + i * 9) + OTHER_TW[i] + ((v * 7) % 17))) })),
    });
    addPanel(env, { id: 'nlb.newflows', group: 'Network Load Balancer (fraud-svc)', namespace: 'AWS/NetworkELB', metric: 'NewFlowCount', resource: `net/${NLB_NAME}/5f2a9c1e7b3d4a60`, unit: 'Count', stat: 'Sum', periodMinutes: 1, series: [{ name: NLB_NAME, points: req.map((r, k) => Math.round(r - errs[k])) }] });
    addPanel(env, { id: 'fraud.latency', group: 'Network Load Balancer (fraud-svc)', namespace: 'ShopFast/Fraud', metric: 'ScoreLatency', resource: 'fraud-svc', unit: 'ms', stat: 'p99', periodMinutes: 1, featured: true, series: [{ name: 'fraud-svc', points: series('flat', 17.6, { noise: 0.06 }).rampTo(155, 18.3, 2).round(1).build() }] });
    addPanel(env, { id: 'nlb.healthy', group: 'Network Load Balancer (fraud-svc)', namespace: 'AWS/NetworkELB', metric: 'HealthyHostCount', resource: 'fraud-svc-tg', unit: 'Count', stat: 'Minimum', periodMinutes: 1, series: [{ name: 'fraud-svc-tg', points: series('hh', 4, { noise: 0 }).map((v, m) => (m >= 152 && m <= 157 ? 3 : v)).round(0).build() }] });
    const checkouts = req.map(r => r * 0.00152); // ~140 checkouts/min at peak
    const ratio = req.map((r, k) => errs[k] / r);
    setPoints(env, 'app.orders', checkouts.map((c, k) => Math.round(c * (1 - ratio[k]) * jitter(k + 7))));
    setPoints(env, 'alb.target5xx', checkouts.map((c, k) => Math.round(c * ratio[k] + 1.2 * jitter(k + 3))));
    panel(env, 'alb.target5xx').featured = true;
    setPoints(env, 'app.checkoutLatency', series('elat', 410, { noise: 0.08 }).wave(0.04).round(0).build());
    setPoints(env, 'alb.latency', series('eal', 0.38, { noise: 0.08 }).wave(0.04).round(3).build());
    for (const [i, h] of APP_HOSTS.entries()) setPoints(env, 'ec2.cpu', perHost(h).map((v, k) => Math.round((10 + v / 760 + i) * jitter(k + i * 11) * 10) / 10), h);
    setPoints(env, 'nat.active', series('nat', 380, { noise: 0.1 }).round(0).build());

    // ---------------- Metrics (hourly, last 4 days) ----------------
    const H = 96;
    const hours = Array.from({ length: H }, (_, k) => (H - 1 - k) * 60 + 30);
    const hReq = hours.map(m => Math.round(demand(at(m)) * jitter(m)));
    const hErr = hours.map((m, k) => (m < DEPLOY ? Math.round(APP_HOSTS.reduce((s, h) => s + Math.max(0, hReq[k] * SHARE[h] - CAP_HOST_PER_MIN), 0) * 60) : 0));
    const hFlows = hours.map((m, k) => (m < DEPLOY ? Math.round(hReq[k] * 60 - hErr[k]) : Math.round(1900 * jitter(m + 5))));
    addPanel(env, { id: 'alb.requests.4d', group: 'Application Load Balancer', namespace: 'AWS/ApplicationELB', metric: 'RequestCount (4 days, per minute avg)', resource: 'shopfast-prod-alb', unit: 'Count/min', stat: 'Average', periodMinutes: 60, series: [{ name: 'shopfast-prod-alb', points: hReq }] });
    addPanel(env, { id: 'app.fraudErrors.4d', group: 'Application (ShopFast/Checkout)', namespace: 'ShopFast/Checkout', metric: 'FraudClientErrors (4 days)', resource: 'checkout-api', unit: 'Count', stat: 'Sum', periodMinutes: 60, featured: true, series: [{ name: 'checkout-api', points: hErr }] });
    addPanel(env, { id: 'nlb.newflows.4d', group: 'Network Load Balancer (fraud-svc)', namespace: 'AWS/NetworkELB', metric: 'NewFlowCount (4 days)', resource: `net/${NLB_NAME}/5f2a9c1e7b3d4a60`, unit: 'Count', stat: 'Sum', periodMinutes: 60, series: [{ name: NLB_NAME, points: hFlows }] });

    env.alarms.push({ name: 'checkout-fraud-errors-high', state: 'ALARM', metric: 'FraudClientErrors', condition: 'Sum > 500 for 5 datapoints within 5 minutes', minutesAgo: 52, panelId: 'app.fraudErrors' });

    // ---------------- Logs ----------------
    const clientIps = ['10.0.0.71', '10.0.1.163', '10.0.0.204', '10.0.1.38'];
    const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
    for (const [i, h] of APP_HOSTS.entries()) {
      const meta = hostMeta[h];
      const pid = host(env, h).services['checkout-api'].mainPid!;
      const app: { ts: number; msg: string }[] = [];
      const access: { ts: number; msg: string }[] = [];
      const emit = (ts: number, k: number, checkout: boolean) => {
        const reqId = `req-${hex(rng, 8)}`;
        app.push({ ts, msg: JSON.stringify({ level: checkout ? 50 : 40, time: iso(ts), pid, hostname: meta.hostname, reqId, upstream: 'fraud-svc', op: checkout ? 'score' : 'signal', err: FRAUD_ERR(FRAUD_IP), msg: checkout ? 'fraud check failed' : 'fraud signal dropped' }) });
        if (!checkout) return;
        const rt = 2.1 + ((k * 37) % 30) / 10;
        app.push({ ts: ts + 1, msg: JSON.stringify({ level: 50, time: iso(ts + 1), pid, hostname: meta.hostname, reqId, req: { method: 'POST', url: '/api/v1/checkout' }, res: { statusCode: 503 }, err: { type: 'FraudCheckUnavailableError', message: 'fraud check unavailable' }, responseTime: rt, msg: 'request errored' }) });
        access.push({ ts: ts + 2, msg: `${clientIps[(k + i) % 4]} - - [${nginxTime(ts + 2)}] "POST /api/v1/checkout HTTP/1.1" 503 74 "-" "${UA}" rt=0.00${Math.round(rt)} uct=0.000 urt=0.00${Math.round(rt)} rid=${hex(rng, 32)}` });
      };
      // tonight: errors per minute proportional to the overload on this host
      let k = 0;
      for (const [idx, m] of mins.entries()) {
        if (m > 75) continue;
        const over = Math.max(0, perHost(h)[idx] - CAP_HOST_PER_MIN) / perHost(h)[idx];
        const n = Math.round(over * 50);
        for (let j = 0; j < n; j++) emit(at(m) + Math.floor(((j + 0.5) / n) * 60000), k++, j % 3 === 0);
      }
      // last night, same time window
      for (let j = 0; j < 12; j++) emit(at(1440 + 60 - j * 7.3 - i), k++, j % 2 === 0);
      injectLog(env, h, '/var/log/checkout-api/app.log', app);
      injectLog(env, h, '/var/log/nginx/access.log', access);
    }
    env.traffic.profile = () => ({ rpm: 9 });
  },

  evidence: [
    {
      id: 'eaddrnotavail',
      label: 'Fraud calls fail instantly in connect() with EADDRNOTAVAIL to 10.0.12.40:8080',
      kind: 'key',
      match: /EADDRNOTAVAIL/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'EADDRNOTAVAIL ("Cannot assign requested address") from connect() is a local error: the kernel on the app host could not find a free source port for that destination. The SYN never left the machine — which is why fraud-svc sees nothing wrong.',
    },
    {
      id: 'time-wait',
      label: '~28,400 sockets in TIME-WAIT on each app host, almost all to 10.0.12.40:8080',
      kind: 'key',
      match: /timewait 2[78]\d{3}\)|TIME-WAIT[^\n]*10\.0\.12\.40:8080|netstat_tcp_time_wait/,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'ss -s' },
      explanation: 'The usable range 32768–60999 holds 28,232 ports per destination ip:port. With every one of them parked in TIME-WAIT for 60 s, a new connection to the same destination has no 4-tuple left.',
    },
    {
      id: 'per-call-agent',
      label: 'checkout-api 2.16.0 creates a new undici Agent with keep-alive disabled for every fraud call',
      kind: 'key',
      match: /pipelining: 0/,
      foundBy: { tool: 'deploys' },
      explanation: 'The "fix" for stale keep-alive sockets turned ~60 pooled connections into one new TCP connection per call — ~470 per second per host at peak. The client closes first, so the TIME-WAIT state lands on the app host.',
    },
    {
      id: 'port-range',
      label: 'net.ipv4.ip_local_port_range = 32768 60999 (28,232 ports)',
      kind: 'supporting',
      match: /ip_local_port_range = 32768\s+60999/,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'sysctl net.ipv4.ip_local_port_range' },
      explanation: 'The ceiling: 28,232 ports ÷ 60 s TIME-WAIT ≈ 470 new connections per second to one destination, per host. Exactly where the errors start.',
    },
    {
      id: 'new-flows',
      label: 'fraud-svc NLB NewFlowCount jumped ~2,500× at the 2.16.0 deploy',
      kind: 'supporting',
      match: /NewFlowCount/,
      foundBy: { tool: 'cloudwatch', panel: 'nlb.newflows.4d' },
      explanation: 'Before Oct 4 10:12 the NLB saw ~2k new flows an hour (pooled connections); afterwards one per request. The errors only appear on evenings after that line.',
    },
    {
      id: 'fraud-deploy',
      label: 'fraud-service 3.8.0 (risk model v42) deployed at 17:20',
      kind: 'red-herring',
      match: /fraud-service 3\.8\.0|risk model v42/,
      foundBy: { tool: 'deploys' },
      explanation: 'Its latency is flat (p99 ~18 ms), targets are healthy, and the errors started two evenings before it shipped. The failing connections never reach fraud-svc.',
    },
    {
      id: 'fin-timeout',
      label: 'net.ipv4.tcp_fin_timeout = 60',
      kind: 'red-herring',
      match: /tcp_fin_timeout/,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'sysctl net.ipv4.tcp_fin_timeout' },
      explanation: 'A classic trap: tcp_fin_timeout controls how long an orphaned socket waits in FIN-WAIT-2. TIME-WAIT on Linux is a compile-time constant (TCP_TIMEWAIT_LEN = 60 s) and is not affected by it.',
    },
  ],

  rootCauses: [
    { id: 'rc-tw-exhaustion', correct: true, text: 'checkout-api 2.16.0 opens a new non-keep-alive connection per fraud call; each leaves 60 s of TIME-WAIT on the app host, exhausting the 28,232 ports to 10.0.12.40:8080 at peak (EADDRNOTAVAIL).', explanation: 'Explains why it is rate-dependent (TIME-WAIT count = new connections/s × 60 s), why errors are instant (local connect() failure), why fraud-svc sees nothing, and why it began with the Oct 4 deploy.' },
    { id: 'rc-port-range', partial: true, text: 'net.ipv4.ip_local_port_range (32768–60999) is too narrow for ~470 new connections/s per host to 10.0.12.40:8080, so the app hosts run out of ephemeral ports at evening peak.', explanation: 'Correct mechanism, wrong culprit: the port range is the default and was fine for years. The connection rate exploded because 2.16.0 stopped reusing connections; widening the range only moves the ceiling.' },
    { id: 'rc-fraud-svc', text: 'fraud-service 3.8.0 (risk model v42) costs more CPU per score; at evening peak its 4 tasks saturate and fraud-svc-nlb starts refusing new connections from checkout-api.', explanation: 'fraud-svc p99 is flat at 18 ms, all targets are healthy, the NLB does not refuse connections when targets are busy, and the errors began two days before 3.8.0 shipped.' },
    { id: 'rc-nofile', text: 'Leaked fraud-svc sockets push checkout-api to its LimitNOFILE=65535 at peak, so new connect() calls fail until the garbage collector closes the leaked file descriptors.', explanation: 'Running out of file descriptors produces EMFILE ("too many open files") in socket(), not EADDRNOTAVAIL in connect(). TIME-WAIT sockets are kernel-owned and hold no file descriptor.' },
    { id: 'rc-conntrack', text: 'The nf_conntrack table on the app hosts fills at evening peak (nf_conntrack_max 262144), so the kernel drops new outbound SYNs to fraud-svc and connect() fails.', explanation: 'nf_conntrack_count is ~61k of 262k, dmesg has no "table full, dropping packet", and conntrack drops cause timeouts, not an instant EADDRNOTAVAIL.' },
    { id: 'rc-nat', text: 'Fraud traffic egresses via NAT nat-0f3c2a91b8e7d6540, which hits ErrorPortAllocation (55,000 concurrent connections per destination) at peak and rejects new flows.', explanation: '10.0.12.40 is inside the VPC: the local route 10.0.0.0/16 wins and the NAT gateway is never involved. And a NAT problem would show as a timeout, not a local connect() error.' },
  ],

  fixes: [
    { id: 'fx-pool', kind: 'correct', text: 'Roll back to 2.15.4 (or hotfix) so fraud calls share one keep-alive undici Pool per process and reuse a few dozen connections instead of one per call.', explanation: 'Removes the cause: with pooled keep-alive connections the app hosts open a handful of new connections per minute instead of ~470 per second. TIME-WAIT drops back to a few hundred.' },
    { id: 'fx-retry', kind: 'correct', text: 'Fix FRAUD-212 properly: keep the pool, expire idle sockets well before the NLB\'s 350 s idle timeout, and retry idempotent fraud calls once on ECONNRESET.', explanation: 'The original problem (stale sockets after target deregistration) is real and has a standard fix: idle-socket expiry below the load balancer\'s idle timeout plus a single retry for idempotent requests — not abandoning connection reuse.' },
    { id: 'fx-port-range', kind: 'partial', text: 'Widen net.ipv4.ip_local_port_range to 1024–65000 and set net.ipv4.tcp_tw_reuse=1 on app-1..3 via /etc/sysctl.d/90-ports.conf.', explanation: 'Buys headroom: ~2.3× more ports, and tcp_tw_reuse=1 lets outgoing connects reuse a TIME-WAIT port once 1 s has passed (safe thanks to TCP timestamps). A useful stop-gap, but the app still opens a connection per call.' },
    { id: 'fx-scale-asg', kind: 'partial', text: 'Raise shopfast-checkout-asg desired capacity from 3 to 5 so each app host opens fewer new connections per second to 10.0.12.40:8080.', explanation: 'Works as a mitigation — the 28k-port budget is per host, so 5 hosts stay under ~470/s each — but you pay for idle capacity to hide a client bug.' },
    { id: 'fx-nlb-az', kind: 'partial', text: 'Enable fraud-svc-nlb in us-east-1b too, so fraud-svc.internal.shopfast.io returns two IPs and clients spread their connections over both.', explanation: 'The limit is per destination ip:port, so a second NLB IP roughly doubles the budget (and adds AZ resilience). Headroom, not a fix.' },
    { id: 'fx-recycle', kind: 'harmful', text: 'Set net.ipv4.tcp_tw_recycle=1 on app-1..3 so TIME-WAIT sockets are recycled immediately instead of after 60 seconds.', explanation: 'tcp_tw_recycle was removed in Linux 4.12 (sysctl: cannot stat …). Where it existed it dropped SYNs from clients behind NAT whose timestamps were not monotonic — it broke real users. Never use it.' },
    { id: 'fx-fin-timeout', kind: 'neutral', text: 'Lower net.ipv4.tcp_fin_timeout from 60 to 15 on app-1..3 so closed fraud-svc sockets leave TIME-WAIT four times faster.', explanation: 'tcp_fin_timeout governs FIN-WAIT-2 for orphaned sockets. TIME-WAIT on Linux is fixed at 60 s (TCP_TIMEWAIT_LEN); this changes nothing here.' },
    { id: 'fx-scale-fraud', kind: 'neutral', text: 'Scale the fraud-svc ECS service from 4 to 8 tasks behind fraud-svc-nlb to absorb the evening peak of score and signal requests.', explanation: 'The client sees one destination, 10.0.12.40:8080, no matter how many targets sit behind the NLB — the port budget does not change. fraud-svc was never the bottleneck.' },
    { id: 'fx-restart', kind: 'harmful', text: 'Rolling-restart checkout-api on app-1..3 to close the leaked fraud-svc sockets and release their ephemeral ports.', explanation: 'TIME-WAIT sockets belong to the kernel, not the process, and survive the restart. Taking one host out at peak pushes the other two further past ~470 connections/s, so errors go up.' },
  ],

  hints: [
    'The failures scale with request rate, disappear at night and fail in ~3 ms. Find the exact error checkout-api logs for fraud calls: which system call fails, and on which machine?',
    'EADDRNOTAVAIL from connect() means the kernel found no free local port for that destination. On an app host compare `ss -s`, the netstat_tcp_time_wait metric and `sysctl net.ipv4.ip_local_port_range`.',
    'Look at the fraud-svc NLB NewFlowCount over 4 days and the fraud client diff in checkout-api 2.16.0: a fresh Agent with keep-alive disabled per call = one TCP connection per call, each leaving 60 s of TIME-WAIT on the app host.',
  ],

  debrief: {
    summary: `On **Oct 4 at 10:12** checkout-api **2.16.0** "fixed" occasional ECONNRESETs on pooled fraud-svc connections by creating a **new undici Agent with keep-alive disabled (\`pipelining: 0\`) for every call** and closing it afterwards. Every API request makes a fraud call (risk signals, plus a synchronous score on checkout), so each app host went from reusing ~60 connections to opening **one new TCP connection per request** to the same destination, the fraud-svc NLB at \`10.0.12.40:8080\`.

The side that closes a TCP connection first keeps it in **TIME-WAIT** for 2×MSL — on Linux a fixed **60 s**. The client closes here, so the TIME-WAIT sockets pile up on the app hosts: TIME-WAIT count ≈ new connections per second × 60. A connection is identified by its 4-tuple (src IP, src port, dst IP, dst port); with src IP and destination fixed, only the source port varies, and \`ip_local_port_range\` 32768–60999 offers **28,232** of them. Ceiling: 28,232 / 60 s ≈ **470 new connections per second per host**.

Below ~85k requests/min (3 hosts) everything works. Above it — every evening from ~18:45 to ~22:00 — connect() finds no free port and fails instantly with \`EADDRNOTAVAIL\` ("Cannot assign requested address"); the SYN never leaves the host, so fraud-svc saw *fewer* requests and stayed green. The errors started the evening after the deploy (Oct 4), not before, even though Oct 3 had similar traffic.

fraud-service 3.8.0 (17:20) and \`tcp_fin_timeout\` were distractions: the first is on the other side of a connection that never got made; the second governs FIN-WAIT-2, not TIME-WAIT.`,
    timeline: [
      { minutesAgo: DEPLOY, event: 'checkout-api 2.16.0: new keep-alive-less Agent per fraud call; NLB NewFlowCount jumps ~2,500×' },
      { minutesAgo: DEPLOY - 520, event: 'Oct 4 evening peak: first EADDRNOTAVAIL errors (closed as "fraud-svc blip")' },
      { minutesAgo: 1440 + 70, event: 'Oct 5 evening peak: same errors, healed by ~22:00' },
      { minutesAgo: 155, event: 'fraud-service 3.8.0 deployed (red herring)' },
      { minutesAgo: 67, event: 'Request rate crosses ~470 new connections/s per host; TIME-WAIT hits ~28.2k' },
      { minutesAgo: 52, event: 'checkout-fraud-errors-high pages on-call' },
    ],
    concepts: [
      { title: 'The TCP 4-tuple and ephemeral ports', body: 'A TCP connection is identified by (source IP, source port, destination IP, destination port). For outgoing connections the kernel picks the source port from `net.ipv4.ip_local_port_range` (default 32768–60999 = 28,232 ports). Since Linux 4.x the same local port can be reused for *different* destinations, so the budget is per destination ip:port — and an NLB with a single IP is a single destination, however many targets sit behind it.' },
      { title: 'What TIME-WAIT is for', body: 'The side that sends the first FIN (the *active closer*) enters TIME-WAIT for 2×MSL so that (1) a lost final ACK can be retransmitted, and (2) delayed segments from the old connection cannot be mistaken for a new one with the same 4-tuple. Linux hard-codes this at 60 s (`TCP_TIMEWAIT_LEN`); there is no sysctl for it. Here undici destroys the socket right after reading the response, so the app host is the active closer. (With `Connection: close` answered by the server, the TIME-WAIT would usually land on the server instead.)' },
      { title: 'Little\'s law for sockets', body: 'Sockets in TIME-WAIT ≈ new connections per second × 60 s. 470/s × 60 = 28,200 — the whole port range. This is why the failure is purely rate-dependent: CPU, memory and latency look normal, and the errors appear at a sharp threshold and vanish when traffic drops.' },
      { title: 'Connection pooling and keep-alive', body: 'Keep-alive amortises the TCP (and TLS) handshake over many requests and keeps the number of new connections tiny. In undici, one `Pool`/`Agent` per process should be shared; `pipelining: 0` disables keep-alive entirely. To survive load-balancer target churn, expire idle sockets before the LB\'s idle timeout (NLB: 350 s) and retry idempotent requests once on ECONNRESET.' },
      { title: 'tcp_tw_reuse, tcp_tw_recycle, tcp_fin_timeout', body: '`tcp_tw_reuse=1` lets *outgoing* connections reuse a port in TIME-WAIT once it is >1 s old, relying on TCP timestamps to reject old duplicates; `2` (the default on modern kernels, including this 6.1) enables it for loopback traffic only. `tcp_tw_recycle` aggressively dropped TIME-WAIT state using per-host timestamps and broke clients behind NAT; it was removed in Linux 4.12. `tcp_fin_timeout` is the FIN-WAIT-2 timeout for orphaned sockets — it does not shorten TIME-WAIT.' },
      { title: 'Why some "scale-outs" help and others don\'t', body: 'The scarce resource is ports per (client host, destination ip:port). More app hosts (fewer connections/s each) or more destination IPs (NLB in a second AZ) raise the ceiling. More fraud-svc targets behind the same NLB IP change nothing for the client.' },
    ],
    commands: [
      { cmd: 'ss -s', why: 'Socket summary — the timewait count is the tell' },
      { cmd: 'ss -tan state time-wait dst 10.0.12.40 | wc -l', why: 'How many TIME-WAIT sockets point at one destination (on a real host)' },
      { cmd: 'cat /proc/net/sockstat', why: 'Kernel socket counters, including tw' },
      { cmd: 'sysctl net.ipv4.ip_local_port_range net.ipv4.tcp_tw_reuse', why: 'The port budget and whether TIME-WAIT ports may be reused' },
      { cmd: 'grep -c EADDRNOTAVAIL /var/log/checkout-api/app.log', why: 'Quantify local connect() failures' },
      { cmd: 'nstat -az TcpActiveOpens', why: 'Rate of outgoing connection attempts (run twice and diff)' },
    ],
    prevention: [
      'Code review / lint rule: HTTP clients must use a shared, long-lived Agent/Pool — no per-request agents or disabled keep-alive.',
      'Load-test at production peak *connection* rate on production-sized hosts, not 150 req/s on one staging host.',
      'Alarm on CWAgent netstat_tcp_time_wait (e.g. > 50% of the port range) and on EADDRNOTAVAIL / connect-error rate.',
      'Track new-connection rate per dependency (NLB NewFlowCount); a step change after a deploy is a regression signal.',
      'Give critical internal NLBs an IP per AZ, and review repeated "self-healing" peak-time errors instead of closing them as blips.',
    ],
    reading: [
      { title: 'Linux kernel: IP sysctl (ip_local_port_range, tcp_tw_reuse, tcp_fin_timeout)', url: 'https://www.kernel.org/doc/html/latest/networking/ip-sysctl.html' },
      { title: 'Vincent Bernat: Coping with the TCP TIME-WAIT state on busy Linux servers', url: 'https://vincent.bernat.ch/en/blog/2014-tcp-time-wait-state-linux' },
      { title: 'Cloudflare: How to stop running out of ephemeral ports', url: 'https://blog.cloudflare.com/how-to-stop-running-out-of-ephemeral-ports-and-start-to-love-long-lived-connections/' },
      { title: 'undici: Agent / Pool API', url: 'https://undici.nodejs.org/#/docs/api/Agent' },
    ],
  },
};

export default incident;
