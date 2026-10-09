import type { Database, Incident } from '../engine/types';
import { createRng } from '../engine/rng';
import { MIN, iso, nginxErrTime, pgTime, syslogTime } from '../engine/time';
import { pgTable } from '../engine/terminal/psql';
import { addPanel, database, ev, host, injectLog, logGroup, panel, setAlarm, setPoints, spread } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4312 — checkout-db was restored (PITR) nine days ago onto gp2 200 GiB storage.
 * gp2 = 3 IOPS/GiB baseline (600) with bursts to 3000 IOPS paid from a 5.4M I/O credit
 * bucket. The nightly full finance export (cron 01:00 on worker-1) runs at the burst
 * ceiling, empties the bucket after ~37 min and from then on the whole database is
 * throttled to 600 IOPS until the export finishes around 05:50.
 */

const NOW_ISO = '2026-10-09T02:40:00Z';
const NOW = Date.parse(NOW_ISO);

const JOB_START = 100; // 01:00 UTC
const DRAINED = 62; // ~01:38 UTC — BurstBalance hits 0
const RESTORE = 12318; // 2026-09-30 13:22 UTC
const TF_IMPORT = 11940; // 2026-09-30 19:40 UTC

const BASELINE_IOPS = 600; // gp2: 3 IOPS/GiB × 200 GiB
const BURST_IOPS = 3000;
const BUCKET = 5_400_000;
const JOB_IOS = 11_500_000; // I/Os the full export needs (model only)
const TOTAL_ROWS = 38_093_782;

const EXPORT_CMD = '/opt/shopfast-worker/bin/export-orders --full --since=1970-01-01';
const EXPORT_SQL =
  "COPY (SELECT o.id, o.public_id, o.customer_id, o.status, o.total_cents, o.currency, o.created_at, oi.sku, oi.quantity, oi.price_cents, p.provider_ref, p.status AS payment_status, p.amount_cents FROM orders o JOIN order_items oi ON oi.order_id = o.id LEFT JOIN payments p ON p.order_id = o.id WHERE o.created_at >= '1970-01-01') TO STDOUT WITH (FORMAT csv, HEADER true)";

const Q = {
  ordersSel: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT $3',
  ordersIns: 'INSERT INTO orders (public_id, customer_id, status, total_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING id',
  itemsIns: 'INSERT INTO order_items (order_id, sku, quantity, price_cents) VALUES ($1,$2,$3,$4)',
  products: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)',
  ordersUpd: 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2',
  payments: 'SELECT * FROM payments WHERE order_id = $1',
  customer: 'SELECT c.id, c.email FROM customers c WHERE c.id = $1',
};

/* ------------------------------------------------------------------ */
/* Storage model: one simulation drives every metric so they agree.    */
/* ------------------------------------------------------------------ */

interface Pt {
  r: number; // ReadIOPS
  w: number; // WriteIOPS
  bal: number; // BurstBalance %
  rl: number; // ReadLatency ms
  wl: number; // WriteLatency ms
  q: number; // DiskQueueDepth
  cpu: number;
  conn: number;
  chk: number; // CheckoutLatency p99 ms
  alb: number; // TargetResponseTime p99 s
  done: number; // tonight's export progress 0..1
}

const SIM_START = 5 * 1440;

function simulate(): { pts: Pt[]; jobEnds: number[] } {
  const rng = createRng(4312);
  const n = (a: number) => 1 + (rng() * 2 - 1) * a;
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  let credits = BUCKET;
  let jobLeft = 0;
  const pts: Pt[] = new Array(SIM_START + 1);
  const jobEnds: number[] = [];
  for (let m = SIM_START; m >= 0; m--) {
    const t = NOW - m * MIN;
    const mod = Math.floor(t / MIN) % 1440;
    const h = mod / 60;
    const f = 0.65 + 0.35 * Math.cos((2 * Math.PI * (h - 19.5)) / 24); // diurnal traffic factor
    const appR = 230 * f * n(0.08);
    const appW = 280 * f * n(0.08);
    if (mod === 60) jobLeft = JOB_IOS;
    const running = jobLeft > 0;
    let r: number;
    let w: number;
    let jobGets = 0;
    let phase: 'idle' | 'burst' | 'throttled' = 'idle';
    if (running && credits > 0) {
      phase = 'burst';
      w = appW;
      r = (BURST_IOPS - w) * n(0.01);
      jobGets = BURST_IOPS - appR - appW;
    } else if (running) {
      phase = 'throttled';
      w = 70 * n(0.12);
      r = BASELINE_IOPS - w - rng() * 18;
      jobGets = 360;
    } else {
      r = appR;
      w = appW;
    }
    // while throttled every earned credit is spent immediately: the bucket stays empty
    credits = phase === 'throttled' ? 0 : Math.min(BUCKET, Math.max(0, credits + (BASELINE_IOPS - (r + w)) * 60));
    if (running) {
      jobLeft -= jobGets * 60;
      if (jobLeft <= 0) jobEnds.push(m);
    }
    let p: Omit<Pt, 'r' | 'w' | 'bal' | 'done'>;
    if (phase === 'burst') {
      p = { q: 5.4 * n(0.12), rl: 1.8 * n(0.1), wl: 2.3 * n(0.1), cpu: 27 * n(0.06), conn: 66 * n(0.05), chk: 540 * n(0.12), alb: 0.58 * n(0.1) };
    } else if (phase === 'throttled') {
      const q = (52 + 14 * Math.sin(m / 9)) * n(0.1);
      const rl = (q / BASELINE_IOPS) * 1000 * n(0.08);
      const chk = (14500 + 3500 * Math.sin(m / 6)) * n(0.1);
      p = { q, rl, wl: rl * 0.85 * n(0.08), cpu: 15.5 * n(0.08), conn: 128 * n(0.04), chk, alb: (chk / 1000) * 0.92 };
    } else {
      p = { q: (0.25 + 0.35 * f) * n(0.25), rl: (0.6 + 0.35 * f) * n(0.12), wl: (1.0 + 0.4 * f) * n(0.12), cpu: (11 + 13 * f) * n(0.08), conn: (38 + 30 * f) * n(0.05), chk: (300 + 120 * f) * n(0.1), alb: (0.3 + 0.14 * f) * n(0.1) };
    }
    pts[m] = {
      r: Math.round(r),
      w: Math.round(w),
      bal: r1((credits / BUCKET) * 100),
      rl: r2(p.rl),
      wl: r2(p.wl),
      q: r2(p.q),
      cpu: r1(p.cpu),
      conn: Math.round(p.conn),
      chk: Math.round(p.chk),
      alb: Math.round(p.alb * 1000) / 1000,
      done: running ? 1 - Math.max(0, jobLeft) / JOB_IOS : 0,
    };
  }
  return { pts, jobEnds };
}

const SIM = simulate();
const last3h = (k: keyof Pt) => Array.from({ length: 180 }, (_, i) => SIM.pts[179 - i][k]);
const last3d = (k: keyof Pt, dec = 1) =>
  Array.from({ length: 288 }, (_, i) => {
    const m = (287 - i) * 15;
    let s = 0;
    for (let j = 0; j < 15; j++) s += SIM.pts[m + j][k];
    const f = 10 ** dec;
    return Math.round((s / 15) * f) / f;
  });

/* ------------------------------------------------------------------ */

