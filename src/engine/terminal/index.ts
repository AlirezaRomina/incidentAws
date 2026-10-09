import type { Environment } from '../types';
import { aws } from './aws';
import * as L from './linux';
import { READ_ONLY, type Ctx } from './linux';
import * as N from './net';
import { psqlConnect, runSql } from './psql';
import { applyFilter, resolvePath, splitPipes, tokenize } from './shell';

export interface TermState {
  host: string;
  cwd: string;
  mode: 'bash' | 'psql';
  db?: string; // database instance id while in psql
}

export interface TermResult {
  output: string;
  state: TermState;
  clear?: boolean;
}

export const initialTermState = (env: Environment): TermState => ({ host: env.startHost, cwd: '/home/ec2-user', mode: 'bash' });

export function promptFor(env: Environment, s: TermState): string {
  if (s.mode === 'psql') {
    const db = env.databases.find(d => d.instanceId === s.db);
    return `${db?.dbName ?? 'checkout'}=> `;
  }
  const h = env.hosts[s.host];
  const dir = s.cwd === '/home/ec2-user' ? '~' : s.cwd.startsWith('/home/ec2-user/') ? '~' + s.cwd.slice(14) : s.cwd;
  return `[${h.user}@${h.role === 'bastion' ? 'bastion' : h.hostname} ${dir}]$ `;
}

export const COMMANDS = [
  'help', 'clear', 'ls', 'cd', 'pwd', 'cat', 'less', 'head', 'tail', 'grep', 'wc', 'top', 'htop', 'ps', 'free', 'df', 'du', 'uptime', 'vmstat', 'iostat', 'dmesg',
  'journalctl', 'systemctl', 'ss', 'netstat', 'ip', 'sysctl', 'date', 'timedatectl', 'chronyc', 'dig', 'nslookup', 'host', 'curl', 'nc', 'ping', 'traceroute',
  'aws', 'psql', 'ssh', 'exit', 'ethtool', 'resolvectl', 'hostname', 'whoami', 'uname', 'nproc', 'env', 'crontab', 'lsof', 'nginx', 'node', 'history',
];

const HELP = `Investigation shell — simulated, read-only. Pipes work: \`… | grep ERROR | tail -n 20\`

  Hosts      ssh app-1 | app-2 | app-3 | worker-1     exit (back to bastion)     hostname
  Files      ls -lh <dir>   cat / less <file>   head|tail -n N <file>   grep [-i -c -v -E] <pattern> <files>   wc -l
  System     top   ps aux   free -m   df -h   du -sh <dir>/*   uptime   vmstat   iostat -x   dmesg -T
  Services   systemctl status <svc>   systemctl list-units --failed   journalctl -u <svc> -n 50
  Network    ss -s   ss -tanp   ss -tlnp   netstat -tlnp   ip addr   ip route   sysctl <key>   ethtool -S ens5   resolvectl
             dig <name>   nslookup <name>   curl -v <url>   nc -zv <host> <port>   ping   traceroute
  Time       date   timedatectl   chronyc tracking
  AWS        aws help   (ec2, elbv2, rds, iam, cloudtrail, route53, logs, s3, sts …)
  Database   psql -h db.internal.shopfast.io -U ops_readonly checkout     (\\? inside psql)

Useful files: /var/log/nginx/{access,error}.log  /var/log/checkout-api/app.log  /var/log/messages
              /etc/checkout-api/env  /etc/nginx/conf.d/checkout.conf  /etc/chrony.conf  /etc/crontab
Keys: ↑/↓ history · Tab completes · Ctrl+L clears · click a line's pin to save it as evidence.`;

function resolveHost(env: Environment, target: string) {
  const t = target.replace(/^[\w.-]+@/, '').toLowerCase();
  return Object.values(env.hosts).find(h => h.name === t || h.hostname === t || h.ip === t || `${h.hostname}.ec2.internal` === t || h.instanceId === t);
}

