import type { Environment, Host } from '../types';
import { dateCmd, hms, syslogTime } from '../time';
import { countArg, globToRegex, human, lines, makeGrepRegex, pad, parseArgs, resolvePath } from './shell';

export interface Ctx {
  env: Environment;
  host: Host;
  cwd: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** sortable key for "Oct 09 14:52:01 ..." syslog lines */
const syslogKey = (l: string) => {
  const m = MONTHS.indexOf(l.slice(0, 3));
  return m < 0 ? l : String(m).padStart(2, '0') + l.slice(3);
};
const lsTime = (ts: number) => {
  const d = new Date(ts);
  return `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${hms(ts).slice(0, 5)}`;
};
const usDate = (ts: number) => {
  const d = new Date(ts);
  return `${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}/${d.getUTCFullYear()}`;
};
const hostNow = (ctx: Ctx) => ctx.env.now + ctx.host.time.offsetSeconds * 1000;

/* ------------------------------ filesystem ------------------------------ */

function fileSize(h: Host, path: string): number {
  return h.fileMeta[path]?.size ?? new TextEncoder().encode(h.files[path] ?? '').length;
}

function listDir(h: Host, dir: string): { name: string; path: string; isDir: boolean }[] {
  const prefix = dir === '/' ? '/' : dir + '/';
  const seen = new Map<string, boolean>();
  const all = new Set([...Object.keys(h.files), ...Object.keys(h.fileMeta)]);
  for (const p of all) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const [first, ...more] = rest.split('/');
    if (!first) continue;
    seen.set(first, (seen.get(first) ?? false) || more.length > 0);
  }
  return [...seen.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, isDir]) => ({ name, path: prefix + name, isDir }));
}

const isDir = (h: Host, path: string) => path === '/' || listDir(h, path).length > 0;
const exists = (h: Host, path: string) => path in h.files || path in h.fileMeta || isDir(h, path);

function expandGlob(h: Host, cwd: string, arg: string): string[] {
  const abs = resolvePath(cwd, arg);
  if (!abs.includes('*') && !abs.includes('?')) return [abs];
  const re = globToRegex(abs);
  const matches = [...new Set([...Object.keys(h.files), ...Object.keys(h.fileMeta)])].filter(p => re.test(p)).sort();
  return matches.length ? matches : [abs];
}

function owner(path: string) {
  if (path.startsWith('/var/log/nginx')) return ['nginx', 'nginx'];
  if (path.startsWith('/var/log/checkout-api') || path.startsWith('/opt/')) return ['shopfast', 'shopfast'];
  if (path.startsWith('/home/ec2-user')) return ['ec2-user', 'ec2-user'];
  return ['root', 'root'];
}

function readFile(ctx: Ctx, path: string, cmd: string): { text?: string; err?: string } {
  const h = ctx.host;
  if (path in h.files) return { text: h.files[path] };
  if (path in h.fileMeta) return { text: '' };
  if (isDir(h, path)) return { err: `${cmd}: ${path}: Is a directory` };
  if (path.startsWith('/proc/') || path.startsWith('/sys/')) return { err: `${cmd}: ${path}: Permission denied` };
  return { err: `${cmd}: ${path}: No such file or directory` };
}

export function ls(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args);
  const long = a.flags.has('l');
  const all = a.flags.has('a');
  const humanSizes = a.flags.has('h');
  const targets = a.positional.length ? a.positional.flatMap(p => expandGlob(ctx.host, ctx.cwd, p)) : [ctx.cwd];
  const out: string[] = [];
  const fmt = (name: string, path: string, dir: boolean) => {
    if (!long) return name;
    const size = dir ? 4096 : fileSize(ctx.host, path);
    const [u, g] = owner(path);
    const mtime = ctx.host.fileMeta[path]?.mtime ?? lsTime(ctx.env.now - 60_000);
    return `${dir ? 'drwxr-xr-x' : '-rw-r--r--'}. 1 ${pad(u, 8)} ${pad(g, 8)} ${pad(humanSizes ? human(size) : size, humanSizes ? 5 : 12, true)} ${mtime} ${name}`;
  };
  for (const t of targets) {
    if (!exists(ctx.host, t)) {
      out.push(`ls: cannot access '${t}': No such file or directory`);
      continue;
    }
    if (!isDir(ctx.host, t)) {
      out.push(fmt(t, t, false));
      continue;
    }
    if (targets.length > 1) out.push(`${t}:`);
    const entries = listDir(ctx.host, t);
    if (long) {
      const total = entries.reduce((s, e) => s + (e.isDir ? 4 : Math.ceil(fileSize(ctx.host, e.path) / 1024)), 0);
      out.push(`total ${humanSizes ? human(total * 1024) : total}`);
      if (all) out.push(fmt('.', t, true), fmt('..', t, true));
    }
    const rows = entries.map(e => fmt(e.name, e.path, e.isDir));
    out.push(long ? rows.join('\n') : rows.join('  '));
  }
  return out.join('\n');
}

