# Authoring an incident

Every incident is one TypeScript module in `src/incidents/` that default-exports an `Incident`
(see `src/engine/types.ts`). The reference implementation is
[`src/incidents/checkout-slow-query.ts`](../src/incidents/checkout-slow-query.ts) — read it first.

## How the simulation works

1. `baseEnvironment(now)` (`src/env/base.ts`) builds a **healthy** ShopFast production stack:
   hosts `bastion`, `app-1..3` (nginx :80 → node checkout-api 127.0.0.1:3000), `worker-1`;
   ALB `shopfast-prod-alb` + target group `checkout-api-tg`; ASG `shopfast-checkout-asg`;
   RDS PostgreSQL `checkout-db` + replica `checkout-db-replica-1`; ElastiCache; NAT gateway;
   Route 53 zones `shopfast.io` (public) and `internal.shopfast.io` (private); IAM roles;
   CloudTrail; deploy history; ~28 CloudWatch metric panels; 8 alarms (all OK).
   IDs live in `IDS` and `hostMeta` exported from `src/env/base.ts`.
2. Your `build(env, kit)` **mutates** that environment to inject the failure *and its
   consequences everywhere a real engineer would see them* (metrics, logs, terminal output,
   console state, change history).
3. `finalizeEnvironment` (`src/env/finalize.ts`) then generates seeded background traffic logs
   from `env.traffic` and merges your injected events (`env.hostLogs`) into host files and
   CloudWatch log groups (`/shopfast/checkout-api`, `/shopfast/nginx/access`,
   `/shopfast/nginx/error`, `/shopfast/system/messages`).
4. Every UI tool and the terminal render from the environment, so anything you don't touch
   stays realistic healthy "noise".

## What you can change (all in `build`)

| Want | How |
|---|---|
| Metric shape | `setPoints(env, 'rds.cpu', series('seed', 24).rampTo(45, 96, 5).clamp(0,100).build())` (series builder in `src/engine/timeseries.ts`: `wave`, `rampTo(minutesAgo, value, rampMinutes)`, `stepTo`, `spike`, `sawtooth`, `repeatWindow`, `map`, `clamp`, `round`). Multi-series panels (`ec2.cpu`, `ec2.mem`, `ec2.disk`) take a series name: `setPoints(env, 'ec2.disk', pts, 'app-2')`. New panels: `addPanel(env, {...})` (use `periodMinutes` + `points` for multi-day views). Mark important panels `featured: true`. |
| Alarm | `setAlarm(env, 'checkout-db-cpu-high', 'ALARM', 41)` — names are in base.ts |
| Traffic logs | `env.traffic.profile = (host, minutesAgo) => ({ p50Ms, errorRate, errorStatus, errorUpstream, errorMsg, errorExtra, rpm })` |
| Hand-written log lines | `injectLog(env, 'app-2', '/var/log/nginx/error.log', [ev(env, 12.5, 'line'), ...spread(env, 40, 1, 30, (i, ts) => \`...\`)])` — use the real format of that file (time helpers in `src/engine/time.ts`: `nginxErrTime`, `syslogTime`, `pgTime`, `iso`, `nginxTime`). |
| Other log groups (RDS, Lambda…) | `logGroup(env, '/aws/lambda/cost-janitor', 'desc').events.push(ev(env, 47, '...'))` |
| Host state | `const h = host(env, 'app-2')` then edit `h.disks`, `h.memory`, `h.cpu`, `h.load`, `h.processes`, `h.sockets`, `h.sysctl`, `h.env` (becomes `/etc/checkout-api/env`), `h.services[...]` (`systemctl status` / `journalctl -u`), `h.dmesg`, `h.files[path]`, `h.fileMeta[path] = { size }` (fake big files for `ls -lh`), `h.du[dir]` (`du -sh dir/*`), `h.time` (clock offset / chrony), `h.crontab`, `h.iostat`, `h.commandOverrides.push({ match: /^some command/, output })` (last resort) |
| New hosts / replaced instances | `cloneHost(env, 'app-3', 'app-4', { hostname, ip, instanceId, amiId, launchTime })`, `removeHost(env, name)` |
| HTTP / TCP behaviour | `env.http.unshift({ match: /paybridge\.com/, fromHosts: ['app-1'], behaviour: 'timeout' })` — rules are first-match, so **unshift** overrides. Behaviours: ok, timeout, refused, reset, dns-fail, tls-error. Used by `curl`, `nc`, `ping`, `traceroute`. Rules are tested against `scheme://host[:port]/path` (and `tcp://host:port` for `nc`). |
| DNS | edit `env.route53.zones[..].records`; names outside our zones resolve via `env.route53.external[name] = ['1.2.3.4'] \| 'NXDOMAIN' \| 'SERVFAIL'` |
| AWS consoles | `env.ec2.instances / securityGroups / amis / asgs`, `env.elb.loadBalancers / targetGroups` (`targetGroup(env)` helper), `env.rds.instances / events / topSql['checkout-db']`, `env.vpc.routeTables / natGateways / subnets`, `env.iam.roles[..].policies[..].document`, `env.cloudtrail.push(...)`, `env.changes.unshift(...)` (deploys, migrations, config, infra, AMI; include a unified `diff` when code/config changed) |
| AWS CLI | most read commands are derived from the env automatically (`aws help` lists them). `aws iam simulate-principal-policy` and `aws s3 cp` evaluate the real role policies. Clock skew > 5 min makes all AWS calls fail with signature errors automatically. Special answers: `env.awsCli.unshift({ match: /regex/, output })`. |
| PostgreSQL (`psql`) | `const db = database(env, 'checkout-db')` → `db.settings` (SHOW), `db.activity` (pg_stat_activity, supports `GROUP BY state` etc.), `db.statements` (pg_stat_statements), `db.tables[name]` (`\d`), `db.explains` (EXPLAIN), `db.queries.push({ match, output })` (any other SQL, checked first), `db.connectError` (psql connection fails). Format tables with `pgTable` from `src/engine/terminal/psql.ts`. |

