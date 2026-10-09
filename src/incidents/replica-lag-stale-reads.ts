import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { hex } from '../engine/rng';
import { MIN, iso, isoSec, nginxTime, pgTime, syslogTime, systemdTime } from '../engine/time';
import { pgTable } from '../engine/terminal/psql';
import { addPanel, database, ev, host, injectLog, logGroup, panel, setAlarm, setPoints } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4266 — "Order not found" right after checkout.
 * (a) 16:00 READS_FROM_REPLICA=true sends order reads (including the confirmation page
 *     right after the write) to checkout-db-replica-1;
 * (b) 19:30 the data team set max_standby_streaming_delay = -1 on the shared parameter
 *     group so Metabase queries stop being cancelled; a 47-minute Metabase query now holds
 *     WAL replay (recovery conflict on snapshot) since autovacuum cleaned `orders` at 20:55.
 */

const FLAG = 310; // 16:00 READS_FROM_REPLICA=true
const PARAM = 100; // 19:30 ModifyDBParameterGroup
const QSTART = 47; // 20:23 Metabase query starts on the replica
const CONFLICT = 15; // 20:55 replay blocked behind it
const LAG_S = 902; // seconds behind, now
const METABASE_PID = 24117;
const METABASE_IP = '10.0.11.152';
const METABASE_SG = 'sg-0f36c8d0e4a2b5179';
const DATA_ENGINEER = 'sso/kenji.watanabe';

const ORDER_BY_ID = 'SELECT o.id, o.public_id, o.status, o.total_cents, o.currency, o.payment_ref, o.created_at FROM orders o WHERE o.public_id = $1';
const METABASE_SQL =
  "-- Metabase:: userID: 14 queryType: native queryHash: 7d1f3c9e0a8b52e4f6c1d7a93b0e5f28c4a6d1b9e3f7a0c2d5b8e1f4a7c3d6b9\nSELECT date_trunc('day', o.created_at) AS day, oi.sku, count(DISTINCT o.customer_id) AS buyers, sum(oi.quantity) AS units, sum(oi.quantity * oi.price_cents) / 100.0 AS revenue FROM orders o JOIN order_items oi ON oi.order_id = o.id WHERE o.created_at >= now() - interval '400 days' AND o.status = 'completed' GROUP BY 1, 2 ORDER BY 1, revenue DESC";
const METABASE_ONE_LINE = METABASE_SQL.replace('\n', ' ');