export function cat(ctx: Ctx, args: string[], cmd = 'cat'): string {
  const a = parseArgs(args);
  if (!a.positional.length) return `${cmd}: missing file operand`;
  const out: string[] = [];
  for (const p of a.positional.flatMap(x => expandGlob(ctx.host, ctx.cwd, x))) {
    const r = readFile(ctx, p, cmd);
    if (r.err) out.push(r.err);
    else out.push((r.text ?? '').replace(/\n$/, ''));
  }
  return out.join('\n');
}

export function headTail(ctx: Ctx, args: string[], which: 'head' | 'tail'): string {
  const n = countArg(args, 10);
  const files = args.filter((a, i) => !a.startsWith('-') && !(args[i - 1] === '-n'));
  if (!files.length) return `${which}: missing file operand`;
  const follow = args.includes('-f') || args.includes('-F') || args.includes('--follow');
  const out: string[] = [];
  const paths = files.flatMap(f => expandGlob(ctx.host, ctx.cwd, f));
  for (const p of paths) {
    const r = readFile(ctx, p, which);
    if (r.err) {
      out.push(r.err);
      continue;
    }
    if (paths.length > 1) out.push(`==> ${p} <==`);
    const ls = r.text ? lines(r.text) : [];
    out.push(...(which === 'head' ? ls.slice(0, n) : ls.slice(Math.max(0, ls.length - n))));
  }
  if (follow) out.push('', '[simulation] -f: live follow is not available; showing the most recent lines. Press ↑ + Enter to refresh.');
  return out.join('\n');
}

export function grep(ctx: Ctx, args: string[], cmd = 'grep'): string {
  const a = parseArgs(args, ['e', 'm', 'A', 'B', 'C']);
  const pattern = a.opts.e ?? a.positional[0];
  const files = a.opts.e ? a.positional : a.positional.slice(1);
  if (pattern === undefined || !files.length) return 'Usage: grep [OPTION]... PATTERNS [FILE]...\nTry: grep -i "error" /var/log/nginx/error.log';
  const re = makeGrepRegex(pattern, a.flags.has('i'), a.flags.has('E') || cmd === 'egrep' || cmd === 'zgrep', a.flags.has('F'));
  const paths = files.flatMap(f => expandGlob(ctx.host, ctx.cwd, f));
  const multi = paths.length > 1;
  const out: string[] = [];
  for (const p of paths) {
    const r = readFile(ctx, p, 'grep');
    if (r.err) {
      out.push(r.err);
      continue;
    }
    let hits = lines(r.text ?? '').filter(l => l && re.test(l) !== a.flags.has('v'));
    if (a.opts.m) hits = hits.slice(0, Number(a.opts.m));
    if (a.flags.has('c')) out.push(multi ? `${p}:${hits.length}` : String(hits.length));
    else if (a.flags.has('l')) {
      if (hits.length) out.push(p);
    } else out.push(...hits.map(l => (multi ? `${p}:${l}` : l)));
  }
  return out.join('\n');
}

export function wc(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args);
  const out: string[] = [];
  for (const p of a.positional.flatMap(x => expandGlob(ctx.host, ctx.cwd, x))) {
    const r = readFile(ctx, p, 'wc');
    if (r.err) {
      out.push(r.err);
      continue;
    }
    const n = r.text ? lines(r.text).length : 0;
    out.push(a.flags.has('l') ? `${n} ${p}` : `${pad(n, 7, true)} ${pad((r.text ?? '').split(/\s+/).filter(Boolean).length, 7, true)} ${pad(fileSize(ctx.host, p), 9, true)} ${p}`);
  }
  return out.join('\n') || 'wc: missing file operand';
}

