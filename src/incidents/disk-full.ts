import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, iso, isoSec, nginxErrTime, nginxTime, syslogTime, systemdTime } from '../engine/time';
import { createRng, hex } from '../engine/rng';
import { addPanel, ev, host, injectLog, panel, setAlarm, setPoints, spread } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-3981 — app-2's root volume is full.
 *
 * Yesterday 14:52 UTC li.wang switched LOG_LEVEL=debug on app-2 only (SSM Run Command) to chase
 * a EUR tax-rounding bug and never reverted it. In debug mode checkout-api also writes
 * /var/log/checkout-api/debug.log, which the logrotate config does not cover (it only matches
 * app.log). ~37 GB later the 50 GB root volume filled at ~05:50. Since then every write on app-2
 * is a lottery: nginx cannot buffer request bodies to disk, checkout-api cannot write invoice
 * PDFs to /tmp, so POST /api/v1/checkout fails with 500 on app-2 (≈1/3 of traffic). /health
 * never touches the disk, so the ALB keeps app-2 in rotation.
 */

const DEBUG_START = 1171; // minutes ago: Mon 14:52 UTC, LOG_LEVEL=debug on app-2
const DISK_85 = 455; // minutes ago: crosses 85 % → alarm (email only)
const DISK_FULL = 273; // minutes ago: 05:50 UTC, 100 %
const APP2_PID = 61207; // checkout-api restarted by the SSM command yesterday
const DEBUG_LOG = '/var/log/checkout-api/debug.log';
const DEBUG_BYTES = 39_728_447_488; // 37.0 GiB

const LOGROTATE_CHECKOUT = `# Managed by ansible (role: checkout-api) — do not edit by hand
/var/log/checkout-api/app.log {
    daily
    rotate 7
    dateext
    compress
    delaycompress
    missingok
    notifempty
    maxsize 500M
    copytruncate
}
`;

const LOGROTATE_NGINX = `/var/log/nginx/*.log {
    create 0640 nginx root
    daily
    rotate 10
    missingok
    notifempty
    compress
    delaycompress
    sharedscripts
    postrotate
        /bin/kill -USR1 \`cat /run/nginx.pid 2>/dev/null\` 2>/dev/null || true
    endscript
}
`;

