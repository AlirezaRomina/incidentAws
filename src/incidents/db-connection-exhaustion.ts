import type { Database, Host, Incident, LogEvent, Process } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, hm, isoSec, pgTime, syslogTime, systemdTime } from '../engine/time';
import { pgTable } from '../engine/terminal/psql';
import { hashString } from '../engine/rng';
import { addPanel, cloneHost, database, host, injectLog, logGroup, panel, setAlarm, setPoints, spread } from '../env/helpers';
import { IDS, hostMeta } from '../env/base';

/*
 * INC-4203 — Saturday flash sale. Three weeks ago a FinOps change downsized checkout-db
 * from db.r6g.large (16 GiB, max_connections 1708) to db.t4g.medium (4 GiB, ≈405).
 * The sale made the ASG scale 3 → 9; every host runs 2 workers × (20 pool + 1 LISTEN)
 * connections, so demand (~407 + others) now exceeds what Postgres allows → SQLSTATE 53300.
 */

const SALE = 65; // 12:00
const SCALE = [51, 38, 24]; // 12:14, 12:27, 12:41 — each +2 instances
const ERRORS = 22; // first connection refusals (12:43)
const DOWNSIZE = 21 * 1440 + 595; // Sat 2026-09-12 03:10 UTC
const MAX_CONN = 405;

type NewHost = { name: string; hostname: string; ip: string; id: string; az: string; subnet: string; at: number; pool: number };
const NEW_HOSTS: NewHost[] = [
  { name: 'app-4', hostname: 'ip-10-0-11-152', ip: '10.0.11.152', id: 'i-0d3a7e5c9b1f24680', az: 'us-east-1b', subnet: IDS.subnets.appB, at: SCALE[0], pool: 42 },
  { name: 'app-5', hostname: 'ip-10-0-10-61', ip: '10.0.10.61', id: 'i-0e8b2f6d4a9c13579', az: 'us-east-1a', subnet: IDS.subnets.appA, at: SCALE[0], pool: 42 },
  { name: 'app-6', hostname: 'ip-10-0-11-219', ip: '10.0.11.219', id: 'i-0f1c4a8e2d6b35791', az: 'us-east-1b', subnet: IDS.subnets.appB, at: SCALE[1], pool: 42 },
  { name: 'app-7', hostname: 'ip-10-0-10-198', ip: '10.0.10.198', id: 'i-01a5d9f3b7e246802', az: 'us-east-1a', subnet: IDS.subnets.appA, at: SCALE[1], pool: 42 },
  { name: 'app-8', hostname: 'ip-10-0-11-43', ip: '10.0.11.43', id: 'i-02b6e0a4c8f357913', az: 'us-east-1b', subnet: IDS.subnets.appB, at: SCALE[2], pool: 40 },
  { name: 'app-9', hostname: 'ip-10-0-10-117', ip: '10.0.10.117', id: 'i-03c7f1b5d9a468024', az: 'us-east-1a', subnet: IDS.subnets.appA, at: SCALE[2], pool: 33 },
];
const OLD_HOSTS = ['app-1', 'app-2', 'app-3'] as const;
const WORKER_IP = hostMeta['worker-1'].ip;
const METABASE_IP = '10.0.11.58';

const ERR_RESERVED = 'remaining connection slots are reserved for non-replication superuser connections';
const ERR_TOO_MANY = 'sorry, too many clients already';
const pgErr = (reserved: boolean) =>
  reserved
    ? { type: 'DatabaseError', message: ERR_RESERVED, length: 129, name: 'error', severity: 'FATAL', code: '53300', file: 'postinit.c', line: '949', routine: 'InitPostgres' }
    : { type: 'DatabaseError', message: ERR_TOO_MANY, length: 85, name: 'error', severity: 'FATAL', code: '53300', file: 'proc.c', line: '359', routine: 'InitProcess' };

const APP_QUERIES = [
  'COMMIT',
  'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)',
  'SELECT c.id, c.email FROM customers c WHERE c.id = $1',
  'INSERT INTO orders (public_id, customer_id, status, total_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING id',
  'INSERT INTO order_items (order_id, sku, quantity, price_cents) VALUES ($1,$2,$3,$4)',
  'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)',
  'UPDATE carts SET updated_at = now() WHERE id = $1',
];

function nodeProcs(masterPid: number, start: string, time: [string, string, string], rss: [number, number, number]): Process[] {
  return [
    { pid: masterPid, user: 'shopfast', cpu: 0.4, mem: 0.8, vszKb: 1_102_412, rssKb: rss[0], stat: 'Ssl', start, time: time[0], command: 'node --max-old-space-size=1536 /opt/checkout-api/dist/server.js' },
    { pid: masterPid + 19, user: 'shopfast', cpu: 31.2, mem: 5.6, vszKb: 11_843_960, rssKb: rss[1], stat: 'Sl', start, time: time[1], command: 'node --max-old-space-size=1536 /opt/checkout-api/dist/server.js' },
    { pid: masterPid + 23, user: 'shopfast', cpu: 29.8, mem: 5.4, vszKb: 11_812_204, rssKb: rss[2], stat: 'Sl', start, time: time[2], command: 'node --max-old-space-size=1536 /opt/checkout-api/dist/server.js' },
  ];
}