const fmtInt = (v: number) => v.toLocaleString('en-US');
const dur = (sec: number) => {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${h ? h + 'h' : ''}${m}m${s}s`;
};

function exportLog(): { ts: number; msg: string }[] {
  const out: { ts: number; msg: string }[] = [];
  // nightly history: Sep 26 .. Oct 8 (dt = the night the job ran, 01:00 UTC)
  const nights: { month: number; day: number; secs: number; rows: number }[] = [
    { month: 8, day: 26, secs: 4194, rows: 37_521_904 },
    { month: 8, day: 27, secs: 4211, rows: 37_566_330 },
    { month: 8, day: 28, secs: 4240, rows: 37_612_418 },
    { month: 8, day: 29, secs: 4229, rows: 37_655_019 },
    { month: 8, day: 30, secs: 4262, rows: 37_701_377 },
    { month: 9, day: 1, secs: 17_402, rows: 37_742_160 },
    { month: 9, day: 2, secs: 17_455, rows: 37_788_902 },
    { month: 9, day: 3, secs: 17_431, rows: 37_830_455 },
    { month: 9, day: 4, secs: 17_498, rows: 37_871_221 },
  ];
  // the last four nights come straight from the storage model
  const simNights = SIM.jobEnds.slice(-4);
  simNights.forEach((endAgo, i) => {
    const d = new Date(NOW - endAgo * MIN);
    const startTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 1, 0, 0);
    nights.push({ month: d.getUTCMonth(), day: d.getUTCDate(), secs: Math.round((NOW - endAgo * MIN - startTs) / 1000) + 37 + i * 11, rows: 37_912_008 + i * 44_310 });
  });
  for (const nt of nights) {
    const start = Date.UTC(2026, nt.month, nt.day, 1, 0, 0) + 318;
    const dt = `${2026}-${String(nt.month + 1).padStart(2, '0')}-${String(nt.day).padStart(2, '0')}`;
    out.push({ ts: start, msg: `${iso(start)} INFO  export-orders: starting export mode=full since=1970-01-01 db=db.internal.shopfast.io user=finance_export fetch=50000 dest=s3://shopfast-dwh-landing/orders/dt=${dt}/` });
    const end = start + nt.secs * 1000;
    out.push({ ts: end - 2100, msg: `${iso(end - 2100)} INFO  export-orders: export complete rows=${fmtInt(nt.rows)} bytes=11.${(nt.rows % 7) + 1}GiB elapsed=${dur(nt.secs)}` });
    out.push({ ts: end, msg: `${iso(end)} INFO  export-orders: uploaded s3://shopfast-dwh-landing/orders/dt=${dt}/full.csv.gz (multipart, 92 parts)` });
    if (end > Date.UTC(2026, nt.month, nt.day, 5, 0, 0)) {
      out.push({ ts: end + 400, msg: `${iso(end + 400)} WARN  export-orders: finished after the 05:00 UTC SLA — downstream job dwh-load-orders started with stale data (FIN-212)` });
    }
  }
  // tonight, with progress lines
  const start = NOW - JOB_START * MIN + 318;
  out.push({ ts: start, msg: `${iso(start)} INFO  export-orders: starting export mode=full since=1970-01-01 db=db.internal.shopfast.io user=finance_export fetch=50000 dest=s3://shopfast-dwh-landing/orders/dt=2026-10-09/` });
  let prevRows = 0;
  for (let m = JOB_START - 5; m >= 0; m -= 5) {
    const rows = Math.round(SIM.pts[m + 1].done * TOTAL_ROWS); // progress after minute m+1 completed
    const rate = Math.round((rows - prevRows) / 300);
    prevRows = rows;
    const ts = NOW - m * MIN + 902;
    if (ts > NOW) continue;
    out.push({ ts, msg: `${iso(ts)} INFO  export-orders: progress rows=${fmtInt(rows)} rate=${fmtInt(rate)} rows/s elapsed=${dur((JOB_START - m) * 60)}` });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

/* ------------------------------------------------------------------ */

const incident: Incident = {
  id: 'rds-burst-balance',
  code: 'INC-4312',
  order: 11,
  title: 'Checkout crawls every night, then heals itself',
  teaser: '02:40 UTC. Checkout takes 10–20 s for night-time shoppers — again. The database looks bored.',
  difficulty: 'expert',
  tags: ['RDS', 'EBS gp2', 'IOPS', 'Burst credits', 'Batch jobs', 'PostgreSQL'],
  parMinutes: 25,
  seed: 4312,
  now: NOW_ISO,
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-latency-p99-high — CheckoutLatency p99 > 2000 ms',
      details:
        'ShopFast/Checkout CheckoutLatency p99 has been above 2000 ms for 5 consecutive minutes (current 15.4 s). Previous occurrences of this alarm: 2026-10-08 01:41 UTC (auto-resolved 05:56), 2026-10-07 01:39 UTC (auto-resolved 05:53). Runbook: https://wiki.shopfast.internal/runbooks/checkout-latency',
      minutesAgo: 58,
    },
    reports: [
      { from: 'Aiko Tanaka', role: 'Customer Support Lead (APAC)', channel: '#incident-4312', message: 'Singapore and Sydney customers again 🙃 checkout spinner for 10–20 seconds, some double-click and get "order already in progress". Same as yesterday and the day before, roughly the same time.', minutesAgo: 50 },
      { from: 'Marco Bianchi', role: 'SRE on-call (EU night shift)', channel: '#incident-4312', message: "Honestly this has paged every night for about a week, somewhere between 01:30 and 02:00 UTC, and it's gone by the time the US wakes up — I've been acking it. DB CPU is ~16%, connections are well under max_connections, no RDS events tonight. I did see a Redis eviction blip and autovacuum chewing on order_items. Could that be it?", minutesAgo: 41 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4312', message: "Please actually root-cause it this time, I don't want a 4th night of this. Possibly unrelated: finance pinged me that the warehouse orders data has been landing late every morning this week.", minutesAgo: 33 },
    ],
    impact: 'Checkout p99 ~15 s (normally ~0.4 s) for night-time shoppers in APAC/EU; ~40% of checkouts abandoned during the slow window. No errors reported by the database.',
    services: ['checkout-api', 'checkout-db (RDS PostgreSQL)', 'shopfast-prod-alb'],
  },

  build(env) {
    const now = env.now;
    const t = (m: number) => pgTime(now - m * MIN);

    /* ---------------- RDS storage: the restore landed on gp2 ---------------- */
    const primary = env.rds.instances.find(i => i.id === 'checkout-db')!;
    primary.storage = { type: 'gp2', sizeGb: 200 };
    const replica = env.rds.instances.find(i => i.id === 'checkout-db-replica-1')!;
    replica.storage = { type: 'gp3', sizeGb: 200, iops: 3000, throughputMBps: 125 };

    env.rds.events.push(
      { minutesAgo: RESTORE + 21, source: 'checkout-db-pitr-0930', message: 'DB instance created' },
      { minutesAgo: RESTORE + 1, source: 'checkout-db-pitr-0930', message: 'Restored from DB instance checkout-db to 2026-09-30 13:05:00.0' },
      { minutesAgo: RESTORE - 6, source: 'checkout-db-old', message: 'Renamed DB instance from checkout-db to checkout-db-old' },
      { minutesAgo: RESTORE - 9, source: 'checkout-db', message: 'Renamed DB instance from checkout-db-pitr-0930 to checkout-db' },
      { minutesAgo: TF_IMPORT - 4, source: 'checkout-db-replica-1', message: 'DB instance created' },
      { minutesAgo: TF_IMPORT - 31, source: 'checkout-db-replica-1', message: 'Replication for the Read Replica resumed' },
      { minutesAgo: RESTORE - 4320 - 35, source: 'checkout-db-old', message: 'DB instance deleted' },
    );

    env.cloudtrail.push(
      {
        minutesAgo: RESTORE + 22,
        eventName: 'RestoreDBInstanceToPointInTime',
        eventSource: 'rds.amazonaws.com',
        user: 'AWSReservedSSO_PowerUser/maria.chen',
        sourceIp: '203.0.113.48',
        resources: 'checkout-db-pitr-0930',
        request: { sourceDBInstanceIdentifier: 'checkout-db', targetDBInstanceIdentifier: 'checkout-db-pitr-0930', restoreTime: 'Sep 30, 2026 1:05:00 PM', dBInstanceClass: 'db.r6g.large', multiAZ: true, storageType: 'gp2', allocatedStorage: 200, dBSubnetGroupName: 'shopfast-db-subnets', vpcSecurityGroupIds: [IDS.dbSg], dBParameterGroupName: 'shopfast-pg15', enablePerformanceInsights: true, deletionProtection: false, copyTagsToSnapshot: true },
      },
      { minutesAgo: RESTORE - 5, eventName: 'ModifyDBInstance', eventSource: 'rds.amazonaws.com', user: 'AWSReservedSSO_PowerUser/maria.chen', sourceIp: '203.0.113.48', resources: 'checkout-db', request: { dBInstanceIdentifier: 'checkout-db', newDBInstanceIdentifier: 'checkout-db-old', applyImmediately: true } },
      { minutesAgo: RESTORE - 8, eventName: 'ModifyDBInstance', eventSource: 'rds.amazonaws.com', user: 'AWSReservedSSO_PowerUser/maria.chen', sourceIp: '203.0.113.48', resources: 'checkout-db-pitr-0930', request: { dBInstanceIdentifier: 'checkout-db-pitr-0930', newDBInstanceIdentifier: 'checkout-db', applyImmediately: true } },
      { minutesAgo: TF_IMPORT - 2, eventName: 'CreateDBInstanceReadReplica', eventSource: 'rds.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'checkout-db-replica-1', request: { dBInstanceIdentifier: 'checkout-db-replica-1', sourceDBInstanceIdentifier: 'checkout-db', dBInstanceClass: 'db.r6g.large', storageType: 'gp3', allocatedStorage: 200, multiAZ: false } },
    );

    /* ---------------- Metrics: tonight (3 h) ---------------- */
    setPoints(env, 'rds.readiops', last3h('r'));
    setPoints(env, 'rds.writeiops', last3h('w'));
    setPoints(env, 'rds.readlatency', last3h('rl'));
    setPoints(env, 'rds.writelatency', last3h('wl'));
    setPoints(env, 'rds.queue', last3h('q'));
    setPoints(env, 'rds.cpu', last3h('cpu'));
    setPoints(env, 'rds.connections', last3h('conn'));
    setPoints(env, 'app.checkoutLatency', last3h('chk'));
    setPoints(env, 'alb.latency', last3h('alb'));
    panel(env, 'rds.queue').threshold = undefined;
    // FreeStorageSpace must fit a 200 GiB volume
    setPoints(env, 'rds.storage', Array.from({ length: 180 }, (_, i) => Math.round((62.4 - i * 0.0009) * 10) / 10));
    addPanel(env, {
      id: 'rds.burstBalance',
      group: 'RDS',
      namespace: 'AWS/RDS',
      metric: 'BurstBalance',
      resource: 'checkout-db',
      unit: '%',
      stat: 'Average',
      periodMinutes: 1,
      featured: true,
      series: [{ name: 'checkout-db', points: last3h('bal') }],
    });
    addPanel(env, {
      id: 'rds.readthroughput',
      group: 'RDS',
      namespace: 'AWS/RDS',
      metric: 'ReadThroughput',
      resource: 'checkout-db',
      unit: 'MB/s',
      stat: 'Average',
      periodMinutes: 1,
      series: [{ name: 'checkout-db', points: last3h('r').map(v => Math.round(v * 0.0262 * 10) / 10) }],
    });

    /* ---------------- Metrics: the last 3 days (15-min) ---------------- */
    const d3 = (id: string, metric: string, unit: string, k: keyof Pt, dec = 1, stat = 'Average', namespace = 'AWS/RDS', resource = 'checkout-db') =>
      addPanel(env, { id, group: 'RDS · last 3 days', namespace, metric, resource, unit, stat, periodMinutes: 15, series: [{ name: resource, points: last3d(k, dec) }] });
    d3('rds.burstBalance.3d', 'BurstBalance', '%', 'bal');
    d3('rds.readiops.3d', 'ReadIOPS', 'Count/Second', 'r', 0);
    d3('rds.readlatency.3d', 'ReadLatency', 'ms', 'rl', 2);
    d3('rds.queue.3d', 'DiskQueueDepth', 'Count', 'q', 2);
    d3('rds.cpu.3d', 'CPUUtilization', '%', 'cpu');
    d3('app.checkoutLatency.3d', 'CheckoutLatency', 'ms', 'chk', 0, 'p99', 'ShopFast/Checkout', 'checkout-api');

    // App tier: idle-ish, waiting on the database
    setPoints(env, 'alb.requests', Array.from({ length: 180 }, (_, i) => Math.round(1480 + 60 * Math.sin(i / 23) + ((i * 7919) % 90))));
    setPoints(env, 'app.orders', Array.from({ length: 180 }, (_, i) => {
      const m = 179 - i;
      return Math.max(0, Math.round((m <= DRAINED ? 19 : 33) + ((i * 31) % 9) - 4));
    }));
    setPoints(env, 'alb.target5xx', Array.from({ length: 180 }, (_, i) => {
      const m = 179 - i;
      return m <= DRAINED - 2 ? 2 + ((i * 13) % 6) : (i * 17) % 7 === 0 ? 1 : 0;
    }));
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', Array.from({ length: 180 }, (_, k) => {
        const m = 179 - k;
        return Math.round(((m <= DRAINED ? 7.5 : 12.5) + i + ((k * 37 + i * 11) % 13) / 6) * 10) / 10;
      }), h);
    }
    // Red herring: a small Redis eviction blip around 01:30
    setPoints(env, 'cache.evictions', Array.from({ length: 180 }, (_, k) => {
      const m = 179 - k;
      return m <= 72 && m >= 66 ? 9 + ((k * 7) % 11) : (k * 13) % 17 === 0 ? 1 : 0;
    }));

    setAlarm(env, 'checkout-latency-p99-high', 'ALARM', 58);
    setAlarm(env, 'checkout-alb-p99-latency-high', 'ALARM', 57);
    setAlarm(env, 'checkout-db-cpu-high', 'OK', 9 * 1440);

    /* ---------------- Traffic & app logs ---------------- */
    env.traffic.minutes = 110;
    env.traffic.profile = (_h, m) =>
      m <= DRAINED - 1
        ? { p50Ms: 2600, errorRate: 0.012, errorStatus: 500, errorMsg: 'timeout exceeded when trying to connect', errorExtra: { pool: { total: 20, idle: 0, waiting: 41 } } }
        : m <= JOB_START
          ? { p50Ms: 58 }
          : {};
    for (const [i, h] of APP_HOSTS.entries()) {
      const meta = hostMeta[h];
      const pid = host(env, h).services['checkout-api'].mainPid ?? 2841;
      const queries = [Q.ordersIns, Q.ordersSel, Q.products, Q.itemsIns, Q.ordersUpd, 'COMMIT'];
      injectLog(
        env,
        h,
        '/var/log/checkout-api/app.log',
        spread(env, DRAINED - 1, 0.3, 34, (k, ts) =>
          JSON.stringify({
            level: 40,
            time: new Date(ts).toISOString(),
            pid,
            hostname: meta.hostname,
            reqId: `req-${(0x7c2e00 + k * 1201 + i * 37).toString(16)}`,
            msg: 'slow query',
            durationMs: 1900 + ((k * 787 + i * 313) % 7400),
            query: queries[(k + i) % queries.length],
            route: queries[(k + i) % queries.length] === Q.ordersSel ? 'GET /api/v1/orders' : queries[(k + i) % queries.length] === Q.products ? 'GET /api/v1/products' : 'POST /api/v1/checkout',
          }),
        ),
      );
      injectLog(env, h, '/var/log/nginx/error.log', spread(env, DRAINED - 4, 1, 5, (k, ts) =>
        `${nginxErrTime(ts)} [error] ${1312 + (k % 2)}#${1312 + (k % 2)}: *${884213 + k * 977 + i * 31} upstream timed out (110: Connection timed out) while reading response header from upstream, client: ${['10.0.0.71', '10.0.1.163', '10.0.0.204'][k % 3]}, server: api.shopfast.io, request: "POST /api/v1/checkout HTTP/1.1", upstream: "http://127.0.0.1:3000/api/v1/checkout", host: "api.shopfast.io"`,
      ));
    }

    /* ---------------- Postgres log ---------------- */
    const pg = logGroup(env, '/aws/rds/instance/checkout-db/postgresql');
    // checkpoints after the drain take much longer to fsync
    pg.events = pg.events
      .filter(e => !e.msg.includes('automatic vacuum of table "checkout.public.order_items"'))
      .map(e => {
        if (!e.msg.includes('checkpoint complete') || e.ts < now - DRAINED * MIN) return e;
        const k = (e.ts / 1000) % 7;
        return { ...e, msg: e.msg.replace('sync=0.004 s', `sync=${(8.4 + k * 1.3).toFixed(3)} s`).replace('longest=0.002 s', `longest=${(2.1 + k * 0.4).toFixed(3)} s`).replace('average=0.001 s', `average=${(0.21 + k * 0.03).toFixed(3)} s`) };
      });
    pg.events.push(
      ev(env, JOB_START - 0.01, `${t(JOB_START - 0.01)}:10.0.11.204(52114):[unknown]@[unknown]:[24410]:LOG:  connection received: host=10.0.11.204 port=52114`),
      ev(env, JOB_START - 0.02, `${t(JOB_START - 0.02)}:10.0.11.204(52114):finance_export@checkout:[24410]:LOG:  connection authorized: user=finance_export database=checkout application_name=export-orders SSL enabled (protocol=TLSv1.3, cipher=TLS_AES_256_GCM_SHA384, bits=256)`),
      ev(env, 96, `${t(96)}::@:[18871]:LOG:  automatic analyze of table "checkout.public.orders" system usage: CPU: user: 1.21 s, system: 0.30 s, elapsed: 3.92 s`),
      ev(env, 70, `${t(70)}::@:[612]:LOG:  checkpoint starting: time`),
      ...spread(env, DRAINED - 1, 0.4, 46, (k, ts) => {
        const q = [Q.ordersIns, Q.ordersSel, Q.itemsIns, Q.products, Q.ordersUpd, Q.payments][k % 6];
        const ip = [hostMeta['app-1'].ip, hostMeta['app-2'].ip, hostMeta['app-3'].ip][k % 3];
        return `${pgTime(ts)}:${ip}(${51200 + k * 13}):checkout_app@checkout:[${18300 + k * 7}]:LOG:  duration: ${(1180 + ((k * 1931) % 8200) + 0.317).toFixed(3)} ms  execute <unnamed>: ${q}`;
      }),
      ...spread(env, DRAINED - 2, 1, 9, (k, ts) =>
        `${pgTime(ts)}:${[hostMeta['app-1'].ip, hostMeta['app-2'].ip, hostMeta['app-3'].ip][k % 3]}(${53300 + k * 17}):checkout_app@checkout:[${19400 + k * 11}]:LOG:  duration: ${(2210 + ((k * 977) % 3900) + 0.442).toFixed(3)} ms  statement: COMMIT`,
      ),
    );

    /* ---------------- Database internals ---------------- */
    const db = database(env, 'checkout-db');
    Object.assign(db.settings, {
      track_io_timing: 'on',
      checkpoint_timeout: '300',
      max_wal_size: '2048MB',
      effective_io_concurrency: '1',
      autovacuum_vacuum_cost_limit: '200',
      shared_buffers: '4006MB',
    });
    const dur2 = (sec: number) => {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${s.toFixed(6).padStart(9, '0')}`;
    };
    const activity: Database['activity'] = [
      { pid: 24410, usename: 'finance_export', application: 'export-orders', client: hostMeta['worker-1'].ip, state: 'active', waitEvent: 'IO: DataFileRead', queryStart: pgTime(now - JOB_START * MIN + 1700), duration: dur2(JOB_START * 60 - 1.7), query: EXPORT_SQL },
      { pid: 25120, usename: '', application: '', client: '', state: 'active', waitEvent: 'IO: DataFileRead', queryStart: pgTime(now - 69 * MIN - 4100), duration: dur2(69 * 60 + 4.1), query: 'autovacuum: VACUUM ANALYZE public.order_items' },
    ];
    const clients = [hostMeta['app-1'].ip, hostMeta['app-2'].ip, hostMeta['app-3'].ip];
    const mix: [string, string][] = [
      [Q.ordersSel, 'IO: DataFileRead'],
      [Q.ordersIns, 'IO: WALSync'],
      [Q.products, 'IO: DataFileRead'],
      [Q.itemsIns, 'IO: WALSync'],
      [Q.ordersSel, 'IO: DataFileRead'],
      [Q.payments, 'IO: DataFileRead'],
      ['COMMIT', 'IO: WALSync'],
      [Q.ordersUpd, 'IO: DataFileRead'],
      [Q.customer, 'IO: DataFileRead'],
      [Q.ordersIns, 'LWLock: WALWrite'],
      [Q.products, 'IO: DataFileRead'],
      [Q.ordersSel, 'IO: DataFileRead'],
    ];
    for (let k = 0; k < 118; k++) {
      const idle = k % 11 === 10;
      const [query, wait] = mix[k % mix.length];
      const secs = idle ? 0.0011 : 0.4 + ((k * 0.733) % 9.1);
      activity.push({
        pid: 18200 + k * 3,
        usename: 'checkout_app',
        application: 'checkout-api',
        client: clients[k % 3],
        state: idle ? 'idle' : 'active',
        waitEvent: idle ? 'Client: ClientRead' : wait,
        queryStart: pgTime(now - secs * 1000),
        duration: dur2(secs),
        query: idle ? 'COMMIT' : query,
      });
    }
    activity.push(
      { pid: 19011, usename: 'worker', application: 'shopfast-worker', client: hostMeta['worker-1'].ip, state: 'active', waitEvent: 'IO: WALSync', queryStart: pgTime(now - 3100), duration: dur2(3.1), query: Q.ordersUpd },
      { pid: 19012, usename: 'worker', application: 'shopfast-worker', client: hostMeta['worker-1'].ip, state: 'idle', waitEvent: 'Client: ClientRead', queryStart: pgTime(now - 9000), duration: dur2(0.0018), query: 'COMMIT' },
      { pid: 20118, usename: 'rdsadmin', application: 'PostgreSQL JDBC Driver', client: '127.0.0.1', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: pgTime(now - 30 * 1000), duration: dur2(0.0004), query: 'SELECT 1' },
    );
    db.activity = activity;

    const actTable = (rows: Database['activity']) =>
      pgTable(
        ['pid', 'usename', 'application_name', 'client_addr', 'state', 'wait_event_type', 'wait_event', 'duration', 'query'],
        rows.map(r => [r.pid, r.usename, r.application, r.client, r.state, r.waitEvent.split(': ')[0] ?? '', r.waitEvent.split(': ')[1] ?? '', r.duration, r.query]),
      );
    db.queries.push(
      { match: /wait_event_type\s*=\s*'io'/i, output: actTable(activity.filter(r => r.waitEvent.startsWith('IO:')).slice(0, 30)) },
      { match: /usename\s*=\s*'finance_export'|application_name\s*=\s*'export-orders'/i, output: actTable(activity.filter(r => r.usename === 'finance_export')) },
      { match: /backend_type|query\s+(i?like)\s+'%autovacuum%'/i, output: actTable(activity.filter(r => r.query.startsWith('autovacuum'))) },
      {
        match: /pg_stat_progress_vacuum/i,
        output: pgTable(['pid', 'relid', 'phase', 'heap_blks_total', 'heap_blks_scanned', 'heap_blks_vacuumed', 'index_vacuum_count'], [[25120, 'order_items', 'scanning heap', 2811204, 1904377, 0, 0]]),
      },
      {
        match: /pg_stat_user_tables/i,
        output: ` relname     | n_live_tup | n_dead_tup | seq_scan |  idx_scan  | last_autovacuum               | last_autoanalyze
-------------+------------+------------+----------+------------+-------------------------------+-------------------------------
 order_items |   21880412 |    4421907 |        9 |  902311871 | 2026-10-08 01:47:12.201+00    | 2026-10-08 01:47:12.884+00
 orders      |    8412339 |      61204 |       11 |  412220913 | 2026-10-07 22:41:03.518+00    | 2026-10-09 01:04:00.512+00
 customers   |    1904221 |       2210 |        2 |  221009221 | 2026-10-07 22:14:51.009+00    | 2026-10-07 22:14:52.102+00
 payments    |    7801233 |       9120 |        9 |  690331002 | 2026-10-08 12:02:19.776+00    | 2026-10-08 12:02:20.004+00
(4 rows)`,
      },
      {
        match: /pg_statio_user_tables/i,
        output: ` relname     | heap_blks_read | heap_blks_hit  | idx_blks_read | idx_blks_hit
-------------+----------------+----------------+---------------+---------------
 order_items |      412880193 |    19044103388 |      21104771 |   88120311402
 orders      |      288104412 |    11203332901 |      14881023 |   61203994018
 payments    |      191220554 |     6610402288 |       9004113 |   30122045019
 customers   |        1204883 |     3302291101 |        442019 |    9921003112
(4 rows)`,
      },
      {
        match: /pg_stat_database/i,
        output: ` datname  | numbackends | xact_commit | blks_read  |   blks_hit   | blk_read_time | blk_write_time |         stats_reset
----------+-------------+-------------+------------+--------------+---------------+----------------+-------------------------------
 checkout |         122 |   418229104 | 1104477120 |  41203399417 |   92210448.12 |     1204413.88 | 2026-09-30 13:31:44.120119+00
(1 row)`,
      },
    );
    db.statements = [
      { query: EXPORT_SQL, calls: 8, totalMs: 8 * 17_491_220.4, meanMs: 17_491_220.4, rows: 303_771_204 },
      { query: Q.ordersSel, calls: 911_204, totalMs: 911_204 * 61.2, meanMs: 61.2, rows: 4_738_260 },
      { query: Q.ordersIns, calls: 188_420, totalMs: 188_420 * 214.6, meanMs: 214.6, rows: 188_420 },
      { query: Q.products, calls: 1_904_331, totalMs: 1_904_331 * 18.3, meanMs: 18.3, rows: 5_712_993 },
      { query: Q.itemsIns, calls: 552_017, totalMs: 552_017 * 96.4, meanMs: 96.4, rows: 552_017 },
      { query: Q.ordersUpd, calls: 377_002, totalMs: 377_002 * 71.9, meanMs: 71.9, rows: 377_002 },
      { query: Q.customer, calls: 1_020_440, totalMs: 1_020_440 * 9.8, meanMs: 9.8, rows: 1_020_440 },
      { query: Q.payments, calls: 318_220, totalMs: 318_220 * 22.7, meanMs: 22.7, rows: 318_220 },
    ];
    db.explains = [
      {
        match: /from\s+orders\s+o\s+join\s+order_items/is,
        output: `                                                              QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------------
 Hash Left Join  (cost=1204118.52..4120983.77 rows=21880412 width=96)
   Hash Cond: (o.id = p.order_id)
   ->  Hash Join  (cost=601222.30..2911204.18 rows=21880412 width=80)
         Hash Cond: (oi.order_id = o.id)
         ->  Seq Scan on order_items oi  (cost=0.00..1104477.12 rows=21880412 width=32)
         ->  Hash  (cost=412220.39..412220.39 rows=8412339 width=56)
               ->  Seq Scan on orders o  (cost=0.00..412220.39 rows=8412339 width=56)
                     Filter: (created_at >= '1970-01-01 00:00:00+00'::timestamp with time zone)
   ->  Hash  (cost=402118.33..402118.33 rows=7801233 width=24)
         ->  Seq Scan on payments p  (cost=0.00..402118.33 rows=7801233 width=24)
 JIT:
   Functions: 21
   Options: Inlining true, Optimization true, Expressions true, Deforming true
(13 rows)

-- (plain EXPLAIN: the export is still running; ANALYZE would read every table again)`,
      },
      {
        match: /from\s+orders.*customer_id/is,
        output: `                                                                  QUERY PLAN
----------------------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=0.56..41.23 rows=20 width=58) (actual time=388.112..1414.902 rows=20 loops=1)
   Buffers: shared hit=7 read=17
   I/O Timings: shared/local read=1413.881
   ->  Index Scan Backward using idx_orders_customer_id_status on orders o  (cost=0.56..203.11 rows=98 width=58) (actual time=388.110..1414.871 rows=20 loops=1)
         Index Cond: ((customer_id = 4412093) AND (status = 'completed'::text))
         Buffers: shared hit=7 read=17
         I/O Timings: shared/local read=1413.881
 Planning:
   Buffers: shared hit=3 read=2
   I/O Timings: shared/local read=171.204
 Planning Time: 171.390 ms
 Execution Time: 1414.977 ms
