import type { Environment, Incident, LogEvent } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, iso, nginxErrTime, nginxTime, syslogTime, systemdTime, hm } from '../engine/time';
import { appJson, nginxAccess } from '../engine/loggen';
import { createRng, hashString, hex } from '../engine/rng';
import { addPanel, host, injectLog, panel, setPoints } from '../env/helpers';
import { APP_HOSTS, hostMeta } from '../env/base';

/*
 * INC-4150 — checkout-api 2.15.0 (deployed ~09:30) added an unbounded in-process
 * price cache and raised --max-old-space-size from 1536 to 6144 on 8 GiB hosts.
 * RSS grows until the kernel OOM killer SIGKILLs node (every ~40–70 min per host,
 * getting faster as traffic rises). systemd restarts it in ~2 s; nginx returns 502
 * during the gap. Nobody notices a host "down" because health checks never fail twice.
 */

type AppHost = (typeof APP_HOSTS)[number];

/** minutes ago each host was restarted by the rolling deploy of 2.15.0 */
const DEPLOY: Record<AppHost, number> = { 'app-1': 432, 'app-2': 430, 'app-3': 428 };
/** minutes ago of every OOM kill (descending = oldest first). Intervals shrink as afternoon traffic grows. */
const KILLS: Record<AppHost, number[]> = {
  'app-1': [362, 298, 239, 183, 131, 86, 44, 6],
  'app-2': [357, 289, 226, 170, 121, 76, 36],
  'app-3': [366, 305, 247, 193, 142, 97, 57, 19],
};
/** seconds inside the minute at which each kill happened (keeps timestamps from looking synthetic) */
const killSec = (h: AppHost, k: number) => 3 + ((hashString(`${h}-${k}`) % 5400) / 100);
const killTs = (env: Environment, h: AppHost, k: number) => env.now - KILLS[h][k] * MIN + killSec(h, k) * 1000;

const BOOT_SECS = 12 * 86400 + 4 * 3600 + 11 * 60; // matches `uptime` (12 days, 4:11) and dmesg -T
const ALB_IPS = ['10.0.0.71', '10.0.1.163', '10.0.0.204', '10.0.1.38'];
const UA = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'ShopFast-iOS/5.12.0 (iPhone15,2; iOS 18.0)',
  'ShopFast-Android/5.12.1 (Pixel 8; Android 15)',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0',
];
const REQS: [string, string][] = [
  ['GET', '/api/v1/cart'],
  ['POST', '/api/v1/cart/items'],
  ['GET', '/api/v1/products/SKU-48211'],
  ['POST', '/api/v1/checkout'],
  ['GET', '/api/v1/cart'],
  ['GET', '/api/v1/products/SKU-20931'],
  ['POST', '/api/v1/cart/items'],
  ['GET', '/api/v1/orders'],
];

const INFLIGHT: [string, string][] = [
  ['POST', '/api/v1/checkout'],
  ['POST', '/api/v1/cart/items'],
  ['GET', '/api/v1/cart'],
  ['POST', '/api/v1/checkout'],
  ['GET', '/api/v1/orders'],
];

const idxOf = (h: AppHost) => APP_HOSTS.indexOf(h);
/** pid of the node process for incarnation k (0 = started by the deploy, k = after k-th OOM kill) */
const pidOf = (h: AppHost, k: number) => 38112 + idxOf(h) * 211 + k * 1187 + ((k * 37) % 113);

/** Where in its leak cycle a host is at `m` minutes ago. */
function cycleAt(h: AppHost, m: number) {
  const starts = [DEPLOY[h], ...KILLS[h]];
  if (m > DEPLOY[h]) return undefined;
  let i = starts.length - 1;
  while (starts[i] < m) i--;
  const next = starts[i + 1];
  const len = next !== undefined ? starts[i] - next : starts[i - 1] - starts[i] - 2;
  return { incarnation: i, since: starts[i] - m, len, untilKill: next !== undefined ? m - next : len - (starts[i] - m) };
}

const LOW = 19.6;
const HIGH = 95.9;
function memPct(h: AppHost, m: number): number {
  const c = cycleAt(h, m);
  if (!c) return 23.6 + idxOf(h) * 0.8;
  return LOW + (HIGH - LOW) * Math.pow(Math.min(1, c.since / c.len), 0.9);
}

/* -------------------------- kernel OOM report -------------------------- */