/* ------------------------------ processes ------------------------------ */

const shortCmd = (c: string) => {
  if (c.startsWith('nginx:')) return 'nginx';
  const first = c.split(' ')[0];
  return first.split('/').pop() ?? first;
};

export function top(ctx: Ctx): string {
  const h = ctx.host;
  const m = h.memory;
  const procs = [...h.processes].sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  const running = procs.filter(p => p.stat.startsWith('R')).length || 1;
  const zombie = procs.filter(p => p.stat.startsWith('Z')).length;
  const total = 96 + procs.length;
  const c = h.cpu;
  const avail = m.freeMb + m.buffCacheMb * 0.85;
  const rows = procs.slice(0, 18).map(p => {
    const shr = Math.round(p.rssKb * 0.07);
    const res = p.rssKb > 999999 ? (p.rssKb / 1048576).toFixed(1) + 'g' : String(p.rssKb);
    const virt = p.vszKb > 9999999 ? (p.vszKb / 1048576).toFixed(1) + 'g' : String(p.vszKb);
    return `${pad(p.pid, 7, true)} ${pad(p.user.slice(0, 8), 8)}  20   0 ${pad(virt, 7, true)} ${pad(res, 6, true)} ${pad(shr, 6, true)} ${p.stat[0]} ${pad(p.cpu.toFixed(1), 5, true)} ${pad(p.mem.toFixed(1), 5, true)} ${pad(p.time + '.11', 9, true)} ${shortCmd(p.command)}`;
  });
  return [
    `top - ${hms(hostNow(ctx))} up ${h.uptime},  ${h.users} user,  load average: ${h.load.map(l => l.toFixed(2)).join(', ')}`,
    `Tasks: ${pad(total, 3, true)} total, ${pad(running, 3, true)} running, ${pad(total - running - zombie, 3, true)} sleeping,   0 stopped, ${pad(zombie, 3, true)} zombie`,
    `%Cpu(s): ${pad(c.user.toFixed(1), 4, true)} us, ${pad(c.system.toFixed(1), 4, true)} sy,  0.0 ni, ${pad(c.idle.toFixed(1), 4, true)} id, ${pad(c.iowait.toFixed(1), 4, true)} wa,  0.0 hi,  0.1 si, ${pad(c.steal.toFixed(1), 4, true)} st`,
    `MiB Mem : ${pad(m.totalMb.toFixed(1), 8, true)} total, ${pad(m.freeMb.toFixed(1), 8, true)} free, ${pad(m.usedMb.toFixed(1), 8, true)} used, ${pad(m.buffCacheMb.toFixed(1), 8, true)} buff/cache`,
    `MiB Swap: ${pad(m.swapTotalMb.toFixed(1), 8, true)} total, ${pad((m.swapTotalMb - m.swapUsedMb).toFixed(1), 8, true)} free, ${pad(m.swapUsedMb.toFixed(1), 8, true)} used. ${pad(avail.toFixed(1), 8, true)} avail Mem`,
    '',
    '    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND',
    ...rows,
  ].join('\n');
}

export function ps(ctx: Ctx, args: string[]): string {
  const procs = ctx.host.processes;
  const joined = args.join(' ');
  if (/-ef|-e\s*-f/.test(joined)) {
    return [
      'UID          PID    PPID  C STIME TTY          TIME CMD',
      ...procs.map(p => `${pad(p.user.slice(0, 8), 8)} ${pad(p.pid, 7, true)} ${pad(p.pid === 1 ? 0 : p.command.startsWith('nginx: worker') ? 1311 : 1, 7, true)}  ${Math.round(p.cpu) % 100} ${pad(p.start, 5)} ?        ${pad('00:' + p.time.padStart(5, '0'), 8)} ${p.command}`),
    ].join('\n');
  }
  return [
    'USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
    ...procs.map(p => `${pad(p.user.slice(0, 8), 8)} ${pad(p.pid, 7, true)} ${pad(p.cpu.toFixed(1), 4, true)} ${pad(p.mem.toFixed(1), 4, true)} ${pad(p.vszKb, 8, true)} ${pad(p.rssKb, 7, true)} ?        ${pad(p.stat, 4)} ${pad(p.start, 5)} ${pad(p.time, 6, true)} ${p.command}`),
  ].join('\n');
}