const incident: Incident = {
  id: 'disk-full',
  code: 'INC-3981',
  order: 1,
  title: 'Some customers can’t check out',
  teaser: 'About a third of checkouts fail with a 500 since early morning. Retrying sometimes works. No alarm paged anyone.',
  difficulty: 'beginner',
  tags: ['Linux', 'Disk', 'Logging', 'nginx'],
  parMinutes: 10,
  seed: 3981,
  now: '2026-10-06T10:23:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[Manual] Checkout failing for a subset of customers',
      details: 'Triggered by jade.morales from Slack (/pd trigger). 71 Zendesk tickets tagged "checkout-error" since 06:00 UTC. No CloudWatch alarm paged on-call. Runbook: https://wiki.shopfast.internal/runbooks/checkout-errors',
      minutesAgo: 14,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-3981', message: 'Started as a trickle around 6am, now it’s a flood. Customers press "Place order" and get "Something went wrong, please try again". Most of them say it works on the 2nd or 3rd try, so it’s not everyone. Browsing and the cart seem fine.', minutesAgo: 13 },
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-3981', message: 'Nothing was deployed today — last checkout-api release was 2.13.1 yesterday morning and it’s been quiet since. ALB says all 3 targets are healthy. Could PayBridge be flaky again?', minutesAgo: 10 },
      { from: 'Priya Natarajan', role: 'SRE', channel: '#incident-3981', message: 'Target 5xx on the ALB is up to ~30/min but under the 50/min alarm threshold, which is why nothing paged. app-1 CPU is a bit higher than the other two, fwiw. You have IC — I’m on the PayBridge status page.', minutesAgo: 7 },
    ],
    impact: '≈30% of checkout attempts fail with HTTP 500 since ~05:50 UTC. Orders are ~25% below a normal Tuesday morning. Retries usually succeed.',
    services: ['checkout-api', 'nginx', 'shopfast-prod-alb / checkout-api-tg'],
  },

  build(env) {
    const rng = createRng(3981);
    const app2 = host(env, 'app-2');
    const m2 = hostMeta['app-2'];
    const t = (m: number) => env.now - m * MIN;

    /* ---------------- Metrics ---------------- */
    // Disk: 30 h view (10-minute period) so the climb since yesterday afternoon is visible.
    const disk = panel(env, 'ec2.disk');
    disk.periodMinutes = 10;
    disk.featured = true;
    for (const [i, h] of APP_HOSTS.entries()) {
      const base = 23.2 + i * 1.4;
      const pts =
        h === 'app-2'
          ? series('disk-app-2', 26, { noise: 0.002, periodMinutes: 10 }).rampTo(DEBUG_START, 100, DEBUG_START - DISK_FULL).clamp(0, 100).round(1).build()
          : series(`disk-${h}`, base, { noise: 0.004, periodMinutes: 10 }).round(1).build();
      setPoints(env, 'ec2.disk', pts, h);
    }
    setAlarm(env, 'checkout-app-disk-used-high', 'ALARM', DISK_85);

    // Target 5xx: below the 50/min alarm threshold the whole time.
    setPoints(env, 'alb.target5xx', series('t5xx', 29, { noise: 0.28 }).wave(0.12).clamp(0).round(0).build());
    // Per-AZ view: app-2 is the only target in us-east-1b.
    addPanel(env, {
      id: 'alb.target5xx.az',
      group: 'Application Load Balancer',
      namespace: 'AWS/ApplicationELB',
      metric: 'HTTPCode_Target_5XX_Count',
      resource: 'checkout-api-tg (by AvailabilityZone)',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 10,
      featured: true,
      series: [
        { name: 'us-east-1a', points: series('az-a-5xx', 9, { noise: 0.9, periodMinutes: 10 }).clamp(0).round(0).build() },
        { name: 'us-east-1b', points: series('az-b-5xx', 5, { noise: 0.14, periodMinutes: 10 }).rampTo(DISK_FULL, 290, 10).wave(0.08, 600).clamp(0).round(0).build() },
      ],
    });
    setPoints(env, 'app.orders', series('orders', 46, { noise: 0.16 }).clamp(0).round(0).build());
    setPoints(env, 'alb.requests', series('req', 2290, { noise: 0.05 }).wave(0.06).clamp(0).round(0).build());
    // Red herring: app-1 runs a bit hotter (noisy neighbour / uneven keep-alive distribution).
    setPoints(env, 'ec2.cpu', series('cpu-app-1', 29, { noise: 0.12 }).wave(0.08).clamp(0, 100).build(), 'app-1');
    setPoints(env, 'ec2.cpu', series('cpu-app-2', 17, { noise: 0.12 }).wave(0.08).clamp(0, 100).build(), 'app-2');
    setPoints(env, 'ec2.cpu', series('cpu-app-3', 20, { noise: 0.12 }).wave(0.08).clamp(0, 100).build(), 'app-3');
    host(env, 'app-1').cpu = { cores: 2, user: 24.1, system: 4.2, iowait: 0.1, steal: 0.6, idle: 71.0 };
    host(env, 'app-1').load = [0.91, 0.88, 0.84];

    /* ---------------- app-2: the full disk ---------------- */
    app2.disks[0].usedGb = 50;
    app2.disks[0].inodesUsedPct = 4;
    app2.du['/'] = [['2.9G', '/usr'], ['39G', '/var'], ['5.6G', '/opt'], ['412M', '/home'], ['78M', '/etc'], ['50G', '/']];
    app2.du['/var'] = [['38G', '/var/log'], ['1.1G', '/var/lib'], ['388M', '/var/cache'], ['16K', '/var/tmp'], ['39G', '/var']];
    app2.du['/var/log'] = [['1.3G', '/var/log/journal'], ['421M', '/var/log/nginx'], ['37G', '/var/log/checkout-api'], ['21M', '/var/log/amazon'], ['3.2M', '/var/log/messages'], ['38G', '/var/log']];
    app2.du['/var/log/checkout-api'] = [
      ['191M', '/var/log/checkout-api/app.log'],
      ['22M', '/var/log/checkout-api/app.log-20261003.gz'],
      ['23M', '/var/log/checkout-api/app.log-20261004.gz'],
      ['158M', '/var/log/checkout-api/app.log-20261005'],
      ['37G', DEBUG_LOG],
      ['37G', '/var/log/checkout-api'],
    ];

    // Log directories on every app host (sizes + mtimes for ls -lh).
    for (const h of APP_HOSTS) {
      const hh = host(env, h);
      const mt = (m: number) => `Oct  ${new Date(t(m)).getUTCDate()} ${new Date(t(m)).toISOString().slice(11, 16)}`;
      hh.files['/etc/logrotate.d/checkout-api'] = LOGROTATE_CHECKOUT;
      hh.files['/etc/logrotate.d/nginx'] = LOGROTATE_NGINX;
      hh.fileMeta['/etc/logrotate.d/checkout-api'] = { size: LOGROTATE_CHECKOUT.length, mtime: 'Sep 18 09:12' };
      hh.fileMeta['/etc/logrotate.d/nginx'] = { size: LOGROTATE_NGINX.length, mtime: 'Sep 18 09:12' };
      hh.fileMeta['/var/log/checkout-api/app.log'] = { size: 199_884_120 + (h === 'app-2' ? 0 : -12_400_000), mtime: mt(0.5) };
      hh.fileMeta['/var/log/checkout-api/app.log-20261003.gz'] = { size: 23_011_442, mtime: 'Oct  4 03:12' };
      hh.fileMeta['/var/log/checkout-api/app.log-20261004.gz'] = { size: 23_920_118, mtime: 'Oct  5 03:12' };
      hh.fileMeta['/var/log/checkout-api/app.log-20261005'] = { size: 165_201_771, mtime: 'Oct  6 03:12' };
      hh.fileMeta['/var/log/nginx/access.log'] = { size: 61_220_018, mtime: mt(0.5) };
      hh.fileMeta['/var/log/nginx/error.log'] = { size: h === 'app-2' ? 4_118_204 : 2_211, mtime: h === 'app-2' ? mt(0.5) : 'Oct  1 03:41' };
      hh.fileMeta['/var/log/nginx/access.log-20261005.gz'] = { size: 9_402_116, mtime: 'Oct  6 03:12' };
      if (h !== 'app-2') hh.commandOverrides.push({ match: /^find\b/, output: "find: '/root': Permission denied\nfind: '/var/lib/nginx/tmp': Permission denied" });
    }

    // The 37 GB debug log (sample content: head = yesterday 14:52, tail = now).
    const dbg = (ts: number, reqId: string, extra: Record<string, unknown>) =>
      JSON.stringify({ level: 20, time: iso(ts), pid: APP2_PID, hostname: m2.hostname, reqId, ...extra });
    const debugBlock = (start: number) => {
      const r = `req-${hex(rng, 8)}`;
      const cart = `cart_${hex(rng, 10)}`;
      const sku = `SKU-${10000 + Math.floor(rng() * 89999)}`;
      return [
        dbg(start, r, { module: 'http', msg: 'incoming request', req: { method: 'POST', url: '/api/v1/checkout', headers: { host: 'api.shopfast.io', 'content-type': 'application/json', 'content-length': '11842', 'x-forwarded-for': '81.2.69.142, 10.0.0.71', 'user-agent': 'ShopFast-iOS/5.12.0 (iPhone15,2; iOS 18.0)' } } }),
        dbg(start + 3, r, { module: 'cart', msg: 'loaded cart', cartId: cart, currency: 'EUR', items: [{ sku, qty: 2, unitCents: 1999 }, { sku: 'SKU-55120', qty: 1, unitCents: 4950 }] }),
        dbg(start + 5, r, { module: 'pg', msg: 'query', text: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)', values: [[sku, 'SKU-55120']], durationMs: 2.2, rowCount: 2 }),
        dbg(start + 9, r, { module: 'tax', msg: 'computeTax line', sku, qty: 2, unitCents: 1999, rate: 0.19, rawTaxCents: 759.62, roundedTaxCents: 760, rounding: 'HALF_EVEN' }),
        dbg(start + 10, r, { module: 'tax', msg: 'computeTax line', sku: 'SKU-55120', qty: 1, unitCents: 4950, rate: 0.19, rawTaxCents: 940.5, roundedTaxCents: 940, rounding: 'HALF_EVEN' }),
        dbg(start + 11, r, { module: 'tax', msg: 'computeTax total', currency: 'EUR', subtotalCents: 8948, taxCents: 1700, totalCents: 10648, legacyHalfUpTotalCents: 10649 }),
        dbg(start + 14, r, { module: 'redis', msg: 'GET', key: `cart:${cart}:lock`, hit: false, durationMs: 0.4 }),
        dbg(start + 42, r, { module: 'paybridge', msg: 'POST /v2/payments/authorize', amount: 10648, currency: 'EUR', idempotencyKey: `idem_${hex(rng, 16)}`, status: 201, durationMs: 27.9 }),
        dbg(start + 51, r, { module: 'invoice', msg: 'rendering invoice', path: `/tmp/checkout-api/invoices/INV-2026-${hex(rng, 6)}.pdf`, template: 'eu-vat-v4' }),
        dbg(start + 60, r, { module: 'http', msg: 'response', res: { statusCode: 201, headers: { 'content-type': 'application/json; charset=utf-8', 'x-request-id': hex(rng, 32) } }, responseTime: 61.3 }),
      ];
    };
    const debugHead = [
      JSON.stringify({ level: 30, time: iso(t(DEBUG_START) + 900), pid: APP2_PID, hostname: m2.hostname, msg: 'logger configured', level_name: 'debug', destinations: ['/var/log/checkout-api/app.log (>=info)', `${DEBUG_LOG} (>=debug)`] }),
      ...debugBlock(t(DEBUG_START) + 41_000),
      ...debugBlock(t(DEBUG_START) + 43_500),
    ];
    const debugTail = [...debugBlock(t(1.6)), ...debugBlock(t(0.9))];
    app2.files[DEBUG_LOG] = [...debugHead, ...debugTail].join('\n') + '\n';
    app2.fileMeta[DEBUG_LOG] = { size: DEBUG_BYTES, mtime: 'Oct  6 10:22' };

    // App env: debug on app-2 only.
    app2.env.LOG_LEVEL = 'debug';

    // checkout-api on app-2 was restarted by the SSM command yesterday.
    const svc = app2.services['checkout-api'];
    const restart = t(DEBUG_START) + 4000;
    svc.mainPid = APP2_PID;
    svc.since = `${systemdTime(restart - 1200)}; 19h ago`;
    svc.memory = '603.8M';
    svc.journal = [
      ...svc.journal,
      `${syslogTime(restart - 2200)} ${m2.hostname} systemd[1]: Stopping checkout-api.service - ShopFast checkout API (Node.js)...`,
      `${syslogTime(restart - 1400)} ${m2.hostname} systemd[1]: checkout-api.service: Deactivated successfully.`,
      `${syslogTime(restart - 1390)} ${m2.hostname} systemd[1]: Stopped checkout-api.service - ShopFast checkout API (Node.js).`,
      `${syslogTime(restart - 1200)} ${m2.hostname} systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`,
      `${syslogTime(restart - 300)} ${m2.hostname} node[${APP2_PID}]: {"level":30,"msg":"logger configured","level_name":"debug","destinations":["/var/log/checkout-api/app.log (>=info)","${DEBUG_LOG} (>=debug)"]}`,
      `${syslogTime(restart + 400)} ${m2.hostname} node[${APP2_PID}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`,
      `${syslogTime(restart + 900)} ${m2.hostname} node[${APP2_PID}]: {"level":30,"msg":"checkout-api v2.13.1 listening on 127.0.0.1:3000"}`,
    ];
    const proc = app2.processes.find(p => p.command.includes('/opt/checkout-api/dist/server.js'));
    if (proc) Object.assign(proc, { pid: APP2_PID, start: 'Oct05', time: '97:12', cpu: 8.9, mem: 7.4, rssKb: 609112 });

    app2.services['systemd-journald'] = {
      name: 'systemd-journald',
      description: 'Journal Service',
      active: 'active (running)',
      since: app2.services.nginx.since,
      mainPid: 412,
      memory: '18.1M',
      tasks: 1,
      execStart: '/usr/lib/systemd/systemd-journald',
      journal: [
        `${syslogTime(t(DISK_FULL) + 9000)} ${m2.hostname} systemd-journald[412]: Failed to create new system journal: No space left on device`,
        `${syslogTime(t(DISK_FULL) + 9100)} ${m2.hostname} systemd-journald[412]: /var/log/journal/ec2a5f0d3b1e4c8a9f7d2e6b0c4a1f38/system.journal: Failed to write entry (9 items, 412 bytes), ignoring: No space left on device`,
        `${syslogTime(t(61))} ${m2.hostname} systemd-journald[412]: /var/log/journal/ec2a5f0d3b1e4c8a9f7d2e6b0c4a1f38/system.journal: Failed to write entry (9 items, 388 bytes), ignoring: No space left on device`,
      ],
    };
    app2.services['amazon-cloudwatch-agent'].journal = [
      `${syslogTime(t(DISK_FULL) + 31000)} ${m2.hostname} amazon-cloudwatch-agent[1043]: 2026-10-06T05:50:31Z E! [inputs.logfile] Failed to save state file /opt/aws/amazon-cloudwatch-agent/logs/state/_var_log_checkout-api_app.log: write /opt/aws/amazon-cloudwatch-agent/logs/state/_var_log_checkout-api_app.log: no space left on device`,
    ];

    // Tools that show what is holding the space.
    app2.commandOverrides.push(
      {
        match: /^lsof\b.*(debug\.log|\/var\/log\/checkout-api)/,
        output: [
          'COMMAND   PID     USER   FD   TYPE DEVICE    SIZE/OFF     NODE NAME',
          `node    ${APP2_PID} shopfast   21w   REG  259,1   199884120 25165951 /var/log/checkout-api/app.log`,
          `node    ${APP2_PID} shopfast   23w   REG  259,1 ${DEBUG_BYTES} 25165954 ${DEBUG_LOG}`,
        ].join('\n'),
      },
      { match: /^lsof\s+(-\S+\s+)*\+L1\b/, output: '' },
      {
        match: /^find\b/,
        output: `find: '/root': Permission denied\nfind: '/var/lib/nginx/tmp': Permission denied\n${DEBUG_LOG}`,
      },
    );

    /* ---------------- Logs on app-2 ---------------- */
    // nginx can't buffer request bodies (> client_body_buffer_size 8k) to its temp dir.
    let conn = 871022;
    const errLines = spread(env, DISK_FULL - 0.3, 75, 64, (i, ts) => {
      conn += 180 + ((i * 37) % 90);
      const w = i % 2 ? 1313 : 1312;
      const ip = i % 3 ? '10.0.0.71' : '10.0.1.163';
      if (i % 9 === 4) return `${nginxErrTime(ts)} [alert] ${w}#${w}: *${conn} write() to "/var/log/nginx/access.log" failed (28: No space left on device) while logging request, client: ${ip}, server: api.shopfast.io, request: "POST /api/v1/checkout HTTP/1.1", upstream: "http://127.0.0.1:3000/api/v1/checkout", host: "api.shopfast.io"`;
      return `${nginxErrTime(ts)} [crit] ${w}#${w}: *${conn} open() "/var/lib/nginx/tmp/client_body/00004${(12000 + i * 211).toString().padStart(5, '0')}" failed (28: No space left on device), client: ${ip}, server: api.shopfast.io, request: "POST /api/v1/checkout HTTP/1.1", host: "api.shopfast.io"`;
    });
    injectLog(env, 'app-2', '/var/log/nginx/error.log', errLines);

    // Last 75 minutes: matching access-log 500s and app ENOSPC errors.
    const uas = ['ShopFast-iOS/5.12.0 (iPhone15,2; iOS 18.0)', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36', 'ShopFast-Android/5.12.1 (Pixel 8; Android 15)', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1'];
    const access: { ts: number; msg: string }[] = [];
    const appErr: { ts: number; msg: string }[] = [];
    const nginxRecent: { ts: number; msg: string }[] = [];
    const stamps = spread(env, 74.5, 0.3, 82, () => '');
    stamps.forEach(({ ts }, i) => {
      const ip = i % 3 ? '10.0.0.71' : '10.0.1.163';
      const ua = uas[i % uas.length];
      const rid = hex(rng, 32);
      if (i % 3 === 0) {
        // nginx itself fails buffering the body → 500 without touching upstream
        conn += 211;
        const w = i % 2 ? 1313 : 1312;
        nginxRecent.push({ ts, msg: `${nginxErrTime(ts)} [crit] ${w}#${w}: *${conn} open() "/var/lib/nginx/tmp/client_body/00004${(31000 + i * 97).toString().padStart(5, '0')}" failed (28: No space left on device), client: ${ip}, server: api.shopfast.io, request: "POST /api/v1/checkout HTTP/1.1", host: "api.shopfast.io"` });
        access.push({ ts, msg: `${ip} - - [${nginxTime(ts)}] "POST /api/v1/checkout HTTP/1.1" 500 177 "-" "${ua}" rt=0.001 uct=- urt=- rid=${rid}` });
      } else {
        const ms = 38 + ((i * 53) % 40);
        const reqId = `req-${hex(rng, 8)}`;
        const inv = `INV-2026-${hex(rng, 6)}`;
        appErr.push({
          ts: ts - ms + 30,
          msg: JSON.stringify({ level: 50, time: iso(ts - ms + 30), pid: APP2_PID, hostname: m2.hostname, reqId, module: 'invoice', path: `/tmp/checkout-api/invoices/${inv}.pdf`, err: { type: 'Error', message: `ENOSPC: no space left on device, write`, errno: -28, code: 'ENOSPC', syscall: 'write', stack: `Error: ENOSPC: no space left on device, write\n    at Object.writeSync (node:fs:936:3)\n    at Object.writeFileSync (node:fs:2350:26)\n    at InvoiceRenderer.renderToFile (/opt/checkout-api/dist/invoices/render.js:88:12)` }, msg: 'invoice render failed' }),
        });
        appErr.push({
          ts: ts - 1,
          msg: JSON.stringify({ level: 50, time: iso(ts - 1), pid: APP2_PID, hostname: m2.hostname, reqId, err: { type: 'Error', message: 'ENOSPC: no space left on device, write', code: 'ENOSPC' }, req: { method: 'POST', url: '/api/v1/checkout' }, res: { statusCode: 500 }, responseTime: ms, msg: 'request errored' }),
        });
        access.push({ ts, msg: `${ip} - - [${nginxTime(ts)}] "POST /api/v1/checkout HTTP/1.1" 500 97 "-" "${ua}" rt=0.0${ms} uct=0.000 urt=0.0${ms - 1} rid=${rid}` });
      }
    });
    injectLog(env, 'app-2', '/var/log/nginx/error.log', nginxRecent);
    injectLog(env, 'app-2', '/var/log/nginx/access.log', access);
    injectLog(env, 'app-2', '/var/log/checkout-api/app.log', appErr);
    injectLog(env, 'app-2', '/var/log/messages', [
      ev(env, DISK_FULL - 0.15, `${syslogTime(t(DISK_FULL - 0.15))} ${m2.hostname} systemd-journald[412]: Failed to create new system journal: No space left on device`),
      ev(env, 61, `${syslogTime(t(61))} ${m2.hostname} rsyslogd[1088]: file '/var/log/messages'[6] write error - see https://www.rsyslog.com/solving-rsyslog-write-errors/ for help OS error: No space left on device [v8.2204.0 try https://www.rsyslog.com/e/2027 ]`),
    ]);

    /* ---------------- Changes / audit ---------------- */
    env.changes.push({
      id: 'chg-8794',
      minutesAgo: DEBUG_START,
      kind: 'config',
      service: 'checkout-api (app-2 only)',
      title: 'Temporarily enable debug logging on one checkout host (PAY-2291)',
      author: 'li.wang (SSM Run Command)',
      status: 'succeeded',
      description: `AWS-RunShellScript on ${m2.id} (app-2). Goal: capture tax-calculation traces for EUR carts after 2.13.1 (PAY-2291 "rounding off by 1 cent"). "Will revert tomorrow morning."`,
      diff: `--- a/etc/checkout-api/env
+++ b/etc/checkout-api/env
@@ -1,5 +1,5 @@
 NODE_ENV=production
 PORT=3000
-LOG_LEVEL=info
+LOG_LEVEL=debug
 APP_VERSION=2.13.1
 DB_HOST=db.internal.shopfast.io
# then: systemctl restart checkout-api
# note (src/logger.ts): when LOG_LEVEL=debug, pino.multistream adds a second
#   destination ${DEBUG_LOG} that receives every record >= debug`,
    });
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);

    env.cloudtrail.push(
      {
        minutesAgo: DEBUG_START + 0.2,
        eventName: 'SendCommand',
        eventSource: 'ssm.amazonaws.com',
        user: 'sso/li.wang',
        sourceIp: '203.0.113.61',
        resources: m2.id,
        request: { documentName: 'AWS-RunShellScript', instanceIds: [m2.id], comment: 'PAY-2291 debug logging on one host', parameters: { commands: ["sed -i 's/^LOG_LEVEL=info$/LOG_LEVEL=debug/' /etc/checkout-api/env", 'systemctl restart checkout-api'] } },
      },
      { minutesAgo: DEBUG_START + 3, eventName: 'StartSession', eventSource: 'ssm.amazonaws.com', user: 'sso/li.wang', sourceIp: '203.0.113.61', resources: m2.id },
    );
    env.cloudtrail.sort((a, b) => a.minutesAgo - b.minutesAgo);

    /* ---------------- AWS CLI: where do alarms go? ---------------- */
    const page = `arn:aws:sns:us-east-1:${IDS.account}:pagerduty-checkout-critical`;
    const email = `arn:aws:sns:us-east-1:${IDS.account}:shopfast-ops-email-digest`;
    const alarmsJson = (only?: string) =>
      JSON.stringify(
        {
          MetricAlarms: env.alarms
            .filter(a => !only || a.state === only)
            .map(a => ({
              AlarmName: a.name,
              AlarmArn: `arn:aws:cloudwatch:us-east-1:${IDS.account}:alarm:${a.name}`,
              StateValue: a.state,
              StateReason: a.state === 'ALARM' ? 'Threshold Crossed: 3 out of the last 3 datapoints [100.0 (06/10/26 10:20:00), 100.0 (06/10/26 10:19:00), 100.0 (06/10/26 10:18:00)] were greater than the threshold (85.0).' : a.condition,
              StateUpdatedTimestamp: isoSec(env.now - a.minutesAgo * MIN),
              MetricName: a.metric,
              ActionsEnabled: true,
              AlarmActions: [a.name === 'checkout-app-disk-used-high' ? email : page],
            })),
        },
        null,
        4,
      );
    env.awsCli.unshift(
      { match: /cloudwatch describe-alarms.*--state-value[ =]ALARM/, output: alarmsJson('ALARM') },
      { match: /cloudwatch describe-alarms/, output: alarmsJson() },
      {
        match: /sns list-subscriptions/,
        output: JSON.stringify(
          {
            Subscriptions: [
              { SubscriptionArn: `${page}:5b0e1c2d-7a4f-4e1b-9c3d-2f8a6b1e0d47`, Owner: IDS.account, Protocol: 'https', Endpoint: 'https://events.pagerduty.com/integration/2f9c…/enqueue', TopicArn: page },
              { SubscriptionArn: `${email}:8d2a7c41-0b6e-4f3a-a1d5-9e7c3b2f6a10`, Owner: IDS.account, Protocol: 'email', Endpoint: 'ops-alerts@shopfast.io', TopicArn: email },
            ],
          },
          null,
          4,
        ),
      },
    );
  },

  evidence: [
    {
      id: 'disk-100',
      label: 'app-2 root filesystem /dev/nvme0n1p1 is 100% full (0 bytes available)',
      kind: 'key',
      match: /\/dev\/nvme0n1p1\s+50G\s+50G\s+0\s+100%|disk_used_percent[^\n]*app-2: now 100\b/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'df -h' },
      explanation: 'The root volume of one of the three checkout hosts has no free space. Anything on app-2 that needs to create or extend a file — nginx request buffering, invoice PDFs in /tmp, logs — fails with ENOSPC.',
    },
    {
      id: 'debug-log-37g',
      label: '/var/log/checkout-api/debug.log is 37 GB',
      kind: 'key',
      match: /\b3\dG\b[^\n]*checkout-api\/debug\.log|\b3\dG\b[^\n]*\bdebug\.log/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'du -sh /var/log/checkout-api/*' },
      explanation: 'du shows exactly where the space went: a single debug log, growing ~2.5 GB/hour since yesterday afternoon. app.log next to it is a normal 190 MB.',
    },
    {
      id: 'log-level-debug',
      label: 'LOG_LEVEL=debug was set on app-2 only (yesterday 14:52, never reverted)',
      kind: 'key',
      match: /LOG_LEVEL=debug/,
      foundBy: { tool: 'deploys' },
      explanation: 'A hand-made, single-host config change (SSM Run Command) for a debugging session. In debug mode checkout-api adds the debug.log destination — and nobody reverted it.',
    },
    {
      id: 'enospc',
      label: 'nginx / checkout-api errors on app-2: (28: No space left on device) / ENOSPC',
      kind: 'supporting',
      match: /No space left on device|ENOSPC/,
      foundBy: { tool: 'logs', group: '/shopfast/nginx/error' },
      explanation: 'Connects the full disk to the customer-facing 500s: nginx cannot buffer POST bodies to /var/lib/nginx/tmp/client_body, and the app cannot write invoice PDFs. Only app-2 logs these.',
    },
    {
      id: 'logrotate-gap',
      label: 'logrotate config only matches /var/log/checkout-api/app.log',
      kind: 'supporting',
      match: /^\/var\/log\/checkout-api\/app\.log \{$|\/var\/log\/checkout-api\/app\.log \{\n\s+daily/m,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'cat /etc/logrotate.d/checkout-api' },
      explanation: 'app.log is rotated daily with maxsize 500M; debug.log matches no logrotate stanza, so nothing ever rotated, compressed or capped it.',
    },
    {
      id: 'disk-alarm-email',
      label: 'checkout-app-disk-used-high has been in ALARM for ~7.5 h — routed to an email digest',
      kind: 'supporting',
      match: /checkout-app-disk-used-high is ALARM|shopfast-ops-email-digest/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'aws cloudwatch describe-alarms --state-value ALARM' },
      explanation: 'The disk alarm fired at 02:48, three hours before customers were affected — but its action is an SNS topic that emails a shared inbox nobody reads at night.',
    },
    {
      id: 'app1-cpu',
      label: 'app-1 CPU is ~10 points higher than the other hosts',
      kind: 'red-herring',
      match: /CPUUtilization \[shopfast-checkout-asg\]/,
      foundBy: { tool: 'cloudwatch', panel: 'ec2.cpu' },
      explanation: 'app-1 at ~29% CPU is unremarkable and was the same before the incident. CPU on app-2 is actually lower — failing requests are cheap.',
    },
    {
      id: 'catalog-deploy',
      label: 'catalog-service 1.42.0 deploy',
      kind: 'red-herring',
      match: /catalog-service 1\.42\.0/,
      foundBy: { tool: 'deploys' },
      explanation: 'A different service on ECS, deployed hours after the failures started. It never touches checkout hosts.',
    },
    {
      id: 'waf',
      label: 'WAF web ACL attached to the ALB (COUNT mode)',
      kind: 'red-herring',
      match: /WAF web ACL|CreateWebACL/,
      foundBy: { tool: 'deploys' },
      explanation: 'The WAF rules are in COUNT mode — they only label requests, they never block — and a WAF block would be a 403 from the ALB, not a 500 from one target.',
    },
  ],

  rootCauses: [
    {
      id: 'rc-disk',
      correct: true,
      text: 'LOG_LEVEL=debug, set by hand on app-2 yesterday and never reverted, grew an unrotated 37 GB debug.log that filled app-2\'s root volume; writes there fail with ENOSPC, so its third of checkouts return 500.',
      explanation: 'Explains everything: only one host’s share of requests fails (≈1/3, retries land elsewhere), errors are ENOSPC, health checks stay green because /health writes nothing, and the timeline matches the disk curve.',
    },
    {
      id: 'rc-disk-only',
      partial: true,
      text: 'app-2\'s 50 GB root volume ran out of space overnight, so nginx on that host can no longer buffer checkout request bodies to /var/lib/nginx/tmp and returns 500 for them.',
      explanation: 'Correct symptom-level diagnosis, but without what filled it (debug.log) and why (a forgotten single-host debug setting + a logrotate pattern that doesn’t match) you would clean up and have the same outage again tomorrow.',
    },
    {
      id: 'rc-tax',
      text: 'The banker\'s-rounding change in checkout-api 2.13.1 throws a RangeError for some EUR/GBP carts during tax calculation, so those checkouts return 500 and only succeed on retry once the cart total changes.',
      explanation: 'All three hosts run 2.13.1, but only app-2 produces errors, and the errors are ENOSPC, not exceptions in tax code. A code bug would also not "fix itself" on retry.',
    },
    {
      id: 'rc-paybridge',
      text: 'PayBridge is failing about a third of /v2/payments/authorize calls with intermittent 502s from its us-east edge, and checkout-api maps those upstream errors to HTTP 500 for the customer.',
      explanation: 'PaymentProviderErrors is flat at ~0, and a provider problem would hit all three hosts equally.',
    },
    {
      id: 'rc-app1-cpu',
      text: 'app-1 is CPU-starved (~30% vs ~20% on its peers) by a noisy neighbour, so checkout requests routed to it exceed nginx\'s proxy_read_timeout of 30 s and fail intermittently.',
      explanation: 'app-1 at ~29% CPU has plenty of headroom and logs no errors; the failing requests are all on app-2, and they fail in milliseconds, not by timing out.',
    },
    {
      id: 'rc-waf',
      text: 'The WAF web ACL attached yesterday (AWSManagedRulesCommonRuleSet, SizeRestrictions_BODY) blocks checkout POST bodies larger than 8 KB, so roughly a third of checkouts are rejected.',
      explanation: 'The ACL is in COUNT mode, was attached a day earlier, and a WAF block returns 403 from the ALB — these are 500s returned by nginx/checkout-api on one host.',
    },
  ],

  fixes: [
    {
      id: 'fx-truncate-revert',
      kind: 'correct',
      text: 'On app-2, `truncate -s 0` debug.log, confirm with `df -h`, then set LOG_LEVEL=info and restart checkout-api.',
      explanation: 'Truncating keeps the inode the process has open and releases the blocks immediately; reverting the log level stops it from refilling. Errors stop the moment space is free.',
    },
    {
      id: 'fx-durable',
      kind: 'correct',
      text: 'Rotate /var/log/checkout-api/*.log with maxsize, page on the disk alarm, and make debug logging time-boxed via config management.',
      explanation: 'Three independent safety nets failed: rotation didn’t match the file, the alarm went to email, and a temporary change had no expiry. Each one alone would have prevented customer impact.',
    },
    {
      id: 'fx-deregister',
      kind: 'partial',
      text: 'Deregister app-2 from checkout-api-tg (or put it in ASG standby) so the ALB stops routing checkouts to it while you clean up.',
      explanation: 'Good first mitigation: customer errors stop within the deregistration delay while you clean up. It leaves you on 2/3 capacity and doesn’t fix anything by itself.',
    },
    {
      id: 'fx-terminate',
      kind: 'partial',
      text: 'Terminate app-2 (i-0b7e21d94c6a3f102) and let shopfast-checkout-asg launch a fresh instance from launch template version 14.',
      explanation: 'It works (the launch template still says LOG_LEVEL=info) but destroys the evidence, takes several minutes, and the logrotate gap is still there for the next person who enables debug.',
    },
    {
      id: 'fx-restart',
      kind: 'neutral',
      text: 'Run `systemctl restart checkout-api` on app-2 (or reboot the instance) to release stuck file handles and temp files.',
      explanation: 'Neither frees a single byte: the 37 GB file is still on disk, and the service comes back with LOG_LEVEL=debug. You lose in-flight requests for nothing.',
    },
    {
      id: 'fx-rm',
      kind: 'harmful',
      text: 'Free the space with `rm /var/log/checkout-api/debug.log` while checkout-api keeps running, then confirm the file is gone with `du`.',
      explanation: 'The directory entry disappears but node still holds the file open, so the blocks are NOT freed — df stays at 100%, `du` no longer shows the culprit, and you now need `lsof +L1` and a restart to recover the space.',
    },
    {
      id: 'fx-debug-all',
      kind: 'harmful',
      text: 'Set LOG_LEVEL=debug on app-1 and app-3 as well and restart them, to capture full request traces of the failing checkouts.',
      explanation: 'This would start filling the other two disks at ~2.5 GB/hour and turn a one-host problem into a full outage by tomorrow morning.',
    },
  ],

  hints: [
    'Only some requests fail and retries usually work. With a load balancer spreading requests over three hosts, ask: do the failures all come from the same host? Compare the nginx logs (or per-AZ ALB metrics) of app-1, app-2 and app-3.',
    'On app-2, read /var/log/nginx/error.log. What does error 28 mean? Then run `df -h`.',
    'Find what is using the space with `du -sh /var/log/*` and drill down. Then ask why that file exists and why it was never rotated: compare /etc/checkout-api/env across hosts, read /etc/logrotate.d/checkout-api, and look at yesterday’s config changes.',
  ],

  debrief: {
    summary: `Yesterday at 14:52 UTC an engineer used SSM Run Command to set \`LOG_LEVEL=debug\` on **app-2 only**, to capture tax-calculation traces for a rounding bug. In debug mode checkout-api adds a second log destination, \`/var/log/checkout-api/debug.log\`, which receives every request’s headers, SQL, tax maths and payment calls. The change was never reverted, and the logrotate config only matched \`app.log\`, so debug.log grew at ~2.5 GB/hour with nothing capping it.

At 02:48 the \`checkout-app-disk-used-high\` alarm fired — but its action was an SNS topic that emails a digest inbox. At ~05:50 the 50 GB root volume hit **100%**. From then on, any write on app-2 was a lottery: nginx could not spool checkout request bodies (larger than its 8 KB in-memory buffer) to \`/var/lib/nginx/tmp/client_body\`, and checkout-api could not write invoice PDFs to \`/tmp\`. Both returned **500**. Browsing, cart reads and \`GET /health\` don’t touch the disk, so they kept working — which is why the ALB kept app-2 **healthy** and in rotation.

Because the ALB spreads requests across three targets, roughly a third of checkouts landed on app-2 and failed, and a retry usually landed on app-1 or app-3 and succeeded. Target 5xx sat at ~30/min, under the 50/min alarm threshold, so nothing paged until customers did.

The higher CPU on app-1, the catalog-service deploy and the WAF ACL were all unrelated: none of them is specific to one host, and none produces ENOSPC.`,
    timeline: [
      { minutesAgo: 1171, event: 'SSM Run Command sets LOG_LEVEL=debug on app-2 and restarts checkout-api; debug.log starts growing' },
      { minutesAgo: 455, event: 'Disk on app-2 crosses 85% → checkout-app-disk-used-high ALARM, emailed to a digest list' },
      { minutesAgo: 273, event: 'Root volume reaches 100%; first "No space left on device" in nginx error.log; checkout 500s begin on app-2' },
      { minutesAgo: 230, event: 'First support tickets ("checkout error, worked on retry")' },
      { minutesAgo: 14, event: 'Support Lead triggers the incident manually in PagerDuty' },
      { minutesAgo: 0, event: 'Investigation: per-host errors → df -h → du → debug.log → LOG_LEVEL=debug' },
    ],
    concepts: [
      {
        title: 'df vs du: finding what fills a disk',
        body: '`df -h` asks the filesystem how many blocks are allocated; `du -sh <dir>/*` walks directory entries and adds up file sizes. Start with df to find the full mount, then drill down with `du -sh /*`, `du -sh /var/*`, `du -sh /var/log/*` until one entry stands out (`| sort -h` puts the biggest last). When df says full but du can’t find the space, suspect deleted-but-open files (next concept). Also check `df -i`: a filesystem can run out of inodes with plenty of free bytes.',
      },
      {
        title: 'Deleted-but-open files: why `rm` doesn’t free space',
        body: 'A file’s data is freed only when its link count is 0 **and** no process has it open. `rm` removes the directory entry (link), but node still holds a file descriptor to debug.log and keeps writing to it — df stays at 100% while du shows nothing. `lsof +L1` lists open files with zero links. The safe way to reclaim space from a log a process is writing to is `truncate -s 0 file` (or `: > file`): same inode, length 0, blocks released immediately. If you already ran rm, you can truncate via `/proc/<pid>/fd/<n>` or restart the process.',
      },
      {
        title: 'Shallow health checks keep broken targets in rotation',
        body: 'The ALB health check is `GET /health` → 200. That endpoint reads nothing from disk and writes nothing, so it passed every 10 seconds while real checkouts failed. Health checks answer “can this process accept a request?”, not “does the important path work?”. Deep checks (try writing a temp file, ping the DB) catch more, but are dangerous if a shared dependency fails — every target goes unhealthy at once. A common compromise: shallow LB health check + per-target error-rate alarms and outlier detection.',
      },
      {
        title: 'logrotate: patterns, copytruncate and maxsize',
        body: 'logrotate only touches files matched by a stanza’s glob — `/var/log/checkout-api/app.log` doesn’t match `debug.log`. Use `/var/log/checkout-api/*.log`. `copytruncate` copies the file then truncates it in place, which works for apps that don’t reopen logs (at the risk of losing a few lines); the alternative is `create` + a `postrotate` signal that makes the app reopen its file (nginx uses USR1). `daily` runs once a day — `maxsize 500M` lets the hourly run rotate early if a file explodes. Test with `logrotate -d /etc/logrotate.d/checkout-api`.',
      },
      {
        title: 'Alerts that nobody receives are not alerts',
        body: 'The disk alarm worked perfectly — three hours early — and was routed to `shopfast-ops-email-digest`. Every alarm should have an owner and an action that matches its urgency: “disk 85% and rising on a production host” should page (or auto-remediate), while purely informational alarms belong on a dashboard. Also note the 5xx alarm threshold (50/min) was an absolute number: one host failing 100% of its checkouts only produced ~30/min fleet-wide. Ratio-based thresholds (5xx / requests) and per-AZ/per-target views catch partial failures.',
      },
      {
        title: 'Snowflake changes and configuration drift',
        body: 'app-2 differed from app-1/app-3 by one line made by hand through SSM. Nothing tracked that it was temporary. Prefer dynamic, self-expiring debug switches (e.g. a log level that resets after 1 hour, or debug for a sampled set of request IDs), and apply host config through the launch template / config management so drift is visible and gets reverted.',
      },
    ],
    commands: [
      { cmd: 'df -h', why: 'Which filesystem is full, and how full' },
      { cmd: 'du -sh /var/log/* | sort -h', why: 'Drill down to the directory/file using the space' },
      { cmd: 'ls -lh /var/log/checkout-api/', why: 'File sizes and modification times — what is still being written' },
      { cmd: 'lsof +L1', why: 'Deleted files still held open by a process (space df counts but du can’t see)' },
      { cmd: 'grep -c "No space left on device" /var/log/nginx/error.log', why: 'Confirm and count ENOSPC failures on a host' },
      { cmd: 'truncate -s 0 /var/log/checkout-api/debug.log', why: 'Free a live log file’s space without breaking the writer' },
      { cmd: 'logrotate -d /etc/logrotate.d/checkout-api', why: 'Dry run: shows which files a logrotate config would actually rotate' },
    ],
    prevention: [
      'Rotate every log the app can write: `/var/log/checkout-api/*.log` with `maxsize`, and run logrotate hourly so maxsize can act.',
      'Route disk-usage alarms to a paging target, alert earlier (80%) or on fill rate, and own every alarm’s action.',
      'Make debug logging self-expiring (TTL on the setting) or request-scoped, and never apply it by hand to a single host.',
      'Alert on 5xx ratio and per-AZ/per-target error rates, not just a fleet-wide absolute count.',
      'Put logs on a separate volume (or ship them and keep little locally) so a log explosion can’t starve nginx temp files and /tmp.',
    ],
    reading: [
      { title: 'logrotate(8) manual page', url: 'https://man7.org/linux/man-pages/man8/logrotate.8.html' },
      { title: 'Metrics collected by the CloudWatch agent (disk_used_percent)', url: 'https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/metrics-collected-by-CloudWatch-agent.html' },
      { title: 'Health checks for Application Load Balancer target groups', url: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html' },
    ],
  },
};

export default incident;