(12 rows)`,
      },
    ];

    env.rds.topSql['checkout-db'] = [
      { sql: Q.ordersSel, calls: 1210, meanMs: 1712.4, loadAas: 34.2, rowsPerCall: 5.1, waitEvent: 'IO:DataFileRead' },
      { sql: Q.ordersIns, calls: 202, meanMs: 5511.9, loadAas: 18.6, rowsPerCall: 1, waitEvent: 'IO:WALSync' },
      { sql: Q.products, calls: 2410, meanMs: 418.2, loadAas: 16.8, rowsPerCall: 3, waitEvent: 'IO:DataFileRead' },
      { sql: Q.itemsIns, calls: 590, meanMs: 1230.7, loadAas: 12.1, rowsPerCall: 1, waitEvent: 'IO:WALSync' },
      { sql: Q.ordersUpd, calls: 288, meanMs: 1270.3, loadAas: 6.1, rowsPerCall: 1, waitEvent: 'IO:DataFileRead' },
      { sql: EXPORT_SQL, calls: 0, meanMs: 0, loadAas: 1.0, rowsPerCall: 0, waitEvent: 'IO:DataFileRead' },
      { sql: Q.customer, calls: 950, meanMs: 133.1, loadAas: 2.1, rowsPerCall: 1, waitEvent: 'IO:DataFileRead' },
    ];

    /* ---------------- worker-1: the nightly export ---------------- */
    const w = host(env, 'worker-1');
    w.processes.push(
      { pid: 48207, user: 'root', cpu: 0, mem: 0, vszKb: 226128, rssKb: 3412, stat: 'S', start: '01:00', time: '0:00', command: '/usr/sbin/CROND -n' },
      { pid: 48209, user: 'shopfast', cpu: 0, mem: 0, vszKb: 222520, rssKb: 3216, stat: 'Ss', start: '01:00', time: '0:00', command: `/bin/sh -c ${EXPORT_CMD} >> /var/log/shopfast-worker/export-orders.log 2>&1` },
      { pid: 48211, user: 'shopfast', cpu: 4.1, mem: 2.6, vszKb: 1192044, rssKb: 214880, stat: 'Sl', start: '01:00', time: '4:07', command: `/usr/bin/node /opt/shopfast-worker/dist/bin/export-orders.js --full --since=1970-01-01` },
    );
    w.cpu = { cores: 2, user: 3.4, system: 1.2, iowait: 0.2, steal: 0, idle: 95.2 };
    w.load = [0.21, 0.26, 0.31];
    w.sockets.established = 21;
    w.sockets.sample.push(
      { state: 'ESTAB', local: `${w.ip}:52114`, peer: '10.0.20.57:5432', process: 'node', recvQ: 0, sendQ: 0 },
      { state: 'ESTAB', local: `${w.ip}:44190`, peer: '10.0.20.57:5432', process: 'node' },
      { state: 'ESTAB', local: `${w.ip}:39822`, peer: '52.217.105.172:443', process: 'node' },
    );
    w.iostat = [
      `Linux ${w.kernel} (${w.hostname}) \t10/09/2026 \t_x86_64_\t(2 CPU)`,
      '',
      'avg-cpu:  %user   %nice %system %iowait  %steal   %idle',
      '           3.41    0.00    1.22    0.19    0.00   95.18',
      '',
      'Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz  aqu-sz  %util',
      'nvme0n1          0.12      1.94     0.00   0.00    0.48    16.17    9.84    711.20     0.88   8.21    0.92    72.28    0.01   0.88',
    ].join('\n');
    w.du['/var/lib/shopfast-export'] = [['2.9G', '/var/lib/shopfast-export/orders-full-2026-10-09.csv.gz.part'], ['2.9G', '/var/lib/shopfast-export']];
    w.fileMeta['/var/lib/shopfast-export/orders-full-2026-10-09.csv.gz.part'] = { size: 3_112_440_812, mtime: 'Oct  9 02:39' };
    w.files['/etc/cron.d/finance-export'] = `# Nightly full export of orders for the finance data warehouse (FIN-212).