export function free(ctx: Ctx, args: string[]): string {
  const m = ctx.host.memory;
  const h = args.some(a => a.includes('h'));
  const g = args.some(a => a === '-g');
  const f = (mb: number) => (h ? (mb >= 1024 ? (mb / 1024).toFixed(1) + 'Gi' : Math.round(mb) + 'Mi') : g ? String(Math.floor(mb / 1024)) : String(Math.round(mb)));
  const avail = m.freeMb + m.buffCacheMb * 0.85;
  return [
    '               total        used        free      shared  buff/cache   available',
    `Mem:     ${pad(f(m.totalMb), 11, true)} ${pad(f(m.usedMb), 11, true)} ${pad(f(m.freeMb), 11, true)} ${pad(f(2), 11, true)} ${pad(f(m.buffCacheMb), 11, true)} ${pad(f(avail), 11, true)}`,
    `Swap:    ${pad(f(m.swapTotalMb), 11, true)} ${pad(f(m.swapUsedMb), 11, true)} ${pad(f(m.swapTotalMb - m.swapUsedMb), 11, true)}`,
  ].join('\n');
}

const gb = (v: number) => {
  if (v === 0) return '0';
  if (v < 1) return `${Math.max(1, Math.round(v * 1024))}M`;
  return v < 10 ? `${v.toFixed(1)}G` : `${Math.round(v)}G`;
};

export function df(ctx: Ctx, args: string[]): string {
  const inodes = args.some(a => a.includes('i'));
  if (inodes) {
    return [
      'Filesystem       Inodes  IUsed    IFree IUse% Mounted on',
      ...ctx.host.disks.map(d => {
        const total = Math.round(d.sizeGb * 524288);
        const pct = d.inodesUsedPct ?? 1;
        const used = Math.round((total * pct) / 100);
        return `${pad(d.fs, 15)} ${pad(total, 7, true)} ${pad(used, 6, true)} ${pad(total - used, 8, true)} ${pad(pct + '%', 5, true)} ${d.mount}`;
      }),
    ].join('\n');
  }
  return [
    'Filesystem        Size  Used Avail Use% Mounted on',
    ...ctx.host.disks.map(d => {
      const avail = Math.max(0, d.sizeGb - d.usedGb);
      const pct = d.sizeGb ? Math.ceil((d.usedGb / d.sizeGb) * 100) : 0;
      return `${pad(d.fs, 16)} ${pad(gb(d.sizeGb), 5, true)} ${pad(gb(d.usedGb), 5, true)} ${pad(gb(avail), 5, true)} ${pad(Math.min(100, pct) + '%', 4, true)} ${d.mount}`;
    }),
  ].join('\n');
}

export function du(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args, ['max-depth', 'd']);
  const target = a.positional[0] ?? ctx.cwd;
  const base = resolvePath(ctx.cwd, target.replace(/\/\*$/, '').replace(/\/$/, '') || '/');
  const rows = ctx.host.du[base];
  if (!rows) {
    if (!exists(ctx.host, base)) return `du: cannot access '${target}': No such file or directory`;
    const files = listDir(ctx.host, base);
    if (!files.length) return `${human(fileSize(ctx.host, base))}\t${base}`;
    return files.map(f => `${human(f.isDir ? 4096 : fileSize(ctx.host, f.path))}\t${f.path}`).join('\n');
  }
  const wantChildren = target.endsWith('*') || a.opts['max-depth'] || a.opts.d;
  const r = wantChildren ? rows.filter(([, p]) => p !== base) : rows.filter(([, p]) => p === base);
  return (r.length ? r : rows).map(([s, p]) => `${s}\t${p}`).join('\n');
}

export function uptime(ctx: Ctx): string {
  const h = ctx.host;
  return ` ${hms(hostNow(ctx))} up ${h.uptime},  ${h.users} user,  load average: ${h.load.map(l => l.toFixed(2)).join(', ')}`;
}

