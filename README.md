# INCIDENT

An interactive production-troubleshooting training game. You're the on-call engineer for
**ShopFast**, a fictional e-commerce company on AWS. Each incident drops you into a broken
production environment with symptoms only. You investigate with simulated CloudWatch metrics
and logs, AWS consoles (EC2, ALB, RDS, VPC, Route 53, IAM, CloudTrail, deploy history) and a
terminal (`ssh`, `top`, `df`, `ss`, `dig`, `curl`, `journalctl`, `psql`, the `aws` CLI…). You pin
evidence, submit a root cause, the evidence and a fix, and then get graded and walked through
the technical concepts behind the incident.

Everything runs locally in the browser. There's no backend, no account and no paid API.

## Quick start

Requires Node.js 18+.

```bash
npm start
```

This installs dependencies (first run only takes a few seconds) and opens
http://localhost:5317.

Other scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Dev server without reinstalling |
| `npm test` | Unit tests + incident integrity tests (Vitest) |
| `npm run typecheck` | TypeScript check |
| `npm run build` / `npm run preview` | Production build / serve it |

## How to play

1. **Pick an incident** on the board. They go from Beginner to Expert, and each has a par time and a maximum score.
2. **Read the briefing.** You get a PagerDuty alert and messages from colleagues. It shows symptoms only.
3. **Investigate.** Use the tool rail (keys `1`–`9` switch tools). Healthy systems are simulated too, so not everything you find is relevant.
   * **CloudWatch**: alarms and metric charts (hover for values).
   * **Logs**: CloudWatch Logs with a filter syntax (`error -health "status":502`), a histogram and per-host streams.
   * **Terminal**: starts on the bastion. Run `ssh app-2`, read logs, check `df -h`, `ss -s`, `dmesg -T`, `dig`, `curl -v`, `psql -h db.internal.shopfast.io -U ops_readonly checkout`, `aws …`. Pipes (`| grep | tail | wc -l`), history and tab completion work. Type `help` for the full list.
   * **Consoles**: EC2 (instances, security groups, Auto Scaling, AMIs), Load Balancers (target health), RDS (Performance Insights, parameters, events), VPC (routes, NAT), Route 53, IAM policies, CloudTrail and Deploys & Changes (with diffs).
4. **Pin evidence.** Hover any log line, terminal line, chart, table row or policy and click the pin. Pinned items go into **Case Notes**, which also has a scratchpad and **hints**. Each hint costs 10% of the score.
5. **Submit a diagnosis.** Choose the root cause, the pinned evidence that proves it, and the remediation actions.
6. **Debrief.** You see your grade (S–D), a score breakdown, the real root cause, any key evidence you missed and where to find it, every remediation option with an explanation, a timeline, concepts, useful commands and prevention steps.

### Scoring

| Part | Weight |
|---|---|
| Root cause | 45% (a close-but-incomplete answer gets 20%) |
| Evidence | 30% × the share of key evidence found (supporting evidence counts half). Each red herring submitted costs −5% |
| Fix | 25% × the share of correct actions chosen (partial actions count half). Each harmful action costs −8%, each pointless one −3% |
| Hints | −10% each |
| Time bonus | Up to +10% when the root cause is right: full bonus at or under par, falling to 0 at 3× par |

Maximum points by difficulty: Beginner 100, Intermediate 200, Advanced 300, Expert 400. Your best
score per incident counts toward your rank. Progress (scores, attempts and in-progress
investigations, including terminal history) is saved in `localStorage`. You can reset it from the board.

## Incidents

| # | Level | Incident | Topics |
|---|---|---|---|
| 1 | Beginner | Checkout errors from one server | Linux disk, logging, nginx |
| 2 | Beginner | Whole site returns 503 | ALB target health, security groups, Terraform |
| 3 | Beginner | API unreachable after a migration | DNS, CNAME vs Alias, TTLs |
| 4 | Intermediate | Checkout API is extremely slow | PostgreSQL indexes, EXPLAIN, migrations |
| 5 | Intermediate | Intermittent 502s | Memory leaks, OOM killer, systemd |
| 6 | Intermediate | Invoices stopped sending | IAM policy evaluation, S3 ARNs |
| 7 | Intermediate | "Too many clients" during a sale | Connection pools, max_connections, autoscaling |
| 8 | Advanced | Payments time out | NAT gateways, route tables, VPC endpoints |
| 9 | Advanced | "Order not found" after checkout | Replica lag, read-after-write, recovery conflicts |
| 10 | Advanced | Errors only at peak | Ephemeral ports, TIME_WAIT, keep-alive |
| 11 | Expert | DB slow every night | gp2 burst balance, IOPS, storage types |
| 12 | Expert | Random DNS failures at peak | VPC resolver limits, ENA allowances, DNS caching |

## Project structure

```
src/
  engine/            simulation engine (pure TypeScript, no React)
    types.ts         domain model: Environment, Incident, Evidence, …
    timeseries.ts    seeded metric generators
    loggen.ts        seeded nginx / app log traffic
    terminal/        shell: parsing & pipes, Linux commands, network (dig/curl/nc),
                     AWS CLI (incl. an IAM policy evaluator), psql
    pins.ts          pin texts for every pinnable thing + evidence matching
    grading.ts       scoring, grades, ranks
  env/
    base.ts          the healthy ShopFast production environment
    finalize.ts      turns traffic config + injected events into log files and log groups
    helpers.ts       authoring helpers (setPoints, injectLog, cloneHost, …)
  incidents/         one file per incident (index.ts registers them)
  state/             progress + session persistence (localStorage)
  components/        React UI: board, workspace, tools, submit wizard, debrief
tests/               grading, terminal and per-incident integrity tests
docs/AUTHORING.md    how to write a new incident
```

Every incident starts from the same healthy environment and changes it in `build()`. Because
every tool renders from that environment, all tools work in every incident and unrelated
systems look realistically healthy. The integrity test runs each incident and checks that it is
well-formed, that every piece of evidence can actually be found where its `foundBy` says, and
that a perfect investigation earns an S.

## Adding an incident

See [docs/AUTHORING.md](docs/AUTHORING.md). In short: create `src/incidents/my-incident.ts`,
register it in `src/incidents/index.ts`, and iterate with:

```bash
INCIDENT_FILE=src/incidents/my-incident.ts npx vitest run tests/incidents.integrity.test.ts
npx tsx scripts/try.ts src/incidents/my-incident.ts "ssh app-2" "df -h"
```