export function execute(env: Environment, state: TermState, rawLine: string): TermResult {
  const line = rawLine.trim();
  if (!line) return { output: '', state };

  if (state.mode === 'psql') {
    if (/^(\\q|quit|exit)$/i.test(line)) return { output: '', state: { ...state, mode: 'bash', db: undefined } };
    if (/^help$/i.test(line)) return { output: runSql(env, env.databases.find(d => d.instanceId === state.db)!, '\\?'), state };
    const db = env.databases.find(d => d.instanceId === state.db);
    if (!db) return { output: 'connection lost', state: { ...state, mode: 'bash' } };
    return { output: runSql(env, db, line), state };
  }

  const segments = splitPipes(line);
  let first = segments[0].replace(/^sudo\s+(-\w+\s+)*/, '');
  first = first.replace(/\s+2>&1$/, '').replace(/\s*2>\/dev\/null$/, '');
  if (/(^|[^2])>\s*\S/.test(first) && !/^(curl|aws|grep|echo)/.test(first)) return { output: READ_ONLY, state };

  const host = env.hosts[state.host];
  const ctx: Ctx = { env, host, cwd: state.cwd };
  let result: TermResult;

  const override = host.commandOverrides.find(o => o.match.test(first));
  if (override) {
    result = { output: typeof override.output === 'function' ? override.output(first) : override.output, state };
  } else {
    result = dispatch(env, state, ctx, first);
  }
  if (segments.length > 1 && !result.clear) {
    let out = result.output;
    for (const seg of segments.slice(1)) {
      const r = applyFilter(out, seg.replace(/^sudo\s+/, ''));
      if (r.error) return { output: r.error, state: result.state };
      out = r.out;
    }
    result = { ...result, output: out };
  }
  return result;
}

