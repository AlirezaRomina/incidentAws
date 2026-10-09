import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { pgTime } from '../engine/time';
import { database, ev, injectLog, logGroup, panel, setAlarm, setPoints, spread } from '../env/helpers';
import { APP_HOSTS, hostMeta } from '../env/base';

const ORDERS_Q =
  'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT $3';

const START = 47; // minutes ago: deploy + migration

const incident: Incident = {
  id: 'checkout-slow-query',
  code: 'INC-4127',
  order: 4,
  title: 'Checkout API is extremely slow',
  teaser: 'Evening peak. Checkout and order history take 5–10 seconds. Nothing is "down".',
  difficulty: 'intermediate',
  tags: ['RDS', 'PostgreSQL', 'Indexes', 'Migrations'],
  parMinutes: 15,
  seed: 4127,
  now: '2026-10-08T19:47:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-alb-p99-latency-high — TargetResponseTime p99 > 2 s',
      details: 'shopfast-prod-alb p99 TargetResponseTime has been above 2 s for 5 consecutive minutes (current 6.9 s). Runbook: https://wiki.shopfast.internal/runbooks/checkout-latency',
      minutesAgo: 39,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4127', message: 'We have ~40 tickets in the last half hour saying checkout "spins forever". A few people say they were charged but the page timed out. Order history page is also super slow.', minutesAgo: 31 },
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-4127', message: 'We shipped checkout-api 2.14.0 around 19:00 (order history sorting). Deploy went green. App hosts look fine to me, CPU is normal-ish?', minutesAgo: 24 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4127', message: "You're IC. Marketing email went out at 18:30 so traffic is a bit higher than usual — could that be it? Please find the cause before we start throwing hardware at it.", minutesAgo: 20 },
    ],
    impact: 'Checkout p99 ~7 s, order history ~5 s. Conversion down ~35% vs. last Wednesday. No full outage.',
    services: ['checkout-api', 'checkout-db (RDS PostgreSQL)', 'shopfast-prod-alb'],
  },

  build(env) {
    // ---------------- Metrics ----------------
    setPoints(env, 'alb.latency', series('lat', 0.41, { noise: 0.1 }).wave(0.05).rampTo(START - 1, 6.9, 5).clamp(0).round(3).build());
    setPoints(env, 'app.checkoutLatency', series('chk', 380, { noise: 0.1 }).rampTo(START - 1, 7400, 5).clamp(0).round(0).build());
    setPoints(env, 'rds.cpu', series('dbcpu', 24, { noise: 0.06 }).wave(0.05).rampTo(START - 1, 96, 4).clamp(0, 100).build());
    setPoints(env, 'rds.connections', series('dbconn', 64, { noise: 0.04 }).rampTo(START - 1, 126, 3).clamp(0).round(0).build());
    setPoints(env, 'rds.readiops', series('riops', 310, { noise: 0.15 }).rampTo(START - 1, 1240, 3).clamp(0).round(0).build());
    setPoints(env, 'rds.readlatency', series('rlat', 0.9, { noise: 0.15 }).rampTo(START - 1, 1.6, 3).clamp(0).round(2).build());
    setPoints(env, 'alb.target5xx', series('t5xx', 1.2, { noise: 0.9 }).rampTo(START - 3, 11, 6).clamp(0).round(0).build());
    setPoints(env, 'alb.requests', series('req', 2380, { noise: 0.05 }).rampTo(77, 2760, 10).rampTo(START - 2, 2210, 8).clamp(0).round(0).build());
    setPoints(env, 'app.orders', series('orders', 61, { noise: 0.15 }).rampTo(77, 72, 10).rampTo(START - 2, 41, 6).clamp(0).round(0).build());
    // red herring: tiny bump in Redis evictions from the marketing email traffic
    setPoints(env, 'cache.evictions', series('evict', 0.2, { noise: 1 }).rampTo(75, 6, 5).clamp(0).round(0).build());
    panel(env, 'cache.evictions').featured = true;
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', series(`appcpu-${h}`, 18 + i, { noise: 0.1 }).rampTo(77, 24 + i, 10).rampTo(START - 2, 15 + i, 4).clamp(0, 100).build(), h);
    }
    setAlarm(env, 'checkout-alb-p99-latency-high', 'ALARM', 39);
    setAlarm(env, 'checkout-latency-p99-high', 'ALARM', 40);
    setAlarm(env, 'checkout-db-cpu-high', 'ALARM', 41);

    // ---------------- Traffic / logs ----------------
    env.traffic.profile = (_h, m) => (m <= START - 1 ? { p50Ms: 2300, errorRate: 0.008, errorStatus: 504, errorUpstream: '30.001', errorMsg: 'upstream request timeout' } : m <= 77 ? { rpm: 8 } : {});
    for (const [i, h] of APP_HOSTS.entries()) {
      const meta = hostMeta[h];
      injectLog(
        env,
        h,
        '/var/log/checkout-api/app.log',
        spread(env, START - 2 - i * 0.41, 0.2 + i * 0.29, 26, (k, ts) =>
          JSON.stringify({ level: 40, time: new Date(ts).toISOString(), pid: env.hosts[h].services['checkout-api'].mainPid, hostname: meta.hostname, reqId: `req-${(0x3a1f00 + k * 977 + i * 31).toString(16)}`, msg: 'slow query', durationMs: 2100 + ((k * 397 + i * 211) % 1900), query: ORDERS_Q, route: k % 3 === 0 ? 'POST /api/v1/checkout' : 'GET /api/v1/orders' }),
        ),
      );
      injectLog(env, h, '/var/log/checkout-api/app.log', [
        ev(env, START + 0.5, JSON.stringify({ level: 30, time: new Date(env.now - (START + 0.5) * 60000).toISOString(), pid: env.hosts[h].services['checkout-api'].mainPid, hostname: meta.hostname, msg: 'checkout-api v2.14.0 listening on 127.0.0.1:3000' })),
      ]);
      for (const h2 of [h]) env.hosts[h2].env.APP_VERSION = '2.14.0';
      env.hosts[h].services['checkout-api'].since = env.hosts[h].services['checkout-api'].since.replace(/; .*$/, '; 47min ago');
    }

    const pg = logGroup(env, '/aws/rds/instance/checkout-db/postgresql');
    const t = (m: number) => pgTime(env.now - m * 60000);
    pg.events.push(
      ev(env, START, `${t(START)}:10.0.11.204(41822):checkout_migrator@checkout:[23011]:LOG:  statement: SET lock_timeout = '5s'`),
      ev(env, START - 0.01, `${t(START - 0.01)}:10.0.11.204(41822):checkout_migrator@checkout:[23011]:LOG:  statement: DROP INDEX IF EXISTS idx_orders_customer_id_status`),
      ev(env, START - 0.03, `${t(START - 0.03)}:10.0.11.204(41822):checkout_migrator@checkout:[23011]:LOG:  statement: CREATE INDEX CONCURRENTLY idx_orders_customer_status_created ON orders (customer_id, status, created_at DESC)`),
      ev(env, START - 0.12, `${t(START - 0.12)}:10.0.11.204(41822):checkout_migrator@checkout:[23011]:ERROR:  canceling statement due to lock timeout`),
      ev(env, START - 0.121, `${t(START - 0.121)}:10.0.11.204(41822):checkout_migrator@checkout:[23011]:STATEMENT:  CREATE INDEX CONCURRENTLY idx_orders_customer_status_created ON orders (customer_id, status, created_at DESC)`),
      ...spread(env, START - 1, 0.3, 34, (k, ts) => `${pgTime(ts)}:10.0.1${k % 2}.${[23, 87, 142][k % 3]}(${51200 + k * 13}):checkout_app@checkout:[${18300 + k * 7}]:LOG:  duration: ${(2050 + ((k * 431) % 1700)).toFixed(3)} ms  execute <unnamed>: ${ORDERS_Q}`),
    );
    pg.events.push(ev(env, 64, `${t(64)}::@:[612]:LOG:  checkpoint starting: time`));

    // ---------------- Database ----------------
    const db = database(env, 'checkout-db');
    db.tables.orders = db.tables.orders.replace(
      '    "idx_orders_customer_id_status" btree (customer_id, status)\n',
      '    "idx_orders_customer_status_created" btree (customer_id, status, created_at DESC) INVALID\n',
    );
    db.statements = db.statements.map(s =>
      s.query.startsWith('SELECT o.id') ? { ...s, calls: 1893012 + 61840, totalMs: 3218120 + 61840 * 2418.4, meanMs: 2418.37, rows: 9844112 + 301220 } : s,
    );
    db.explains = [
      {
        match: /from\s+orders.*customer_id/is,
        output: `                                                          QUERY PLAN
--------------------------------------------------------------------------------------------------------------------------------
 Limit  (cost=212418.33..212418.38 rows=20 width=58) (actual time=2391.442..2391.447 rows=20 loops=1)
   ->  Sort  (cost=212418.33..212418.58 rows=98 width=58) (actual time=2391.440..2391.443 rows=20 loops=1)
         Sort Key: created_at DESC
         Sort Method: top-N heapsort  Memory: 27kB
         ->  Seq Scan on orders o  (cost=0.00..212415.72 rows=98 width=58) (actual time=14.211..2391.102 rows=112 loops=1)
               Filter: ((customer_id = 4412093) AND (status = 'completed'::text))
               Rows Removed by Filter: 8412227
 Planning Time: 0.188 ms
 Execution Time: 2391.508 ms
(9 rows)`,
      },
    ];
    // pg_stat_activity: lots of active sessions running the same query
    const activity = [];
    const clients = ['10.0.10.23', '10.0.11.87', '10.0.10.142'];
    for (let k = 0; k < 126; k++) {
      const isActive = k % 4 !== 3;
      const dur = isActive ? 0.3 + ((k * 0.37) % 2.6) : 0.001;
      activity.push({
        pid: 18200 + k * 3,
        usename: k > 118 ? 'worker' : 'checkout_app',
        application: k > 118 ? 'shopfast-worker' : 'checkout-api',
        client: k > 118 ? '10.0.11.204' : clients[k % 3],
        state: isActive ? 'active' : 'idle',
        waitEvent: isActive ? (k % 5 === 0 ? 'IO: DataFileRead' : '') : 'Client: ClientRead',
        queryStart: pgTime(env.now - dur * 1000),
        duration: `00:00:0${dur.toFixed(3)}`.replace(/0(\d\d\.)/, '$1'),
        query: isActive ? ORDERS_Q : 'COMMIT',
      });
    }
    db.activity = activity;
    db.queries.push({
      match: /pg_stat_user_tables/i,
      output: ` relname     | n_live_tup | seq_scan | seq_tup_read | idx_scan  | n_dead_tup | last_autovacuum
-------------+------------+----------+--------------+-----------+------------+-------------------------------
 order_items |   21880412 |        3 |     48211002 | 902311871 |      14211 | 2026-10-08 18:11:42.101+00
 orders      |    8412339 |    61877 | 520499913201 | 412220913 |      31922 | 2026-10-08 16:40:03.518+00
 customers   |    1904221 |        2 |      3808442 | 221009221 |       2210 | 2026-10-07 22:14:51.009+00
 payments    |    7801233 |        4 |     31204932 | 690331002 |       9120 | 2026-10-08 12:02:19.776+00
(4 rows)`,
    });
    db.queries.push({
      match: /indisvalid|pg_index\b/i,
      output: `            indexrelid              | indisvalid | indisready
------------------------------------+------------+------------
 orders_pkey                        | t          | t
 orders_public_id_key               | t          | t
 idx_orders_created_at              | t          | t
 idx_orders_customer_status_created | f          | f
(4 rows)`,
    });

    env.rds.topSql['checkout-db'] = [
      { sql: ORDERS_Q, calls: 1290, meanMs: 2418.4, loadAas: 31.4, rowsPerCall: 5.1, waitEvent: 'CPU' },
      { sql: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)', calls: 3020, meanMs: 4.1, loadAas: 0.21, rowsPerCall: 3, waitEvent: 'CPU' },
      { sql: 'INSERT INTO orders (public_id, customer_id, status, total_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING id', calls: 228, meanMs: 6.2, loadAas: 0.02, rowsPerCall: 1, waitEvent: 'IO:WALWrite' },
      { sql: 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', calls: 510, meanMs: 2.0, loadAas: 0.02, rowsPerCall: 1, waitEvent: 'CPU' },
    ];

    // ---------------- Changes ----------------
    env.changes.unshift({
      id: 'chg-8823',
      minutesAgo: START + 1,
      kind: 'deploy',
      service: 'checkout-api',
      title: 'checkout-api 2.14.0 — order history sorted by date + index migration',
      author: 'li.wang',
      status: 'succeeded',
      version: '2.14.0',
      description: 'Pipeline: build ✔ · migrate ✔ (1 warning) · rolling deploy ✔. Migration 20261008185500_orders_history_index applied by checkout_migrator from worker-1.',
      diff: `diff --git a/migrations/20261008185500_orders_history_index.sql b/migrations/20261008185500_orders_history_index.sql
new file mode 100644
--- /dev/null
+++ b/migrations/20261008185500_orders_history_index.sql
@@ -0,0 +1,9 @@
+-- Replace the (customer_id, status) index with one that also covers
+-- ORDER BY created_at DESC so order history avoids a sort.
+SET lock_timeout = '5s';
+DROP INDEX IF EXISTS idx_orders_customer_id_status;
+
+-- migrate:no-transaction
+CREATE INDEX CONCURRENTLY idx_orders_customer_status_created
+    ON orders (customer_id, status, created_at DESC);
+-- migrate:continue-on-error   (TODO: remove once runner handles CONCURRENTLY)`,
    });
    env.changes.unshift({
      id: 'chg-8822',
      minutesAgo: 77,
      kind: 'config',
      service: 'marketing',
      title: 'Braze campaign "Autumn Flash Sale" sent to 1.2M subscribers',
      author: 'growth-team',
      status: 'succeeded',
      description: 'Expected +15–20% traffic for ~2 hours.',
    });
  },

  evidence: [
    {
      id: 'slow-orders-query',
      label: 'The order-history query on `orders` averages ~2.4 s (was ~1.7 ms)',
      kind: 'key',
      match: /(orders o WHERE o\.customer_id = \$1 AND o\.status = \$2)/,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', 'SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5;'] },
      explanation: 'pg_stat_statements / Performance Insights show one statement consuming almost all database time: ~31 average active sessions on a 2-vCPU instance. Everything else is fast.',
    },
    {
      id: 'seq-scan',
      label: 'EXPLAIN ANALYZE: Seq Scan on orders, 8.4M rows removed by filter',
      kind: 'key',
      match: /Seq Scan on orders|Rows Removed by Filter: 84\d{5}/,
      foundBy: { tool: 'terminal', host: 'bastion', command: ['psql -h db.internal.shopfast.io -U ops_readonly checkout', `EXPLAIN ANALYZE ${ORDERS_Q.replace('$1', '4412093').replace('$2', "'completed'").replace('$3', '20')};`] },
      explanation: 'The planner reads every row of the 8.4M-row table to return 20. That is what an index would normally prevent.',
    },
    {
      id: 'index-gone',
      label: 'Index idx_orders_customer_id_status was dropped; its replacement is INVALID',
      kind: 'key',
      match: /INVALID|DROP INDEX[^\n]*idx_orders_customer_id_status|idx_orders_customer_status_created\s*\|\s*f/,
      foundBy: { tool: 'deploys' },
      explanation: 'The 2.14.0 migration dropped the working index first, then CREATE INDEX CONCURRENTLY hit the 5 s lock_timeout and was cancelled — leaving an INVALID index the planner will never use. The runner continued on error, so the pipeline went green.',
    },
    {
      id: 'migration-error',
      label: 'Postgres log: CREATE INDEX CONCURRENTLY cancelled due to lock timeout',
      kind: 'supporting',
      match: /canceling statement due to lock timeout|STATEMENT:\s+CREATE INDEX CONCURRENTLY/,
      foundBy: { tool: 'logs', group: '/aws/rds/instance/checkout-db/postgresql' },
      explanation: 'The database itself recorded the failed index build at 19:00 — the exact moment latency jumped.',
    },
    {
      id: 'db-cpu',
      label: 'checkout-db CPU jumped from ~24% to ~96% at 19:00',
      kind: 'supporting',
      match: /CPUUtilization \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.cpu' },
      explanation: 'CPU saturation is the symptom: scanning millions of in-memory rows per request is CPU work. It tells you where to look, not why.',
    },
    {
      id: 'alb-latency',
      label: 'ALB p99 latency rose from 0.4 s to ~7 s',
      kind: 'supporting',
      match: /TargetResponseTime \[shopfast-prod-alb\]/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.latency' },
      explanation: 'Confirms user impact and gives you the start time (≈19:00) to correlate with changes.',
    },
    {
      id: 'evictions',
      label: 'Redis evictions ticked up',
      kind: 'red-herring',
      match: /Evictions \[checkout-cache-001\]/,
      foundBy: { tool: 'cloudwatch', panel: 'cache.evictions' },
      explanation: 'A handful of evictions per minute (from the marketing traffic) cannot explain a 20× latency increase, and they started 30 minutes earlier than the latency.',
    },
    {
      id: 'catalog-deploy',
      label: 'catalog-service 1.42.0 deploy',
      kind: 'red-herring',
      match: /catalog-service 1\.42\.0/,
      foundBy: { tool: 'deploys' },
      explanation: 'A different service on different infrastructure (ECS), deployed hours before the regression.',
    },
  ],

  rootCauses: [
    { id: 'rc-index', correct: true, text: 'The 2.14.0 migration dropped idx_orders_customer_id_status and its CREATE INDEX CONCURRENTLY replacement was cancelled (left INVALID), so the order-history query seq-scans 8.4M rows and pins RDS CPU.', explanation: 'Every layer of evidence lines up: one query dominates DB load, its plan is a Seq Scan, the index it used is gone and the replacement is invalid — all starting at the 19:00 migration.' },
    { id: 'rc-missing-index', partial: true, text: 'The orders table has grown past the point where the order-history query can be served efficiently and needs an additional composite index on (customer_id, status).', explanation: 'Close, but it misses why it started at 19:00: the index existed until the migration dropped it, and the failed CONCURRENTLY build left an INVALID index behind (which you must drop before rebuilding).' },
    { id: 'rc-capacity', text: 'The 18:30 marketing email pushed evening traffic beyond what a 2-vCPU db.r6g.large can serve; CPU saturation at 96% is a capacity limit and checkout-db needs a larger instance class.', explanation: 'Traffic rose ~15% starting at 18:30 — but latency only jumped at 19:00 and request volume actually fell afterwards. A 15% increase cannot make one query 1,400× slower.' },
    { id: 'rc-redis', text: 'Redis started evicting keys under the sale traffic, so product and cart lookups miss the cache and fall through to checkout-db, multiplying read load and IOPS on the primary.', explanation: 'Evictions are tiny, cache hit rate is unchanged at ~94%, and the hot query is not one the cache serves.' },
    { id: 'rc-pool', text: "checkout-api's connection pool (DB_POOL_MAX=20 × 2 workers per host) is too small for peak, so requests queue inside Node waiting for a free connection and time out at the ALB.", explanation: 'Pools are full because each query takes 2.4 s. The pool is a victim; enlarging it would push more concurrent seq scans onto a CPU-bound database.' },
    { id: 'rc-catalog', text: 'The catalog-service 1.42.0 deploy rewrote product image URLs, and the extra product lookups it triggers on every page view are overloading the shared checkout-db.', explanation: 'catalog-service runs separately on ECS, was deployed hours earlier and does not query checkout-db.' },
  ],

  fixes: [
    { id: 'fx-rebuild', kind: 'correct', text: 'Drop the INVALID index and rebuild it with CREATE INDEX CONCURRENTLY (outside a transaction, with no short lock_timeout), watching pg_stat_progress_create_index until it is valid.', explanation: 'This restores an index the planner can use without blocking writes. Builds on 8.4M rows take minutes, and CPU will recover the moment it becomes valid.' },
    { id: 'fx-migrations', kind: 'correct', text: 'Fix the migration process: create the new index before dropping the old one (expand → contract), and fail the deploy on any migration error or invalid index (pg_index.indisvalid = false).', explanation: 'The incident was caused by ordering (drop first) plus a runner that ignored errors. Expand/contract and hard failures prevent the repeat.' },
    { id: 'fx-alarm', kind: 'partial', text: 'Add alerting on query performance (pg_stat_statements / Performance Insights top-SQL load, or slow-query log rate).', explanation: 'Useful for faster detection next time, but it does not fix this incident.' },
    { id: 'fx-scale', kind: 'partial', text: 'Scale checkout-db up to a larger instance class (e.g. db.r6g.4xlarge).', explanation: 'More CPU would dull the pain but costs money, triggers a Multi-AZ failover during the change, and a sequential scan per request still scales linearly with table size.' },
    { id: 'fx-rollback', kind: 'neutral', text: 'Roll checkout-api back to 2.13.1.', explanation: 'Rolling back the application does not roll back the schema: the dropped index stays dropped. Rollbacks must include the database change.' },
    { id: 'fx-pool', kind: 'harmful', text: 'Raise DB_POOL_MAX from 20 to 100 so requests stop waiting for connections.', explanation: 'More concurrent sequential scans on a CPU-saturated database makes every query slower and risks exhausting max_connections.' },
    { id: 'fx-vacuum', kind: 'harmful', text: 'Run VACUUM FULL orders to make the scans faster.', explanation: 'VACUUM FULL rewrites the table under an ACCESS EXCLUSIVE lock — it would block every read and write on orders (a full checkout outage) for many minutes, and does not add an index.' },
    { id: 'fx-flush', kind: 'neutral', text: 'Flush the Redis cache to clear the evictions.', explanation: 'Unrelated to the problem — and a cold cache would briefly add even more database load.' },
  ],

  hints: [
    'Work from the outside in: ALB latency → application → database. Which component\'s metrics changed first, and what was deployed right before that moment?',
    'Find out which queries are consuming the database\'s time (RDS → Performance Insights, or pg_stat_statements via psql from the bastion). Then ask the planner how it executes the worst one with EXPLAIN ANALYZE.',
    'A sequential scan over millions of rows usually means an index is missing or unusable. Compare `\\d orders` with the migration that shipped in checkout-api 2.14.0.',
  ],

  debrief: {
    summary: `At 19:00 the checkout-api **2.14.0** deploy ran a migration that dropped \`idx_orders_customer_id_status\` and then tried to build a better index with \`CREATE INDEX CONCURRENTLY\`. Because the migration set \`lock_timeout = '5s'\` and evening traffic held locks on \`orders\`, the build was cancelled. A failed concurrent build does not disappear — it leaves an **INVALID** index that the planner ignores. The migration runner was configured to continue on error, so the pipeline went green.

From that moment the order-history query (also used by checkout's fraud check) had no usable index and fell back to a **sequential scan of 8.4 million rows** to return 20. Each call took ~2.4 s of CPU, ~31 sessions were running it concurrently on a 2-vCPU instance, CPU pinned at 96%, connection pools filled, and ALB p99 latency went from 0.4 s to ~7 s.

The marketing email, Redis evictions and the catalog deploy were all real, but none of them lined up with the 19:00 step change or explained why a single query became 1,400× slower.`,
    timeline: [
      { minutesAgo: 77, event: 'Marketing email sent; traffic +15% (red herring)' },
      { minutesAgo: 48, event: 'checkout-api 2.14.0 pipeline starts' },
      { minutesAgo: 47, event: 'Migration drops idx_orders_customer_id_status; CREATE INDEX CONCURRENTLY cancelled by lock timeout → INVALID index' },
      { minutesAgo: 46, event: 'Order-history query switches to Seq Scan; RDS CPU climbs to 96%' },
      { minutesAgo: 41, event: 'checkout-db-cpu-high alarm' },
      { minutesAgo: 39, event: 'checkout-alb-p99-latency-high pages on-call' },
    ],
    concepts: [
      { title: 'Why an index matters', body: 'A B-tree index on `(customer_id, status)` lets PostgreSQL jump straight to one customer\'s rows in O(log n) — a handful of page reads. Without it, the only option is to read every row and filter (O(n)). On 8.4M rows that is ~2.4 s of CPU per call, and the cost keeps growing as the table grows.' },
      { title: 'Reading EXPLAIN ANALYZE', body: '`Seq Scan on orders` with `Rows Removed by Filter: 8412227` to return 112 rows is the smoking gun. Compare estimated vs. actual rows and look for the node where most of the `actual time` is spent. A healthy plan here is `Index Scan using idx_… on orders` taking well under a millisecond.' },
      { title: 'CREATE INDEX CONCURRENTLY and INVALID indexes', body: 'CONCURRENTLY builds an index without blocking writes, but it cannot run inside a transaction and it waits for existing transactions. If it fails or is cancelled, PostgreSQL leaves the index marked INVALID (`pg_index.indisvalid = false`): it is maintained on writes (costing you) but never used for reads. You must DROP it and build again.' },
      { title: 'Expand / contract migrations', body: 'Never remove the old structure before the new one is proven. Expand: create the new index (concurrently) and verify it is valid. Migrate: ship code that benefits from it. Contract: drop the old index in a later release. Each step is independently safe to roll back.' },
      { title: 'CPU is a symptom, not a cause', body: 'High DB CPU tells you the database is busy, not why. Performance Insights and `pg_stat_statements` attribute load to individual statements — always find out *what* is consuming the resource before scaling it.' },
    ],
    commands: [
      { cmd: "SELECT query, calls, mean_exec_time FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 5;", why: 'Which statements consume the most database time' },
      { cmd: 'EXPLAIN ANALYZE <query>;', why: 'How the planner actually executes a query, with real timings' },
      { cmd: '\\d orders', why: 'Table columns and indexes (INVALID indexes are flagged here)' },
      { cmd: 'SELECT indexrelid::regclass, indisvalid FROM pg_index WHERE indrelid = \'orders\'::regclass;', why: 'Check index validity explicitly' },
      { cmd: "SELECT state, count(*) FROM pg_stat_activity GROUP BY state;", why: 'How many sessions are active vs. idle' },
    ],
    prevention: [
      'Run migrations expand → contract: add the new index, verify `indisvalid`, then drop the old one in a later deploy.',
      'Make the migration runner fail the pipeline on any error; never "continue on error" for DDL.',
      'Alert on top-SQL load (Performance Insights) or slow-query rate, not just CPU.',
      'Test migrations against a production-sized snapshot to see lock behaviour and build times.',
      'Include schema state in rollback plans — rolling back code does not restore a dropped index.',
    ],
    reading: [
      { title: 'PostgreSQL: Building Indexes Concurrently', url: 'https://www.postgresql.org/docs/current/sql-createindex.html#SQL-CREATEINDEX-CONCURRENTLY' },
      { title: 'Using EXPLAIN', url: 'https://www.postgresql.org/docs/current/using-explain.html' },
      { title: 'Amazon RDS Performance Insights', url: 'https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PerfInsights.html' },
    ],
  },
};

export default incident;
