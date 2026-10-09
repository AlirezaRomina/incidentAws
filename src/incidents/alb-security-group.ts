import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, systemdTime } from '../engine/time';
import { addPanel, host, panel, setAlarm, setPoints, targetGroup } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4002 — total outage behind the ALB.
 *
 * 07:58 PR #1219 "consolidate security groups" merged; terraform-ci auto-applied at 08:00.
 * The new shared module takes the service port from a variable that defaults to 8080 (the ECS
 * services' port). The app module didn't pass port = 80, so Terraform revoked
 * "tcp/80 from shopfast-alb-sg" on shopfast-app-sg and authorized "tcp/8080 from shopfast-alb-sg".
 * nginx listens on :80. Health checks (and requests) from the ALB are silently dropped →
 * Target.Timeout on all three targets → the ALB fails open, tries the targets anyway and gives
 * up after its 10 s connect timeout → 504 for everybody. The hosts themselves are perfectly fine.
 */

const REVOKE = 11.9; // 08:00:06
const START = 11.5; // targets unhealthy, 504s begin
const TG = 'checkout-api-tg';

const TF_DIFF = `diff --git a/envs/prod/app.tf b/envs/prod/app.tf
@@ -41,14 +41,11 @@ resource "aws_security_group" "app" {
-resource "aws_security_group_rule" "app_from_alb" {
-  type                     = "ingress"
-  from_port                = 80
-  to_port                  = 80
-  protocol                 = "tcp"
-  security_group_id        = aws_security_group.app.id
-  source_security_group_id = aws_security_group.alb.id
-  description              = "HTTP from ALB"
-}
+module "app_sg_rules" {
+  source            = "../../modules/security-group-rules"
+  security_group_id = aws_security_group.app.id
+  ingress_from_sgs = {
+    "HTTP from ALB" = aws_security_group.alb.id
+  }
+}
diff --git a/modules/security-group-rules/variables.tf b/modules/security-group-rules/variables.tf
new file mode 100644
@@ -0,0 +1,14 @@
+variable "security_group_id" {
+  type = string
+}
+
+variable "ingress_from_sgs" {
+  description = "description => source security group id"
+  type        = map(string)
+}
+
+variable "port" {
+  description = "Port the service listens on"
+  type        = number
+  default     = 8080 # catalog-service / search-service containers
+}

--- terraform plan (envs/prod) ---
  # aws_security_group_rule.app_from_alb will be destroyed
  # (because aws_security_group_rule.app_from_alb is not in configuration)
  - resource "aws_security_group_rule" "app_from_alb" {
      - description              = "HTTP from ALB" -> null
      - from_port                = 80 -> null
      - protocol                 = "tcp" -> null
      - security_group_id        = "${IDS.appSg}" -> null
      - source_security_group_id = "${IDS.albSg}" -> null
      - to_port                  = 80 -> null
      - type                     = "ingress" -> null
    }

  # module.app_sg_rules.aws_vpc_security_group_ingress_rule.this["HTTP from ALB"] will be created
  + resource "aws_vpc_security_group_ingress_rule" "this" {
      + description                  = "HTTP from ALB"
      + from_port                    = 8080
      + ip_protocol                  = "tcp"
      + referenced_security_group_id = "${IDS.albSg}"
      + security_group_id            = "${IDS.appSg}"
      + to_port                      = 8080
    }

  # module.worker_sg_rules … (3 more resources: moved, no changes)

Plan: 1 to add, 0 to change, 1 to destroy.`;

const incident: Incident = {
  id: 'alb-security-group',
  code: 'INC-4002',
  order: 2,
  title: 'The whole site is down behind the load balancer',
  teaser: 'Every request to shopfast.io hangs for 10 seconds and dies at the load balancer. The servers swear they are fine.',
  difficulty: 'beginner',
  tags: ['ALB', 'Security Groups', 'Terraform', 'Networking'],
  parMinutes: 10,
  seed: 4002,
  now: '2026-10-07T08:12:00Z',
  briefing: {
    severity: 'SEV1',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-unhealthy-hosts — UnHealthyHostCount >= 1 (checkout-api-tg)',
      details: 'UnHealthyHostCount Maximum = 3 for 2 datapoints within 2 minutes. Also open: Pingdom "API health" DOWN from 4/4 locations — "HTTP 504 Gateway Time-out (10.0 s)".',
      minutesAgo: 10,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4002', message: 'Site is completely down. Every page spins for about 10 seconds and then shows "504 Gateway Time-out". The mobile app just says "Server unavailable". Status page is updated.', minutesAgo: 9 },
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-4002', message: 'I’m on the boxes: nginx and checkout-api are running on all three, `curl localhost/health` → 200 everywhere, nothing in the error logs. Weirdly app.log has no new lines at all for ~10 min. We shipped 2.13.2 (dependency bumps) yesterday — want me to roll back?', minutesAgo: 7 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4002', message: 'SEV1, you’re IC. We got an AWS email at 07:55 about a certificate renewal for *.shopfast.io — could that be it? I need a decision on the rollback within 10 minutes.', minutesAgo: 5 },
    ],
    impact: 'Full outage since ~08:01 UTC: 100% of requests to shopfast.io and api.shopfast.io fail with 504 after ~10 s. Orders: 0.',
    services: ['shopfast-prod-alb', 'checkout-api-tg', 'checkout-api', 'shopfast-app-sg'],
  },

  build(env) {
    const t = (m: number) => env.now - m * MIN;

    /* ---------------- The change ---------------- */
    const appSg = env.ec2.securityGroups.find(s => s.id === IDS.appSg)!;
    appSg.inbound = [
      { protocol: 'tcp', ports: '8080', source: IDS.albSg, description: 'HTTP from ALB' },
      { protocol: 'tcp', ports: '22', source: IDS.bastionSg, description: 'SSH from bastion' },
    ];

    /* ---------------- Load balancer view ---------------- */
    const tg = targetGroup(env, TG);
    for (const tgt of tg.targets) Object.assign(tgt, { state: 'unhealthy', reason: 'Target.Timeout', description: 'Request timed out' });
    const lb = env.elb.loadBalancers[0];
    lb.listeners[0].certificate = 'arn:aws:acm:us-east-1:481562039374:certificate/9d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6 (*.shopfast.io, renewed 2026-10-07, expires 2027-04-25)';

    setPoints(env, 'alb.healthy', series('healthy', 3, { noise: 0 }).stepTo(START, 0).round(0).build());
    setPoints(env, 'alb.unhealthy', series('unhealthy', 0, { noise: 0 }).stepTo(START, 3).round(0).build());
    panel(env, 'alb.healthy').featured = true;
    panel(env, 'alb.unhealthy').featured = true;
    setPoints(env, 'alb.elb5xx', series('e5xx', 0.4, { noise: 0.06 }).rampTo(START, 2060, 1).wave(0.04).clamp(0).round(0).build());
    panel(env, 'alb.elb5xx').featured = true;
    setPoints(env, 'alb.target5xx', series('t5xx', 1.4, { noise: 0.9 }).stepTo(START, 0).clamp(0).round(0).build());
    setPoints(env, 'alb.requests', series('req', 2380, { noise: 0.05 }).wave(0.06).rampTo(START, 2140, 2).clamp(0).round(0).build());
    setPoints(env, 'alb.latency', series('lat', 0.41, { noise: 0.12 }).wave(0.05).stepTo(START, 0).clamp(0).round(3).build());
    addPanel(env, {
      id: 'alb.connErrors',
      group: 'Application Load Balancer',
      namespace: 'AWS/ApplicationELB',
      metric: 'TargetConnectionErrorCount',
      resource: 'shopfast-prod-alb',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      featured: true,
      series: [{ name: 'shopfast-prod-alb', points: series('connerr', 0.2, { noise: 0.05 }).rampTo(START, 2090, 1).wave(0.04).clamp(0).round(0).build() }],
    });
    setPoints(env, 'app.orders', series('orders', 61, { noise: 0.15 }).stepTo(START, 0).clamp(0).round(0).build());
    setPoints(env, 'app.checkoutLatency', series('chk', 380, { noise: 0.1 }).stepTo(START, 0).clamp(0).round(0).build());
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', series(`cpu-${h}`, 18 + i * 1.5, { noise: 0.1 }).wave(0.06).rampTo(START, 2.1 + i * 0.2, 2).clamp(0, 100).build(), h);
    }
    // Red herring: a nightly reporting query spiked RDS CPU half an hour before the outage.
    setPoints(env, 'rds.cpu', series('dbcpu', 24, { noise: 0.1 }).wave(0.05).spike(41, 71, 6).rampTo(START, 6.2, 2).clamp(0, 100).build());
    panel(env, 'rds.cpu').featured = true;
    setPoints(env, 'rds.connections', series('dbconn', 64, { noise: 0.05 }).rampTo(START, 41, 3).clamp(0).round(0).build());
    env.rds.events.push({ minutesAgo: 44, source: 'checkout-db', message: 'Performance Insights: database load exceeded 2 vCPUs (reporting query, 6 min)' });

    setAlarm(env, 'checkout-unhealthy-hosts', 'ALARM', 10);
    setAlarm(env, 'checkout-alb-p99-latency-high', 'INSUFFICIENT_DATA', 8);
    setAlarm(env, 'checkout-latency-p99-high', 'INSUFFICIENT_DATA', 8);

    /* ---------------- Hosts: healthy, idle, unreachable ---------------- */
    env.traffic.profile = (_h, m) => (m <= 11 ? { rpm: 0 } : {});
    for (const [i, h] of APP_HOSTS.entries()) {
      const hh = host(env, h);
      hh.env.APP_VERSION = '2.13.2';
      hh.files['/opt/checkout-api/package.json'] = hh.files['/opt/checkout-api/package.json']
        .replace('"version": "2.13.1"', '"version": "2.13.2"')
        .replace('"undici": "6.19.8"', '"undici": "6.20.1"')
        .replace('"pg": "8.12.0"', '"pg": "8.13.0"')
        .replace('"fastify": "4.28.1"', '"fastify": "4.28.2"');
      const svc = hh.services['checkout-api'];
      svc.since = `${systemdTime(t(1203 - i * 3))}; 20h ago`;
      svc.journal = svc.journal.map(l => l.replace('v2.13.1', 'v2.13.2'));
      hh.load = [0.04, 0.21, 0.38];
      hh.cpu = { cores: 2, user: 1.4, system: 0.6, iowait: 0, steal: 0, idle: 98.0 };
      const meta = hostMeta[h];
      hh.sockets.established = 23 + i;
      hh.sockets.timeWait = 3;
      hh.sockets.sample = [
        { state: 'ESTAB', local: `${meta.ip}:51210`, peer: '10.0.20.57:5432', process: 'node' },
        { state: 'ESTAB', local: `${meta.ip}:51224`, peer: '10.0.20.57:5432', process: 'node' },
        { state: 'ESTAB', local: `${meta.ip}:51236`, peer: '10.0.20.57:5432', process: 'node' },
        { state: 'ESTAB', local: `${meta.ip}:40112`, peer: '10.0.20.88:6379', process: 'node' },
        { state: 'ESTAB', local: `${meta.ip}:22`, peer: '10.0.0.12:51844', process: 'sshd' },
      ];
    }

    // Network behaviour seen from inside the VPC.
    env.http.unshift(
      // nothing but the ALB SG is allowed to app hosts on web ports (and now only on 8080, where nothing listens)
      { match: /^(https?|tcp):\/\/10\.0\.1[01]\.\d+(:(80|443|3000|8080))?(\/|$)/, behaviour: 'timeout' },
      ...['api.shopfast.io', 'shopfast.io'].map(name => ({
        match: new RegExp(`^http://${name.replace(/\./g, '\\.')}(:80)?(/|$)`),
        behaviour: 'ok' as const,
        status: 301,
        headers: { Server: 'awselb/2.0', 'Content-Type': 'text/html', Location: `https://${name}:443/` },
        body: '<html>\r\n<head><title>301 Moved Permanently</title></head>\r\n<body>\r\n<center><h1>301 Moved Permanently</h1></center>\r\n</body>\r\n</html>',
        timeMs: 3,
      })),
      { match: /^https:\/\/(api\.)?shopfast\.io/, behaviour: 'ok', status: 504, headers: { Server: 'awselb/2.0', 'Content-Type': 'text/html' }, body: '<html>\r\n<head><title>504 Gateway Time-out</title></head>\r\n<body>\r\n<center><h1>504 Gateway Time-out</h1></center>\r\n</body>\r\n</html>', timeMs: 10012 },
    );

    /* ---------------- Audit trail ---------------- */
    const perm = (port: number) => ({ items: [{ ipProtocol: 'tcp', fromPort: port, toPort: port, groups: { items: [{ groupId: IDS.albSg, description: 'HTTP from ALB' }] } }] });
    env.cloudtrail.push(
      { minutesAgo: 12.6, eventName: 'DescribeSecurityGroups', eventSource: 'ec2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: '-' },
      { minutesAgo: REVOKE, eventName: 'RevokeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: IDS.appSg, request: { groupId: IDS.appSg, ipPermissions: perm(80) } },
      { minutesAgo: REVOKE - 0.02, eventName: 'AuthorizeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: IDS.appSg, request: { groupId: IDS.appSg, ipPermissions: perm(8080) } },
      { minutesAgo: 6, eventName: 'DescribeTargetHealth', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'sso/priya.natarajan', sourceIp: '203.0.113.52', resources: IDS.tgArn },
      { minutesAgo: 4, eventName: 'DescribeInstances', eventSource: 'ec2.amazonaws.com', user: 'sso/li.wang', sourceIp: '203.0.113.61', resources: '-' },
    );
    env.cloudtrail.sort((a, b) => a.minutesAgo - b.minutesAgo);

    env.changes.push(
      {
        id: 'chg-8841',
        minutesAgo: 12.5,
        kind: 'infra',
        service: 'network (terraform envs/prod)',
        title: 'Consolidate security groups into shared module (PR #1219)',
        author: 'terraform-ci (PR #1219, tom.reyes)',
        status: 'succeeded',
        description: 'Merged to main 07:58 (1 approval). Pipeline: fmt ✔ · validate ✔ · plan ✔ · apply ✔ (auto-approve on main). PR description: "Refactor only — moves ingress rules into modules/security-group-rules. No functional change intended."',
        diff: TF_DIFF,
      },
      {
        id: 'chg-8839',
        minutesAgo: 17,
        kind: 'infra',
        service: 'edge (ACM)',
        title: 'ACM managed renewal completed for *.shopfast.io',
        author: 'aws-acm (automatic)',
        status: 'succeeded',
        description: 'Certificate arn:aws:acm:us-east-1:481562039374:certificate/9d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6 renewed in place (same ARN, DNS validation). New validity 2026-10-07 → 2027-04-25. Associated resources (shopfast-prod-alb HTTPS:443) use the renewed certificate automatically.',
      },
      {
        id: 'chg-8836',
        minutesAgo: 1205,
        kind: 'deploy',
        service: 'checkout-api',
        title: 'checkout-api 2.13.2 — dependency bumps (undici, pg, fastify)',
        author: 'renovate[bot] (merged by li.wang)',
        status: 'succeeded',
        version: '2.13.2',
        description: 'Canary 10% for 30 min, then rolling to 100%. Error rate and p99 unchanged during canary.',
        diff: `diff --git a/package.json b/package.json
-    "fastify": "4.28.1",
+    "fastify": "4.28.2",
-    "pg": "8.12.0",
+    "pg": "8.13.0",
-    "undici": "6.19.8",
+    "undici": "6.20.1",`,
      },
    );
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'targets-timeout',
      label: 'All three targets unhealthy: Target.Timeout — "Request timed out"',
      kind: 'key',
      match: /in checkout-api-tg is unhealthy — Target\.Timeout|"Reason": "Target\.Timeout"/,
      foundBy: { tool: 'alb' },
      explanation: 'The ALB’s health checks to port 80 get no answer at all — not a 500, not a refusal, just silence. That points at the network path, not at the application.',
    },
    {
      id: 'sg-8080',
      label: 'shopfast-app-sg only allows the ALB on tcp/8080 — nginx listens on 80',
      kind: 'key',
      match: /shopfast-app-sg\) inbound: tcp\/8080 from sg-0a71c3e9d5b2f4810|"FromPort": 8080/,
      foundBy: { tool: 'ec2' },
      explanation: 'The target group sends traffic and health checks to port 80. The only rule admitting the ALB’s security group is for 8080, so every packet to :80 is dropped (security groups drop silently → timeouts).',
    },
    {
      id: 'sg-change',
      label: 'terraform-ci revoked tcp/80 and authorized tcp/8080 on shopfast-app-sg at 08:00',
      kind: 'key',
      match: /(Revoke|Authorize)SecurityGroupIngress[^\n]*sg-0b52e8f1a6c3d7924|Consolidate security groups/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'CloudTrail pins the exact moment and actor: the PR #1219 pipeline replaced the rule seconds before targets went unhealthy. The diff shows why — the new module’s `port` variable defaults to 8080.',
    },
    {
      id: 'local-health-ok',
      label: 'On the hosts, /health returns 200',
      kind: 'supporting',
      match: /"status":"ok"/,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'curl -s localhost/health' },
      explanation: 'Proves nginx and checkout-api work. Combined with the ALB’s timeouts, the problem must sit between the ALB and the instance.',
    },
    {
      id: 'nginx-80',
      label: 'nginx listens on 0.0.0.0:80; nothing listens on 8080',
      kind: 'supporting',
      match: /LISTEN[^\n]*0\.0\.0\.0:80\s/,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'ss -tlnp' },
      explanation: 'Confirms the port mismatch: the security group opens a port nobody listens on and closes the one nginx uses.',
    },
    {
      id: 'conn-errors',
      label: 'ALB TargetConnectionErrorCount / ELB 5XX jumped to ~2,000/min at 08:01',
      kind: 'supporting',
      match: /TargetConnectionErrorCount|HTTPCode_ELB_5XX_Count/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.connErrors' },
      explanation: 'The ALB itself generates the errors (ELB 5XX, not Target 5XX) because it cannot even open a TCP connection to the targets.',
    },
    {
      id: 'acm-renewal',
      label: 'ACM renewed the *.shopfast.io certificate at 07:55',
      kind: 'red-herring',
      match: /ACM managed renewal|renewed in place/,
      foundBy: { tool: 'deploys' },
      explanation: 'Managed renewals keep the same ARN and are picked up by the listener transparently. A TLS problem would fail the handshake from clients (curl error 60), not produce 504s after 10 s.',
    },
    {
      id: 'deps-bump',
      label: 'checkout-api 2.13.2 dependency bumps deployed yesterday',
      kind: 'red-herring',
      match: /checkout-api 2\.13\.2 — dependency/,
      foundBy: { tool: 'deploys' },
      explanation: '2.13.2 ran fine for 20 hours, and the app answers /health locally right now. Rolling it back would change nothing.',
    },
    {
      id: 'rds-cpu',
      label: 'checkout-db CPU spiked to ~70% at 07:31',
      kind: 'red-herring',
      match: /CPUUtilization \[checkout-db\]/,
      foundBy: { tool: 'cloudwatch', panel: 'rds.cpu' },
      explanation: 'A 6-minute reporting query half an hour before the outage. Database CPU is now near zero because no requests reach the app at all.',
    },
    {
      id: 'worker-sg',
      label: 'terraform-ci opened tcp/9100 on the worker security group',
      kind: 'red-herring',
      match: /AuthorizeSecurityGroupIngress[^\n]*sg-0e25b7c9d3f1a4268/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'A node-exporter rule on the worker SG, applied hours earlier. Workers aren’t behind the ALB.',
    },
  ],

  rootCauses: [
    {
      id: 'rc-sg-port',
      correct: true,
      text: 'PR #1219 swapped shopfast-app-sg\'s tcp/80-from-ALB rule for tcp/8080 (module default); nginx listens on 80, so the ALB\'s health checks and requests are dropped and targets time out.',
      explanation: 'Every observation fits: healthy processes, silent hosts (no new log lines), timeouts rather than refusals, ELB-generated 5xx, and a CloudTrail revoke/authorize pair seconds before the outage.',
    },
    {
      id: 'rc-unhealthy',
      partial: true,
      text: 'All three targets in checkout-api-tg are failing the ALB\'s HTTP health check on /health, so the ALB has no healthy target to route to and returns 504 for every request.',
      explanation: 'True, but it is the symptom. Without the why (a security group no longer allows port 80 from the ALB) you can’t fix it — restarting or replacing instances won’t help.',
    },
    {
      id: 'rc-deps',
      text: 'The 2.13.2 bump to undici 6.20.1 changed keep-alive handling, so checkout-api stalls on the ALB\'s health checks, all targets hit Target.Timeout and the ALB returns 504.',
      explanation: '/health returns 200 on every host, 2.13.2 ran for 20 hours without issues, and a broken endpoint would produce Target.ResponseCodeMismatch, not Target.Timeout.',
    },
    {
      id: 'rc-acm',
      text: 'The ACM managed renewal at 07:55 attached a certificate whose chain the HTTPS:443 listener can\'t serve, so TLS negotiation with the ALB stalls and every request ends in 504.',
      explanation: 'Clients complete the TLS handshake fine (curl -v shows "SSL certificate verify ok") and get an HTTP 504 back from awselb/2.0. Health checks are plain HTTP on port 80 and don’t involve the certificate.',
    },
    {
      id: 'rc-nginx',
      text: 'nginx on all three hosts exhausted worker_connections (4096) after the 07:31 database slowdown, so new connections from the ALB sit in the listen backlog and time out.',
      explanation: 'nginx is listening and answers locally immediately; it has fewer than 30 sockets open. An exhausted nginx would also show up in its error log.',
    },
    {
      id: 'rc-nacl',
      text: 'A network ACL change on shopfast-app-a/b now blocks return traffic on ephemeral ports 1024–65535, so the ALB\'s connections to the targets never complete and health checks time out.',
      explanation: 'Plausible shape (timeouts) but nothing changed in the VPC’s NACLs — CloudTrail only shows security-group changes, and the SG rules alone already explain the drop.',
    },
  ],

  fixes: [
    {
      id: 'fx-restore',
      kind: 'correct',
      text: 'Revert PR #1219 (or pass port = 80 to the module) and apply to restore tcp/80 from sg-0a71c3e9d5b2f4810; watch HealthyHostCount return to 3.',
      explanation: 'This is the actual fix. Targets need `healthy threshold` (3) consecutive passing checks at 10 s intervals, so traffic recovers ~30 s after the rule is back. Doing it through Terraform keeps code and reality in sync.',
    },
    {
      id: 'fx-guardrails',
      kind: 'correct',
      text: 'Add a post-apply smoke test with auto-revert, review plans that destroy SG rules, remove the port default, and alarm on ELB 5XX.',
      explanation: 'The plan clearly said "destroy … from_port = 80" and "create … 8080"; nobody read it because the PR claimed "no functional change". Guardrails catch what humans skim.',
    },
    {
      id: 'fx-console',
      kind: 'partial',
      text: 'Add tcp/80 from sg-0a71c3e9d5b2f4810 to shopfast-app-sg by hand in the EC2 console, confirm the targets turn healthy, and close the incident.',
      explanation: 'Restores service fastest, but Terraform code still says 8080: the stray 8080 rule stays, and the next refactor or SG re-creation brings the outage back. Follow up in code immediately.',
    },
    {
      id: 'fx-open-world',
      kind: 'harmful',
      text: 'Allow tcp/80 from 0.0.0.0/0 on shopfast-app-sg (sg-0b52e8f1a6c3d7924) to rule out the security group and get traffic flowing again.',
      explanation: 'It would restore traffic, but now anything that can route to the instances (the whole VPC, peered networks, VPN users — and the internet if an instance ever gets a public IP) bypasses the ALB, TLS and WAF. "Temporary" wide-open rules tend to stay forever.',
    },
    {
      id: 'fx-hc-port',
      kind: 'harmful',
      text: 'Change checkout-api-tg\'s health-check port from traffic-port to 8080 so the health checks match the new security-group rule.',
      explanation: 'Health checks would now reach the hosts and be refused (nothing listens on 8080) → Target.FailedHealthChecks, real traffic to :80 is still dropped, and once the SG is fixed the targets would stay unhealthy until someone notices this second change.',
    },
    {
      id: 'fx-restart',
      kind: 'neutral',
      text: 'Restart nginx and checkout-api on all three hosts with `systemctl restart nginx checkout-api` to clear stalled workers.',
      explanation: 'The processes are healthy; packets never reach them. Nothing changes.',
    },
    {
      id: 'fx-rollback',
      kind: 'neutral',
      text: 'Roll checkout-api back from 2.13.2 to 2.13.1 across the ASG to undo yesterday\'s undici 6.20.1 / pg 8.13.0 / fastify bumps.',
      explanation: 'Costs 10 minutes of a SEV1 and changes nothing — the application isn’t the problem.',
    },
    {
      id: 'fx-replace',
      kind: 'neutral',
      text: 'Terminate the three unhealthy instances so shopfast-checkout-asg replaces them with fresh ones from launch template 14.',
      explanation: 'Replacements launch into the same security group and fail the same health check. You lose warm caches and logs for nothing.',
    },
  ],

  hints: [
    'The load balancer answers (with 504 after ~10 s), so DNS and TLS work. Look at what the ALB thinks of its targets, and at what the hosts themselves see — are requests even arriving?',
    'Targets fail with Target.Timeout while `curl localhost/health` on each host returns 200 and the access logs went silent at 08:01. A timeout (not a refusal, not a 500) means packets are being dropped on the way. What decides which packets may reach an EC2 instance?',
    'Compare shopfast-app-sg’s inbound rules with the port the target group uses (80), then check CloudTrail / Deploys for what changed at 08:00.',
  ],

  debrief: {
    summary: `At 07:58 PR #1219 ("consolidate security groups") was merged and the terraform-ci pipeline auto-applied it at 08:00. The refactor moved the app’s ingress rule into a new shared module whose \`port\` variable **defaults to 8080** — the port the ECS services use. The app module didn’t pass \`port = 80\`, so Terraform destroyed "tcp/80 from shopfast-alb-sg" and created "tcp/8080 from shopfast-alb-sg" on **shopfast-app-sg**. The plan said so in plain text; the PR description said "no functional change", and nobody read the plan.

Security groups drop disallowed packets silently. Within ~20 s (2 failed checks × 10 s interval) all three targets went **unhealthy with Target.Timeout**. When every target in a target group is unhealthy, an ALB **fails open**: it keeps sending requests to the targets anyway. Each attempt waited for the ALB’s 10-second connect timeout and ended in **504 Gateway Time-out** — counted as \`HTTPCode_ELB_5XX_Count\` and \`TargetConnectionErrorCount\`, not as target 5xx. A few requests on keep-alive connections that were already open kept working for a few seconds, because security groups are stateful and only evaluate new connections.

On the hosts everything looked perfect — nginx and checkout-api were up, \`curl localhost/health\` returned 200 — because localhost traffic never crosses a security group. The tell-tale sign was silence: the access logs, including the ELB-HealthChecker lines that normally arrive every few seconds, simply stopped at 08:01. The ASG uses EC2 status checks, so it didn’t start replacing instances; with ELB health checks it would have churned through replacements that fail the same way.

The ACM renewal, the 2.13.2 dependency bump and the RDS CPU blip were coincidences: none of them can make packets disappear between the ALB and the instances.`,
    timeline: [
      { minutesAgo: 1205, event: 'checkout-api 2.13.2 (dependency bumps) deployed — healthy for 20 h (red herring)' },
      { minutesAgo: 41, event: 'Reporting query spikes checkout-db CPU to ~70% for 6 minutes (red herring)' },
      { minutesAgo: 17, event: 'ACM renews *.shopfast.io in place (red herring)' },
      { minutesAgo: 14, event: 'PR #1219 "consolidate security groups" merged' },
      { minutesAgo: 11.9, event: 'terraform-ci: RevokeSecurityGroupIngress tcp/80, AuthorizeSecurityGroupIngress tcp/8080 on shopfast-app-sg' },
      { minutesAgo: 11.5, event: 'All targets Target.Timeout; ALB fails open; every request ends in 504 after 10 s' },
      { minutesAgo: 10, event: 'checkout-unhealthy-hosts pages on-call; Pingdom reports API down' },
    ],
    concepts: [
      {
        title: 'Read the failure mode: timeout vs refused vs error',
        body: 'A **timeout** means nothing answered — packets were dropped (security group, NACL, route, firewall) or the host is gone. **Connection refused** (TCP RST) means the host is reachable but nothing listens on that port. An **HTTP 5xx** means the process answered but failed. Target.Timeout on every target while the app answers locally is the classic signature of a security group problem; Target.ResponseCodeMismatch would have pointed at the app.',
      },
      {
        title: 'Security groups: default deny, stateful, referenced by group',
        body: 'A security group allows only what its rules list; everything else is dropped without a reply. Rules can reference another security group ("tcp/80 from sg-alb") so any ALB node — whose IPs change — is allowed. They are **stateful**: return traffic is allowed automatically, and already-established connections keep flowing after a rule is removed until they close. Changing a rule is instant and global, which makes it one of the fastest ways to cause (or fix) an outage.',
      },
      {
        title: 'ALB fail-open, and which 5xx means what',
        body: 'If all targets are unhealthy, an ALB routes to all of them anyway (fail open) rather than to none. **502** = the target answered with garbage or closed the connection; **503** = no registered targets (or a fixed 503 rule); **504** = the target didn’t accept or answer in time (10 s connect timeout, or the idle timeout). `HTTPCode_ELB_5XX_Count` is generated by the ALB itself; `HTTPCode_Target_5XX_Count` comes from your app. Here target 5xx dropped to zero — the existing target-5xx alarm could never have fired.',
      },
      {
        title: 'Terraform plans: read the destroys, distrust defaults',
        body: 'Every `-` / `-/+` line in a plan is something that disappears from production. "Refactor only" PRs that move resources between modules are high-risk precisely because reviewers expect a no-op. Module inputs that encode environment-specific facts (ports, CIDRs, sizes) should have **no default**, so forgetting them is a plan-time error, not an outage. Tools like `terraform plan -detailed-exitcode`, OPA/conftest policies or Atlantis plan comments make destructive changes visible.',
      },
      {
        title: 'Test from where the traffic comes from',
        body: '`curl localhost/health` proves the process works but skips the network path the ALB uses. The bastion can’t help either — it is only allowed on port 22. Use the vantage point that matters: the ALB’s own view (target health, TargetConnectionErrorCount), the security group rules for the exact source and port, or VPC Reachability Analyzer for a path analysis between the ALB ENI and the instance.',
      },
    ],
    commands: [
      { cmd: `aws elbv2 describe-target-health --target-group-arn ${IDS.tgArn}`, why: 'Health state and reason code for every target' },
      { cmd: `aws ec2 describe-security-groups --group-ids ${IDS.appSg}`, why: 'Exactly which ports and sources the instances admit' },
      { cmd: `aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=${IDS.appSg}`, why: 'Who changed the security group, when, and to what' },
      { cmd: 'curl -sv localhost/health', why: 'Is the process itself healthy (bypassing the network)?' },
      { cmd: 'ss -tlnp', why: 'Which ports are actually listening on the host' },
      { cmd: 'curl -v https://api.shopfast.io/health', why: 'The customer’s view: DNS, TLS handshake, and who generates the error (Server: awselb/2.0)' },
    ],
    prevention: [
      'Post-apply smoke tests in the Terraform pipeline (synthetic request + HealthyHostCount) with automatic revert on failure.',
      'Require human review of any plan that destroys or replaces security-group rules; post the plan in the PR.',
      'No defaults for environment-specific module inputs such as ports — make them required.',
      'Alarm on HTTPCode_ELB_5XX_Count, TargetConnectionErrorCount and HealthyHostCount < 1, not only on target 5xx.',
      'Run VPC Reachability Analyzer (ALB → instance:80) as a policy check after network changes.',
    ],
    reading: [
      { title: 'Health checks for Application Load Balancer target groups (incl. fail-open)', url: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/target-group-health-checks.html' },
      { title: 'Troubleshoot your Application Load Balancers (HTTP 502/503/504)', url: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-troubleshooting.html' },
      { title: 'Control traffic to your AWS resources using security groups', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/vpc-security-groups.html' },
    ],
  },
};

export default incident;