function dispatch(env: Environment, state: TermState, ctx: Ctx, cmdline: string): TermResult {
  const argv = tokenize(cmdline);
  const [cmd, ...args] = argv;
  const ok = (output: string): TermResult => ({ output, state });
  const host = ctx.host;

  switch (cmd) {
    case 'help':
    case '?':
      return ok(HELP);
    case 'clear':
    case 'reset':
      return { output: '', state, clear: true };
    case 'pwd':
      return ok(state.cwd);
    case 'cd': {
      const target = resolvePath(state.cwd, args[0] ?? '~');
      const isDir = target === '/' || Object.keys(host.files).some(p => p.startsWith(target + '/')) || Object.keys(host.fileMeta).some(p => p.startsWith(target + '/'));
      if (!isDir) return ok(`-bash: cd: ${args[0]}: No such file or directory`);
      return { output: '', state: { ...state, cwd: target } };
    }
    case 'whoami':
      return ok(host.user);
    case 'id':
      return ok(`uid=1000(${host.user}) gid=1000(${host.user}) groups=1000(${host.user}),4(adm),10(wheel),190(systemd-journal)`);
    case 'hostname':
      return ok(args.includes('-I') ? host.ip : host.hostname);
    case 'uname':
      return ok(args.includes('-a') ? `Linux ${host.hostname} ${host.kernel} #1 SMP PREEMPT_DYNAMIC Mon Sep 16 19:21:24 UTC 2024 x86_64 x86_64 x86_64 GNU/Linux` : args.includes('-r') ? host.kernel : 'Linux');
    case 'nproc':
      return ok(String(host.cpu.cores));
    case 'echo':
      return ok(args.join(' ').replace(/\$HOSTNAME/g, host.hostname).replace(/\$USER/g, host.user));
    case 'history':
      return ok('');
    case 'ls':
    case 'll':
      return ok(L.ls(ctx, cmd === 'll' ? ['-l', ...args] : args));
    case 'cat':
    case 'less':
    case 'more':
    case 'zcat':
    case 'bat':
      return ok(L.cat(ctx, args, cmd));
    case 'head':
    case 'tail':
      return ok(L.headTail(ctx, args, cmd));
    case 'grep':
    case 'egrep':
    case 'zgrep':
      return ok(L.grep(ctx, args, cmd));
    case 'wc':
      return ok(L.wc(ctx, args));
    case 'top':
    case 'htop':
    case 'atop':
      return ok(L.top(ctx));
    case 'ps':
      return ok(L.ps(ctx, args));
    case 'free':
      return ok(L.free(ctx, args));
    case 'df':
      return ok(L.df(ctx, args));
    case 'du':
      return ok(L.du(ctx, args));
    case 'uptime':
      return ok(L.uptime(ctx));
    case 'w':
      return ok(L.uptime(ctx) + `\nUSER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n${host.user} pts/0    10.0.0.12        14:41    0.00s  0.04s  0.00s w`);
    case 'vmstat':
      return ok(L.vmstat(ctx));
    case 'iostat':
      return ok(L.iostat(ctx));
    case 'dmesg':
      return ok(L.dmesg(ctx, args));
    case 'systemctl':
    case 'service':
      return ok(cmd === 'service' ? L.systemctl(ctx, [args[1] ?? 'status', args[0]]) : L.systemctl(ctx, args));
    case 'journalctl':
      return ok(L.journalctl(ctx, args));
    case 'ss':
      return ok(L.ss(ctx, args));
    case 'netstat':
      return ok(L.netstat(ctx, args));
    case 'ip':
    case 'ifconfig':
      return ok(L.ip(ctx, cmd === 'ifconfig' ? ['addr'] : args));
    case 'sysctl':
      return ok(L.sysctl(ctx, args));
    case 'date':
      return ok(L.date(ctx, args));
    case 'timedatectl':
      return ok(L.timedatectl(ctx));
    case 'chronyc':
      return ok(L.chronyc(ctx, args));
    case 'ntpq':
    case 'ntpstat':
      return ok(`-bash: ${cmd}: command not found\n(Amazon Linux 2023 uses chrony — try: chronyc tracking)`);
    case 'dig':
      return ok(N.dig(ctx, args));
    case 'nslookup':
      return ok(N.nslookup(ctx, args));
    case 'host':
      return ok(N.hostCmd(ctx, args));
    case 'getent':
      return ok(args[0] === 'hosts' && args[1] ? N.resolveDns(env, args[1]).addresses.map(a => `${a}      ${args[1]}`).join('\n') : '');
    case 'curl':
    case 'wget':
      return ok(N.curl(ctx, cmd === 'wget' ? ['-v', ...args.filter(a => !a.startsWith('-'))] : args));
    case 'nc':
    case 'ncat':
    case 'telnet':
      return ok(N.nc(ctx, cmd === 'telnet' ? ['-z', ...args] : args));
    case 'ping':
      return ok(N.ping(ctx, args));
    case 'traceroute':
    case 'tracepath':
    case 'mtr':
      return ok(N.traceroute(ctx, args));
    case 'aws':
      return ok(aws(ctx, cmdline));
    case 'psql': {
      const r = psqlConnect(env, cmdline);
      if (r.db && !r.oneShot) return { output: r.output, state: { ...state, mode: 'psql', db: r.db.instanceId } };
      return ok(r.output);
    }
    case 'ethtool': {
      const dev = args.find(a => !a.startsWith('-'));
      if (dev && dev !== 'ens5') return ok(`netlink error: no device matches name (offset 24)\nnetlink error: No such device`);
      if (args.includes('-i')) return ok('driver: ena\nversion: 2.12.0g\nfirmware-version:\nbus-info: 0000:00:05.0\nsupports-statistics: yes');
      if (args.includes('-S')) {
        const n = (k: number) => String(1000003 * k + host.ip.length * 7919);
        return ok(
          [
            'NIC statistics:',
            `     tx_timeout: 0`,
            `     suspend: 0`,
            `     resume: 0`,
            `     wd_expired: 0`,
            `     interface_up: 1`,
            `     interface_down: 0`,
            `     admin_q_pause: 0`,
            `     bw_in_allowance_exceeded: 0`,
            `     bw_out_allowance_exceeded: 0`,
            `     pps_allowance_exceeded: 0`,
            `     conntrack_allowance_available: 409812`,
            `     conntrack_allowance_exceeded: 0`,
            `     linklocal_allowance_exceeded: 0`,
            `     queue_0_tx_cnt: ${n(41)}`,
            `     queue_0_tx_bytes: ${n(9011)}`,
            `     queue_0_rx_cnt: ${n(44)}`,
            `     queue_0_rx_bytes: ${n(12007)}`,
            `     queue_1_tx_cnt: ${n(39)}`,
            `     queue_1_rx_cnt: ${n(43)}`,
          ].join('\n'),
        );
      }
      return ok('Settings for ens5:\n\tSupported ports: [ ]\n\tSpeed: Unknown!\n\tDuplex: Unknown! (255)\n\tLink detected: yes');
    }
    case 'resolvectl':
      if (args[0] === 'statistics') return ok('DNSSEC supported by current servers: no\n\nTransactions\nCurrent Transactions: 0\n  Total Transactions: 1840221\n\nCache\n  Current Cache Size: 412\n          Cache Hits: 1795318\n        Cache Misses: 44903\n\nDNSSEC Verdicts\n              Secure: 0\n            Insecure: 0\n               Bogus: 0\n       Indeterminate: 0');
      return ok('Global\n       Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported\nresolv.conf mode: uplink\n\nLink 2 (ens5)\n    Current Scopes: DNS\n         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported\nCurrent DNS Server: 10.0.0.2\n       DNS Servers: 10.0.0.2\n        DNS Domain: ec2.internal');
    case 'mysql':
      return ok('-bash: mysql: command not found\n(checkout-db is PostgreSQL — use psql -h db.internal.shopfast.io -U ops_readonly checkout)');
    case 'redis-cli': {
      if (args.some(a => /^ping$/i.test(a))) return ok('PONG');
      if (args.some(a => /^info$/i.test(a))) return ok('# Server\nredis_version:7.1.0\nuptime_in_days:41\n# Clients\nconnected_clients:46\n# Memory\nused_memory_human:1.21G\nmaxmemory_human:6.38G\nmaxmemory_policy:volatile-lru\n# Stats\nkeyspace_hits:88213012\nkeyspace_misses:5410388\nevicted_keys:12');
      return ok('[simulation] redis-cli supports: redis-cli -h cache.internal.shopfast.io ping | info');
    }
    case 'ssh': {
      const target = args.find(a => !a.startsWith('-'));
      if (!target) return ok('usage: ssh [-i identity_file] [user@]hostname');
      const h = resolveHost(env, target);
      if (!h) {
        const r = N.resolveDns(env, target.replace(/^[\w.-]+@/, ''));
        return ok(r.addresses.length ? `ssh: connect to host ${target} port 22: Connection timed out` : `ssh: Could not resolve hostname ${target}: Name or service not known`);
      }
      if (h.name === state.host) return ok(`[already on ${h.name}]`);
      const inst = env.ec2.instances.find(i => i.host === h.name);
      if (inst && inst.state !== 'running') return ok(`ssh: connect to host ${h.ip} port 22: Connection timed out`);
      const banner = [
        `Last login: ${new Date(env.now - 3 * 3600000).toUTCString().replace('GMT', 'UTC')} from 10.0.0.12`,
        '   ,     #_',
        '   ~\\_  ####_        Amazon Linux 2023',
        '  ~~  \\_#####\\',
        '  ~~     \\###|',
        `  ~~       \\#/ ___   ${h.name} · ${h.instanceId} · ${h.ip}`,
        "   ~~       V~' '->",
        '    ~~~         /',
        '      ~~._.   _/',
        '         _/ _/',
        '       _/m/\'',
      ].join('\n');
      return { output: banner, state: { host: h.name, cwd: '/home/ec2-user', mode: 'bash' } };
    }
    case 'exit':
    case 'logout': {
      if (state.host === env.startHost) return ok('[you are on the bastion — nothing to exit. Use `ssh <host>` to connect to a server]');
      return { output: `logout\nConnection to ${host.ip} closed.`, state: { host: env.startHost, cwd: '/home/ec2-user', mode: 'bash' } };
    }
    case 'env':
    case 'printenv': {
      const shellEnv: Record<string, string> = { SHELL: '/bin/bash', HOSTNAME: host.hostname, USER: host.user, HOME: '/home/ec2-user', PATH: '/usr/local/bin:/usr/bin:/usr/local/sbin:/usr/sbin', LANG: 'C.UTF-8', AWS_REGION: env.region, AWS_DEFAULT_REGION: env.region };
      if (args[0]) return ok(shellEnv[args[0]] ?? '');
      const note = host.role === 'app' ? '\n\n# note: the application environment lives in /etc/checkout-api/env (EnvironmentFile of checkout-api.service)' : '';
      return ok(Object.entries(shellEnv).map(([k, v]) => `${k}=${v}`).join('\n') + note);
    }
    case 'crontab':
      return ok(host.crontab ?? `no crontab for ${host.user}`);
    case 'lsof': {
      const port = args.join(' ').match(/:(\d+)/)?.[1];
      const ls = host.sockets.listen.filter(l => !port || l.addr.endsWith(':' + port));
      return ok(['COMMAND   PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME', ...ls.map(l => `${l.process.padEnd(9)} ${String(host.processes.find(p => p.command.includes(l.process))?.pid ?? 1).padStart(5)} ${l.process === 'node' ? 'shopfast' : 'root    '}   6u  IPv4  41822      0t0  TCP ${l.addr.replace('0.0.0.0', '*')} (LISTEN)`)].join('\n'));
    }
    case 'nginx':
      if (host.role !== 'app') return ok('-bash: nginx: command not found');
      if (args.includes('-T')) return ok(`nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful\n# configuration file /etc/nginx/nginx.conf:\n${host.files['/etc/nginx/nginx.conf']}\n# configuration file /etc/nginx/conf.d/checkout.conf:\n${host.files['/etc/nginx/conf.d/checkout.conf']}`);
      if (args.includes('-t')) return ok('nginx: the configuration file /etc/nginx/nginx.conf syntax is ok\nnginx: configuration file /etc/nginx/nginx.conf test is successful');
      if (args.includes('-v') || args.includes('-V')) return ok('nginx version: nginx/1.24.0');
      return ok(READ_ONLY);
    case 'node':
      return ok(args.includes('-v') || args.includes('--version') ? 'v20.17.0' : '[simulation] interactive node is not available');
    case 'which':
      return ok(args.map(a => (COMMANDS.includes(a) ? `/usr/bin/${a}` : `/usr/bin/which: no ${a} in (/usr/local/bin:/usr/bin)`)).join('\n'));
    case 'kill':
    case 'pkill':
    case 'killall':
    case 'rm':
    case 'mv':
    case 'cp':
    case 'touch':
    case 'mkdir':
    case 'truncate':
    case 'reboot':
    case 'shutdown':
    case 'chmod':
    case 'chown':
    case 'dnf':
    case 'yum':
    case 'apt':
    case 'apt-get':
    case 'logrotate':
    case 'tee':
      return ok(READ_ONLY);
    case 'vi':
    case 'vim':
    case 'nano':
    case 'emacs':
      return ok(`[simulation] editors are disabled — use cat/less/grep to read files. (${READ_ONLY.split('\n')[0].replace('[simulation] ', '')})`);
    default:
      return ok(`-bash: ${cmd}: command not found\nType \`help\` to see what this shell can do.`);
  }
}