export function vmstat(ctx: Ctx): string {
  const h = ctx.host;
  const c = h.cpu;
  const r = Math.max(1, Math.round(h.load[0]));
  const b = Math.round(c.iowait / 10);
  return [
    'procs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----',
    ' r  b   swpd   free   buff  cache   si   so    bi    bo   in   cs us sy id wa st',
    ` ${r}  ${b}  ${pad(h.memory.swapUsedMb * 1024, 5, true)} ${pad(h.memory.freeMb * 1024, 7, true)}  ${pad(2120, 5, true)} ${pad(h.memory.buffCacheMb * 1024, 7, true)}    0    0    ${pad(Math.round(4 + c.iowait * 30), 3, true)}   ${pad(118, 3, true)} ${pad(1840, 4, true)} ${pad(3120, 4, true)} ${pad(Math.round(c.user), 2, true)} ${pad(Math.round(c.system), 2, true)} ${pad(Math.round(c.idle), 2, true)} ${pad(Math.round(c.iowait), 2, true)} ${pad(Math.round(c.steal), 2, true)}`,
  ].join('\n');
}

export function iostat(ctx: Ctx): string {
  if (ctx.host.iostat) return ctx.host.iostat;
  const c = ctx.host.cpu;
  return [
    `Linux ${ctx.host.kernel} (${ctx.host.hostname}) \t${usDate(hostNow(ctx))} \t_x86_64_\t(${ctx.host.cpu.cores} CPU)`,
    '',
    'avg-cpu:  %user   %nice %system %iowait  %steal   %idle',
    `          ${pad(c.user.toFixed(2), 6, true)}    0.00 ${pad(c.system.toFixed(2), 7, true)} ${pad(c.iowait.toFixed(2), 7, true)} ${pad(c.steal.toFixed(2), 7, true)} ${pad(c.idle.toFixed(2), 7, true)}`,
    '',
    'Device            r/s     rkB/s   rrqm/s  %rrqm r_await rareq-sz     w/s     wkB/s   wrqm/s  %wrqm w_await wareq-sz  aqu-sz  %util',
    'nvme0n1          0.41      9.84     0.00   0.00    0.52    24.00   14.12    211.30     2.10  12.95    0.81    14.96    0.01   1.20',
  ].join('\n');
}

/** boot time derived from the host's `uptime` string ("12 days,  4:11" / "3:07" / "41 min") */
function bootTime(ctx: Ctx): number {
  const u = ctx.host.uptime;
  const days = Number(u.match(/(\d+)\s+days?/)?.[1] ?? 0);
  const hm = u.match(/(\d+):(\d+)/);
  const mins = Number(u.match(/(\d+)\s+min/)?.[1] ?? 0);
  return ctx.env.now - (days * 1440 + (hm ? Number(hm[1]) * 60 + Number(hm[2]) : 0) + mins) * 60000;
}

export function dmesg(ctx: Ctx, args: string[]): string {
  const human = args.some(a => a.includes('T'));
  const bootTs = bootTime(ctx);
  return ctx.host.dmesg
    .map(l => {
      if (!human) return l;
      const m = l.match(/^\[\s*(\d+\.\d+)\]\s?(.*)$/);
      if (!m) return l;
      const ts = bootTs + parseFloat(m[1]) * 1000;
      return `[${dateCmd(ts).replace(' UTC', '')}] ${m[2]}`;
    })
    .join('\n');
}

/* ------------------------------ services ------------------------------ */

const SERVICE_ALIASES: Record<string, string> = { checkout: 'checkout-api', 'checkout-api.service': 'checkout-api', 'nginx.service': 'nginx', chrony: 'chronyd', 'chronyd.service': 'chronyd', ssh: 'sshd' };

function findService(ctx: Ctx, name: string) {
  const n = SERVICE_ALIASES[name] ?? name.replace(/\.service$/, '');
  return ctx.host.services[n];
}