## Evidence, choices, grading

* `evidence[]`: `kind` is `key` (needed for full marks), `supporting` (half credit) or
  `red-herring` (costs points if submitted). `match` is a RegExp tested against the **text of
  pinned items**. Pin texts are produced by builders in `src/engine/pins.ts`, e.g.
  metric panels → `CloudWatch AWS/RDS CPUUtilization [checkout-db] (Average) — now …`,
  targets → `Target i-… :80 (us-east-1a) in checkout-api-tg is unhealthy — Target.Timeout: …`,
  route tables → `Route table rtb-… (name) for …: 0.0.0.0/0 → nat-… (blackhole); …`,
  changes → `Change chg-… [deploy] service: title by author, … description\n<diff>`,
  log lines and terminal output lines → the raw line. Terminal output can also be pinned as a
  whole block (`$ cmd\n<output>`), so multi-line regexes work there.
* `foundBy` must point to a place where the evidence really appears; the integrity test
  executes it (terminal commands are run starting on the bastion, `ssh` to `host` first; use an
  array for psql: `['psql -h db.internal.shopfast.io -U ops_readonly checkout', 'SELECT …;']`).
* Red-herring regexes must not match key evidence text.
* `rootCauses`: 5–6 specific, plausible statements; exactly one `correct`, optionally one
  `partial`. Each has an `explanation` shown in the debrief.
* `fixes`: mix of `correct` (immediate mitigation + durable fix), `partial`, `neutral` and at
  least one `harmful` (plausible-sounding but makes it worse).
* `hints`: exactly 3, increasingly specific (where to look → what to look for → near answer).
* `debrief`: real technical explanation, timeline, ≥3 concepts, ≥3 commands, ≥3 prevention items.

## Quality bar

* Realistic formats: real nginx/pino/postgres/syslog/kernel/journald log formats, real AWS
  error strings, real CLI output. No "ERROR: the disk is full (this is the root cause)".
* The player must *investigate*: the briefing describes symptoms only; the evidence is spread
  across 2–4 tools; at least one plausible red herring exists.
* Keep it consistent: timestamps, IDs, IPs and hostnames must agree across metrics, logs,
  consoles and terminal (use `hostMeta`, `IDS`, minutes-ago constants).

## Testing

```bash
INCIDENT_FILE=src/incidents/my-incident.ts npx vitest run tests/incidents.integrity.test.ts
npx tsx scripts/try.ts src/incidents/my-incident.ts "ssh app-2" "df -h" "tail -n 20 /var/log/nginx/error.log"
npx tsc --noEmit
```

Register the module in `src/incidents/index.ts`.