/** Tab completion: commands, hosts, and file paths on the current host. */
export function complete(env: Environment, state: TermState, line: string): string[] {
  if (state.mode === 'psql') return [];
  const parts = line.split(/\s+/);
  const word = parts[parts.length - 1];
  if (parts.length === 1) return COMMANDS.filter(c => c.startsWith(word));
  if (parts[0] === 'ssh') return Object.keys(env.hosts).filter(h => h.startsWith(word));
  if (['systemctl', 'journalctl'].includes(parts[0]) && !word.startsWith('/')) {
    return Object.keys(env.hosts[state.host].services).filter(s => s.startsWith(word));
  }
  const host = env.hosts[state.host];
  const abs = resolvePath(state.cwd, word || '.');
  const base = word.endsWith('/') ? abs + '/' : abs;
  const candidates = new Set<string>();
  for (const p of [...Object.keys(host.files), ...Object.keys(host.fileMeta)]) {
    if (!p.startsWith(base)) continue;
    const rest = p.slice(base.length);
    const nextSlash = rest.indexOf('/');
    candidates.add(base + (nextSlash >= 0 ? rest.slice(0, nextSlash + 1) : rest));
  }
  const prefixAbs = word.startsWith('/');
  return [...candidates].map(c => (prefixAbs ? c : c.replace(resolvePath(state.cwd, '.') + '/', ''))).sort();
}