export function systemctl(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args);
  const [sub, name] = a.positional;
  if (!sub || sub === 'list-units' || sub === 'list-unit-files') {
    const failed = a.flags.has('failed') || args.includes('--state=failed');
    const svcs = Object.values(ctx.host.services).filter(s => !failed || /failed/.test(s.active));
    return [
      '  UNIT                               LOAD   ACTIVE   SUB     DESCRIPTION',
      ...svcs.map(s => {
        const [act, sub2] = s.active.split(' ');
        return `${/failed/.test(s.active) ? '●' : ' '} ${pad(s.name + '.service', 34)} loaded ${pad(act, 8)} ${pad((sub2 ?? '').replace(/[()]/g, ''), 7)} ${s.description}`;
      }),
      '',
      `${svcs.length} loaded units listed.`,
    ].join('\n');
  }
  if (['start', 'stop', 'restart', 'reload', 'enable', 'disable', 'kill', 'mask', 'daemon-reload'].includes(sub)) {
    return READ_ONLY;
  }
  if (!name) return `Too few arguments.`;
  const s = findService(ctx, name);
  if (sub === 'is-active') return s ? s.active.split(' ')[0] : 'inactive';
  if (sub === 'is-enabled') return s ? (s.active.startsWith('inactive') && /disabled/.test(s.since) ? 'disabled' : 'enabled') : `Failed to get unit file state for ${name}.service: No such file or directory`;
  if (sub === 'cat' && s) return ctx.host.files[`/etc/systemd/system/${s.name}.service`] ?? `# /usr/lib/systemd/system/${s.name}.service\n[Service]\nExecStart=${s.execStart ?? ''}`;
  if (sub !== 'status' && sub !== 'show') return `Unknown command verb ${sub}.`;
  if (!s) return `Unit ${name.replace(/\.service$/, '')}.service could not be found.`;
  const dot = /running/.test(s.active) ? '●' : /failed/.test(s.active) ? '×' : '○';
  const enabled = /disabled/.test(s.since) ? 'disabled' : 'enabled';
  const out = [
    `${dot} ${s.name}.service - ${s.description}`,
    `     Loaded: loaded (/etc/systemd/system/${s.name}.service; ${enabled}; preset: disabled)`,
    `     Active: ${s.active} since ${s.since.replace(/; disabled$/, '')}`,
  ];
  if (s.restarts) out.push(`    Restarts: ${s.restarts}`);
  if (s.mainPid && /running|auto-restart/.test(s.active)) out.push(`   Main PID: ${s.mainPid} (${shortCmd(s.execStart ?? s.name)})`);
  if (s.tasks && /running/.test(s.active)) out.push(`      Tasks: ${s.tasks} (limit: 9347)`);
  if (s.memory && /running/.test(s.active)) out.push(`     Memory: ${s.memory}`);
  if (/running/.test(s.active)) out.push(`        CPU: 2h 21min 4.118s`, `     CGroup: /system.slice/${s.name}.service`, `             └─${s.mainPid} ${s.execStart ?? ''}`);
  const tail = s.journal.slice(-6);
  if (tail.length) out.push('', ...tail);
  return out.join('\n');
}

export function journalctl(ctx: Ctx, args: string[]): string {
  if (args.includes('-k') || args.includes('--dmesg')) {
    return dmesg(ctx, ['-T'])
      .split('\n')
      .map(l => l.replace(/^\[\w{3} (\w{3}) +(\d+) ([\d:]+) \d{4}\] /, (_m, mon, d, t) => `${mon} ${String(d).padStart(2, '0')} ${t} ${ctx.host.hostname} kernel: `))
      .join('\n');
  }
  const a = parseArgs(args, ['u', 'n', 'since', 'p', 'unit', 'lines']);
  const unit = a.opts.u ?? a.opts.unit;
  const n = Number(a.opts.n ?? a.opts.lines ?? (a.flags.has('e') ? 40 : 200));
  let entries: string[];
  if (unit) {
    const s = findService(ctx, unit);
    if (!s) return '-- No entries --';
    entries = s.journal;
  } else {
    entries = Object.values(ctx.host.services)
      .flatMap(s => s.journal)
      .concat(ctx.host.dmesg.filter(l => /oom|killed|error|fail/i.test(l)).map(l => `${syslogTime(ctx.env.now)} ${ctx.host.hostname} kernel: ${l.replace(/^\[[^\]]+\]\s*/, '')}`))
      .sort((a, b) => syslogKey(a).localeCompare(syslogKey(b)));
  }
  if (!entries.length) return '-- No entries --';
  return entries.slice(-n).join('\n');
}

/* ------------------------------ network ------------------------------ */

