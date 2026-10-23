import type { Environment, LogEvent, LogGroup } from '../engine/types';
import { appJson, merge, nginxAccess, toFile } from '../engine/loggen';
import { MIN, syslogTime } from '../engine/time';

/** Host log file -> CloudWatch Logs group the CloudWatch agent ships it to. */
export const SHIPPED_LOGS: Record<string, { group: string; description: string }> = {
  '/var/log/checkout-api/app.log': { group: '/shopfast/checkout-api', description: 'checkout-api application logs (pino JSON)' },
  '/var/log/nginx/access.log': { group: '/shopfast/nginx/access', description: 'nginx access log on checkout hosts' },
  '/var/log/nginx/error.log': { group: '/shopfast/nginx/error', description: 'nginx error log on checkout hosts' },
  '/var/log/messages': { group: '/shopfast/system/messages', description: 'syslog from all EC2 hosts' },
};

function backgroundMessages(env: Environment, hostname: string): LogEvent[] {
  const out: LogEvent[] = [];
  for (let m = env.traffic.minutes; m >= 0; m -= 15) {
    const ts = env.now - m * MIN + 7000;
    out.push({ ts, msg: `${syslogTime(ts)} ${hostname} systemd[1]: Started session-${4100 + m}.scope - Session ${4100 + m} of User ec2-user.` });
    if (m % 30 === 0) out.push({ ts: ts + 41000, msg: `${syslogTime(ts + 41000)} ${hostname} amazon-ssm-agent[921]: INFO [HealthCheck] HealthCheck reporting agent health.` });
    if (m % 60 === 0) out.push({ ts: ts + 52000, msg: `${syslogTime(ts + 52000)} ${hostname} CROND[${22000 + m}]: (root) CMD (run-parts /etc/cron.hourly)` });
  }
  return out;
}

/**
 * Called after an incident's build(): turns traffic config + injected events
 * into host log files and CloudWatch log groups.
 */
export function finalizeEnvironment(env: Environment): Environment {
  const appHosts = env.traffic.hosts ?? Object.values(env.hosts).filter(h => h.role === 'app').map(h => h.name);
  const groups = new Map<string, LogGroup>();
  for (const g of env.logGroups) groups.set(g.name, g);
  const groupFor = (path: string) => {
    const s = SHIPPED_LOGS[path];
    if (!s) return undefined;
    let g = groups.get(s.group);
    if (!g) {
      g = { name: s.group, description: s.description, retentionDays: 30, events: [] };
      groups.set(s.group, g);
    }
    return g;
  };

  for (const host of Object.values(env.hosts)) {
    if (host.role === 'app' && '/etc/checkout-api/env' in host.files) {
      const secret = host.files['/etc/checkout-api/env'].match(/^DB_PASSWORD_SECRET_ARN=.*$/m)?.[0];
      host.files['/etc/checkout-api/env'] = Object.entries(host.env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n' + (secret ? secret + '\n' : '');
    }
    const generated: Record<string, LogEvent[]> = {};
    generated['/var/log/messages'] = backgroundMessages(env, host.hostname);
    if (appHosts.includes(host.name)) {
      const profile = env.traffic.profile ? (m: number) => env.traffic.profile!(host.name, m) : undefined;
      const pid = host.services['checkout-api']?.mainPid ?? 2841;
      generated['/var/log/nginx/access.log'] = nginxAccess({
        seed: `access-${host.name}-${env.now}`,
        now: env.now,
        minutes: env.traffic.minutes,
        rpm: env.traffic.rpmPerHost,
        p50Ms: env.traffic.p50Ms,
        profile,
      });
      generated['/var/log/checkout-api/app.log'] = appJson({
        seed: `app-${host.name}-${env.now}`,
        now: env.now,
        minutes: env.traffic.minutes,
        rpm: env.traffic.rpmPerHost,
        p50Ms: env.traffic.p50Ms,
        hostname: host.hostname,
        pid,
        profile,
      });
    }
    const injected = env.hostLogs[host.name] ?? {};
    const paths = new Set([...Object.keys(generated), ...Object.keys(injected)]);
    for (const path of paths) {
      if (!(path in host.files) && !generated[path] && !injected[path]) continue;
      const events = merge(generated[path] ?? [], injected[path] ?? []);
      const existing = host.files[path] ?? '';
      host.files[path] = existing + toFile(events);
      const g = groupFor(path);
      if (g) {
        const stream = `${host.name}/${host.instanceId}`;
        for (const e of events) g.events.push({ ...e, stream });
      }
    }
  }

  // health endpoints report the version actually running
  const version = env.hosts['app-1']?.env.APP_VERSION;
  const ours = (src: string) => ['localhost', '127', 'shopfast', '10\\.0'].some(k => src.includes(k));
  if (version) for (const r of env.http) if (r.body && ours(r.match.source)) r.body = r.body.replace(/"version":"[\d.]+"/, `"version":"${version}"`);

  env.logGroups = [...groups.values()].map(g => ({ ...g, events: [...g.events].sort((a, b) => a.ts - b.ts) }));
  env.logGroups.sort((a, b) => a.name.localeCompare(b.name));
  return env;
}