const dur = (minutes: number) => {
  const raw = minutes * 60;
  const s = Math.floor(raw * 1000) / 1000 + ((Math.round(raw * 1000) * 7919) % 997) / 1e6;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = (s % 60).toFixed(6).padStart(9, '0');
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`;
};

const incident: Incident = {
  id: 'replica-lag-stale-reads',
  code: 'INC-4266',
  order: 9,
  title: '"Order not found" right after checkout',
  teaser: 'Payments go through, but customers land on "Order not found". Twenty minutes later the order is there.',
  difficulty: 'advanced',
  tags: ['RDS', 'PostgreSQL', 'Read replicas', 'Replication lag', 'Consistency'],
  parMinutes: 20,
  seed: 4266,
  now: '2026-10-04T21:10:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-order-notfound-high — OrderNotFound > 20 per minute',
      details: 'ShopFast/Checkout OrderNotFound (GET /api/v1/orders/{id} returning 404) has been above 20/min for 5 consecutive minutes (current 94). Runbook: https://wiki.shopfast.internal/runbooks/order-lookup',
      minutesAgo: 8,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4266', message: 'Since about 21:00 basically every customer who pays lands on "Order not found" on the confirmation page. They WERE charged. Some came back 15–20 min later and the order was there. A few are ordering a second time because they think it failed 😬. We had maybe 4–5 tickets like this earlier this afternoon too, we thought it was a glitch.', minutesAgo: 6 },
      { from: 'Priya Nair', role: 'Backend Engineer (checkout)', channel: '#incident-4266', message: "I checked three of the order ids from the tickets directly on checkout-db — they're all there, status paid, created at the time the customer says. So the write path is fine. We did move order reads to the replica at 16:00 to take load off the primary before the Q4 sale, but replica lag has been sub-second all month.", minutesAgo: 5 },
      { from: 'Dev Patel', role: 'Frontend Engineer', channel: '#incident-4266', message: 'Fwiw we changed CloudFront behaviours for /account/* this evening. I really doubt it, but maybe the 404 page got cached?', minutesAgo: 4 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4266', message: "You're IC. Money is coming in, but duplicate orders and refunds are piling up and support is drowning. I want the cause, not just a restart.", minutesAgo: 3 },
    ],
    impact: 'Nearly 100% of order confirmations and order-history views for new orders show "Order not found" for ~15 minutes after purchase. Payments succeed; duplicate orders and support tickets are rising.',
    services: ['checkout-api', 'checkout-db (RDS PostgreSQL primary)', 'checkout-db-replica-1 (read replica)'],
  },

  build(env, kit) {
    const rng = kit.rng;
    const at = (m: number) => env.now - Math.round(m * MIN);
    const primary = database(env, 'checkout-db');
    const replica = database(env, 'checkout-db-replica-1');

    // ---------------- App config: order reads go to the replica since 16:00 ----------------
    for (const [i, h] of APP_HOSTS.entries()) {
      const hh = host(env, h);
      hh.env.READS_FROM_REPLICA = 'true';
      const svc = hh.services['checkout-api'];
      const restarted = at(FLAG - 2 - i * 1.5);
      svc.since = `${systemdTime(restarted)}; 5h ${Math.round((env.now - restarted) / MIN - 300)}min ago`;
      svc.journal.push(
        `${syslogTime(restarted - 1800)} ${hh.hostname} systemd[1]: Stopping checkout-api.service - ShopFast checkout API (Node.js)...`,
        `${syslogTime(restarted - 200)} ${hh.hostname} systemd[1]: checkout-api.service: Deactivated successfully.`,
        `${syslogTime(restarted)} ${hh.hostname} systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`,
        `${syslogTime(restarted + 900)} ${hh.hostname} node[${svc.mainPid}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`,
        `${syslogTime(restarted + 950)} ${hh.hostname} node[${svc.mainPid}]: {"level":30,"msg":"connected to postgres read pool","host":"db-ro.internal.shopfast.io","pool":{"max":20},"readsFromReplica":true,"routes":["GET /api/v1/orders","GET /api/v1/orders/:id"]}`,
        `${syslogTime(restarted + 1300)} ${hh.hostname} node[${svc.mainPid}]: {"level":30,"msg":"checkout-api v2.13.1 listening on 127.0.0.1:3000"}`,
      );
    }

    env.changes.unshift(
      {
        id: 'chg-8866',
        minutesAgo: 120,
        kind: 'config',
        service: 'web-frontend',
        title: 'CloudFront: /account/* behaviour → CachingDisabled; /static/* immutable 1y',
        author: 'terraform-ci (PR #1231, dev.patel)',
        status: 'succeeded',
        description: 'Account pages (order history, confirmation) were inheriting the default 60 s TTL; set them to the managed CachingDisabled policy (no-store). /static/* gets Cache-Control: public, max-age=31536000, immutable. API traffic (api.shopfast.io) does not go through CloudFront.',
      },
      {
        id: 'chg-8861',
        minutesAgo: FLAG,
        kind: 'config',
        service: 'checkout-api',
        title: 'checkout-api: serve order reads from checkout-db-replica-1 (READS_FROM_REPLICA=true)',
        author: 'priya.nair',
        status: 'succeeded',
        description: 'Q4 readiness (CHK-1407): offload GET /api/v1/orders and GET /api/v1/orders/:id to the read replica to cut primary CPU ~15%. The flag shipped dark in 2.13.0. Replica lag p99 over the last 30 days: 0.6 s. Rolled out via config-sync + rolling restart of checkout-api.',
        diff: `diff --git a/config/prod/checkout-api.env b/config/prod/checkout-api.env
--- a/config/prod/checkout-api.env
+++ b/config/prod/checkout-api.env
@@ -7,7 +7,7 @@ DB_USER=checkout_app
 DB_POOL_MAX=20
 DB_POOL_IDLE_TIMEOUT_MS=10000
-READS_FROM_REPLICA=false
+READS_FROM_REPLICA=true
 REDIS_URL=redis://cache.internal.shopfast.io:6379
 INVOICE_BUCKET=shopfast-invoices-prod
 ORDERS_QUEUE_URL=https://sqs.us-east-1.amazonaws.com/481562039374/orders-prod

# for reference — src/orders/repository.ts (unchanged, shipped in 2.13.0):
#   const readPool = config.READS_FROM_REPLICA ? replicaPool : primaryPool;
#   export const getOrderByPublicId = (id: string) =>
#     readPool.query(ORDER_BY_PUBLIC_ID, [id]).then(r => r.rows[0] ?? null);`,
      },
    );
    env.cloudtrail.push(
      { minutesAgo: FLAG + 1, eventName: 'SendCommand', eventSource: 'ssm.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'AWS-RunShellScript (config-sync checkout-api)', request: { documentName: 'AWS-RunShellScript', targets: [{ key: 'tag:service', values: ['checkout-api'] }], maxConcurrency: '1' } },
      { minutesAgo: PARAM, eventName: 'ModifyDBParameterGroup', eventSource: 'rds.amazonaws.com', user: DATA_ENGINEER, sourceIp: '203.0.113.61', resources: 'shopfast-pg15', request: { dBParameterGroupName: 'shopfast-pg15', parameters: [{ parameterName: 'max_standby_streaming_delay', parameterValue: '-1', applyMethod: 'immediate' }] } },
      { minutesAgo: PARAM + 6, eventName: 'ConsoleLogin', eventSource: 'signin.amazonaws.com', user: DATA_ENGINEER, sourceIp: '203.0.113.61', resources: '-' },
      { minutesAgo: PARAM + 4, eventName: 'DescribeDBParameters', eventSource: 'rds.amazonaws.com', user: DATA_ENGINEER, sourceIp: '203.0.113.61', resources: 'shopfast-pg15' },
      { minutesAgo: 120, eventName: 'UpdateDistribution', eventSource: 'cloudfront.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'E2QX7R1LZ0WB4K (www.shopfast.io)', request: { id: 'E2QX7R1LZ0WB4K', distributionConfig: { cacheBehaviors: { items: [{ pathPattern: '/account/*', cachePolicyId: '4135ea2d-6df8-44a3-9df3-4b5a84be39ad' }] } } } },
    );
    env.rds.events.push(
      { minutesAgo: PARAM, source: 'shopfast-pg15', message: 'Updated parameter max_standby_streaming_delay to -1 with apply method immediate' },
      { minutesAgo: 9.5, source: 'checkout-db-replica-1', message: 'Replica lag has exceeded the CloudWatch alarm threshold (checkout-replica-lag-high)' },
    );

    // Metabase lives on ECS in the app-b subnet and has its own SG allowed on the DB SG.
    env.ec2.securityGroups.push({ id: METABASE_SG, name: 'shopfast-metabase-sg', description: 'Metabase (analytics, ECS)', inbound: [{ protocol: 'tcp', ports: '3000', source: '10.8.0.0/16', description: 'office VPN' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] });
    env.ec2.securityGroups.find(s => s.id === IDS.dbSg)!.inbound.push({ protocol: 'tcp', ports: '5432', source: METABASE_SG, description: 'metabase → replica (analytics)' });

    // ---------------- Databases ----------------
    for (const db of [primary, replica]) {
      db.settings.max_standby_streaming_delay = '-1';
      db.settings.max_standby_archive_delay = '30s';
      db.settings.hot_standby_feedback = 'off';
      db.settings.log_recovery_conflict_waits = 'on';
      db.settings.hot_standby = 'on';
    }
    const replayTs = env.now - LAG_S * 1000 - 417;
    replica.activity.push(
      { pid: METABASE_PID, usename: 'analytics', application: 'Metabase', client: METABASE_IP, state: 'active', waitEvent: 'IO: DataFileRead', queryStart: pgTime(at(QSTART) - 12400), duration: dur(QSTART + 12.4 / 60), query: METABASE_ONE_LINE },
      { pid: 24131, usename: 'analytics', application: 'Metabase', client: METABASE_IP, state: 'active', waitEvent: '', queryStart: pgTime(at(QSTART) - 12100), duration: dur(QSTART + 12.1 / 60), query: METABASE_ONE_LINE + ' /* parallel worker */' },
      { pid: 488, usename: '', application: '', client: '', state: '', waitEvent: 'IPC: RecoveryConflictSnapshot', queryStart: '', duration: '', query: '' },
      { pid: 7741, usename: 'checkout_app', application: 'checkout-api', client: '10.0.11.87', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: pgTime(env.now - 2100), duration: '00:00:00.0014', query: ORDER_BY_ID },
      { pid: 7748, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.142', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: pgTime(env.now - 900), duration: '00:00:00.0011', query: ORDER_BY_ID },
      { pid: 7755, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.23', state: 'active', waitEvent: '', queryStart: pgTime(env.now - 2), duration: '00:00:00.002', query: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT 20' },
    );
    const lagRow = (alias: string) => pgTable([alias], [[dur(LAG_S / 60 + 0.417 / 60).replace(/(\.\d{6})$/, '$1')]]);
    replica.queries.push(
      { match: /now\(\)\s*-\s*pg_last_xact_replay_timestamp\(\)\s+as\s+(\w+)/i, output: lagRow('lag') },
      { match: /now\(\)\s*-\s*pg_last_xact_replay_timestamp\(\)|clock_timestamp\(\)\s*-\s*pg_last_xact_replay_timestamp\(\)/i, output: lagRow('?column?') },
      { match: /pg_last_xact_replay_timestamp/i, output: pgTable(['pg_last_xact_replay_timestamp'], [[pgTime(replayTs).replace(' UTC', '+00')]]) },
      { match: /pg_is_wal_replay_paused/i, output: pgTable(['pg_is_wal_replay_paused'], [['f']]) },
      { match: /pg_last_wal_receive_lsn|pg_last_wal_replay_lsn/i, output: pgTable(['pg_last_wal_receive_lsn', 'pg_last_wal_replay_lsn'], [['3A/9C41E2F0', '3A/7F2C1D28']]) },
      { match: /pg_stat_database_conflicts/i, output: pgTable(['datname', 'confl_tablespace', 'confl_lock', 'confl_snapshot', 'confl_bufferpin', 'confl_deadlock'], [['checkout', 0, 0, 41, 2, 0], ['postgres', 0, 0, 0, 0, 0], ['rdsadmin', 0, 0, 0, 0, 0]]) },
      { match: /pg_stat_replication/i, output: pgTable(['pid', 'usename', 'application_name', 'client_addr', 'state', 'replay_lag'], []) },
    );
    primary.queries.push({
      match: /pg_stat_replication/i,
      output: pgTable(
        ['pid', 'usename', 'application_name', 'client_addr', 'state', 'sent_lsn', 'write_lsn', 'flush_lsn', 'replay_lsn', 'write_lag', 'flush_lag', 'replay_lag', 'sync_state'],
        [[1288, 'rdsrepladmin', 'walreceiver', '10.0.21.33', 'streaming', '3A/9C41E2F0', '3A/9C41E2F0', '3A/9C41E2F0', '3A/7F2C1D28', '00:00:00.000874', '00:00:00.002113', dur(LAG_S / 60 - 0.53 / 60), 'async']],
      ),
    });
    env.rds.topSql['checkout-db-replica-1'] = [
      { sql: METABASE_ONE_LINE, calls: 0, meanMs: 0, loadAas: 1.96, rowsPerCall: 0, waitEvent: 'IO:DataFileRead' },
      { sql: ORDER_BY_ID, calls: 101, meanMs: 0.4, loadAas: 0.01, rowsPerCall: 0.31, waitEvent: 'CPU' },
      { sql: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT $3', calls: 1240, meanMs: 1.8, loadAas: 0.04, rowsPerCall: 5.1, waitEvent: 'CPU' },
    ];

    // ---------------- Postgres logs ----------------
    const pgPrim = logGroup(env, '/aws/rds/instance/checkout-db/postgresql');
    pgPrim.events.push(
      ev(env, CONFLICT - 1.7, `${pgTime(at(CONFLICT - 1.7))}::@:[30122]:LOG:  automatic vacuum of table "checkout.public.orders": index scans: 1\n\tpages: 0 removed, 212418 remain, 38211 scanned (17.99% of total)\n\ttuples: 61204 removed, 8412339 remain, 0 are dead but not yet removable, oldest xmin: 98812307\n\tremovable cutoff: 98812307, which was 3 XIDs old when operation ended\n\tindex scan needed: 9120 pages from table (4.29% of total) had 61204 dead item identifiers removed\n\tavg read rate: 41.284 MB/s, avg write rate: 9.112 MB/s\n\tsystem usage: CPU: user: 3.81 s, system: 0.92 s, elapsed: 101.33 s`),
      ev(env, PARAM - 0.2, `${pgTime(at(PARAM - 0.2))}::@:[612]:LOG:  received SIGHUP, reloading configuration files`),
      ev(env, PARAM - 0.21, `${pgTime(at(PARAM - 0.21))}::@:[612]:LOG:  parameter "max_standby_streaming_delay" changed to "-1"`),
    );
    const pgRep = logGroup(env, '/aws/rds/instance/checkout-db-replica-1/postgresql', 'PostgreSQL log exported from RDS (read replica)', 7);
    const rt = (m: number) => pgTime(at(m));
    for (const [k, m] of [178.3, 151.9, 131.2, 112.6, 104.8].entries()) {
      const pid = 22871 + k * 413;
      const port = 51344 + k * 97;
      pgRep.events.push(
        ev(env, m, `${rt(m)}:${METABASE_IP}(${port}):analytics@checkout:[${pid}]:ERROR:  canceling statement due to conflict with recovery`),
        ev(env, m - 0.0001, `${rt(m - 0.0001)}:${METABASE_IP}(${port}):analytics@checkout:[${pid}]:DETAIL:  User query might have needed to see row versions that must be removed.`),
        ev(env, m - 0.0002, `${rt(m - 0.0002)}:${METABASE_IP}(${port}):analytics@checkout:[${pid}]:STATEMENT:  ${METABASE_ONE_LINE}`),
      );
    }
    pgRep.events.push(
      ev(env, PARAM - 0.2, `${rt(PARAM - 0.2)}::@:[401]:LOG:  received SIGHUP, reloading configuration files`),
      ev(env, PARAM - 0.21, `${rt(PARAM - 0.21)}::@:[401]:LOG:  parameter "max_standby_streaming_delay" changed to "-1"`),
      ev(env, CONFLICT - 1 / 60, `${rt(CONFLICT - 1 / 60)}::@:[488]:LOG:  recovery still waiting after 1000.284 ms: recovery conflict on snapshot`),
      ev(env, CONFLICT - 1.0001 / 60, `${rt(CONFLICT - 1.0001 / 60)}::@:[488]:DETAIL:  Conflicting process: ${METABASE_PID}.`),
      ev(env, CONFLICT - 1.0002 / 60, `${rt(CONFLICT - 1.0002 / 60)}::@:[488]:CONTEXT:  WAL redo at 3A/7F2C1D28 for Heap2/PRUNE: snapshotConflictHorizon: 98812231, nredirected: 0, ndead: 4, nunused: 0, redirected: [], dead: [3, 7, 11, 12], unused: []; blkref #0: rel 1663/16401/16488, blk 1182733`),
    );
    for (let m = 170; m > 0; m -= 20) pgRep.events.push(ev(env, m, `${rt(m)}::@:[402]:LOG:  restartpoint complete: wrote ${900 + ((m * 7) % 300)} buffers (0.2%); 0 WAL file(s) added, 0 removed, 1 recycled; write=29.912 s, sync=0.003 s, total=29.941 s; sync files=38, longest=0.002 s, average=0.001 s; distance=20114 kB, estimate=21877 kB; lsn=3A/${(0x6a000000 + m * 0x10000).toString(16).toUpperCase()}, redo lsn=3A/${(0x69f00000 + m * 0x10000).toString(16).toUpperCase()}`));

    // ---------------- Application logs: place order (primary) → read it back (replica) ----------------
    const clientIps = ['10.0.0.71', '10.0.1.163', '10.0.0.204', '10.0.1.38'];
    const UAS = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
      'ShopFast-iOS/5.12.0 (iPhone15,2; iOS 18.0)',
    ];
    for (const [i, h] of APP_HOSTS.entries()) {
      const meta = hostMeta[h];
      const pid = host(env, h).services['checkout-api'].mainPid!;
      const app = [];
      const access = [];
      // times (minutes ago) of checkouts whose confirmation read hit a stale replica
      const stale: number[] = [];
      for (let k = 0; k < 5; k++) stale.push(FLAG - 25 - k * 61 - i * 7); // rare, sub-second lag (afternoon)
      for (let k = 0; k < 22; k++) stale.push(CONFLICT - 0.3 - k * 0.66 - i * 0.07); // every order since 20:55
      for (const [k, m] of stale.entries()) {
        if (m <= 0.05) continue;
        const ts = at(m);
        const order = `ord_${hex(rng, 12)}`;
        const reqA = `req-${hex(rng, 8)}`;
        const reqB = `req-${hex(rng, 8)}`;
        const ip = clientIps[(k + i) % 4];
        const ua = UAS[(k + i) % 3];
        const afternoon = m > CONFLICT;
        const gap = afternoon ? 380 + ((k * 97) % 240) : 900 + ((k * 211) % 900);
        const total = 2400 + ((k * 7919) % 19000);
        app.push(
          { ts, msg: JSON.stringify({ level: 30, time: iso(ts), pid, hostname: meta.hostname, reqId: reqA, orderId: order, customerId: 4400000 + ((k * 104729 + i * 31) % 900000), totalCents: total, paymentRef: `pb_ch_${hex(rng, 16)}`, db: 'primary', msg: 'order placed' }) },
          { ts: ts + 2, msg: JSON.stringify({ level: 30, time: iso(ts + 2), pid, hostname: meta.hostname, reqId: reqA, req: { method: 'POST', url: '/api/v1/checkout' }, res: { statusCode: 201 }, responseTime: 412.6 + ((k * 31) % 200), msg: 'request completed' }) },
          { ts: ts + gap, msg: JSON.stringify({ level: 40, time: iso(ts + gap), pid, hostname: meta.hostname, reqId: reqB, orderId: order, readSource: 'replica', dbHost: 'db-ro.internal.shopfast.io', msg: 'order not found' }) },
          { ts: ts + gap + 1, msg: JSON.stringify({ level: 30, time: iso(ts + gap + 1), pid, hostname: meta.hostname, reqId: reqB, req: { method: 'GET', url: `/api/v1/orders/${order}` }, res: { statusCode: 404 }, responseTime: 2.1 + ((k * 13) % 9) / 10, msg: 'request completed' }) },
        );
        access.push(
          { ts: ts + 3, msg: `${ip} - - [${nginxTime(ts + 3)}] "POST /api/v1/checkout HTTP/1.1" 201 612 "-" "${ua}" rt=0.${String(415 + ((k * 31) % 200)).padStart(3, '0')} uct=0.000 urt=0.${String(414 + ((k * 31) % 200)).padStart(3, '0')} rid=${hex(rng, 32)}` },
          { ts: ts + gap + 2, msg: `${ip} - - [${nginxTime(ts + gap + 2)}] "GET /api/v1/orders/${order} HTTP/1.1" 404 61 "-" "${ua}" rt=0.003 uct=0.000 urt=0.003 rid=${hex(rng, 32)}` },
        );
        if (afternoon) {
          // the customer refreshes a moment later and it works
          const ts2 = ts + gap + 4200 + ((k * 331) % 3000);
          app.push({ ts: ts2, msg: JSON.stringify({ level: 30, time: iso(ts2), pid, hostname: meta.hostname, reqId: `req-${hex(rng, 8)}`, req: { method: 'GET', url: `/api/v1/orders/${order}` }, res: { statusCode: 200 }, responseTime: 3.4, msg: 'request completed' }) });
          access.push({ ts: ts2 + 1, msg: `${ip} - - [${nginxTime(ts2 + 1)}] "GET /api/v1/orders/${order} HTTP/1.1" 200 1840 "-" "${ua}" rt=0.004 uct=0.000 urt=0.004 rid=${hex(rng, 32)}` });
        } else if (k % 3 === 0) {
          // refresh 20 s later: still not there
          const ts2 = ts + gap + 20000 + ((k * 331) % 9000);
          if (ts2 < env.now) {
            app.push({ ts: ts2, msg: JSON.stringify({ level: 40, time: iso(ts2), pid, hostname: meta.hostname, reqId: `req-${hex(rng, 8)}`, orderId: order, readSource: 'replica', dbHost: 'db-ro.internal.shopfast.io', msg: 'order not found' }) });
            access.push({ ts: ts2 + 1, msg: `${ip} - - [${nginxTime(ts2 + 1)}] "GET /api/v1/orders/${order} HTTP/1.1" 404 61 "-" "${ua}" rt=0.002 uct=0.000 urt=0.002 rid=${hex(rng, 32)}` });
          }
        }
      }
      injectLog(env, h, '/var/log/checkout-api/app.log', app);
      injectLog(env, h, '/var/log/nginx/access.log', access);
    }

    // ---------------- Metrics ----------------
    setPoints(env, 'replica.lag', series('rlag', 0.4, { noise: 0.6 }).map((v, m) => (m <= CONFLICT ? (CONFLICT - m) * 60 + 2 : v)).setNoise(0.02).clamp(0).round(1).build());
    panel(env, 'replica.lag').featured = true;
    setPoints(env, 'replica.cpu', series('rcpu', 11, { noise: 0.12 }).rampTo(QSTART, 41, 2).clamp(0, 100).build());
    panel(env, 'replica.cpu').featured = true;
    setPoints(env, 'rds.cpu', series('pcpu', 19, { noise: 0.08 }).wave(0.05).clamp(0, 100).build());
    setPoints(env, 'cache.evictions', series('rev', 0.2, { noise: 1 }).rampTo(62, 9, 3).rampTo(48, 0.4, 4).clamp(0).round(0).build());
    panel(env, 'cache.evictions').featured = true;
    addPanel(env, {
      id: 'app.orderNotFound',
      group: 'Application (ShopFast/Checkout)',
      namespace: 'ShopFast/Checkout',
      metric: 'OrderNotFound',
      resource: 'checkout-api',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      featured: true,
      threshold: 20,
      series: [{ name: 'checkout-api', points: series('o404', 1.6, { noise: 0.8 }).rampTo(CONFLICT - 0.5, 92, 1.5).setNoise(0.12).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'replica.readiops',
      group: 'RDS',
      namespace: 'AWS/RDS',
      metric: 'ReadIOPS',
      resource: 'checkout-db-replica-1',
      unit: 'Count/Second',
      stat: 'Average',
      periodMinutes: 1,
      series: [{ name: 'checkout-db-replica-1', points: series('riops2', 140, { noise: 0.15 }).rampTo(QSTART, 2650, 2).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'replica.storage',
      group: 'RDS',
      namespace: 'AWS/RDS',
      metric: 'FreeStorageSpace',
      resource: 'checkout-db-replica-1',
      unit: 'GB',
      stat: 'Average',
      periodMinutes: 1,
      series: [{ name: 'checkout-db-replica-1', points: series('rstor', 252.1, { noise: 0.0004 }).map((v, m) => (m <= CONFLICT ? v - (CONFLICT - m) * 0.021 : v)).round(2).build() }],
    });
    setAlarm(env, 'checkout-replica-lag-high', 'ALARM', 9.5);
    env.alarms.push({ name: 'checkout-order-notfound-high', state: 'ALARM', metric: 'OrderNotFound', condition: 'Sum > 20 for 5 datapoints within 5 minutes', minutesAgo: 8, panelId: 'app.orderNotFound' });

    env.awsCli.unshift(
      {
        match: /aws cloudwatch describe-alarms.*checkout-replica-lag-high/,
        output: JSON.stringify({ MetricAlarms: [{ AlarmName: 'checkout-replica-lag-high', AlarmArn: `arn:aws:cloudwatch:us-east-1:${IDS.account}:alarm:checkout-replica-lag-high`, StateValue: 'ALARM', StateReason: 'Threshold Crossed: 5 datapoints [302.0 (04/10/26 20:59:00), 362.0 (04/10/26 21:00:00), 422.0 (04/10/26 21:01:00), 482.0 (04/10/26 21:00:00), 242.0 (04/10/26 20:58:00)] were greater than the threshold (30.0).', StateUpdatedTimestamp: isoSec(at(9.5)), MetricName: 'ReplicaLag', Namespace: 'AWS/RDS', Statistic: 'Maximum', Dimensions: [{ Name: 'DBInstanceIdentifier', Value: 'checkout-db-replica-1' }], Period: 60, EvaluationPeriods: 5, Threshold: 30, ComparisonOperator: 'GreaterThanThreshold', ActionsEnabled: true, AlarmActions: [`arn:aws:sns:us-east-1:${IDS.account}:data-platform-low-priority`], OKActions: [] }] }, null, 4),
      },
      {
        match: /aws rds describe-db-parameters/,
        output: JSON.stringify({
          Parameters: [
            { ParameterName: 'hot_standby_feedback', ParameterValue: '0', Description: 'Allows feedback from a hot standby to the primary that will avoid query conflicts.', Source: 'engine-default', ApplyType: 'dynamic', DataType: 'boolean', IsModifiable: true },
            { ParameterName: 'log_recovery_conflict_waits', ParameterValue: '1', Description: 'Logs standby recovery conflict waits.', Source: 'user', ApplyType: 'dynamic', DataType: 'boolean', IsModifiable: true },
            { ParameterName: 'max_standby_archive_delay', ParameterValue: '30000', Description: 'Sets the maximum delay before canceling queries when a hot standby server is processing archived WAL data.', Source: 'engine-default', ApplyType: 'dynamic', DataType: 'integer', AllowedValues: '-1-2147483647', IsModifiable: true },
            { ParameterName: 'max_standby_streaming_delay', ParameterValue: '-1', Description: 'Sets the maximum delay before canceling queries when a hot standby server is processing streamed WAL data.', Source: 'user', ApplyType: 'dynamic', DataType: 'integer', AllowedValues: '-1-2147483647', IsModifiable: true },
          ],
        }, null, 4),
      },
    );

    env.traffic.profile = (_h, m) => (m <= 75 ? { rpm: 7 } : {});
  },

  evidence: [
    {
      id: 'notfound-replica',
      label: 'checkout-api logs "order not found" with readSource=replica right after "order placed" on the primary',
      kind: 'key',
      match: /"readSource":"replica"[^\n]*order not found/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'Follow one order id: POST /api/v1/checkout writes it to the primary, and a second later GET /api/v1/orders/{id} looks for it on the replica — which has not replayed that write yet. The data exists; the read went to the wrong place.',
    },
    {
      id: 'reads-from-replica',
      label: 'READS_FROM_REPLICA=true since 16:00 routes order reads to checkout-db-replica-1',
      kind: 'key',
      match: /READS_FROM_REPLICA=true/,
      foundBy: { tool: 'deploys' },
      explanation: 'This config change turned the confirmation page into a read-after-write against an asynchronous replica. With sub-second lag it only bit a few customers (the afternoon tickets); with 15 minutes of lag it bites everyone.',
    },
    {
      id: 'metabase-blocks-replay',
      label: 'A 47-minute Metabase query on the replica; the startup process waits on RecoveryConflictSnapshot',
      kind: 'key',
      match: /Metabase|RecoveryConflictSnapshot|recovery conflict on snapshot/,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db-ro.internal.shopfast.io -U ops_readonly checkout', "SELECT pid, usename, application_name, state, wait_event, now() - query_start AS duration, query FROM pg_stat_activity WHERE state <> 'idle';"] },
      explanation: 'WAL replay on a hot standby must wait (or cancel the query) when it needs to remove row versions a running query might still see. Since 20:55 the startup process has been waiting for the Metabase analytics query (pid 24117) to finish.',
    },
    {
      id: 'standby-delay',
      label: 'max_standby_streaming_delay changed 30s → -1 at 19:30 on the shared parameter group',
      kind: 'key',
      match: /max_standby_streaming_delay[^\n]*(to -1|"-1")/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'With the default 30 s, the replica would have cancelled the Metabase query and moved on (that is what happened all afternoon — see the "conflict with recovery" errors). -1 means "wait forever", so one long query can freeze replication indefinitely.',
    },
    {
      id: 'replica-lag',
      label: 'ReplicaLag climbing 1 s per second since 20:55 (now ~15 min)',
      kind: 'supporting',
      match: /ReplicaLag \[checkout-db-replica-1\]|00:15:0\d\.\d+/,
      foundBy: { tool: 'cloudwatch', panel: 'replica.lag' },
      explanation: 'A lag that grows exactly as fast as the clock means replay is not slow — it is stopped.',
    },
    {
      id: 'wal-received-not-replayed',
      label: 'Primary: WAL is shipped and flushed on the replica within ms, but replay_lag is 15 minutes',
      kind: 'supporting',
      match: /streaming[^\n]*3A\/7F2C1D28|3A\/9C41E2F0[^\n]*3A\/7F2C1D28/,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', 'SELECT * FROM pg_stat_replication;'] },
      explanation: 'write_lag and flush_lag are milliseconds, so network and replica disk are fine. Only replay is behind: the replica has the data on disk but is not applying it.',
    },
    {
      id: 'earlier-cancels',
      label: 'Replica log: Metabase queries were being cancelled "due to conflict with recovery" before 19:30',
      kind: 'supporting',
      match: /canceling statement due to conflict with recovery/,
      foundBy: { tool: 'logs', group: '/aws/rds/instance/checkout-db-replica-1/postgresql' },
      explanation: 'This is why the data team changed the parameter: their dashboards kept failing. The safety valve that protected replication was removed to make the errors go away.',
    },
    {
      id: 'cloudfront',
      label: 'CloudFront behaviour change for /account/* pages',
      kind: 'red-herring',
      match: /CloudFront|UpdateDistribution/,
      foundBy: { tool: 'deploys' },
      explanation: 'The change disabled caching for account pages, and api.shopfast.io does not go through CloudFront at all. The 404s are generated by checkout-api itself (see the app logs), not by an edge cache.',
    },
    {
      id: 'redis-evictions',
      label: 'Redis evictions spiked around 20:08',
      kind: 'red-herring',
      match: /Evictions \[checkout-cache-001\]/,
      foundBy: { tool: 'cloudwatch', panel: 'cache.evictions' },
      explanation: 'A short burst of evictions (session keys) an hour earlier that has already subsided. Orders are not served from Redis; the 404 path goes straight to PostgreSQL.',
    },
  ],

  rootCauses: [
    { id: 'rc-both', correct: true, text: 'READS_FROM_REPLICA=true routes post-checkout order reads to checkout-db-replica-1, whose WAL replay is stalled behind a Metabase query since max_standby_streaming_delay was set to -1.', explanation: 'Both halves are needed: the routing makes customers sensitive to replica lag (it caused a trickle of 404s all afternoon), and the paused replay turned sub-second lag into 15 minutes.' },
    { id: 'rc-lag-only', partial: true, text: 'checkout-db-replica-1 is ~15 min behind: max_standby_streaming_delay = -1 (19:30) lets Metabase query pid 24117 hold WAL replay through a recovery conflict on snapshot.', explanation: 'Correct about the lag, but it misses why customers are affected at all: order reads right after a write should never depend on an asynchronous replica. Fix only the lag and the afternoon\'s "occasional" 404s come back.' },
    { id: 'rc-async-orders', text: 'shopfast-worker inserts orders from the orders-prod SQS queue and its consumer is ~15 min backlogged, so the row does not exist yet when GET /api/v1/orders/:id runs.', explanation: 'The app log shows "order placed" with db=primary inside POST /api/v1/checkout, and Priya found the orders on the primary. The worker only sends emails.' },
    { id: 'rc-cloudfront', text: 'PR #1231 changed the CloudFront /account/* behaviour; the first 404 for a new order page is cached at the edge for the default TTL, so customers keep seeing "Order not found".', explanation: 'The change disabled caching, and API calls (api.shopfast.io) do not pass through CloudFront. The 404s are produced by checkout-api with readSource=replica.' },
    { id: 'rc-redis', text: 'The 20:08 Redis eviction burst dropped order:{id} keys, and checkout-api\'s cache-miss path returns 404 instead of falling back to checkout-db for orders created since.', explanation: 'Orders are not cached in Redis, the eviction burst ended an hour before the incident, and the logs show the request reaching PostgreSQL (the replica).' },
    { id: 'rc-primary-commit', text: 'Long-running transactions on checkout-db hold row locks on orders, so INSERTs from POST /api/v1/checkout commit minutes late and stay invisible to the confirmation read.', explanation: 'The checkout request completes (201) only after COMMIT, and the orders are visible on the primary immediately. The stale reads are on the replica.' },
  ],

  fixes: [
    { id: 'fx-read-primary', kind: 'correct', text: 'Set READS_FROM_REPLICA=false now, then add read-your-writes: a session\'s reads go to the primary until the replica has replayed its last write\'s LSN.', explanation: 'Restores confirmations within a rolling restart. Read-your-writes keeps most of the offload benefit while guaranteeing customers see their own data — e.g. pin the session to the primary for N seconds after a write, or store pg_current_wal_lsn() after the write and only use the replica once pg_last_wal_replay_lsn() has passed it.' },
    { id: 'fx-cancel-restore', kind: 'correct', text: 'Cancel Metabase query pid 24117 on the replica (pg_cancel_backend) and set max_standby_streaming_delay back to 30s in shopfast-pg15.', explanation: 'Replay resumes the moment the conflicting query ends and the replica catches up in seconds (the WAL is already on its disk). Restoring the parameter keeps one analytics query from freezing replication again.' },
    { id: 'fx-analytics-replica', kind: 'correct', text: 'Move Metabase to a dedicated analytics replica with its own parameter group; keep checkout-db-replica-1 on strict standby settings.', explanation: 'The durable fix for the conflict of interest: OLTP readers want a fresh replica, analysts want long-running snapshots. One replica cannot serve both; one parameter group must not be shared across roles.' },
    { id: 'fx-cancel-only', kind: 'partial', text: 'Cancel Metabase query pid 24117 with pg_cancel_backend and leave shopfast-pg15 and READS_FROM_REPLICA as they are.', explanation: 'Lag recovers within seconds, so the incident looks over — but max_standby_streaming_delay is still -1 (the next Metabase query freezes replication again) and confirmations still read from an asynchronous replica.' },
    { id: 'fx-feedback', kind: 'neutral', text: 'Set hot_standby_feedback = 1 in shopfast-pg15 so the primary\'s vacuum keeps the rows replica queries need and replay stops conflicting.', explanation: 'It would not release the conflict that is already waiting (that WAL record is already written), and on a replica shared with hour-long analytics queries it makes the primary keep dead rows in orders/order_items for the duration of those queries — table bloat and slower queries on the primary. A legitimate setting for a dedicated analytics replica, not a fix here.' },
    { id: 'fx-promote', kind: 'harmful', text: 'Promote checkout-db-replica-1 (aws rds promote-read-replica) so it stops applying WAL behind the primary and its lag drops to zero.', explanation: 'Promotion permanently breaks replication: the promoted instance stays frozen 15 minutes in the past and diverges from the primary, and you would need a new replica. Pointing anything at it would lose 15 minutes of orders.' },
    { id: 'fx-reboot-primary', kind: 'harmful', text: 'Reboot checkout-db with --force-failover to restart its walsender and re-establish streaming to checkout-db-replica-1 from a fresh LSN.', explanation: 'Causes a 1–2 minute write outage for all checkouts and does nothing for the replica: WAL is already streaming fine; replay is blocked by a query on the replica itself.' },
    { id: 'fx-cdn', kind: 'neutral', text: 'Create a CloudFront invalidation for /account/* and /api/v1/orders/* on distribution E2QX7R1LZ0WB4K to purge cached 404 responses.', explanation: 'Nothing is cached there — the 404s come from the API, which does not go through CloudFront. Harmless, but it costs time.' },
  ],

  hints: [
    'Follow a single order id through the logs: the request that created it and the request that could not find it. Which database did each one talk to?',
    'Order reads go to checkout-db-replica-1. How far behind is it, and is replay slow or stopped? Compare pg_stat_replication on the primary with now() - pg_last_xact_replay_timestamp() on the replica, then look at what is running on the replica.',
    'A Metabase query has been running for 47 minutes on the replica, and max_standby_streaming_delay was changed to -1 at 19:30 (CloudTrail / RDS events) — so replay waits for it forever. Combine that with READS_FROM_REPLICA=true (16:00) and you have the whole story.',
  ],

  debrief: {
    summary: `Two independent, individually reasonable changes combined. At **16:00** checkout-api was switched to \`READS_FROM_REPLICA=true\` to offload the primary before the Q4 sale. That sends \`GET /api/v1/orders/:id\` — including the confirmation page a customer loads one second after paying — to **checkout-db-replica-1**, an *asynchronous* streaming replica. With the usual ~0.4 s of lag, a small fraction of confirmations 404'd and worked on refresh (the "glitch" tickets from the afternoon).

At **19:30** a data engineer changed \`max_standby_streaming_delay\` from 30 s to **-1** in the parameter group \`shopfast-pg15\` — shared by the primary *and* the replica — because Metabase dashboards on the replica kept failing with "canceling statement due to conflict with recovery". At 20:23 a 47-minute Metabase revenue query started. At **20:55** autovacuum cleaned dead row versions in \`orders\` on the primary; when the replica reached that WAL record it had to choose between removing rows the Metabase snapshot might still need, or waiting. With -1 it waits forever: the startup process sits in \`RecoveryConflictSnapshot\` and **replay stops**, while WAL keeps arriving (write/flush lag in ms, replay lag growing 1 s per second).

From 20:55 every new order was invisible on the replica for ~15 minutes, so virtually every confirmation page showed "Order not found". The replica-lag alarm did fire at 21:00 — but it notifies a low-priority data-platform SNS topic, not on-call. The CloudFront change and the Redis eviction burst were unrelated.`,
    timeline: [
      { minutesAgo: FLAG, event: 'READS_FROM_REPLICA=true rolled out; a few confirmations 404 when they beat sub-second lag' },
      { minutesAgo: 178, event: 'Metabase queries on the replica keep being cancelled by recovery conflicts (30 s limit)' },
      { minutesAgo: 120, event: 'CloudFront /account/* caching disabled (red herring)' },
      { minutesAgo: PARAM, event: 'Data team sets max_standby_streaming_delay = -1 on shared parameter group shopfast-pg15' },
      { minutesAgo: QSTART, event: 'Metabase revenue query (pid 24117) starts on the replica' },
      { minutesAgo: CONFLICT, event: 'Autovacuum cleans orders; replay blocks behind the Metabase snapshot — lag starts growing 1 s/s' },
      { minutesAgo: 9.5, event: 'checkout-replica-lag-high → ALARM (routed to a low-priority data-platform topic)' },
      { minutesAgo: 8, event: 'checkout-order-notfound-high pages on-call' },
    ],
    concepts: [
      { title: 'Asynchronous streaming replication', body: 'The primary streams WAL to the replica, which (1) writes it, (2) flushes it to disk, and (3) **replays** it to make the changes visible. RDS read replicas are asynchronous: the primary commits without waiting for any of these steps. `pg_stat_replication` on the primary shows each stage: `write_lag`/`flush_lag` measure shipping, `replay_lag` measures visibility. Here shipping took milliseconds while replay was 15 minutes behind — the problem was on the replica, not the network.' },
      { title: 'Read-after-write consistency', body: 'Any read served by an async replica may be stale. That is fine for "browse products", not for "show me the order I just placed". Patterns: route reads to the primary for a while after a session writes (sticky-primary window); store the commit LSN (`pg_current_wal_lsn()`) in the session and only use a replica once `pg_last_wal_replay_lsn()` ≥ that LSN; or read your own write from the response of the write itself. Measure the share of reads that follow writes before moving them to a replica.' },
      { title: 'Hot standby recovery conflicts', body: 'On a replica, a running query holds a snapshot. If the WAL contains the removal of row versions that snapshot might need (VACUUM/pruning cleanup), an `ACCESS EXCLUSIVE` lock, or a dropped tablespace, the startup process must either **cancel the query** or **wait**. `max_standby_streaming_delay` (default 30 s) caps the wait; after that the query gets "canceling statement due to conflict with recovery". `-1` means wait indefinitely — one long query can stop replication. `pg_stat_database_conflicts` counts the cancellations, and `log_recovery_conflict_waits` logs waits longer than `deadlock_timeout`.' },
      { title: 'hot_standby_feedback trade-off', body: 'With `hot_standby_feedback = on` the replica tells the primary the oldest xmin it still needs, so the primary\'s VACUUM keeps those row versions and no snapshot conflicts happen. The cost moves to the primary: dead tuples in hot tables accumulate for as long as the longest replica query runs (bloat, slower index scans, more I/O). Reasonable for short queries, dangerous with hour-long analytics on a busy OLTP table.' },
      { title: 'Separate replicas (and parameter groups) per workload', body: 'OLTP read offload wants a replica with seconds of lag and short queries; analytics wants long, consistent snapshots. Give analytics its own replica — or better, a separate system (snapshot export, logical replication into a warehouse) — with its own parameter group. A parameter group shared by primary and replicas means any change applies to all of them.' },
    ],
    commands: [
      { cmd: 'SELECT application_name, state, write_lag, flush_lag, replay_lag, sent_lsn, replay_lsn FROM pg_stat_replication;', why: 'On the primary: is WAL shipping or replay behind?' },
      { cmd: 'SELECT now() - pg_last_xact_replay_timestamp() AS lag;', why: 'On the replica: how stale are reads right now (beware: grows on an idle primary too)' },
      { cmd: "SELECT pid, usename, application_name, wait_event, now() - query_start AS duration, query FROM pg_stat_activity WHERE state <> 'idle' ORDER BY query_start;", why: 'On the replica: long-running queries and the startup process waiting on RecoveryConflictSnapshot' },
      { cmd: 'SELECT * FROM pg_stat_database_conflicts;', why: 'How many queries recovery conflicts have cancelled (by type)' },
      { cmd: 'SHOW max_standby_streaming_delay; SHOW hot_standby_feedback;', why: 'The two settings that decide who wins a recovery conflict' },
      { cmd: 'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=ModifyDBParameterGroup', why: 'Who changed database parameters, and when' },
    ],
    prevention: [
      'Never route read-after-write paths to an asynchronous replica without read-your-writes (sticky primary window or LSN tracking); test with injected replica lag.',
      'Dedicated analytics replica (or warehouse) with its own parameter group; the application replica keeps max_standby_streaming_delay ≤ 30 s.',
      'Parameter groups per role, managed in Terraform with review — no console changes to shared production parameters.',
      'Route checkout-replica-lag-high to the on-call rotation that owns replica readers, and alert on lag that grows linearly (replay stopped).',
      'Have the app fall back to the primary (and emit a metric) when the replica is more than N seconds behind or a just-written order is not found.',
    ],
    reading: [
      { title: 'PostgreSQL: Hot Standby — handling query conflicts', url: 'https://www.postgresql.org/docs/current/hot-standby.html#HOT-STANDBY-CONFLICT' },
      { title: 'PostgreSQL: pg_stat_replication view', url: 'https://www.postgresql.org/docs/current/monitoring-stats.html#MONITORING-PG-STAT-REPLICATION-VIEW' },
      { title: 'Amazon RDS: Working with PostgreSQL read replicas', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PostgreSQL.Replication.ReadReplicas.html' },
    ],
  },
};

export default incident;