export function ss(ctx: Ctx, args: string[]): string {
  const s = ctx.host.sockets;
  const joined = args.join('');
  if (joined.includes('s') && !joined.includes('t') && !joined.includes('l')) {
    const tcp = s.established + s.timeWait + s.closeWait + (s.synSent ?? 0) + s.listen.length;
    return [
      `Total: ${tcp + 52}`,
      `TCP:   ${tcp} (estab ${s.established}, closed ${s.timeWait + 3}, orphaned ${s.orphaned ?? 0}, timewait ${s.timeWait})`,
      '',
      'Transport Total     IP        IPv6',
      `RAW\t  0         0         0`,
      `UDP\t  4         2         2`,
      `TCP\t  ${pad(tcp - s.timeWait - 3, 9)} ${pad(tcp - s.timeWait - 5, 9)} 2`,
      `INET\t  ${pad(tcp - s.timeWait + 1, 9)} ${pad(tcp - s.timeWait - 3, 9)} 4`,
      `FRAG\t  0         0         0`,
    ].join('\n');
  }
  const listening = joined.includes('l');
  const showProc = joined.includes('p');
  const head = `${pad('State', 10)} ${pad('Recv-Q', 6)} ${pad('Send-Q', 6)} ${pad('Local Address:Port', 24, true)}  ${pad('Peer Address:Port', 22)}${showProc ? 'Process' : ''}`;
  const pidOf = (proc?: string) => ctx.host.processes.find(p => proc && shortCmd(p.command) === proc)?.pid ?? 1;
  if (listening) {
    return [
      head,
      ...s.listen.map(l => `${pad('LISTEN', 10)} ${pad(0, 6)} ${pad(4096, 6)} ${pad(l.addr, 24, true)}  ${pad('0.0.0.0:*', 22)}${showProc ? `users:(("${l.process}",pid=${pidOf(l.process)},fd=6))` : ''}`),
    ].join('\n');
  }
  const rows = s.sample.map(r => `${pad(r.state, 10)} ${pad(r.recvQ ?? 0, 6)} ${pad(r.sendQ ?? 0, 6)} ${pad(r.local, 24, true)}  ${pad(r.peer, 22)}${showProc && r.process ? `users:(("${r.process}",pid=${pidOf(r.process)},fd=${20 + (r.peer.length % 40)}))` : ''}`);
  const total = s.established + s.timeWait + s.closeWait + (s.synSent ?? 0);
  const shown = rows.length;
  const more = total - shown > 0 ? [`... ${total - shown} more sockets (${s.established} ESTAB, ${s.timeWait} TIME-WAIT, ${s.closeWait} CLOSE-WAIT${s.synSent ? `, ${s.synSent} SYN-SENT` : ''}) — use \`ss -s\` for a summary`] : [];
  return [head, ...rows, ...more].join('\n');
}

export function netstat(ctx: Ctx, args: string[]): string {
  const joined = args.join('');
  const s = ctx.host.sockets;
  if (joined.includes('l')) {
    return [
      'Active Internet connections (only servers)',
      'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
      ...s.listen.map(l => `tcp        0      0 ${pad(l.addr, 23)} 0.0.0.0:*               LISTEN      ${ctx.host.processes.find(p => shortCmd(p.command) === l.process)?.pid ?? 1}/${l.process}`),
    ].join('\n');
  }
  return [
    'Active Internet connections (servers and established)',
    'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
    ...s.sample.map(r => `tcp        0      0 ${pad(r.local, 23)} ${pad(r.peer, 23)} ${r.state.replace('ESTAB', 'ESTABLISHED').replace('TIME-WAIT', 'TIME_WAIT')}`),
  ].join('\n');
}

export function ip(ctx: Ctx, args: string[]): string {
  const sub = args[0] ?? '';
  const h = ctx.host;
  const gw = h.ip.split('.').slice(0, 3).join('.') + '.1';
  if (sub.startsWith('r')) {
    return [`default via ${gw} dev ens5 proto dhcp src ${h.ip} metric 512`, `10.0.0.2 via ${gw} dev ens5 proto dhcp src ${h.ip} metric 512`, `${h.ip.split('.').slice(0, 3).join('.')}.0/24 dev ens5 proto kernel scope link src ${h.ip} metric 512`, `169.254.169.254 dev ens5 proto dhcp scope link src ${h.ip} metric 512`].join('\n');
  }
  if (sub.startsWith('a') || sub === '') {
    return [
      '1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000',
      '    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00',
      '    inet 127.0.0.1/8 scope host lo',
      '2: ens5: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 9001 qdisc mq state UP group default qlen 1000',
      '    link/ether 0e:4f:7a:21:9c:3b brd ff:ff:ff:ff:ff:ff',
      `    inet ${h.ip}/24 metric 512 brd ${h.ip.split('.').slice(0, 3).join('.')}.255 scope global dynamic ens5`,
      '       valid_lft 2834sec preferred_lft 2834sec',
    ].join('\n');
  }
  return 'Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\n       where OBJECT := { address | route | link | neigh }';
}