function oomReport(env: Environment, h: AppHost, k: number): { dmesg: string[]; syslog: LogEvent[] } {
  const ts = killTs(env, h, k);
  const bootTs = env.now - BOOT_SECS * 1000;
  let us = Math.round((ts - bootTs) * 1000);
  const stamp = () => {
    us += 3 + (us % 5);
    return `[${(us / 1e6).toFixed(6).padStart(12)}]`;
  };
  const pid = pidOf(h, k);
  const jitter = hashString(`${h}${k}`) % 40000;
  const anonKb = 6712_000 + jitter * 3;
  const fileKb = 44_800 + (jitter % 900);
  const totalVmKb = 17_180_000 + jitter * 7;
  const pgtablesKb = 14_200 + (jitter % 300);
  const pages = (kb: number) => Math.round(kb / 4);
  const cont = (s: string) => ' '.repeat(18) + s;
  const kill = `Out of memory: Killed process ${pid} (node) total-vm:${totalVmKb}kB, anon-rss:${anonKb}kB, file-rss:${fileKb}kB, shmem-rss:0kB, UID:1001 pgtables:${pgtablesKb}kB oom_score_adj:0`;
  const constraint = `oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),cpuset=/,mems_allowed=0,global_oom,task_memcg=/system.slice/checkout-api.service,task=node,pid=${pid},uid=1001`;
  const header = `node invoked oom-killer: gfp_mask=0x140cca(GFP_HIGHUSER_MOVABLE|__GFP_COMP), order=0, oom_score_adj=0`;
  const inactiveAnon = pages(anonKb) + 15_620;
  const dm = [
    `${stamp()} ${header}`,
    `${stamp()} CPU: ${k % 2} PID: ${pid} Comm: node Not tainted 6.1.109-118.189.amzn2023.x86_64 #1`,
    `${stamp()} Hardware name: Amazon EC2 m6i.large/, BIOS 1.0 10/16/2017`,
    `${stamp()} Call Trace:`,
    `${stamp()}  <TASK>`,
    `${stamp()}  dump_stack_lvl+0x34/0x48`,
    `${stamp()}  dump_header+0x4a/0x201`,
    `${stamp()}  oom_kill_process.cold+0xb/0x10`,
    `${stamp()}  out_of_memory+0x1ed/0x2e0`,
    `${stamp()}  __alloc_pages_slowpath.constprop.0+0xc7b/0xe00`,
    `${stamp()}  __alloc_pages+0x308/0x330`,
    `${stamp()}  __folio_alloc+0x17/0x50`,
    `${stamp()}  vma_alloc_folio+0x9a/0x380`,
    `${stamp()}  do_anonymous_page+0x6d/0x3a0`,
    `${stamp()}  __handle_mm_fault+0x3cb/0x750`,
    `${stamp()}  handle_mm_fault+0xdc/0x2d0`,
    `${stamp()}  do_user_addr_fault+0x1bf/0x690`,
    `${stamp()}  exc_page_fault+0x6c/0x170`,
    `${stamp()}  asm_exc_page_fault+0x22/0x30`,
    `${stamp()} RIP: 0033:0x14c8f3a`,
    `${stamp()}  </TASK>`,
    `${stamp()} Mem-Info:`,
    `${stamp()} active_anon:2131 inactive_anon:${inactiveAnon} isolated_anon:0`,
    cont(`active_file:41 inactive_file:187 isolated_file:0`),
    cont(`unevictable:0 dirty:0 writeback:0`),
    cont(`slab_reclaimable:8817 slab_unreclaimable:13054`),
    cont(`mapped:263 shmem:516 pagetables:${pages(pgtablesKb) + 410}`),
    cont(`sec_pagetables:0 bounce:0`),
    cont(`kernel_misc_reclaimable:0`),
    cont(`free:21604 free_pcp:57 free_cma:0`),
    `${stamp()} Node 0 active_anon:8524kB inactive_anon:${inactiveAnon * 4}kB active_file:164kB inactive_file:748kB unevictable:0kB isolated(anon):0kB isolated(file):0kB mapped:1052kB dirty:0kB writeback:0kB shmem:2064kB shmem_thp: 0kB shmem_pmdmapped: 0kB anon_thp: 0kB writeback_tmp:0kB kernel_stack:3216kB pagetables:${pgtablesKb + 1640}kB sec_pagetables:0kB all_unreclaimable? yes`,
    `${stamp()} Node 0 Normal free:73320kB boost:0kB min:45116kB low:56392kB high:67668kB reserved_highatomic:0KB active_anon:7012kB inactive_anon:${inactiveAnon * 4 - 1_901_140}kB active_file:96kB inactive_file:412kB unevictable:0kB writepending:0kB present:6291456kB managed:6125344kB mlocked:0kB bounce:0kB free_pcp:228kB local_pcp:0kB free_cma:0kB`,
    `${stamp()} Free swap  = 0kB`,
    `${stamp()} Total swap = 0kB`,
    `${stamp()} 2097050 pages RAM`,
    `${stamp()} 0 pages HighMem/MovableOnly`,
    `${stamp()} 99872 pages reserved`,
    `${stamp()} Tasks state (memory values in pages):`,
    `${stamp()} [  pid  ]   uid  tgid total_vm      rss pgtables_bytes swapents oom_score_adj name`,
    `${stamp()} [    412]     0   412    13042     5386   110592        0          -250 systemd-journal`,
    `${stamp()} [    798]   992   798    21163      980    69632        0             0 chronyd`,
    `${stamp()} [    812]     0   812     3855     2278    69632        0         -1000 sshd`,
    `${stamp()} [    921]     0   921   372817     6840   253952        0             0 amazon-ssm-agen`,
    `${stamp()} [   1043]   994  1043   455185    12822   311296        0             0 amazon-cloudwat`,
    `${stamp()} [   1102]     0  1102    56532      800    77824        0             0 crond`,
    `${stamp()} [   1311]     0  1311     9969     1610    77824        0             0 nginx`,
    `${stamp()} [   1312]   991  1312    10405     2553    81920        0             0 nginx`,
    `${stamp()} [   1313]   991  1313    10405     2545    81920        0             0 nginx`,
    `${stamp()} [ ${String(pid).padStart(6)}]  1001 ${String(pid).padStart(5)}  ${String(pages(totalVmKb)).padStart(7)}  ${String(pages(anonKb + fileKb)).padStart(7)} ${String(pgtablesKb * 1024).padStart(8)}        0             0 node`,
    `${stamp()} ${constraint}`,
    `${stamp()} ${kill}`,
  ];
  const hn = hostMeta[h].hostname;
  const sl = (offMs: number, msg: string): LogEvent => ({ ts: ts + offMs, msg: `${syslogTime(ts + offMs)} ${hn} ${msg}` });
  const syslog = [
    sl(0, `kernel: ${header}`),
    sl(1, `kernel: Mem-Info:`),
    sl(2, `kernel: ${constraint}`),
    sl(3, `kernel: ${kill}`),
  ];
  return { dmesg: dm, syslog };
}

/* ------------------------- systemd / journald ------------------------- */

function cpuConsumed(minutes: number) {
  const s = minutes * 60 * 0.36 + minutes * 0.917;
  return `${Math.floor(s / 60)}min ${(s % 60).toFixed(3)}s`;
}

function serviceJournal(env: Environment, h: AppHost): LogEvent[] {
  const hn = hostMeta[h].hostname;
  const out: LogEvent[] = [];
  const L = (ts: number, msg: string) => out.push({ ts, msg: `${syslogTime(ts)} ${hn} ${msg}` });
  const node = (ts: number, pid: number, msg: string) => L(ts, `node[${pid}]: ${msg}`);
  const startup = (ts: number, pid: number) => {
    L(ts, `systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`);
    node(ts + 820, pid, `{"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`);
    node(ts + 1010, pid, `{"level":30,"msg":"connected to redis","url":"redis://cache.internal.shopfast.io:6379"}`);
    node(ts + 1180, pid, `{"level":30,"msg":"pricing: in-memory price cache enabled"}`);
    node(ts + 1290, pid, `{"level":30,"msg":"checkout-api v2.15.0 listening on 127.0.0.1:3000"}`);
  };
  // the old 2.13.1 process (started ~18h ago) stopped by the deploy
  const oldStart = env.now - (18 * 60 + 22) * MIN;
  const oldPid = 2841 + idxOf(h) * 17;
  L(oldStart, `systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`);
  node(oldStart + 1300, oldPid, `{"level":30,"msg":"checkout-api v2.13.1 listening on 127.0.0.1:3000"}`);
  const dep = env.now - DEPLOY[h] * MIN + 14_000;
  L(dep - 1400, `systemd[1]: Stopping checkout-api.service - ShopFast checkout API (Node.js)...`);
  node(dep - 1390, oldPid, `{"level":30,"msg":"SIGTERM received, draining connections"}`);
  L(dep - 300, `systemd[1]: checkout-api.service: Deactivated successfully.`);
  L(dep - 290, `systemd[1]: Stopped checkout-api.service - ShopFast checkout API (Node.js).`);
  L(dep - 280, `systemd[1]: checkout-api.service: Consumed 6h 41min 12.008s CPU time.`);
  startup(dep, pidOf(h, 0));
  let prevStart = DEPLOY[h];
  KILLS[h].forEach((m, k) => {
    const ts = killTs(env, h, k);
    const used = cpuConsumed(prevStart - m);
    L(ts + 4, `systemd[1]: checkout-api.service: A process of this unit has been killed by the OOM killer.`);
    L(ts + 31, `systemd[1]: checkout-api.service: Main process exited, code=killed, status=9/KILL`);
    L(ts + 33, `systemd[1]: checkout-api.service: Failed with result 'oom-kill'.`);
    L(ts + 35, `systemd[1]: checkout-api.service: Consumed ${used} CPU time.`);
    L(ts + 2080, `systemd[1]: checkout-api.service: Scheduled restart job, restart counter is at ${k + 1}.`);
    L(ts + 2084, `systemd[1]: Stopped checkout-api.service - ShopFast checkout API (Node.js).`);
    L(ts + 2086, `systemd[1]: checkout-api.service: Consumed ${used} CPU time.`);
    startup(ts + 2091, pidOf(h, k + 1));
    prevStart = m;
  });
  return out;
}