# Owner: data-eng (#finance-data). Lands in s3://shopfast-dwh-landing/orders/ before dwh-load-orders (05:00 UTC).
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=""

0 1 * * * shopfast ${EXPORT_CMD} >> /var/log/shopfast-worker/export-orders.log 2>&1
`;
    w.files['/etc/cron.d/0hourly'] = `# Run the hourly jobs\nSHELL=/bin/bash\nPATH=/sbin:/bin:/usr/sbin:/usr/bin\nMAILTO=root\n01 * * * * root run-parts /etc/cron.hourly\n`;
    w.crontab = `# shopfast-worker housekeeping (managed by ansible, role shopfast-worker)
*/5 * * * * /opt/shopfast-worker/bin/requeue-stuck-orders --older-than=15m >> /var/log/shopfast-worker/requeue.log 2>&1
30 3 * * * /opt/shopfast-worker/bin/cleanup-carts --older-than=30d >> /var/log/shopfast-worker/cleanup-carts.log 2>&1
# finance export lives in /etc/cron.d/finance-export (runs as shopfast)`;
    w.files['/opt/shopfast-worker/bin/export-orders'] = `#!/usr/bin/env bash
# Export orders + items + payments to the finance data warehouse landing bucket.
#   --full           export everything since --since (default: incremental since last watermark)
#   --since=DATE     lower bound for orders.created_at
# Connection settings come from /etc/shopfast-worker/export.env
set -euo pipefail
source /etc/shopfast-worker/export.env
exec /usr/bin/node /opt/shopfast-worker/dist/bin/export-orders.js "$@"
`;
    w.files['/etc/shopfast-worker/export.env'] = `EXPORT_DB_HOST=db.internal.shopfast.io
EXPORT_DB_NAME=checkout
EXPORT_DB_USER=finance_export
EXPORT_FETCH_SIZE=50000
EXPORT_BUCKET=s3://shopfast-dwh-landing/orders/
EXPORT_TMP_DIR=/var/lib/shopfast-export
# TODO(FIN-198): incremental mode needs a watermark table; until then finance asked for --full nightly
`;
    injectLog(env, 'worker-1', '/var/log/shopfast-worker/export-orders.log', exportLog());
    const cronLines: { ts: number; msg: string }[] = [];
    for (let d = 8; d >= 0; d--) {
      const ts = NOW - JOB_START * MIN - d * 1440 * MIN + 1000;
      cronLines.push({ ts, msg: `${syslogTime(ts)} ${w.hostname} CROND[${48207 - d * 311}]: (shopfast) CMD (${EXPORT_CMD} >> /var/log/shopfast-worker/export-orders.log 2>&1)` });
      cronLines.push({ ts: ts + 300_000 * 6, msg: `${syslogTime(ts + 1_800_000)} ${w.hostname} CROND[${48390 - d * 311}]: (shopfast) CMD (/opt/shopfast-worker/bin/requeue-stuck-orders --older-than=15m >> /var/log/shopfast-worker/requeue.log 2>&1)` });
    }
    injectLog(env, 'worker-1', '/var/log/cron', cronLines);
    injectLog(env, 'worker-1', '/var/log/messages', [
      { ts: NOW - JOB_START * MIN + 1000, msg: `${syslogTime(NOW - JOB_START * MIN + 1000)} ${w.hostname} CROND[48207]: (shopfast) CMD (${EXPORT_CMD} >> /var/log/shopfast-worker/export-orders.log 2>&1)` },
    ]);

    /* ---------------- Changes ---------------- */
    env.changes.push(
      {
        id: 'chg-8736',
        minutesAgo: RESTORE,
        kind: 'infra',
        service: 'checkout-db',
        title: 'Emergency point-in-time restore of checkout-db (INC-4288: bad backfill migration)',
        author: 'maria.chen',
        status: 'succeeded',
        description:
          'Restored checkout-db to 2026-09-30 13:05:00 UTC (just before migration 20260930125900_backfill_order_totals overwrote total_cents) as new instance checkout-db-pitr-0930 from the RDS console. Validated row counts and order/payment checksums with finance. Swapped names: checkout-db → checkout-db-old, checkout-db-pitr-0930 → checkout-db (endpoint unchanged, apps reconnected automatically). Old instance kept 72 h for forensics, then deleted with a final snapshot. Write downtime: 14 min.',
      },
      {
        id: 'chg-8741',
        minutesAgo: TF_IMPORT,
        kind: 'infra',
        service: 'checkout-db',
        title: 'terraform: re-import checkout-db after the PITR restore, re-create checkout-db-replica-1',
        author: 'terraform-ci (PR #1204, maria.chen)',
        status: 'succeeded',
        description: 'Imports the restored primary into state and re-creates the read replica from it (the old replica followed checkout-db-old). Plan showed some drift on the primary; suppressed to unblock the replica, follow-up in PLAT-1931.',
        diff: `diff --git a/infra/rds/checkout.tf b/infra/rds/checkout.tf
--- a/infra/rds/checkout.tf
+++ b/infra/rds/checkout.tf
@@ -1,24 +1,33 @@
 resource "aws_db_instance" "checkout" {
   identifier                   = "checkout-db"
   engine                       = "postgres"
   engine_version               = "15.7"
   instance_class               = "db.r6g.large"
   allocated_storage            = 200
   storage_type                 = "gp3"
   multi_az                     = true
   parameter_group_name         = aws_db_parameter_group.pg15.name
   performance_insights_enabled = true
   backup_retention_period      = 14
   deletion_protection          = true
+
+  # Re-imported after the 2026-09-30 PITR restore (INC-4288). The restored
+  # instance shows drift on a few attributes; ignore for now so the replica
+  # can be re-created today. TODO(PLAT-1931): reconcile and remove.
+  lifecycle {
+    ignore_changes = [snapshot_identifier, restore_to_point_in_time, storage_type, iops, storage_throughput]
+  }
 }

 resource "aws_db_instance" "checkout_replica" {
   identifier          = "checkout-db-replica-1"
-  replicate_source_db = "checkout-db"
+  replicate_source_db = aws_db_instance.checkout.identifier
   instance_class      = "db.r6g.large"
   storage_type        = "gp3"
   multi_az            = false
   parameter_group_name = aws_db_parameter_group.pg15.name
 }`,
      },
      {
        id: 'chg-8779',
        minutesAgo: 2 * 1440 + 380,
        kind: 'config',
        service: 'checkout-cache',
        title: 'Lower cart TTL in Redis from 7 days to 3 days',
        author: 'li.wang',
        status: 'succeeded',
        description: 'Reduces memory pressure on checkout-cache (used_memory ~1.2 GB of 6.4 GB). Abandoned carts older than 3 days are rebuilt from the database on access.',
      },
    );
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'burst-balance',
      label: 'checkout-db BurstBalance drains from 100% to 0% every night after 01:00',
      kind: 'key',
      match: /BurstBalance \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.burstBalance' },
      explanation: 'BurstBalance is the percentage of the gp2 I/O credit bucket left. It falls from 100% at 01:00 to 0% at ~01:38 and stays there until the export ends; the 3-day view shows the same sawtooth every night with a slow refill during the day.',
    },
    {
      id: 'gp2-storage',
      label: 'checkout-db runs on gp2 200 GiB (600 baseline IOPS) — its replica and Terraform say gp3',
      kind: 'key',
      match: /RDS checkout-db \(primary\)[^\n]*storage gp2 200 GiB|"StorageType": "gp2"|"storageType":"gp2"/,
      foundBy: { tool: 'rds' },
      explanation: 'gp2 gives 3 IOPS per GiB: 200 GiB = 600 IOPS baseline, bursting to 3,000 only while credits last. The replica (gp3, 3,000 IOPS flat) and the Terraform definition (storage_type = "gp3") show what the primary used to be.',
    },
    {
      id: 'nightly-export',
      label: 'worker-1 runs a full export of orders/order_items/payments at 01:00 every night against the primary',
      kind: 'key',
      match: /export-orders --full --since=1970-01-01|export mode=full since=1970-01-01/,
      foundBy: { tool: 'terminal', host: 'worker-1', command: 'cat /etc/cron.d/finance-export' },
      explanation: 'The cron job in /etc/cron.d/finance-export streams every order ever placed out of db.internal.shopfast.io (the primary). It is the I/O workload that drives ReadIOPS to the 3,000 IOPS burst ceiling and empties the bucket.',
    },
    {
      id: 'io-waits',
      label: 'Checkout queries are waiting on storage (IO:DataFileRead / IO:WALSync), not on CPU',
      kind: 'key',
      match: /wait IO:(DataFileRead|WALSync)|checkout_app[^\n]*\|\s*active\s*\|\s*(IO\s*\|\s*)?(DataFileRead|WALSync)\b|^\s*IO\s*\|\s*DataFileRead\s*\|\s*\d{2,}/m,
      foundBy: { tool: 'rds' },
      explanation: 'Performance Insights / pg_stat_activity show ~90 average active sessions on a 2-vCPU instance, almost all in IO wait. The database is not busy computing — it is queued behind a disk that delivers 600 IOPS.',
    },
    {
      id: 'restore',
      label: 'checkout-db was re-created by a point-in-time restore 9 days ago (and Terraform ignores the storage drift)',
      kind: 'supporting',
      match: /Restored from DB instance checkout-db|RestoreDBInstanceToPointInTime|Emergency point-in-time restore|ignore_changes = \[snapshot_identifier/,
      foundBy: { tool: 'rds' },
      explanation: 'A restore always creates a brand-new instance with whatever storage settings the restore request specified — here gp2 200 GiB. Terraform would have flagged the drift, but storage_type was added to ignore_changes to unblock the replica.',
    },
    {
      id: 'queue-latency',
      label: 'DiskQueueDepth 30–60 and ReadLatency 60–120 ms while IOPS sit flat at ~600',
      kind: 'supporting',
      match: /DiskQueueDepth \[checkout-db\]|ReadLatency \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.queue' },
      explanation: 'Little\'s law: queue depth = throughput × latency. 50 outstanding I/Os at 600 IOPS means each one waits ~80 ms. When throughput is capped, more concurrency only makes the queue longer.',
    },
    {
      id: 'export-duration',
      label: 'The nightly export went from ~1h10m to ~4h50m right after the restore',
      kind: 'supporting',
      match: /elapsed=4h\d+m|finished after the 05:00 UTC SLA/,
      foundBy: { tool: 'terminal', host: 'worker-1', command: 'grep -E "complete|SLA" /var/log/shopfast-worker/export-orders.log' },
      explanation: 'Same job, same data volume, 4× slower from the night of Oct 1 — the first night after the restore. That is also why finance has been getting late warehouse data.',
    },
    {
      id: 'db-cpu',
      label: 'checkout-db CPU is only ~16%',
      kind: 'red-herring',
      match: /CPUUtilization \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.cpu' },
      explanation: 'Low CPU does not mean the database is healthy. An I/O-bound database has idle CPUs because every backend is blocked waiting for the disk — CPU actually dropped when the throttling started.',
    },
    {
      id: 'autovacuum',
      label: 'Autovacuum is running on order_items',
      kind: 'red-herring',
      match: /autovacuum: VACUUM|automatic (vacuum|analyze) of table/,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', "SELECT * FROM pg_stat_activity WHERE state = 'active';"] },
      explanation: 'Autovacuum is throttled by autovacuum_vacuum_cost_limit and is one session among ~100. It is slow tonight because it is also starved of I/O — a victim, not the cause. Killing it only builds up bloat.',
    },
    {
      id: 'checkpoints',
      label: 'Checkpoints are taking a long time to sync',
      kind: 'red-herring',
      match: /checkpoint (complete|starting)/,
      foundBy: { tool: 'logs', group: '/aws/rds/instance/checkout-db/postgresql' },
      explanation: 'Timed checkpoints every 5 minutes are normal; their fsync phase just takes longer because the volume is throttled. Tuning max_wal_size would not give the disk more IOPS.',
    },
    {
      id: 'evictions',
      label: 'Redis evictions blipped around 01:30',
      kind: 'red-herring',
      match: /Evictions \[checkout-cache-001\]/,
      foundBy: { tool: 'cloudwatch', panel: 'cache.evictions' },
      explanation: 'A few evictions per minute for a few minutes (after the cart TTL change two days ago) cannot explain a 40× latency increase that lasts four hours, and the cache hit rate is unchanged.',
    },
  ],

  rootCauses: [
    {
      id: 'rc-gp2-burst',
      correct: true,
      text: 'The PITR restore re-created checkout-db on gp2 200 GiB (600 baseline IOPS). The 01:00 full export burns its 5.4M I/O credits in ~37 min, after which the volume is capped at 600 IOPS until the export ends.',
      explanation: 'BurstBalance hits 0% at 01:38 every night, IOPS flatten at ~600 while queue depth and latency explode, sessions wait on IO:DataFileRead/WALSync, the export ran in ~1h10m on gp3 but ~4h50m since the restore, and the storage type in RDS/CloudTrail is gp2 while the replica and Terraform say gp3.',
    },
    {
      id: 'rc-export',
      partial: true,
      text: 'The 01:00 finance export on worker-1 (export-orders --full) scans orders, order_items and payments on the primary and saturates checkout-db\'s read I/O for ~5 hours every night.',
      explanation: 'The export is the trigger, but it ran nightly for months without hurting checkout. What changed is the storage: on gp3 the same job finished in ~70 minutes at 3,000 IOPS without starving anyone; on gp2 it exhausts the burst credits and leaves 600 IOPS for everyone.',
    },
    {
      id: 'rc-autovacuum',
      text: 'Autovacuum on order_items (4.4M dead tuples) starts around 01:30 every night; its full heap scan saturates read I/O, so checkout queries queue on IO:DataFileRead.',
      explanation: 'Autovacuum is cost-limited, started after the slowdown began, and is itself starved. It does not explain the BurstBalance sawtooth or the storage change.',
    },
    {
      id: 'rc-capacity',
      text: 'db.r6g.large has only 16 GiB RAM; once APAC traffic arrives the hot set no longer fits in the buffer cache, cache misses turn into disk reads, and the instance class must grow.',
      explanation: 'CPU is ~16% and night traffic is lower than the evening peak, which the same instance handles comfortably. The bottleneck is storage IOPS, which the instance class does not provide.',
    },
    {
      id: 'rc-redis',
      text: 'The cart TTL cut from 7 to 3 days makes Redis evict carts at night, so checkout rebuilds them from order_items and multiplies read I/O on checkout-db after 01:30.',
      explanation: 'Evictions were a handful per minute for a few minutes, hit rate is unchanged, and the pattern started days before the TTL change.',
    },
    {
      id: 'rc-checkpoint',
      text: 'max_wal_size = 2048MB is too small: checkpoints every 5 min flush gigabytes at night and their fsync stalls (sync up to 14 s) block commits on IO:WALSync.',
      explanation: 'Checkpoints are timed (every 5 minutes), not WAL-triggered, and the log shows no "checkpoints are occurring too frequently" warnings. They are slower because the disk is throttled — a symptom.',
    },
  ],

  fixes: [
    {
      id: 'fx-gp3',
      kind: 'correct',
      text: 'Modify checkout-db storage to gp3 with --apply-immediately (at ≥400 GiB you can provision 12,000 IOPS again); the change is online, with no failover.',
      explanation: 'gp3 has no credit bucket: 3,000 IOPS / 125 MiB/s baseline at any size (more can be provisioned at ≥400 GiB on RDS). The instance stays available during "storage-optimization". Note the 6-hour cooldown between storage modifications, so pick the target size/IOPS deliberately.',
    },
    {
      id: 'fx-replica',
      kind: 'correct',
      text: 'Point the finance export at the read replica (db-ro.internal.shopfast.io) and make it incremental on an updated_at watermark instead of --full.',
      explanation: 'Heavy analytical reads belong on a replica (or a snapshot export to S3), never on the primary that serves checkout. Incremental exports read megabytes instead of the whole database every night.',
    },
    {
      id: 'fx-gp2-bigger',
      kind: 'partial',
      text: 'Grow the gp2 volume from 200 to 1,000 GiB so its baseline becomes 3 IOPS/GiB × 1,000 = 3,000 IOPS and no longer depends on burst credits.',
      explanation: 'It works — gp2 baseline is 3 IOPS/GiB, so 1 TiB has a 3,000 IOPS baseline and no longer depends on credits — but you pay for 5× the storage, RDS storage can never be shrunk, and gp3 gives the same performance for less.',
    },
    {
      id: 'fx-reschedule',
      kind: 'partial',
      text: 'Move the cron in /etc/cron.d/finance-export from 01:00 to 09:00 UTC, the lowest-traffic hour, so fewer shoppers overlap with the export.',
      explanation: 'The bucket still empties and the database is still throttled for hours — just for a different set of customers — and the warehouse data stays late.',
    },
    {
      id: 'fx-scale-class',
      kind: 'neutral',
      text: 'Scale checkout-db from db.r6g.large to db.r6g.2xlarge for 4× the RAM (64 GiB of cache) and a higher instance EBS bandwidth ceiling.',
      explanation: 'The instance class sets CPU, RAM and the instance\'s EBS bandwidth ceiling (r6g.large can already burst well past 600 IOPS), but the volume\'s own limit — 600 IOPS once credits are gone — is unchanged. More RAM caches a little more, yet a full export still has to come from disk. And a Multi-AZ class change means a failover.',
    },
    {
      id: 'fx-failover',
      kind: 'harmful',
      text: 'Reboot checkout-db with failover now so the Multi-AZ standby, whose volume still has a full credit bucket, takes over the I/O.',
      explanation: 'Credits belong to the volume, not the instance. At best the standby\'s own bucket buys ~30 minutes; in exchange you get a 1–2 minute checkout outage, a cold buffer cache (even more reads), and an export that restarts from scratch with --full.',
    },
    {
      id: 'fx-kill-autovacuum',
      kind: 'harmful',
      text: 'Terminate the autovacuum worker (pid 25120) and set autovacuum_enabled = false on order_items until the night traffic is over.',
      explanation: 'Autovacuum is a victim of the throttling. Disabling it lets dead tuples and bloat pile up (more pages to read tomorrow) and moves you toward transaction-ID wraparound.',
    },
    {
      id: 'fx-pool',
      kind: 'harmful',
      text: 'Raise DB_POOL_MAX on checkout-api from 20 to 60 so checkout requests stop queueing for a free connection while the database is slow.',
      explanation: 'The volume completes 600 I/Os per second regardless of how many are queued. More concurrent sessions only deepen the queue (Little\'s law) and raise every query\'s latency.',
    },
  ],

  hints: [
    'The on-call says it happens every night and heals itself by morning. Don\'t just look at tonight — find the RDS views that cover several days. What follows a nightly rhythm, and what is different about the hours it happens?',
    'CPU is low and ReadIOPS actually *dropped* at the moment latency exploded. A database that is slow but idle is waiting for something — check Performance Insights wait events or pg_stat_activity, and the storage metrics (BurstBalance, DiskQueueDepth). Then find out what starts at 01:00.',
    'Compare checkout-db\'s storage type with its replica and with Terraform (Deploys, RDS events, CloudTrail around the restore 9 days ago), and look at /etc/cron.d on worker-1. gp2 earns 3 IOPS per GiB and bursts to 3,000 only while its 5.4M I/O credits last.',
  ],

  debrief: {
    summary: `Nine days ago a bad backfill migration forced an emergency **point-in-time restore** of checkout-db. A restore always creates a *new* instance, and this one was created on **gp2, 200 GiB** — the restore request said so, nobody noticed, and Terraform's drift warning was silenced with \`ignore_changes = [storage_type, …]\`. The old instance and the re-created replica are gp3 (3,000 IOPS flat, no credits).

gp2 performance is tied to size: **3 IOPS per GiB = 600 IOPS baseline**, with bursts up to **3,000 IOPS** paid from an I/O credit bucket of **5.4 million credits**. Every night at 01:00 a cron job on worker-1 runs \`export-orders --full --since=1970-01-01\` against the *primary*, reading every order, item and payment ever recorded. It drives the volume to the 3,000 IOPS ceiling; the bucket drains at (3,000 − 600) ≈ 2,400 credits/s and is empty after 5.4M / 2,400 ≈ **37 minutes** — 01:38, exactly when the alarm fires every night.

From then on the volume delivers 600 IOPS for **everyone**. The export keeps a deep queue of reads, checkout's index lookups and WAL fsyncs wait behind it (\`IO:DataFileRead\`, \`IO:WALSync\`), DiskQueueDepth sits at 30–60 and ReadLatency at 60–120 ms. CPU *falls* to ~16% because every backend is blocked on the disk, and ReadIOPS *drops* from 3,000 to 600 — the metrics most people look at first point the wrong way. When the export finally finishes (~05:50, four times slower than before, which is why finance's data is late) the bucket slowly refills during the day, and the cycle repeats the next night.

Autovacuum, slow checkpoints and the Redis blip were all real, but they were victims of the same throttled disk, not causes.`,
    timeline: [
      { minutesAgo: RESTORE + 22, event: 'Sep 30 13:00 — PITR restore of checkout-db requested with storageType gp2, allocatedStorage 200' },
      { minutesAgo: RESTORE - 9, event: 'Restored instance renamed to checkout-db (endpoint unchanged)' },
      { minutesAgo: TF_IMPORT, event: 'Terraform re-import adds ignore_changes on storage_type; replica re-created on gp3' },
      { minutesAgo: 11620, event: 'Oct 1 01:00 — first nightly export on gp2; credits exhausted at ~01:38, checkout slow until ~05:50' },
      { minutesAgo: JOB_START, event: 'Tonight 01:00 — cron starts export-orders --full; ReadIOPS jumps to ~3,000, BurstBalance falls' },
      { minutesAgo: DRAINED, event: '01:38 — BurstBalance 0%: volume throttled to 600 IOPS, queue depth 30–60, ReadLatency 60–120 ms' },
      { minutesAgo: 58, event: 'checkout-latency-p99-high pages the on-call (4th night in a row it was acked)' },
    ],
    concepts: [
      {
        title: 'EBS/RDS storage types: gp2 vs gp3 vs io1/io2',
        body: '**gp2** ties performance to size: 3 IOPS/GiB (min 100), with volumes under 1 TiB able to burst to 3,000 IOPS using credits. **gp3** decouples them: 3,000 IOPS and 125 MiB/s baseline at any size, with more IOPS/throughput provisioned independently (on RDS, from 400 GiB). **io1/io2** are provisioned IOPS with no burst model, for sustained high or latency-sensitive I/O. For almost every RDS workload today, gp3 is the default you want.',
      },
      {
        title: 'The burst credit bucket, with numbers',
        body: 'A gp2 volume starts with 5.4M I/O credits and earns credits at its baseline rate (here 600/s). Any second you use more than baseline, the difference is withdrawn. Drain time = 5.4M / (burst − baseline) = 5,400,000 / 2,400 ≈ 2,250 s ≈ 37.5 min. Refill time at night-time load (~300 IOPS) = 5.4M / 300 ≈ 5 h. `BurstBalance` (AWS/RDS, %) is that bucket — at 0% the volume is hard-capped at baseline. It is the single most important gp2 metric and should always be alarmed.',
      },
      {
        title: 'Little\'s law: why latency explodes when throughput is capped',
        body: 'Queue length = arrival rate × time in system. With the device capped at 600 IOPS and ~50 I/Os outstanding (`DiskQueueDepth`), each I/O waits 50 / 600 ≈ 83 ms. Adding more concurrency (bigger connection pools, more workers) does not add IOPS — it just makes the queue longer and every query slower. Before the drain the same volume did 3,000 IOPS at a queue of ~5 and ~1.8 ms: same law, very different numbers.',
      },
      {
        title: 'Why CPU is low when a database is I/O-bound',
        body: 'A PostgreSQL backend waiting for a page from disk is sleeping, not computing. CPUUtilization measures work done, so an I/O-starved database looks *idle*. Performance Insights makes this visible: average active sessions far above vCPU count, with the load attributed to `IO:DataFileRead` (reading data pages) and `IO:WALSync` (commits waiting for WAL fsync). Always ask "what are the sessions waiting on?" before concluding the database is fine.',
      },
      {
        title: 'Restores create new instances — with whatever settings you ask for',
        body: 'Snapshot and point-in-time restores in RDS never modify the original; they create a new instance, and storage type, size, IOPS, parameter group, security groups and monitoring are all parameters of that restore. Defaults in consoles, CLIs and old runbooks can differ from what the source had. After any restore, diff the new instance against IaC (and never silence the drift with `ignore_changes`).',
      },
      {
        title: 'Batch and analytics jobs belong on replicas',
        body: 'A full export competes with OLTP traffic for the same buffer cache, I/O and WAL. Run it against a read replica, an Aurora clone, or RDS snapshot export to S3, and make it incremental (watermark on `updated_at`) so it reads only what changed. Scheduling it "at night" only works if night really is idle — for a global shop it never is.',
      },
    ],
    commands: [
      { cmd: 'aws rds describe-db-instances --db-instance-identifier checkout-db', why: 'StorageType, AllocatedStorage and Iops of the actual instance (compare with the replica and Terraform)' },
      { cmd: 'aws cloudwatch get-metric-statistics --namespace AWS/RDS --metric-name BurstBalance --dimensions Name=DBInstanceIdentifier,Value=checkout-db --statistics Average --period 300 …', why: 'How much of the gp2 credit bucket is left' },
      { cmd: 'SELECT wait_event_type, wait_event, count(*) FROM pg_stat_activity WHERE state = \'active\' GROUP BY 1, 2;', why: 'What sessions are actually waiting on (IO vs CPU vs locks)' },
      { cmd: 'EXPLAIN (ANALYZE, BUFFERS) <query>;', why: 'With track_io_timing on, shows how many pages came from disk and how long those reads took' },
      { cmd: 'cat /etc/cron.d/* ; crontab -l', why: 'What runs on a schedule — the first thing to check for anything that "happens every night"' },
      { cmd: 'aws rds modify-db-instance --db-instance-identifier checkout-db --storage-type gp3 --allocated-storage 400 --iops 12000 --apply-immediately', why: 'Online storage change back to gp3 (no failover)' },
    ],
    prevention: [
      'Alarm on BurstBalance < 50% for every gp2 volume — or better, migrate all RDS storage to gp3 and remove the credit model entirely.',
      'After any restore, diff the new instance against IaC; ban `ignore_changes` on performance-relevant attributes without an owner and deadline.',
      'Run exports/analytics against a read replica or snapshot export, and make them incremental.',
      'Treat "it happens every night and fixes itself" as a SEV, not noise: alarms that repeatedly auto-resolve need a ticket and an owner.',
      'Watch DiskQueueDepth and Performance Insights wait events alongside CPU on database dashboards.',
    ],
    reading: [
      { title: 'Amazon RDS DB instance storage (gp2, gp3, Provisioned IOPS)', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_Storage.html' },
      { title: 'Amazon EBS General Purpose SSD volumes — I/O credits and burst performance', url: 'https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html' },
      { title: 'RDS for PostgreSQL wait event IO:DataFileRead', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/wait-event.iodatafileread.html' },
    ],
  },
};

export default incident;