export function sysctl(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args);
  if (a.flags.has('w') || a.positional.some(p => p.includes('='))) return READ_ONLY;
  if (a.flags.has('a')) return Object.entries(ctx.host.sysctl).map(([k, v]) => `${k} = ${v}`).join('\n');
  if (!a.positional.length) return 'sysctl: no variables specified\nTry `sysctl -a` or `sysctl net.ipv4.ip_local_port_range`.';
  return a.positional
    .map(k => (k in ctx.host.sysctl ? (a.flags.has('n') ? ctx.host.sysctl[k] : `${k} = ${ctx.host.sysctl[k]}`) : `sysctl: cannot stat /proc/sys/${k.replace(/\./g, '/')}: No such file or directory`))
    .join('\n');
}

/* ------------------------------ time ------------------------------ */

export function date(ctx: Ctx, args: string[]): string {
  const now = hostNow(ctx);
  if (args.includes('-u') || args.length === 0) return dateCmd(now);
  if (args.some(a => a.includes('%s'))) return String(Math.floor(now / 1000));
  if (args.some(a => a.startsWith('-I') || a.includes('iso'))) return new Date(now).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  return dateCmd(now);
}

export function timedatectl(ctx: Ctx): string {
  const t = ctx.host.time;
  const now = hostNow(ctx);
  const d = new Date(now);
  const local = `${dateCmd(now).slice(0, 3)} ${d.toISOString().slice(0, 10)} ${hms(now)} UTC`;
  return [
    `               Local time: ${local}`,
    `           Universal time: ${local}`,
    `                 RTC time: ${d.toISOString().slice(0, 10)} ${hms(ctx.env.now)}`,
    `                Time zone: Etc/UTC (UTC, +0000)`,
    `System clock synchronized: ${t.ntpSynced ? 'yes' : 'no'}`,
    `              NTP service: ${t.chronyRunning ? 'active' : 'inactive'}`,
    `          RTC in local TZ: no`,
  ].join('\n');
}

export function chronyc(ctx: Ctx, args: string[]): string {
  const t = ctx.host.time;
  if (!t.chronyRunning) return '506 Cannot talk to daemon';
  const sub = args[0] ?? 'tracking';
  if (sub === 'sources') {
    return [
      'MS Name/IP address         Stratum Poll Reach LastRx Last sample',
      '===============================================================================',
      `^* 169.254.169.123               3   4   377    11    ${t.offsetSeconds ? '+' + t.offsetSeconds + 's' : '-12us'}[  -14us] +/-  412us`,
      '^- ec2-3-91-54-170.compute-1>    2  10   377   412   +312us[ +318us] +/-   21ms',
    ].join('\n');
  }
  if (sub === 'tracking') {
    return [
      'Reference ID    : A9FEA97B (169.254.169.123)',
      'Stratum         : 4',
      `Ref time (UTC)  : ${dateCmd(ctx.env.now - 11000).replace(' UTC', '')}`,
      `System time     : ${Math.abs(t.offsetSeconds) > 0 ? Math.abs(t.offsetSeconds).toFixed(9) : '0.000002117'} seconds ${t.offsetSeconds > 0 ? 'fast' : 'slow'} of NTP time`,
      'Last offset     : -0.000001902 seconds',
      'RMS offset      : 0.000011284 seconds',
      'Frequency       : 18.402 ppm slow',
      'Residual freq   : -0.000 ppm',
      'Skew            : 0.011 ppm',
      'Root delay      : 0.000307 seconds',
      'Root dispersion : 0.000201 seconds',
      'Update interval : 16.0 seconds',
      `Leap status     : ${t.ntpSynced ? 'Normal' : 'Not synchronised'}`,
    ].join('\n');
  }
  return `Unrecognized command`;
}

export const READ_ONLY = `[simulation] This is a read-only investigation: changing the system is disabled.
Record what you would do in your diagnosis (the "proposed fix" step) instead.`;