/* ------------------------------ incident ------------------------------ */

const incident: Incident = {
  id: 'oom-memory-leak',
  code: 'INC-4150',
  order: 5,
  title: 'Random 502 Bad Gateway bursts',
  teaser: 'Since this morning, short bursts of 502s hit a few percent of requests — and they are getting more frequent.',
  difficulty: 'intermediate',
  tags: ['Linux', 'OOM killer', 'Node.js', 'systemd', 'Memory leaks'],
  parMinutes: 15,
  seed: 4150,
  now: '2026-10-05T16:40:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[SLO] checkout-api availability — 1h error-budget burn rate 7.4×',
      details:
        'SLO "checkout-api availability 99.9% (30d)": 1h burn rate 7.4×, 6h burn rate 3.2×. Errors are HTTP 502 returned by checkout-api-tg targets. Note: alarm checkout-alb-target-5xx-high is still OK (errors arrive in bursts shorter than its 3-datapoint window).',
      minutesAgo: 12,
    },
    reports: [
      { from: 'Priya Nair', role: 'Customer Support Lead', channel: '#incident-4150', message: 'We keep getting screenshots of a plain white "502 Bad Gateway" page, mostly right after people press Pay. Hitting refresh usually works, which is why it took us a while to escalate. Two customers think they were charged twice — can someone confirm?', minutesAgo: 10 },
      { from: 'Marco Rossi', role: 'Backend Engineer (pricing)', channel: '#incident-4150', message: "2.15.0 went out at 09:30 — it's the pricing perf work, /cart p50 went from 140 ms to under 40 ms. All three hosts are up, the ALB says healthy and I can't reproduce a single 502. Wasn't there a WAF change this morning too?", minutesAgo: 7 },
      { from: 'Hannah Okafor', role: 'SRE Lead', channel: '#incident-4150', message: "The 502s come in clumps, a few times an hour, and the clumps are getting closer together — that smells like something cyclic. Nothing stays down long enough for a health check to notice. You're IC; I'd like a cause before the evening peak, not another round of 'can't reproduce'.", minutesAgo: 5 },
    ],
    impact: '1–3% of requests fail with 502 in short bursts several times per hour; some checkout submissions fail mid-flight (customers retry, risking duplicate payments). Bursts are becoming more frequent through the day.',
    services: ['checkout-api (app-1, app-2, app-3)', 'nginx', 'shopfast-prod-alb'],
  },

  build(env) {
    const hosts = APP_HOSTS;
    env.traffic.minutes = 180;
    env.traffic.hosts = []; // access/app logs are generated below, per process incarnation

    // ---------------- Metrics ----------------
    for (const h of hosts) {
      setPoints(env, 'ec2.mem', series(`mem-${h}`, 0, { noise: 0.004 }).map((_v, m) => memPct(h, m)).clamp(0, 100).round(1).build(), h);
      setPoints(
        env,
        'ec2.cpu',
        series(`cpu-${h}`, 0, { noise: 0.08 })
          .map((_v, m) => {
            const c = cycleAt(h, m);
            const base = 19 + idxOf(h) * 1.4 + (180 - m) * 0.012;
            if (!c) return base;
            if (c.since <= 1) return base + 22; // V8 startup + JIT warm-up
            if (c.untilKill <= 6) return base + 18 + (6 - c.untilKill) * 5; // GC thrashing near the limit
            return base + 2;
          })
          .clamp(0, 100)
          .build(),
        h,
      );
    }
    panel(env, 'ec2.mem').featured = true;
    addPanel(env, {
      id: 'ec2.mem.12h',
      group: 'EC2',
      namespace: 'CWAgent',
      metric: 'mem_used_percent',
      resource: 'shopfast-checkout-asg (last 13 h, 5-min)',
      unit: '%',
      stat: 'Maximum',
      periodMinutes: 5,
      featured: true,
      series: hosts.map(h => ({
        name: h,
        points: series(`mem12-${h}`, 0, { noise: 0.004, points: 156, periodMinutes: 5 })
          .map((_v, m) => Math.max(memPct(h, m), memPct(h, m + 1), memPct(h, m + 2), memPct(h, m + 3), memPct(h, m + 4)))
          .clamp(0, 100)
          .round(1)
          .build(),
      })),
    });

    const recentKills = hosts.flatMap(h => KILLS[h].filter(m => m < 180));
    setPoints(
      env,
      'alb.target5xx',
      series('t5xx', 1.3, { noise: 0.4 })
        .map((v, m) => {
          const hits = recentKills.filter(k => k === m).length;
          return hits ? v + 34 * hits + (m % 7) * 3 : v;
        })
        .clamp(0)
        .round(0)
        .build(),
    );
    setPoints(
      env,
      'alb.latency',
      series('lat', 0.42, { noise: 0.1 })
        .wave(0.05)
        .map((v, m) => {
          const worst = Math.min(...hosts.map(h => cycleAt(h, m)?.untilKill ?? 99));
          return worst <= 4 ? v + 0.35 * (5 - worst) : v;
        })
        .clamp(0)
        .round(3)
        .build(),
    );
    // red herrings: Monday traffic a bit higher, a few Redis evictions
    setPoints(env, 'alb.requests', series('req', 2390, { noise: 0.05 }).wave(0.04).rampTo(170, 2610, 60).clamp(0).round(0).build());
    setPoints(env, 'cache.evictions', series('evict', 0.3, { noise: 1 }).rampTo(150, 7, 10).rampTo(95, 3, 20).clamp(0).round(0).build());
    panel(env, 'cache.evictions').featured = true;

    // ---------------- Host state ----------------
    const nowState: Record<AppHost, { rssKb: number; vszKb: number; pctMem: number; cpu: number; used: number; free: number; cache: number; load: [number, number, number]; memory: string; time: string }> = {
      'app-1': { rssKb: 1_594_112, vszKb: 12_811_244, pctMem: 20.0, cpu: 24.1, used: 2707, free: 3605, cache: 1490, load: [0.61, 0.74, 0.88], memory: '1.5G', time: '1:52' },
      'app-2': { rssKb: 6_180_544, vszKb: 15_912_448, pctMem: 77.4, cpu: 61.3, used: 7186, free: 168, cache: 448, load: [1.94, 1.61, 1.12], memory: '5.9G', time: '17:48' },
      'app-3': { rssKb: 3_798_416, vszKb: 14_102_016, pctMem: 47.5, cpu: 23.8, used: 4860, free: 1702, cache: 1240, load: [0.72, 0.81, 0.93], memory: '3.6G', time: '6:21' },
    };
    const unit = (heap: number) =>
      `[Unit]\nDescription=ShopFast checkout API (Node.js)\nAfter=network-online.target\n\n[Service]\nUser=shopfast\nEnvironmentFile=/etc/checkout-api/env\n# rendered by deploy pipeline from checkout-api@2.15.0:deploy/checkout-api.service\nExecStart=/usr/bin/node --max-old-space-size=${heap} /opt/checkout-api/dist/server.js\nRestart=always\nRestartSec=2\nLimitNOFILE=65535\n\n[Install]\nWantedBy=multi-user.target\n`;

    for (const h of hosts) {
      const hh = host(env, h);
      const meta = hostMeta[h];
      const st = nowState[h];
      const kills = KILLS[h];
      const k = kills.length; // current incarnation
      const pid = pidOf(h, k);
      const lastStart = killTs(env, h, k - 1) + 2091;
      const sinceMin = Math.round((env.now - lastStart) / MIN);

      hh.env.APP_VERSION = '2.15.0';
      hh.files['/etc/systemd/system/checkout-api.service'] = unit(6144);
      hh.files['/opt/checkout-api/package.json'] = hh.files['/opt/checkout-api/package.json'].replace('"version": "2.13.1"', '"version": "2.15.0"');
      hh.files['/opt/checkout-api/CHANGELOG.md'] = `# Changelog

## 2.15.0 (2026-10-05)
- perf(pricing): memoise priceCart() results per cart + promo code (#842) — /cart p50 140 ms → 38 ms in staging
- ops: give node more heap headroom (--max-old-space-size 1536 → 6144) after "JavaScript heap out of memory" crashes in staging (#845)
- chore: bump fastify 4.28.1, pino 9.4.0

## 2.13.1 (2026-10-04)
- fix(tax): banker's rounding for EUR/GBP multi-currency carts
`;
      hh.memory = { totalMb: 7802, usedMb: st.used, freeMb: st.free, buffCacheMb: st.cache, swapTotalMb: 0, swapUsedMb: 0 };
      hh.load = st.load;
      hh.cpu = { cores: 2, user: h === 'app-2' ? 33.8 : 11.2 + idxOf(h), system: h === 'app-2' ? 6.4 : 2.3, iowait: h === 'app-2' ? 1.1 : 0.1, steal: 0, idle: 0 };
      hh.cpu.idle = Math.round((100 - hh.cpu.user - hh.cpu.system - hh.cpu.iowait) * 10) / 10;
      hh.sysctl['vm.panic_on_oom'] = '0';
      hh.sysctl['vm.oom_kill_allocating_task'] = '0';
      hh.sysctl['vm.overcommit_ratio'] = '50';
      const node = hh.processes.find(p => p.command.includes('/opt/checkout-api/dist/server.js'))!;
      Object.assign(node, {
        pid,
        cpu: st.cpu,
        mem: st.pctMem,
        vszKb: st.vszKb,
        rssKb: st.rssKb,
        start: hm(lastStart),
        time: st.time,
        command: 'node --max-old-space-size=6144 /opt/checkout-api/dist/server.js',
      });
      const svc = hh.services['checkout-api'];
      Object.assign(svc, {
        active: 'active (running)',
        since: `${systemdTime(lastStart)}; ${sinceMin}min ago`,
        mainPid: pid,
        memory: st.memory,
        tasks: 23,
        execStart: '/usr/bin/node --max-old-space-size=6144 /opt/checkout-api/dist/server.js',
        journal: serviceJournal(env, h).map(e => e.msg),
      });

      // kernel ring buffer: one full OOM report per kill
      for (let i = 0; i < kills.length; i++) hh.dmesg.push(...oomReport(env, h, i).dmesg);

      const oomScore = Math.round((st.rssKb / (7802 * 1024)) * 1000);
      hh.commandOverrides.push(
        { match: /^systemctl\s+show\b.*NRestarts/, output: `NRestarts=${k}` },
        { match: new RegExp(`^cat\\s+/proc/(${pid}|self)/oom_score$`), output: String(oomScore) },
        { match: new RegExp(`^cat\\s+/proc/${pid}/oom_score_adj$`), output: '0' },
        {
          match: new RegExp(`^cat\\s+/proc/${pid}/status$`),
          output: `Name:\tnode\nUmask:\t0022\nState:\tS (sleeping)\nTgid:\t${pid}\nPid:\t${pid}\nPPid:\t1\nUid:\t1001\t1001\t1001\t1001\nGid:\t1001\t1001\t1001\t1001\nVmPeak:\t${st.vszKb + 41_220} kB\nVmSize:\t${st.vszKb} kB\nVmHWM:\t${st.rssKb + 2_104} kB\nVmRSS:\t${st.rssKb} kB\nRssAnon:\t${st.rssKb - 44_912} kB\nRssFile:\t44912 kB\nRssShmem:\t0 kB\nVmData:\t${st.rssKb + 812_330} kB\nVmSwap:\t0 kB\nThreads:\t11`,
        },
        {
          match: /^journalctl\s+(-k|--dmesg)\b/,
          output: kills.flatMap((_m, i) => oomReport(env, h, i).syslog.map(e => e.msg)).join('\n'),
        },
        {
          match: /^cat\s+\/proc\/meminfo$/,
          output: `MemTotal:        ${7802 * 1024} kB\nMemFree:         ${st.free * 1024} kB\nMemAvailable:    ${Math.round((st.free + st.cache * 0.85) * 1024)} kB\nBuffers:            2120 kB\nCached:          ${st.cache * 1024 - 120_000} kB\nSwapCached:            0 kB\nActive:           412880 kB\nInactive:        ${st.rssKb + 310_000} kB\nAnonPages:       ${st.rssKb + 92_000} kB\nSwapTotal:             0 kB\nSwapFree:              0 kB\nCommitLimit:     ${Math.round(7802 * 1024 * 0.5)} kB\nCommitted_AS:    ${st.vszKb + 2_400_000} kB`,
        },
      );

      // ---------------- Logs ----------------
      // /var/log/messages: kernel + systemd + node stdout
      const msgs: LogEvent[] = [];
      for (let i = 0; i < kills.length; i++) msgs.push(...oomReport(env, h, i).syslog);
      msgs.push(...serviceJournal(env, h).filter(e => e.ts > env.now - (DEPLOY[h] + 2) * MIN));
      injectLog(env, h, '/var/log/messages', msgs);

      // nginx error log: in-flight requests cut off + connection refused while node restarts
      const errLines: LogEvent[] = [];
      let conn = 4_400_000 + idxOf(h) * 211_000;
      kills.forEach((m, i) => {
        const ts = killTs(env, h, i);
        conn += 9000 + (m % 13) * 211;
        const rng = createRng(hashString(`err-${h}-${i}`));
        const inflight = 2 + (i % 3);
        for (let j = 0; j < inflight; j++) {
          const [meth, path] = INFLIGHT[(i + j) % INFLIGHT.length];
          const t = ts + 2 + j;
          errLines.push({ ts: t, msg: `${nginxErrTime(t)} [error] ${1312 + (j % 2)}#${1312 + (j % 2)}: *${conn + j} upstream prematurely closed connection while reading response header from upstream, client: ${ALB_IPS[(i + j) % 4]}, server: api.shopfast.io, request: "${meth} ${path} HTTP/1.1", upstream: "http://127.0.0.1:3000${path}", host: "api.shopfast.io"` });
        }
        const refused = 7 + Math.floor(rng() * 6);
        for (let j = 0; j < refused; j++) {
          const t = ts + 120 + Math.floor((j * 3300) / refused);
          const isHealth = j === 4;
          const [meth, path] = isHealth ? ['GET', '/health'] : REQS[(i * 5 + j) % REQS.length];
          errLines.push({ ts: t, msg: `${nginxErrTime(t)} [error] ${1312 + (j % 2)}#${1312 + (j % 2)}: *${conn + 10 + j} connect() failed (111: Connection refused) while connecting to upstream, client: ${isHealth ? ALB_IPS[j % 2] : ALB_IPS[(i + j) % 4]}, server: api.shopfast.io, request: "${meth} ${path} HTTP/1.1", upstream: "http://127.0.0.1:3000${path}", host: "api.shopfast.io"` });
        }
      });
      injectLog(env, h, '/var/log/nginx/error.log', errLines);

      // access log: background traffic + the 502s that match the error log
      const profile = (m: number) => {
        const c = cycleAt(h, m);
        const near = c && c.untilKill <= 4;
        return { rpm: 7 + Math.round((180 - m) / 90), p50Ms: near ? 180 + (4 - c!.untilKill) * 90 : 41 };
      };
      const access = nginxAccess({ seed: `oom-access-${h}`, now: env.now, minutes: 180, rpm: 7, p50Ms: 41, profile });
      const access502 = errLines
        .filter(e => e.ts > env.now - 180 * MIN)
        .map(e => {
          const req = e.msg.match(/request: "(\w+) ([^ ]+) HTTP\/1\.1"/)!;
          const client = e.msg.match(/client: ([\d.]+)/)![1];
          const premature = /prematurely/.test(e.msg);
          const r = createRng(hashString(e.msg));
          const rt = premature ? (0.2 + r() * 1.3).toFixed(3) : '0.000';
          const ua = req[2] === '/health' ? 'ELB-HealthChecker/2.0' : UA[Math.floor(r() * UA.length)];
          return { ts: e.ts, msg: `${client} - - [${nginxTime(e.ts)}] "${req[1]} ${req[2]} HTTP/1.1" 502 157 "-" "${ua}" rt=${rt} uct=${premature ? '0.000' : '-'} urt=${premature ? (Number(rt) - 0.001).toFixed(3) : '0.000'} rid=${hex(r, 32)}` };
        });
      injectLog(env, h, '/var/log/nginx/access.log', [...access, ...access502]);

      // app log: request logs per process incarnation (pid changes at every restart) + GC warnings + startup
      const starts = [DEPLOY[h], ...kills];
      const app: LogEvent[] = [];
      for (let inc = 0; inc < starts.length; inc++) {
        const from = inc === 0 ? env.now - DEPLOY[h] * MIN + 14_000 : killTs(env, h, inc - 1) + 2091;
        const to = inc < kills.length ? killTs(env, h, inc) : env.now;
        const ipid = pidOf(h, inc);
        if (to > env.now - 180 * MIN) {
          const gen = appJson({ seed: `oom-app-${h}`, now: env.now, minutes: 180, rpm: 7, p50Ms: 41, hostname: meta.hostname, pid: ipid, profile });
          app.push(...gen.filter(e => e.ts > from + 1300 && e.ts < to));
        }
        app.push({ ts: from + 1180, msg: JSON.stringify({ level: 30, time: iso(from + 1180), pid: ipid, hostname: meta.hostname, msg: 'pricing: in-memory price cache enabled' }) });
        app.push({ ts: from + 1290, msg: JSON.stringify({ level: 30, time: iso(from + 1290), pid: ipid, hostname: meta.hostname, msg: 'checkout-api v2.15.0 listening on 127.0.0.1:3000' }) });
        // long mark-sweep pauses as the old generation approaches its (new, huge) limit
        const lenMin = inc < kills.length ? (to - from) / MIN : cycleAt(h, 0)!.len;
        for (let g = 0; g < 7; g++) {
          const t = to - (7 - g) * 62_000 - (g * 4513) % 20_000;
          if (t <= from) continue;
          const frac = (t - from) / MIN / lenMin;
          if (frac < 0.6) continue;
          app.push({ ts: t, msg: JSON.stringify({ level: 40, time: iso(t), pid: ipid, hostname: meta.hostname, msg: 'long gc pause', kind: 'mark-sweep-compact', durationMs: 290 + g * 96 + (g * 37) % 50, heapUsedMb: Math.round(380 + 5320 * frac), heapTotalMb: Math.round(420 + 5420 * frac) }) });
        }
      }
      // the pre-deploy 2.13.1 process (before the window this is just the shutdown line)
      app.push({ ts: env.now - DEPLOY[h] * MIN + 12_610, msg: JSON.stringify({ level: 30, time: iso(env.now - DEPLOY[h] * MIN + 12_610), pid: 2841 + idxOf(h) * 17, hostname: meta.hostname, msg: 'SIGTERM received, draining connections' }) });
      injectLog(env, h, '/var/log/checkout-api/app.log', app);
    }

    // ---------------- Changes / CloudTrail ----------------
    env.changes.unshift({
      id: 'chg-9031',
      minutesAgo: 335,
      kind: 'infra',
      service: 'edge',
      title: 'terraform: WAF AWSManagedRulesCommonRuleSet COUNT → BLOCK (SizeRestrictions_BODY excluded)',
      author: 'terraform-ci (PR #1219, tom.reyes)',
      status: 'succeeded',
      description: 'After 7 days in COUNT mode (0.02% of requests matched, all from scanners), switch shopfast-prod-waf CommonRuleSet to BLOCK. Blocked requests receive HTTP 403 from the load balancer.',
    });
    env.changes.unshift({
      id: 'chg-9024',
      minutesAgo: 433,
      kind: 'deploy',
      service: 'checkout-api',
      title: 'checkout-api 2.15.0 — memoised cart pricing + Node heap headroom',
      author: 'marco.rossi',
      status: 'succeeded',
      version: '2.15.0',
      description: 'Pipeline: build ✔ · unit ✔ · staging soak (20 min) ✔ · rolling deploy app-1 → app-2 → app-3 ✔ (09:28–09:32). /cart p50 140 ms → 38 ms in staging. The systemd unit is rendered from deploy/checkout-api.service.',
      diff: `diff --git a/src/pricing/priceCart.ts b/src/pricing/priceCart.ts
--- a/src/pricing/priceCart.ts
+++ b/src/pricing/priceCart.ts
@@ -1,14 +1,27 @@
 import { promotions } from './promotions';
 import { applyPromotions, type PricedCart } from './engine';
 import type { Cart } from '../cart/types';

+// Pricing is recomputed on every cart read/update/checkout and evaluating
+// ~3.4k promotion rules is our hottest path. Memoise per cart + promo code.
+const priceCache = new Map<string, PricedCart>();
+
 export async function priceCart(cart: Cart, promoCode?: string): Promise<PricedCart> {
-  const promos = await promotions.active();
-  return applyPromotions(cart, promos, promoCode);
+  const key = \`\${cart.id}:\${cart.updatedAt}:\${promoCode ?? ''}\`;
+  const hit = priceCache.get(key);
+  if (hit) return hit;
+
+  const promos = await promotions.active(); // structuredClone()d snapshot of all active rules
+  const priced = applyPromotions(cart, promos, promoCode);
+  // keep the evaluated rules next to the result so support can explain a price
+  priceCache.set(key, { ...priced, evaluatedRules: promos });
+  return priced;
 }
diff --git a/deploy/checkout-api.service b/deploy/checkout-api.service
--- a/deploy/checkout-api.service
+++ b/deploy/checkout-api.service
@@ -6,7 +6,8 @@ After=network-online.target
 [Service]
 User=shopfast
 EnvironmentFile=/etc/checkout-api/env
-ExecStart=/usr/bin/node --max-old-space-size=1536 /opt/checkout-api/dist/server.js
+# staging crashed with "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory"; m6i.large has 8 GiB
+ExecStart=/usr/bin/node --max-old-space-size=6144 /opt/checkout-api/dist/server.js
 Restart=always
 RestartSec=2
 LimitNOFILE=65535`,
    });
    env.cloudtrail.push(
      { minutesAgo: 335, eventName: 'UpdateWebACL', eventSource: 'wafv2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'shopfast-prod-waf', request: { name: 'shopfast-prod-waf', scope: 'REGIONAL', rules: [{ name: 'AWS-AWSManagedRulesCommonRuleSet', priority: 1, overrideAction: { none: {} } }] } },
      { minutesAgo: 433, eventName: 'SendCommand', eventSource: 'ssm.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'AWS-RunShellScript → i-0a3f9c1e7b2d40851, i-0b7e21d94c6a3f102, i-0c58d0a6e19f7b334' },
    );
    env.cloudtrail.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'oom-kill',
      label: 'Kernel OOM killer repeatedly SIGKILLs the node process (anon-rss ≈ 6.7 GB)',
      kind: 'key',
      match: /Out of memory: Killed process \d+ \(node\)|node invoked oom-killer/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'dmesg -T' },
      explanation: 'This is the kernel, not Node, ending the process: the whole 8 GiB host ran out of memory and the OOM killer picked the process with the highest oom_score — node, with ~6.7 GB of anonymous memory. A SIGKILL cannot be caught, so the app never logs anything about its own death.',
    },
    {
      id: 'unbounded-cache',
      label: '2.15.0 added a module-level Map price cache with no eviction (and stores all promotion rules per entry)',
      kind: 'key',
      match: /new Map<string, PricedCart>\(\)|priceCache\.set\(/,
      foundBy: { tool: 'deploys' },
      explanation: 'Keys include cart.updatedAt, so every cart change creates a new entry, and each entry also retains a cloned snapshot of ~3.4k promotion rules. Nothing ever deletes from the Map, so memory grows with traffic until something kills the process.',
    },
    {
      id: 'heap-flag',
      label: 'node runs with --max-old-space-size=6144 on an 8 GiB host (was 1536)',
      kind: 'key',
      match: /max-old-space-size=6144/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'systemctl cat checkout-api' },
      explanation: 'With a 1.5 GB limit, V8 would have failed fast with "JavaScript heap out of memory" (exactly what staging showed). Raising it to 6 GB on a host with ~7.6 GB usable means the old generation can grow past what the machine can hold, so the kernel OOM killer fires before V8 ever reaches its own limit.',
    },
    {
      id: 'restart-loop',
      label: "systemd: Main process exited, status=9/KILL, Failed with result 'oom-kill', restart counter climbing",
      kind: 'supporting',
      match: /Failed with result 'oom-kill'|restart counter is at \d+|status=9\/KILL/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'journalctl -u checkout-api' },
      explanation: 'Restart=always + RestartSec=2 brings node back within ~3 s every time, which is why no host ever looks "down" — the crash loop is hidden unless you read the journal or alert on restart counts.',
    },
    {
      id: 'mem-sawtooth',
      label: 'mem_used_percent on every app host is a sawtooth: climbs to ~96%, drops to ~20%',
      kind: 'supporting',
      match: /mem_used_percent \[shopfast-checkout-asg/,
      foundBy: { tool: 'cloudwatch', panel: 'ec2.mem' },
      explanation: 'A steady climb followed by a vertical drop is the signature of a leak plus a restart. The drop times line up exactly with the 502 bursts, and the teeth get narrower as traffic grows during the day.',
    },
    {
      id: 'nginx-refused',
      label: 'nginx: connect() failed (111: Connection refused) / upstream prematurely closed connection',
      kind: 'supporting',
      match: /connect\(\) failed \(111: Connection refused\) while connecting to upstream|upstream prematurely closed connection/,
      foundBy: { tool: 'logs', group: '/shopfast/nginx/error' },
      explanation: 'Two flavours of 502: requests in flight when node died ("prematurely closed") and requests that arrived during the ~3 s before node was listening again ("Connection refused"). nginx is healthy — its upstream on 127.0.0.1:3000 is briefly gone.',
    },
    {
      id: 'waf-change',
      label: 'WAF CommonRuleSet switched from COUNT to BLOCK at 11:05',
      kind: 'red-herring',
      match: /CommonRuleSet|UpdateWebACL/,
      foundBy: { tool: 'deploys' },
      explanation: 'WAF blocks are answered by the load balancer with 403, not by the targets with 502, and they would be steady rather than bursty. The first 502 burst (10:38) also predates the WAF change.',
    },
    {
      id: 'evictions',
      label: 'Redis evictions ticked up',
      kind: 'red-herring',
      match: /Evictions \[checkout-cache-001\]/,
      foundBy: { tool: 'cloudwatch', panel: 'cache.evictions' },
      explanation: 'A handful of evictions per minute only means a few cache misses. They cannot make nginx get "Connection refused" from a local process.',
    },
    {
      id: 'traffic',
      label: 'Monday traffic is ~9% higher than the morning baseline',
      kind: 'red-herring',
      match: /RequestCount \[shopfast-prod-alb\]/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.requests' },
      explanation: 'More traffic makes the leak fill memory faster (which is why bursts get closer together), but a 9% increase on hosts at ~20% CPU is not a capacity problem — it is an accelerant, not the cause.',
    },
  ],

  rootCauses: [
    { id: 'rc-oom', correct: true, text: "2.15.0's never-evicted priceCache Map plus --max-old-space-size=6144 on 8 GiB hosts lets node's RSS outgrow the host; the kernel OOM killer SIGKILLs it every ~40–70 min and nginx 502s during the 2 s systemd restart.", explanation: 'dmesg shows the OOM kills, journald shows status=9/KILL + oom-kill restarts, the memory graphs are a sawtooth starting at the 09:30 deploy, and the 2.15.0 diff contains both the never-evicted Map and the heap-limit change.' },
    { id: 'rc-leak', partial: true, text: "A memory leak in checkout-api 2.15.0 makes V8 throw 'JavaScript heap out of memory' once the old generation reaches its limit, crashing node until systemd restarts it.", explanation: 'Right direction, wrong mechanism: V8 never reaches its limit because it was raised to 6144 MB. The host runs out first and the kernel OOM killer SIGKILLs node (status=9/KILL in journald, no heap-OOM message anywhere). Missing that is how the heap-limit change gets overlooked.' },
    { id: 'rc-gc', text: "Mark-sweep-compact GC pauses of 300–900 ms in 2.15.0 stall node's event loop long enough that nginx's upstream connections to 127.0.0.1:3000 fail and return 502.", explanation: 'GC pauses cause latency, not 502s: nginx waits up to 30 s (proxy_read_timeout) and a timeout would be a 504. The errors are "Connection refused" and "prematurely closed" — the process is gone, not paused.' },
    { id: 'rc-keepalive', text: "nginx reuses idle upstream keepalive connections (keepalive 64) after node's 5 s keepAliveTimeout has already closed them, so requests hit a dead socket and get 502.", explanation: 'A plausible classic, but that pattern produces a steady trickle of "upstream prematurely closed" errors at all times, not clumps that line up with memory drops, PID changes and kernel OOM kills.' },
    { id: 'rc-waf', text: 'The 11:05 change put AWSManagedRulesCommonRuleSet into BLOCK mode, and its SizeRestrictions/CrossSiteScripting rules reject checkout POST bodies as intermittent 5xx.', explanation: 'WAF blocks are 403s generated by the ALB, not 502s from targets, and the first 502 burst (10:38) happened before the WAF change.' },
    { id: 'rc-capacity', text: 'Monday traffic (+9%, ~2,600 req/min) exceeds what three m6i.large hosts serve at peak; target tracking is not scaling the ASG out, so nginx sheds load with 502s.', explanation: 'CPU sits around 20% between bursts and traffic is only ~9% up. Adding hosts would spread the same leak over more processes — every one of them would still be OOM-killed.' },
  ],

  fixes: [
    { id: 'fx-rollback', kind: 'correct', text: 'Roll back to 2.13.1 now, then reintroduce the cache as a bounded LRU (max entries + TTL) that does not keep a copy of the promotion rules in every entry.', explanation: 'Rollback stops the bleeding immediately (memory flat again). A cache is only safe if it has a bound — entries, bytes or TTL — and you know the size of what you put in it.' },
    { id: 'fx-heap-alarms', kind: 'correct', text: 'Set --max-old-space-size well below host memory (~1.5–2 GB) and alarm on mem_used_percent plus OOM-kill / systemd-restart log metric filters.', explanation: 'A heap limit below physical memory makes a leak fail loudly as a V8 heap OOM with a clear message instead of a silent kernel SIGKILL. Restart-count and memory alarms would have paged at 10:38 instead of letting the error budget burn all day.' },
    { id: 'fx-bigger', kind: 'partial', text: 'Move the launch template to m6i.xlarge (16 GiB) so each node process has twice the memory headroom before the host runs out.', explanation: 'Doubles the time between OOM kills, but an unbounded cache fills any amount of memory. It buys time at a cost and hides the bug.' },
    { id: 'fx-cron-restart', kind: 'partial', text: 'Add a cron job that gracefully drains and restarts checkout-api every 30 minutes, staggered so only one host restarts at a time.', explanation: 'A graceful drain-and-restart before the OOM point avoids most 502s and is a legitimate stopgap — but it must be retuned as traffic grows, and the leak is still there.' },
    { id: 'fx-swap', kind: 'harmful', text: 'Add an 8 GiB swap file on each app host (vm.swappiness=10) so node can page out cold heap instead of being killed when RAM runs out.', explanation: "V8's garbage collector walks the whole heap; once parts of it are swapped out every major GC turns into disk I/O. The host would thrash for minutes — slow requests, failing health checks, maybe unresponsive SSH — instead of failing in 3 s, and the leak still fills the swap." },
    { id: 'fx-oom-adj', kind: 'harmful', text: 'Set OOMScoreAdjust=-1000 in checkout-api.service so the kernel OOM killer never selects node and the API stays up under memory pressure.', explanation: 'The memory pressure does not go away: the OOM killer kills something else (nginx, the CloudWatch or SSM agent, journald) and, once nothing killable is left, the host hangs or panics. You trade a 3-second blip for a dead host.' },
    { id: 'fx-waf', kind: 'neutral', text: "Revert shopfast-prod-waf's AWSManagedRulesCommonRuleSet to COUNT mode and review sampled requests for false positives on checkout POSTs.", explanation: 'Unrelated to the 502s; it only removes protection.' },
    { id: 'fx-redis', kind: 'neutral', text: 'Scale checkout-cache from cache.r6g.large to cache.r6g.xlarge to eliminate evictions and the extra cache-miss load on checkout-api.', explanation: 'Costs money and changes nothing: Redis is not involved in the failure.' },
  ],

  hints: [
    'The errors come in clumps and no host stays down. Pick one clump, note its exact time and host (nginx error log), and ask: what happened on that host at that second? The system journal and the kernel log know.',
    'Look at CWAgent mem_used_percent for the app hosts over the whole day, then on app-2 run `dmesg -T | grep -i "killed process"` and `journalctl -u checkout-api`.',
    'The kernel OOM killer is SIGKILLing node and systemd restarts it in 2 s. Why can node grow to ~6.7 GB when its heap used to be capped at 1.5 GB? Read the 2.15.0 diff and `systemctl cat checkout-api`.',
  ],

  debrief: {
    summary: `At 09:30 checkout-api **2.15.0** shipped two changes together. The first memoised \`priceCart()\` in a module-level \`Map\` — keyed by cart id, \`updatedAt\` and promo code, so every cart change creates a new key, and each entry also kept a cloned copy of ~3,400 promotion rules. Nothing ever removed entries. The second raised \`--max-old-space-size\` from **1536 to 6144** MB because staging had crashed with "JavaScript heap out of memory" — the leak announcing itself, misread as "Node needs more heap".

In production each node process now grew by ~150 MB per minute of traffic. With a 6 GB heap limit on an 8 GiB m6i.large, V8 never reached its own limit: the **host** ran out first and the kernel **OOM killer** chose the process with the largest \`oom_score\` — node — and sent it SIGKILL. \`Restart=always\` brought it back after 2 s, so every 40–70 minutes per host nginx returned **502** for ~3 seconds: in-flight requests got "upstream prematurely closed connection", new ones got "connect() failed (111: Connection refused)". Health checks (2 failures × 10 s) never noticed, and the 5xx alarm (3 datapoints > 50) never fired because each burst lasted one minute.

The restarts staggered across the three hosts and got closer together as afternoon traffic grew, which is exactly what the memory sawtooth shows. The WAF change, Redis evictions and the Monday traffic bump were all real, but none of them can make a local process refuse connections.`,
    timeline: [
      { minutesAgo: 433, event: 'checkout-api 2.15.0 rolling deploy (app-1 09:28, app-2 09:30, app-3 09:32) with priceCache Map and --max-old-space-size=6144' },
      { minutesAgo: 366, event: 'First kernel OOM kill (app-3); systemd restarts node in ~2 s — first 502 burst' },
      { minutesAgo: 335, event: 'WAF CommonRuleSet switched to BLOCK (unrelated, red herring)' },
      { minutesAgo: 183, event: 'OOM kill interval has shrunk from ~70 to ~55 minutes per host as traffic rises' },
      { minutesAgo: 36, event: 'Latest OOM kill on app-2 (restart counter 7); app-2 is back at ~92% memory now' },
      { minutesAgo: 12, event: 'SLO burn-rate alert pages on-call (5xx alarm still OK)' },
    ],
    concepts: [
      { title: 'The Linux OOM killer and oom_score', body: 'Linux overcommits memory: allocations succeed until pages are actually touched. When a page fault cannot be satisfied even after reclaiming page cache, the kernel invokes the OOM killer, which picks the process with the highest `oom_score` (roughly its share of RAM + swap, adjusted by `oom_score_adj` from -1000 to +1000) and sends SIGKILL. The report in `dmesg` lists every task\'s RSS in pages and ends with `Out of memory: Killed process <pid> (node) … anon-rss:…kB`. SIGKILL cannot be caught, so the victim never logs anything — look in the kernel log and journald, not the app log.' },
      { title: 'RSS vs. V8 heap vs. max-old-space-size', body: 'RSS is all resident memory of the process: the V8 heap (new + old generation), compiled code, stacks, and off-heap buffers. `--max-old-space-size` caps only the old generation. Its job is to make a runaway heap fail inside Node ("FATAL ERROR: Reached heap limit … JavaScript heap out of memory") with a clear message and core/heap snapshot options. The cap must sit comfortably below the memory the host can actually give the process — on an 8 GiB box with nginx, agents and page cache, 6144 MB of old space plus everything else does not fit, so the kernel kills node before V8 complains.' },
      { title: 'Unbounded caches', body: 'An in-process cache without eviction is a memory leak with a nice name. Every cache needs a bound — max entries, max total size, and/or TTL (LRU caches do this) — plus a key with good reuse (a key that includes `updatedAt` changes on every write, so hit rate is low and growth is maximal). Also be careful what you store: here each entry retained a deep-cloned rules snapshot, making every miss cost hundreds of KB.' },
      { title: 'systemd Restart=always hides crash loops', body: 'Automatic restarts are good for availability, but they turn a crash into a 3-second blip that health checks, ASG and dashboards miss. `journalctl -u <svc>` shows `Main process exited, code=killed, status=9/KILL` and `Failed with result \'oom-kill\'`; `systemctl show -p NRestarts <svc>` gives the count. Alert on restarts and OOM kills (CloudWatch Logs metric filter), not just on "is it up?".' },
      { title: 'Reading a sawtooth memory graph', body: 'A slow, roughly linear climb followed by a vertical drop to the same floor means "leak + restart". Read three things: the slope (leak rate — here proportional to traffic), the ceiling (where something kills it — ~96% means the kernel, not V8), and the period (time to fill). When the teeth narrow over the day, the leak is driven by request volume. Use Maximum, not Average, at coarse periods or the peaks get smoothed away.' },
      { title: '502 vs. 504, Target_5XX vs. ELB_5XX', body: 'nginx returns 502 when it cannot get a valid response from its upstream (refused, reset, closed early) and 504 when the upstream is too slow. Because nginx on the target generated the 502, the ALB counts it in `HTTPCode_Target_5XX_Count`; if nginx itself were down, the ALB would generate the 502 and count `HTTPCode_ELB_5XX_Count`. Knowing who produced an error tells you which hop failed.' },
    ],
    commands: [
      { cmd: 'dmesg -T | grep -iE "invoked oom-killer|killed process"', why: 'Find kernel OOM kills, their victims and RSS at the moment of death' },
      { cmd: 'journalctl -u checkout-api | grep -E "oom-kill|status=9/KILL|restart counter"', why: 'See systemd-level crash/restart history that the app itself cannot log' },
      { cmd: 'systemctl show -p NRestarts checkout-api', why: 'How many times systemd has restarted the service since it was last started deliberately' },
      { cmd: 'ps -o pid,rss,vsz,etime,cmd -C node', why: 'Current RSS and uptime of node — a young process with a huge RSS is leaking fast' },
      { cmd: 'cat /proc/<pid>/oom_score', why: 'How likely the kernel is to pick this process next (0–1000)' },
      { cmd: 'grep -c "connect() failed (111" /var/log/nginx/error.log', why: 'Count upstream-refused errors and line their timestamps up with restarts' },
    ],
    prevention: [
      'Every in-process cache must have a bound (entries, bytes, TTL) and a hit-rate metric; review "new Map()" at module scope like any other resource allocation.',
      'Derive --max-old-space-size from instance memory (e.g. 50–75% of RAM minus other processes) and never raise it to "fix" a heap OOM without a heap snapshot showing why the heap grew.',
      'Alarm on CWAgent mem_used_percent and on OOM kills / systemd restarts (CloudWatch Logs metric filter on "oom-kill"), and use burn-rate SLO alerts so bursty errors still page.',
      'Soak-test releases under production-like traffic long enough to fill memory (hours, not 20 minutes) and watch the memory slope, not just error rate.',
      'Make deploys reversible in one step and treat "staging crashed with heap OOM" as a bug report, not a tuning request.',
    ],
    reading: [
      { title: 'Node.js CLI: --max-old-space-size', url: 'https://nodejs.org/api/cli.html#--max-old-space-sizesize-in-mib' },
      { title: 'Linux kernel docs: /proc/sys/vm (overcommit, OOM)', url: 'https://docs.kernel.org/admin-guide/sysctl/vm.html' },
      { title: 'systemd.service: Restart=', url: 'https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html' },
    ],
  },
};

export default incident;