const incident: Incident = {
  id: 'db-connection-exhaustion',
  code: 'INC-4203',
  order: 7,
  title: 'Flash sale: "too many clients"',
  teaser: 'The biggest sale of the quarter is live, autoscaling worked — and checkout is failing anyway. The database looks bored.',
  difficulty: 'intermediate',
  tags: ['RDS', 'PostgreSQL', 'Connection pooling', 'Auto Scaling', 'Capacity planning'],
  parMinutes: 15,
  seed: 4203,
  now: '2026-10-03T13:05:00Z',
  briefing: {
    severity: 'SEV1',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-alb-target-5xx-high — HTTPCode_Target_5XX_Count > 50',
      details: 'shopfast-prod-alb targets returned 912 HTTP 5xx in the last minute (threshold 50, 3 of 5 datapoints). Runbook: https://wiki.shopfast.internal/runbooks/checkout-5xx',
      minutesAgo: 20,
    },
    reports: [
      { from: 'Aisha Bello', role: 'Growth Lead', channel: '#incident-4203', message: 'Doorbusters went live at 12:00 and traffic is ~3.5× a normal Saturday — exactly the plan. But for the last 20 minutes conversion has fallen off a cliff and people are posting "Something went wrong" screenshots from the payment step. Every minute of this costs us real money.', minutesAgo: 17 },
      { from: 'Diego Fernández', role: 'Backend Engineer (on-call)', channel: '#incident-4203', message: 'Autoscaling did its job, we are at 9 instances. Logs look DB-ish, but RDS CPU is only ~30% so the database is clearly not the bottleneck? Most of the errors come from the newest instances — maybe the new hosts came up broken?', minutesAgo: 12 },
      { from: 'Tomasz Nowak', role: 'DBA', channel: '#incident-4203', message: 'On my phone at a wedding. psql from the bastion still gets in — ops_readonly goes through the break-glass role that may use the reserved slots — so you can look inside. Reminder: we load-tested this sale in July and were fine at 12 instances.', minutesAgo: 8 },
    ],
    impact: '15–25% of checkout attempts fail with HTTP 500 at the peak of the quarter\'s biggest sale; failures concentrate on the most recently launched instances. Marketing\'s live Metabase dashboard is also flaky.',
    services: ['checkout-api (shopfast-checkout-asg)', 'checkout-db (RDS PostgreSQL)', 'shopfast-prod-alb'],
  },

  build(env) {
    env.traffic.minutes = 90;

    // ---------------- RDS ----------------
    for (const i of env.rds.instances) Object.assign(i, { class: 'db.t4g.medium', vCpu: 2, memoryGb: 4, maxConnections: MAX_CONN });
    env.rds.events.push(
      { minutesAgo: DOWNSIZE + 9, source: 'checkout-db', message: 'Applying modification to database instance class' },
      { minutesAgo: DOWNSIZE + 2, source: 'checkout-db', message: 'Multi-AZ instance failover started.' },
      { minutesAgo: DOWNSIZE + 1, source: 'checkout-db', message: 'DB instance restarted' },
      { minutesAgo: DOWNSIZE + 1, source: 'checkout-db', message: 'Multi-AZ instance failover completed' },
      { minutesAgo: DOWNSIZE, source: 'checkout-db', message: 'Finished applying modification to DB instance class' },
      { minutesAgo: DOWNSIZE - 14, source: 'checkout-db-replica-1', message: 'Applying modification to database instance class' },
      { minutesAgo: DOWNSIZE - 22, source: 'checkout-db-replica-1', message: 'Finished applying modification to DB instance class' },
    );
    env.rds.events.sort((a, b) => b.minutesAgo - a.minutesAgo);

    const db = database(env, 'checkout-db');
    Object.assign(db.settings, {
      max_connections: String(MAX_CONN),
      superuser_reserved_connections: '3',
      shared_buffers: '920MB',
      effective_cache_size: '1840MB',
      work_mem: '4MB',
      maintenance_work_mem: '58MB',
      idle_session_timeout: '0',
    });
    const replica = database(env, 'checkout-db-replica-1');
    replica.settings = { ...db.settings };

    // pg_stat_activity: 405 sessions, almost all idle connections parked in client pools
    const activity: Database['activity'] = [];
    let pid = 21_004;
    const qs = (s: number) => pgTime(env.now - s * 1000);
    const add = (usename: string, application: string, client: string, state: string, waitEvent: string, ageS: number, query: string) => {
      pid += 3 + (pid % 7);
      const dur = state === 'active' ? ageS : 0.0004 + (pid % 37) / 10000;
      activity.push({ pid, usename, application, client, state, waitEvent, queryStart: qs(ageS), duration: `00:00:${dur.toFixed(4).padStart(7, '0')}`, query });
    };
    const appHosts = [...OLD_HOSTS.map(h => ({ ip: hostMeta[h].ip, pool: 42 })), ...NEW_HOSTS.map(h => ({ ip: h.ip, pool: h.pool }))];
    for (const h of appHosts) {
      for (let k = 0; k < h.pool; k++) {
        if (k < 2) {
          add('checkout_app', 'checkout-api-listener', h.ip, 'idle', 'Client: ClientRead', 1500 + k * 7, 'LISTEN price_changes');
          continue;
        }
        const r = hashString(`${h.ip}-${k}`) % 100;
        const state = r < 9 ? 'active' : r < 11 ? 'idle in transaction' : 'idle';
        const q = APP_QUERIES[r % APP_QUERIES.length];
        add('checkout_app', 'checkout-api', h.ip, state, state === 'active' ? (r % 3 ? '' : 'Client: ClientRead') : 'Client: ClientRead', state === 'active' ? 0.002 + (r % 5) / 1000 : 0.05 + (r % 40) / 10, state === 'idle in transaction' ? 'SELECT id, status FROM orders WHERE public_id = $1 FOR UPDATE' : q);
      }
    }
    for (let k = 0; k < 20; k++) add('worker', 'shopfast-worker', WORKER_IP, k % 6 === 0 ? 'active' : 'idle', 'Client: ClientRead', 0.3 + k / 10, 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2');
    for (let k = 0; k < 15; k++)
      add('metabase', 'Metabase v0.50.21 [8f3c2a1e-4b7d-4e2f-9a01-6c5d4e3f2a1b]', METABASE_IP, k % 4 === 0 ? 'active' : 'idle', k % 4 === 0 ? 'IO: DataFileRead' : 'Client: ClientRead', k % 4 === 0 ? 2.1 + k / 10 : 21 + k, `SELECT date_trunc('minute', "public"."orders"."created_at") AS "created_at", sum("public"."orders"."total_cents") AS "sum" FROM "public"."orders" WHERE "public"."orders"."created_at" >= timestamp '2026-10-03 12:00:00' GROUP BY 1 ORDER BY 1`);
    for (let k = 0; k < 3; k++) add('rdsadmin', 'PostgreSQL JDBC Driver', '127.0.0.1', 'idle', 'Client: ClientRead', 3 + k * 11, 'SELECT 1');
    db.activity = activity;

    db.queries.push(
      {
        match: /pg_settings/i,
        output: pgTable(['name', 'setting', 'unit', 'source'], [
          ['max_connections', '405', '', 'configuration file'],
          ['superuser_reserved_connections', '3', '', 'configuration file'],
          ['shared_buffers', '117804', '8kB', 'configuration file'],
          ['work_mem', '4096', 'kB', 'configuration file'],
          ['idle_session_timeout', '0', 'ms', 'default'],
          ['idle_in_transaction_session_timeout', '86400000', 'ms', 'configuration file'],
        ]),
      },
      { match: /current_setting\(\s*'max_connections'\s*\)/i, output: pgTable(['connections', 'max_connections', 'reserved_for_superuser'], [[activity.length, '405', '3']]) },
      { match: /pg_stat_database/i, output: pgTable(['datname', 'numbackends'], [['checkout', activity.length - 3], ['rdsadmin', 3], ['postgres', 0]]) },
      {
        match: /pg_roles|rolconnlimit/i,
        output: pgTable(['rolname', 'rolconnlimit', 'rolsuper'], [['checkout_app', -1, 'f'], ['worker', -1, 'f'], ['metabase', -1, 'f'], ['ops_readonly', 5, 'f'], ['rds_superuser', -1, 'f'], ['rdsadmin', -1, 't']]),
      },
    );

    // RDS PostgreSQL log: FATALs for every refused connection
    const pg = logGroup(env, '/aws/rds/instance/checkout-db/postgresql');
    const refusers = [
      ...NEW_HOSTS.slice(4).flatMap(h => [h.ip, h.ip, h.ip]),
      NEW_HOSTS[2].ip, NEW_HOSTS[3].ip, hostMeta['app-2'].ip, METABASE_IP,
    ];
    pg.events.push(
      ...spread(env, ERRORS, 0.1, 140, (k, ts) => {
        const ip = refusers[(k * 7) % refusers.length];
        const user = ip === METABASE_IP ? 'metabase' : 'checkout_app';
        const reserved = (k * 5) % 11 !== 0;
        return `${pgTime(ts)}:${ip}(${40_000 + ((k * 3571) % 25_000)}):${user}@checkout:[${28_100 + k * 13}]:FATAL:  ${reserved ? ERR_RESERVED : ERR_TOO_MANY}`;
      }),
      ...spread(env, 64, 30, 4, (k, ts) => `${pgTime(ts)}::@:[612]:LOG:  checkpoint complete: wrote ${2810 + k * 211} buffers (2.4%); 0 WAL file(s) added, 0 removed, 2 recycled; write=26.981 s, sync=0.006 s, total=27.014 s; sync files=58, longest=0.003 s, average=0.001 s; distance=48211 kB, estimate=50120 kB`),
    );

    // ---------------- Hosts ----------------
    for (const [i, h] of OLD_HOSTS.entries()) {
      const hh = host(env, h);
      const master = 2841 + i * 17;
      hh.processes = [...hh.processes.filter(p => !p.command.includes('/opt/checkout-api/')), ...nodeProcs(master, 'Oct02', ['0:41', '96:12', '94:57'], [61_204, 452_118, 441_906])];
      hh.services['checkout-api'].tasks = 41;
      hh.services['checkout-api'].memory = '948.1M';
      hh.cpu = { cores: 2, user: 41.2 + i * 2, system: 6.1, iowait: 0.1, steal: 0, idle: 52.6 - i * 2 };
      hh.load = [1.62 + i * 0.1, 1.71, 1.18];
      hh.sockets.established = 610 + i * 20;
    }
    for (const n of NEW_HOSTS) {
      const launchTs = env.now - n.at * MIN - 22_000;
      const hh: Host = cloneHost(env, 'app-3', n.name, { hostname: n.hostname, ip: n.ip, instanceId: n.id, az: n.az, subnetId: n.subnet, launchTime: isoSec(launchTs) });
      const startTs = launchTs + 71_000;
      const master = 2790 + (hashString(n.name) % 90);
      const short = n.pool < 42;
      hh.uptime = `${n.at} min`;
      hh.processes = [
        ...hh.processes.filter(p => !p.command.includes('/opt/checkout-api/')).map(p => ({ ...p, start: hm(launchTs), time: p.time.replace(/^\d+:/, '0:') })),
        ...nodeProcs(master, hm(startTs), ['0:02', `${Math.round(n.at / 3)}:1${n.at % 10}`, `${Math.round(n.at / 3)}:0${n.at % 7}`], [58_302, 398_110, 391_552]),
      ];
      hh.memory = { totalMb: 7802, usedMb: 1612, freeMb: 5410, buffCacheMb: 780, swapTotalMb: 0, swapUsedMb: 0 };
      hh.cpu = { cores: 2, user: short ? 22.4 : 38.9, system: 5.2, iowait: 0.1, steal: 0, idle: short ? 72.3 : 55.8 };
      hh.load = short ? [0.88, 0.92, 0.61] : [1.51, 1.48, 1.02];
      hh.sockets.established = short ? 420 : 590;
      hh.dmesg = hh.dmesg.slice(0, 7);
      const L = (ts: number, msg: string) => `${syslogTime(ts)} ${n.hostname} ${msg}`;
      const w1 = master + 19;
      const w2 = master + 23;
      const journal = [
        L(startTs - 2000, 'systemd[1]: Starting checkout-api.service - ShopFast checkout API (Node.js)...'),
        L(startTs, 'systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).'),
        L(startTs + 410, `node[${master}]: {"level":30,"msg":"cluster primary ${master} starting 2 workers (WEB_CONCURRENCY=2)"}`),
        L(startTs + 1500, `node[${w1}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`),
        L(startTs + 1560, `node[${w2}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`),
        L(startTs + 1700, `node[${w1}]: {"level":30,"msg":"checkout-api v2.13.1 listening on 127.0.0.1:3000"}`),
      ];
      if (short) {
        for (let k = 0; k < 9; k++) {
          const ts = env.now - (ERRORS - k * 2.4) * MIN;
          const w = k % 2 ? w2 : w1;
          journal.push(
            L(ts, `node[${w}]: {"level":50,"msg":"${k % 3 === 0 ? 'LISTEN price_changes failed, retrying in 5000 ms' : 'pg pool: failed to establish connection'}","err":{"code":"53300","severity":"FATAL","message":"${k % 4 === 3 ? ERR_TOO_MANY : ERR_RESERVED}"}}`),
          );
        }
      }
      Object.assign(hh.services['checkout-api'], {
        since: `${systemdTime(startTs)}; ${Math.round((env.now - startTs) / MIN)}min ago`,
        mainPid: master,
        memory: '851.3M',
        tasks: 41,
        journal,
      });
      for (const k of Object.keys(hh.services)) {
        if (k === 'checkout-api') continue;
        hh.services[k].since = `${systemdTime(launchTs + 9000)}; ${n.at}min ago`;
        hh.services[k].journal = [];
      }
      if (short) {
        env.http.unshift(
          { match: /^https?:\/\/(localhost|127\.0\.0\.1)(:80|:3000)?\/health/, fromHosts: [n.name], behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"status":"ok","version":"2.13.1","db":"degraded","redis":"ok"}', timeMs: 6 },
        );
      }
    }
    // the app's own DB user cannot get in either (from any app host); ops break-glass from the bastion can
    for (const name of [...OLD_HOSTS, ...NEW_HOSTS.map(n => n.name), 'worker-1']) {
      host(env, name).commandOverrides.push({
        match: /^psql\b.*(checkout_app|-U\s*worker)/,
        output: `psql: error: connection to server at "${IDS.rdsEndpoint}" (10.0.20.57), port 5432 failed: FATAL:  ${ERR_RESERVED}`,
      });
    }

    // ---------------- ASG ----------------
    const asg = env.ec2.asgs[0];
    asg.desired = 9;
    asg.min = 3;
    asg.max = 12;
    const alarmName = 'TargetTracking-shopfast-checkout-asg-AlarmHigh-7d1e4f2a-5b6c-4d8e-9f01-a2b3c4d5e6f7';
    const steps: [number, number, number][] = [[SCALE[0], 3, 5], [SCALE[1], 5, 7], [SCALE[2], 7, 9]];
    steps.forEach(([m, from, to], si) => {
      for (const n of NEW_HOSTS.slice(si * 2, si * 2 + 2)) {
        asg.activities.push({
          minutesAgo: m,
          status: 'Successful',
          description: `Launching a new EC2 instance: ${n.id}`,
          cause: `At ${isoSec(env.now - m * MIN - 21_000)} a monitor alarm ${alarmName} in state ALARM triggered policy cpu50-target-tracking changing the desired capacity from ${from} to ${to}. At ${isoSec(env.now - m * MIN)} an instance was started in response to a difference between desired and actual capacity, increasing the capacity from ${from} to ${to}.`,
        });
      }
    });
    asg.activities.sort((a, b) => a.minutesAgo - b.minutesAgo);
    addPanel(env, {
      id: 'asg.inservice', group: 'EC2', namespace: 'AWS/AutoScaling', metric: 'GroupInServiceInstances', resource: 'shopfast-checkout-asg', unit: 'Count', stat: 'Maximum', periodMinutes: 1, featured: true,
      series: [{ name: 'shopfast-checkout-asg', points: series('asg', 3, { noise: 0 }).stepTo(SCALE[0] - 2, 5).stepTo(SCALE[1] - 2, 7).stepTo(SCALE[2] - 2, 9).round(0).build() }],
    });

    // ---------------- Metrics ----------------
    setPoints(env, 'rds.connections', series('conn', 74, { noise: 0.03 }).rampTo(SALE, 164, 6).rampTo(SCALE[0] - 1, 246, 4).rampTo(SCALE[1] - 1, 330, 4).rampTo(SCALE[2] - 1, 404, 3).setNoise(0.006).clamp(0, MAX_CONN).round(0).build());
    panel(env, 'rds.connections').threshold = MAX_CONN;
    setPoints(env, 'rds.cpu', series('dbcpu', 17, { noise: 0.07 }).wave(0.05).rampTo(SALE, 31, 8).clamp(0, 100).build());
    setPoints(env, 'rds.memory', series('dbmem', 74, { noise: 0.03 }).rampTo(SALE, 164, 6).rampTo(SCALE[0] - 1, 246, 4).rampTo(SCALE[1] - 1, 330, 4).rampTo(SCALE[2] - 1, 404, 3).map(c => 1660 - (Math.min(c, 405) - 74) * 1.72).setNoise(0.01).clamp(0).round(0).build());
    setPoints(env, 'rds.readiops', series('riops', 140, { noise: 0.15 }).rampTo(SALE, 380, 8).clamp(0).round(0).build());
    setPoints(env, 'rds.writeiops', series('wiops', 310, { noise: 0.12 }).rampTo(SALE, 1020, 8).clamp(0).round(0).build());
    setPoints(env, 'alb.requests', series('req', 2290, { noise: 0.04 }).rampTo(SALE, 8150, 10).clamp(0).round(0).build());
    setPoints(env, 'alb.target5xx', series('t5xx', 1.2, { noise: 0.25 }).rampTo(ERRORS, 880, 4).clamp(0).round(0).build());
    setPoints(env, 'alb.latency', series('lat', 0.4, { noise: 0.1 }).rampTo(SALE, 0.82, 8).rampTo(ERRORS, 1.46, 4).clamp(0).round(3).build());
    setPoints(env, 'app.checkoutLatency', series('chk', 370, { noise: 0.1 }).rampTo(SALE, 690, 8).rampTo(ERRORS, 1380, 4).clamp(0).round(0).build());
    setPoints(env, 'app.orders', series('orders', 58, { noise: 0.12 }).rampTo(SALE, 212, 10).rampTo(ERRORS, 151, 4).clamp(0).round(0).build());
    for (const [i, h] of OLD_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', series(`appcpu-${h}`, 18 + i, { noise: 0.08 }).rampTo(SALE, 74, 8).rampTo(SCALE[0] - 2, 61, 3).rampTo(SCALE[1] - 2, 52, 3).rampTo(SCALE[2] - 2, 45 + i, 3).clamp(0, 100).build(), h);
    }
    setPoints(env, 'cache.evictions', series('evict', 0.3, { noise: 0.6 }).rampTo(SALE, 44, 10).clamp(0).round(0).build());
    setPoints(env, 'cache.cpu', series('ccpu', 6.5, { noise: 0.1 }).rampTo(SALE, 21, 8).clamp(0).build());
    panel(env, 'cache.evictions').featured = true;
    setAlarm(env, 'checkout-alb-target-5xx-high', 'ALARM', 20);

    // ---------------- Traffic / app logs ----------------
    const launchedAt: Record<string, number> = Object.fromEntries(NEW_HOSTS.map(n => [n.name, n.at]));
    const errRate: Record<string, number> = { 'app-8': 0.14, 'app-9': 0.38, 'app-6': 0.05, 'app-7': 0.04, 'app-4': 0.03, 'app-5': 0.03 };
    env.traffic.profile = (h, m) => {
      if (launchedAt[h] !== undefined && m > launchedAt[h] - 1.5) return { rpm: 0 };
      const sale = m <= SALE;
      const failing = m <= ERRORS;
      return {
        rpm: sale ? 10 : 7,
        p50Ms: failing ? 120 : sale ? 74 : 42,
        ...(failing
          ? { errorRate: errRate[h] ?? 0.015, errorStatus: 500, errorMsg: ERR_RESERVED, errorExtra: { err: pgErr(Math.floor(m) % 4 !== 0), route: 'POST /api/v1/checkout' } }
          : {}),
      };
    };
    for (const n of NEW_HOSTS.filter(x => x.pool < 42)) {
      const lines: LogEvent[] = spread(env, ERRORS + 0.5, 0.3, 26, (k, ts) =>
        JSON.stringify({ level: 50, time: new Date(ts).toISOString(), pid: 2790 + (hashString(n.name) % 90) + (k % 2 ? 23 : 19), hostname: n.hostname, msg: k % 5 === 0 ? 'LISTEN price_changes failed, retrying in 5000 ms' : 'pg pool: failed to establish connection', pool: { total: k % 2 ? 15 : 16, idle: 0, waiting: 3 + (k % 9) }, err: pgErr(k % 4 !== 3) }),
      );
      injectLog(env, n.name, '/var/log/checkout-api/app.log', lines);
    }

    env.rds.topSql['checkout-db'] = env.rds.topSql['checkout-db'].map(q => ({ ...q, calls: Math.round(q.calls * 3.4), loadAas: Math.round(q.loadAas * 3.9 * 100) / 100 }));

    // ---------------- Changes ----------------
    env.changes.unshift(
      {
        id: 'chg-8702',
        minutesAgo: DOWNSIZE,
        kind: 'infra',
        service: 'checkout-db',
        title: 'terraform: right-size checkout-db + replica r6g.large → t4g.medium (FinOps Q4 savings)',
        author: 'terraform-ci (PR #1131, ben.adeyemi)',
        status: 'succeeded',
        description: '30-day review: CPU p95 21%, FreeableMemory never below 11 GiB → db.r6g.large is oversized. Saves ~$310/month. Applied in the Saturday 03:00 maintenance window; Multi-AZ failover took 41 s. Parameter group shopfast-pg15 unchanged (formula defaults).',
        diff: `diff --git a/rds/checkout-db.tf b/rds/checkout-db.tf
--- a/rds/checkout-db.tf
+++ b/rds/checkout-db.tf
@@ -3,7 +3,7 @@ resource "aws_db_instance" "checkout_db" {
   identifier              = "checkout-db"
   engine                  = "postgres"
   engine_version          = "15.7"
-  instance_class          = "db.r6g.large"
+  instance_class          = "db.t4g.medium" # FinOps-311: CPU p95 21%, 11+ GiB free
   allocated_storage       = 400
   storage_type            = "gp3"
   multi_az                = true
   parameter_group_name    = "shopfast-pg15"
@@ -41,7 +41,7 @@ resource "aws_db_instance" "checkout_db_replica_1" {
   identifier              = "checkout-db-replica-1"
   replicate_source_db     = aws_db_instance.checkout_db.identifier
-  instance_class          = "db.r6g.large"
+  instance_class          = "db.t4g.medium"
   parameter_group_name    = "shopfast-pg15"`,
      },
      {
        id: 'chg-8941',
        minutesAgo: 2 * 1440 + 310,
        kind: 'infra',
        service: 'shopfast-checkout-asg',
        title: 'ASG max size 6 → 12 for Saturday "Doorbusters" sale',
        author: 'terraform-ci (PR #1188, diego.fernandez)',
        status: 'succeeded',
        description: 'Load test LT-0712 (July) sustained 4× normal traffic at 12 instances with p99 < 900 ms. Target tracking policy cpu50-target-tracking unchanged (CPU 50%).',
      },
      {
        id: 'chg-8966',
        minutesAgo: SALE + 1,
        kind: 'config',
        service: 'marketing',
        title: 'Flash sale "Saturday Doorbusters" live — 40% off electronics',
        author: 'growth-team',
        status: 'succeeded',
        description: 'Push + email to 2.4M users at 12:00. Expected 3–4× normal traffic 12:00–14:00. Live Metabase dashboard "Doorbusters — live" shared with the growth team (auto-refresh 30 s).',
      },
    );
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'too-many-clients',
      label: 'PostgreSQL refuses new connections: FATAL 53300 "remaining connection slots are reserved…" / "too many clients"',
      kind: 'key',
      match: /remaining connection slots are reserved for non-replication superuser connections|sorry, too many clients already/,
      foundBy: { tool: 'logs', group: '/aws/rds/instance/checkout-db/postgresql' },
      explanation: 'SQLSTATE 53300 (too_many_connections) is Postgres saying "I am at max_connections". The query workload is fine; the server simply has no free backend slot for a new session.',
    },
    {
      id: 'max-conn-405',
      label: 'checkout-db is a db.t4g.medium (4 GiB) with max_connections 405',
      kind: 'key',
      match: /db\.t4g\.medium[^\n]*max_connections 405|max_connections\s*\n-+\n\s*405/,
      foundBy: { tool: 'rds' },
      explanation: 'On RDS, max_connections defaults to LEAST(DBInstanceClassMemory/9531392, 5000). 16 GiB gave 1708; 4 GiB gives ~405. The limit is a function of the instance class.',
    },
    {
      id: 'downsize',
      label: 'Three weeks ago checkout-db was downsized from db.r6g.large to db.t4g.medium',
      kind: 'key',
      match: /instance_class\s*=\s*"db\.t4g\.medium"/,
      foundBy: { tool: 'deploys' },
      explanation: 'The FinOps review looked at CPU and memory, not connections. Nothing broke for three weeks because 3 hosts × 2 workers × 21 connections ≈ 126 fit easily; the cut in max_connections from 1708 to 405 waited for the first big scale-out.',
    },
    {
      id: 'scale-out',
      label: 'The sale made the ASG scale from 3 to 9 instances',
      kind: 'key',
      match: /desired capacity from 7 to 9|desired 9, min 3/,
      foundBy: { tool: 'ec2' },
      explanation: 'Every new instance brings 2 workers × (20 pool + 1 LISTEN) = 42 connections. 9 × 42 = 378, plus worker-1 (20), Metabase (15) and rdsadmin (3) = 416 wanted vs. 405 allowed. Autoscaling the app multiplied the database connections.',
    },
    {
      id: 'conn-flatline',
      label: 'DatabaseConnections climbs in steps with each scale-out and flat-lines at ~402–405',
      kind: 'supporting',
      match: /DatabaseConnections \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.connections' },
      explanation: 'Each step lines up with an Auto Scaling activity; the flat top is the ceiling, not the demand.',
    },
    {
      id: 'idle-pools',
      label: 'pg_stat_activity: ~90% of the 405 sessions are idle — held open by client pools',
      kind: 'supporting',
      match: /^\s*idle\s*\|\s*3\d\d\s*$/m,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', 'SELECT state, count(*) FROM pg_stat_activity GROUP BY state;'] },
      explanation: 'The database is not busy — it is full. Idle pooled connections each cost a Postgres backend process and memory, but do no work. Only a few dozen queries are actually active at any moment.',
    },
    {
      id: 'pool-math',
      label: 'Each host: WEB_CONCURRENCY=2, DB_POOL_MAX=20 (plus one LISTEN connection per worker)',
      kind: 'supporting',
      match: /^DB_POOL_MAX=20$/,
      foundBy: { tool: 'terminal', host: 'app-9', command: 'cat /etc/checkout-api/env' },
      explanation: 'The inputs to the connection math. Per-process pool limits are invisible to the database: the total is pool × processes × instances, and only the last factor changes during a scale-out.',
    },
    {
      id: 'db-cpu',
      label: 'checkout-db CPU is only ~30%',
      kind: 'red-herring',
      match: /CPUUtilization \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.cpu' },
      explanation: 'True — and it is why "the database is fine" is a trap. Connection limits are a separate resource from CPU: a database can refuse connections while mostly idle.',
    },
    {
      id: 'redis',
      label: 'ElastiCache evictions and engine CPU rose with the sale',
      kind: 'red-herring',
      match: /Evictions \[checkout-cache-001\]|EngineCPUUtilization \[checkout-cache-001\]/,
      foundBy: { tool: 'cloudwatch', panel: 'cache.evictions' },
      explanation: 'Expected under 3.5× traffic, and the cache hit rate is unchanged. Redis has nothing to do with Postgres refusing connections.',
    },
  ],

  rootCauses: [
    { id: 'rc-maxconn', correct: true, text: 'The 3-week-old downsize to db.t4g.medium cut max_connections to ~405; scaling 3→9 hosts × 2 workers × 21 connections plus other clients now exceeds it, so new sessions get 53300.', explanation: 'Every piece lines up: 53300 errors, 405 sessions mostly idle, the limit derived from a 4 GiB instance class, and connection steps matching each scale-out activity.' },
    { id: 'rc-limit', partial: true, text: "checkout-db's max_connections of 405 is too low for the number of checkout-api processes running during the sale, so new pool connections are rejected with SQLSTATE 53300.", explanation: 'Correct symptom-level diagnosis, but it misses why the limit is 405 (the instance downsizing changed the formula) and why demand jumped (autoscaling multiplies pools) — both needed to fix it durably.' },
    { id: 'rc-cpu', text: 'checkout-db (2 vCPU) cannot keep up with the 3.5× sale query volume; queries queue inside the pools until acquisition times out and node-postgres turns it into a 500.', explanation: 'DB CPU is ~30% and queries are fast; the error is a FATAL at connection time, not a timeout while waiting for a pooled client.' },
    { id: 'rc-leak', text: 'checkout-api leaks pg clients: code paths that throw before client.release() keep connections checked out, so pg_stat_activity fills with abandoned sessions until the limit.', explanation: 'Leaked clients would be stuck "idle in transaction" or grow without bound per process. Here every host holds exactly 42 or fewer — pools at their configured maximum, not leaks.' },
    { id: 'rc-launch', text: 'Instances from the scale-out (app-4..app-9) boot without the RDS CA bundle, so TLS to checkout-db (rds.force_ssl=1) fails intermittently on the new hosts under load.', explanation: 'Same AMI and launch template as app-1..3, the new hosts do hold dozens of connections, and a TLS failure would not produce a Postgres 53300 error. They fail more because they arrived last, after the slots were gone.' },
    { id: 'rc-redis', text: 'ElastiCache evictions (~45/min) during the sale empty the product cache, sending ~3× more reads to checkout-db and saturating its connection slots with cache-miss queries.', explanation: 'Hit rate is steady at ~94% and the connections are idle, not busy with reads. More queries do not need more connections when pools are capped.' },
  ],

  fixes: [
    { id: 'fx-proxy', kind: 'correct', text: 'Put RDS Proxy (or PgBouncer in transaction mode) in front of checkout-db so every host\'s pools are multiplexed onto a bounded set of server connections.', explanation: 'A proxy decouples "number of app processes" from "number of Postgres backends": hundreds of client connections share a few dozen server connections, because most client connections are idle at any instant.' },
    { id: 'fx-math', kind: 'correct', text: 'Size it on purpose: smaller DB_POOL_MAX, an ASG max that keeps max hosts × 2 × (pool+1) + other clients under ~80% of max_connections, and an alarm at 80%.', explanation: 'Connection capacity is a budget. Choose the instance class (or an explicit max_connections that its memory supports) and the pool sizes together, and alert before the ceiling — DatabaseConnections had been climbing for 40 minutes.' },
    { id: 'fx-scaleup', kind: 'partial', text: 'Modify checkout-db back to db.r6g.large (max_connections 1708) now, accepting a ~60 s Multi-AZ failover in the middle of the sale.', explanation: 'Restores headroom quickly and is a reasonable mitigation, but costs a failover blip and leaves the multiplication problem in place: the next bigger scale-out hits the wall again.' },
    { id: 'fx-capasg', kind: 'partial', text: 'Temporarily cap the ASG at 7 instances and suspend scale-out so connection demand drops below 405, accepting higher CPU on the remaining hosts.', explanation: 'Stops the errors within minutes (7 × 42 + 38 ≈ 332), but limits sale capacity and is only a stopgap.' },
    { id: 'fx-5000', kind: 'harmful', text: 'Set max_connections=5000 in parameter group shopfast-pg15 and reboot checkout-db during the sale so every new app host can open its full 42-connection pool.', explanation: 'Each Postgres connection is a process with its own memory (plus work_mem per sort/hash). 5000 backends on 4 GiB will exhaust memory — the instance swaps or the engine gets OOM-killed and restarts — and the static parameter needs a reboot mid-sale.' },
    { id: 'fx-pool50', kind: 'harmful', text: 'Raise DB_POOL_MAX from 20 to 50 on all hosts so each worker keeps spare connections and requests stop failing when one cannot be acquired quickly.', explanation: 'Increases demand per process 2.5× against the same 405 slots: more hosts get locked out and idle connections multiply.' },
    { id: 'fx-restart', kind: 'neutral', text: 'Rolling-restart checkout-api on app-1..app-9 so the pools reconnect cleanly and release any stuck or half-open PostgreSQL sessions.', explanation: 'Pools reconnect to the same limit in seconds; whoever restarts last loses. Restarting mid-sale also drops in-flight checkouts.' },
    { id: 'fx-redis', kind: 'neutral', text: 'Scale ElastiCache checkout-cache up one node size (cache.r6g.large → xlarge) to stop evictions and take read load off checkout-db during the sale.', explanation: 'Redis is not the constraint; the database is refusing connections, not struggling with reads.' },
  ],

  hints: [
    'Read the exact error text in the app or RDS logs. Then compare how many connections checkout-db allows with how many are open right now.',
    'Where does max_connections on RDS come from, and has anything changed checkout-db\'s instance class recently? Check the RDS console, RDS events and Deploys & changes.',
    'Do the math: instances × WEB_CONCURRENCY × (DB_POOL_MAX + 1 listener) + other clients. How many instances does the ASG have now, and how many did it have before 12:00?',
  ],

  debrief: {
    summary: `Three weeks ago a FinOps review downsized **checkout-db** from \`db.r6g.large\` (16 GiB) to \`db.t4g.medium\` (4 GiB) because CPU and memory were under-used. Nobody looked at connections: on RDS, \`max_connections\` defaults to \`LEAST(DBInstanceClassMemory/9531392, 5000)\`, so the limit silently fell from **1708 to ~405**. On a normal day three app hosts hold ~126 connections, so nothing happened.

At 12:00 the flash sale started. Target tracking (CPU 50%) scaled the ASG **3 → 5 → 7 → 9**. Every instance runs 2 Node workers, each with a node-postgres pool of 20 plus one dedicated \`LISTEN\` connection: 42 per host. 9 × 42 = 378, plus the order worker (20), marketing's live Metabase dashboard (15) and RDS's own sessions — more than 405. From 12:43 every new connection attempt got \`FATAL: remaining connection slots are reserved for non-replication superuser connections\` or \`sorry, too many clients already\` (SQLSTATE 53300). The newest instances suffered most because they arrived after the slots were gone.

The database itself was relaxed — ~30% CPU, ~90% of sessions idle in pools — which is exactly why "RDS looks fine" misled the on-call. Autoscaling the stateless tier multiplied a stateful resource. The fix is to bound and share connections (RDS Proxy/PgBouncer, smaller pools, ASG max that fits) and to size the database with connections as a first-class capacity dimension.`,
    timeline: [
      { minutesAgo: DOWNSIZE, event: 'checkout-db + replica downsized to db.t4g.medium (max_connections 1708 → ~405)' },
      { minutesAgo: 2 * 1440 + 310, event: 'ASG max raised to 12 for the sale, based on a July load test (on the old r6g.large)' },
      { minutesAgo: SALE, event: 'Flash sale goes live; traffic 3.5×; DB connections ~164' },
      { minutesAgo: SCALE[0], event: 'ASG 3 → 5 (app-4, app-5); connections ~246' },
      { minutesAgo: SCALE[1], event: 'ASG 5 → 7 (app-6, app-7); connections ~330' },
      { minutesAgo: SCALE[2], event: 'ASG 7 → 9 (app-8, app-9); connections hit the ~405 ceiling' },
      { minutesAgo: ERRORS, event: 'First FATAL 53300 errors; checkout 500s climb' },
      { minutesAgo: 20, event: 'checkout-alb-target-5xx-high pages on-call' },
    ],
    concepts: [
      { title: 'A PostgreSQL connection is a process', body: 'Postgres forks one backend process per connection. Each holds private memory (catalog caches, buffers — several MB, more with `work_mem` for sorts and hashes) even when idle, plus a slot in shared structures sized by `max_connections`. That is why the limit exists and why it scales with RAM. When all non-reserved slots are taken, new sessions get SQLSTATE 53300; `superuser_reserved_connections` keeps a few for administrators.' },
      { title: 'How RDS sets max_connections', body: 'RDS parameter groups use formulas: for PostgreSQL the default is `LEAST({DBInstanceClassMemory/9531392}, 5000)`. DBInstanceClassMemory is the memory available to the engine (a bit less than the instance\'s RAM), so a 16 GiB class gives ~1700 and a 4 GiB class ~400. Changing the instance class therefore changes your connection limit even though you never touched a parameter.' },
      { title: 'Pool sizing math and why autoscaling multiplies it', body: 'Client-side pools cap connections per process, not in total. Total = instances × processes per instance × (pool size + dedicated connections) + every other client. Horizontal autoscaling of the app multiplies the first factor, so a database that is fine at 3 hosts can be exhausted at 9 without a single query getting slower. Size pools from the database\'s budget downward, not from the app upward.' },
      { title: 'RDS Proxy and PgBouncer', body: 'A connection pooler in front of the database lets many client connections share a small number of server connections. In transaction pooling mode a server connection is borrowed only for the duration of a transaction, so 400 mostly-idle client connections might need only 30–50 backends. RDS Proxy is the managed option (also smooths failovers); PgBouncer is the classic self-hosted one. Session features like `LISTEN`, session-level `SET` or advisory locks need care in transaction mode.' },
      { title: 'Idle connections are not free', body: 'In `pg_stat_activity`, `state = idle` means a connection is open but not running anything — typically parked in an application pool. Hundreds of idle sessions mean the bottleneck is the number of slots, not CPU. Settings like `idle_session_timeout` and pool `idleTimeoutMillis` reclaim them, but under sustained load pools stay full by design.' },
    ],
    commands: [
      { cmd: 'SHOW max_connections;', why: 'The ceiling for this instance' },
      { cmd: 'SELECT state, count(*) FROM pg_stat_activity GROUP BY state;', why: 'How many sessions are actually doing work vs. sitting idle in pools' },
      { cmd: 'SELECT client_addr, count(*) FROM pg_stat_activity GROUP BY client_addr;', why: 'Which hosts hold the connections — reveals per-host pool totals' },
      { cmd: 'SELECT application_name, count(*) FROM pg_stat_activity GROUP BY application_name;', why: 'Which applications (app, listener, worker, BI) use the budget' },
      { cmd: 'aws autoscaling describe-scaling-activities --auto-scaling-group-name shopfast-checkout-asg', why: 'When and why the ASG added instances' },
      { cmd: 'aws rds describe-events --source-identifier checkout-db --source-type db-instance --duration 43200', why: 'Recent modifications of the instance (class changes, failovers)' },
    ],
    prevention: [
      'Treat database connections as a capacity budget: document hosts × workers × pool + other clients against max_connections, and keep it under ~80% at ASG max.',
      'Alarm on DatabaseConnections at 80% of max_connections (the limit is known per instance class).',
      'Put RDS Proxy or PgBouncer between autoscaled services and Postgres.',
      'Include connection counts (peak and at ASG max) in any right-sizing review, and re-run load tests after infrastructure changes — the July load test was done on the old instance class.',
      'Give BI tools and background jobs their own small, explicit connection limits (ALTER ROLE … CONNECTION LIMIT) so they cannot starve checkout.',
    ],
    reading: [
      { title: 'Amazon RDS: maximum number of database connections', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Limits.html#RDS_Limits.MaxConnections' },
      { title: 'Amazon RDS Proxy', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html' },
      { title: 'PostgreSQL: connection settings (max_connections, superuser_reserved_connections)', url: 'https://www.postgresql.org/docs/15/runtime-config-connection.html' },
      { title: 'node-postgres: pooling', url: 'https://node-postgres.com/features/pooling' },
    ],
  },
};

export default incident;
