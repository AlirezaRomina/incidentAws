import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, isoSec } from '../engine/time';
import { addPanel, setPoints } from '../env/helpers';
import { APP_HOSTS, IDS } from '../env/base';

/*
 * INC-4033 — api.shopfast.io stopped resolving.
 *
 * Last week (Oct 2) the team moved from the console-built shopfast-legacy-alb to the
 * Terraform-managed shopfast-prod-alb. The Route 53 change batch only UPSERTed the apex
 * (shopfast.io → Alias A to the new ALB). api.shopfast.io had always been a plain CNAME
 * (TTL 3600) to the legacy ALB's AWS-generated DNS name — nobody noticed, because the legacy
 * ALB kept serving the API (mobile apps + partners) all week. Today at 08:40 the cleanup ticket
 * deleted shopfast-legacy-alb: its DNS name now returns NXDOMAIN, so api.shopfast.io → CNAME →
 * NXDOMAIN. The website uses same-origin /api paths on the apex and keeps working.
 */

const DELETED = 25; // 08:40 UTC
const CUTOVER = 9775; // Fri Oct 2 14:10 UTC: apex moved to the new ALB
const LEGACY_DNS = 'shopfast-legacy-alb-884213377.us-east-1.elb.amazonaws.com';
const LEGACY_ARN = `arn:aws:elasticloadbalancing:us-east-1:${IDS.account}:loadbalancer/app/shopfast-legacy-alb/3c9d1e7f5a2b8064`;
const LEGACY_TG_ARN = `arn:aws:elasticloadbalancing:us-east-1:${IDS.account}:targetgroup/checkout-api-legacy-tg/7e8f9a0b1c2d3e4f`;
const ZONE = 'Z04812763KQ1ZP9X0ABCD';

const HOMEPAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>ShopFast — everyday essentials, delivered fast</title>
  <link rel="stylesheet" href="/static/app.4f1c2a.css">
</head>
<body>
  <div id="root"></div>
  <script>window.__SHOPFAST__ = { apiBase: "/api/v1", release: "web-2026.10.08.2" };</script>
  <script src="/static/app.9b2e71.js" defer></script>
</body>
</html>`;

const incident: Incident = {
  id: 'dns-stale-cname',
  code: 'INC-4033',
  order: 3,
  title: 'Mobile apps and partners can’t reach the API',
  teaser: 'The website works. The mobile apps and every partner integration say "Could not resolve host". The load balancer looks perfectly healthy.',
  difficulty: 'beginner',
  tags: ['DNS', 'Route 53', 'ALB', 'Migrations'],
  parMinutes: 10,
  seed: 4033,
  now: '2026-10-09T09:05:00Z',
  briefing: {
    severity: 'SEV1',
    alert: {
      source: 'Pingdom',
      title: 'DOWN: "API health" (https://api.shopfast.io/health)',
      details: 'Error: Could not resolve host: api.shopfast.io — from 4/4 probe locations since 08:41 UTC. Check "Website" (https://shopfast.io/) is UP.',
      minutesAgo: 23,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4033', message: 'The iOS and Android apps are broken for everyone: "Cannot connect to ShopFast. Check your internet connection." 1-star reviews are piling up. The website is fine though — I just placed a test order there.', minutesAgo: 19 },
      { from: 'Marcus Bell', role: 'Partner Integrations', channel: '#incident-4033', message: 'Brightline Logistics and two marketplace partners report their order-sync jobs failing since ~08:41 with `curl: (6) Could not resolve host: api.shopfast.io`. They say nothing changed on their side.', minutesAgo: 14 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4033', message: 'ALB dashboard is all green, 5xx basically zero, so I don’t think the backend is the problem. Sara turned on the new checkout flow v3 for iOS this morning — could the apps be choking on that?', minutesAgo: 9 },
    ],
    impact: 'Mobile apps (~45% of orders) and all partner API integrations down since ~08:40 UTC. Website unaffected.',
    services: ['api.shopfast.io (Route 53)', 'shopfast-prod-alb', 'mobile apps', 'partner API'],
  },

  build(env) {
    const t = (m: number) => env.now - m * MIN;

    /* ---------------- DNS ---------------- */
    const zone = env.route53.zones.find(z => z.id === ZONE)!;
    zone.records = zone.records.filter(r => r.name !== 'api.shopfast.io');
    zone.records.splice(5, 0, { name: 'api.shopfast.io', type: 'CNAME', ttl: 3600, values: [LEGACY_DNS] });
    env.route53.external[LEGACY_DNS] = 'NXDOMAIN';
    env.route53.external[`dualstack.${LEGACY_DNS}`] = 'NXDOMAIN';

    /* ---------------- Load balancers ---------------- */
    const lb = env.elb.loadBalancers[0];
    lb.created = isoSec(t(9 * 1440 + 200));

    /* ---------------- HTTP ---------------- */
    env.http.unshift(
      { match: /^https:\/\/(www\.)?shopfast\.io\/health/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', Server: 'awselb/2.0' }, body: '{"status":"ok","version":"2.13.1","db":"ok","redis":"ok"}', timeMs: 36 },
      { match: /^https:\/\/(www\.)?shopfast\.io\/api\//, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', Server: 'awselb/2.0' }, body: '{"items":[{"sku":"SKU-41822","name":"Merino crew socks (3-pack)","price_cents":1999}],"next":"c_2f9a"}', timeMs: 44 },
      { match: /^https:\/\/(www\.)?shopfast\.io(\/|$)/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8', Server: 'awselb/2.0', 'Cache-Control': 'no-cache' }, body: HOMEPAGE, timeMs: 52 },
    );

    /* ---------------- Metrics ---------------- */
    // The new ALB only ever carried the website — it never saw the API traffic.
    setPoints(env, 'alb.requests', series('req-new', 955, { noise: 0.05 }).wave(0.06).clamp(0).round(0).build());
    setPoints(env, 'alb.elb5xx', series('e5xx', 0.2, { noise: 1 }).clamp(0).round(0).build());
    setPoints(env, 'alb.target5xx', series('t5xx', 0.5, { noise: 1 }).clamp(0).round(0).build());
    addPanel(env, {
      id: 'alb.legacyRequests',
      group: 'Application Load Balancer',
      namespace: 'AWS/ApplicationELB',
      metric: 'RequestCount',
      resource: 'shopfast-legacy-alb',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      series: [{ name: 'shopfast-legacy-alb', points: series('req-legacy', 1425, { noise: 0.05 }).wave(0.06).stepTo(DELETED, 0).clamp(0).round(0).build() }],
    });
    setPoints(env, 'app.orders', series('orders', 61, { noise: 0.14 }).stepTo(DELETED - 1, 34).clamp(0).round(0).build());
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', series(`cpu-${h}`, 18 + i * 1.3, { noise: 0.1 }).wave(0.06).rampTo(DELETED, 8.5 + i * 0.6, 2).clamp(0, 100).build(), h);
    }
    setPoints(env, 'rds.connections', series('dbconn', 64, { noise: 0.04 }).rampTo(DELETED, 39, 3).clamp(0).round(0).build());
    env.traffic.profile = (_h, m) => (m < DELETED ? { rpm: 3 } : {});

    /* ---------------- Audit trail ---------------- */
    env.cloudtrail.push(
      {
        minutesAgo: CUTOVER,
        eventName: 'ChangeResourceRecordSets',
        eventSource: 'route53.amazonaws.com',
        user: 'sso/maria.chen',
        sourceIp: '203.0.113.48',
        resources: ZONE,
        request: { hostedZoneId: ZONE, changeBatch: { comment: 'OPS-1398 cut shopfast.io over to shopfast-prod-alb', changes: [{ action: 'UPSERT', resourceRecordSet: { name: 'shopfast.io.', type: 'A', aliasTarget: { hostedZoneId: 'Z35SXDOTRQ7X7K', dNSName: `dualstack.${IDS.albDns}.`, evaluateTargetHealth: true } } }] } },
      },
      { minutesAgo: 9 * 1440 + 200, eventName: 'CreateLoadBalancer', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: IDS.albArn, request: { name: 'shopfast-prod-alb', scheme: 'internet-facing', type: 'application', securityGroups: [IDS.albSg] } },
      { minutesAgo: DELETED + 1.4, eventName: 'ModifyLoadBalancerAttributes', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'sso/maria.chen', sourceIp: '203.0.113.48', resources: LEGACY_ARN, request: { loadBalancerArn: LEGACY_ARN, attributes: [{ key: 'deletion_protection.enabled', value: 'false' }] } },
      { minutesAgo: DELETED, eventName: 'DeleteLoadBalancer', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'sso/maria.chen', sourceIp: '203.0.113.48', resources: LEGACY_ARN, request: { loadBalancerArn: LEGACY_ARN } },
      { minutesAgo: DELETED - 0.8, eventName: 'DetachLoadBalancerTargetGroups', eventSource: 'autoscaling.amazonaws.com', user: 'sso/maria.chen', sourceIp: '203.0.113.48', resources: 'shopfast-checkout-asg', request: { autoScalingGroupName: 'shopfast-checkout-asg', targetGroupARNs: [LEGACY_TG_ARN] } },
      { minutesAgo: DELETED - 1.1, eventName: 'DeleteTargetGroup', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'sso/maria.chen', sourceIp: '203.0.113.48', resources: LEGACY_TG_ARN, request: { targetGroupArn: LEGACY_TG_ARN } },
      { minutesAgo: 7, eventName: 'DescribeLoadBalancers', eventSource: 'elasticloadbalancing.amazonaws.com', user: 'sso/sam.kowalski', sourceIp: '203.0.113.77', resources: '-' },
    );
    env.cloudtrail.sort((a, b) => a.minutesAgo - b.minutesAgo);

    env.ec2.asgs[0].activities.unshift({
      minutesAgo: DELETED - 0.8,
      status: 'Successful',
      description: 'Detaching target group checkout-api-legacy-tg',
      cause: `At ${isoSec(t(DELETED - 0.8))} a user request detached target group ${LEGACY_TG_ARN} from the Auto Scaling group.`,
    });

    env.changes.push(
      {
        id: 'chg-8851',
        minutesAgo: DELETED + 1.5,
        kind: 'infra',
        service: 'edge',
        title: 'Delete legacy ALB shopfast-legacy-alb after migration (OPS-1432)',
        author: 'maria.chen',
        status: 'succeeded',
        description: 'Cleanup after OPS-1398. Pre-checks from the ticket: ✔ shopfast.io is an alias to shopfast-prod-alb (since Oct 2) ✔ shopfast-prod-alb healthy, 0 ELB 5xx ✔ WAF attached to shopfast-prod-alb. Steps: disable deletion protection → delete shopfast-legacy-alb → detach and delete checkout-api-legacy-tg.',
      },
      {
        id: 'chg-8770',
        minutesAgo: CUTOVER,
        kind: 'infra',
        service: 'edge',
        title: 'Cut shopfast.io over to the new ALB shopfast-prod-alb (OPS-1398)',
        author: 'maria.chen',
        status: 'succeeded',
        description: 'Replaces the 2023 console-built shopfast-legacy-alb with the Terraform-managed shopfast-prod-alb (TLS 1.3 policy, HTTP/2, WAF). Route 53 change batch applied; verified https://shopfast.io in a browser. Legacy ALB kept for one week as a fallback.',
        diff: `--- route53 change batch (zone ${ZONE}) ---
{
  "Comment": "OPS-1398 cut shopfast.io over to shopfast-prod-alb",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "shopfast.io.",
        "Type": "A",
        "AliasTarget": {
          "HostedZoneId": "Z35SXDOTRQ7X7K",
-         "DNSName": "dualstack.${LEGACY_DNS}.",
+         "DNSName": "dualstack.${IDS.albDns}.",
          "EvaluateTargetHealth": true
        }
      }
    }
  ]
}`,
      },
      {
        id: 'chg-8849',
        minutesAgo: 55,
        kind: 'feature-flag',
        service: 'mobile-app',
        title: 'Enable checkout-flow-v3 for 10% of iOS users',
        author: 'sara.okafor',
        status: 'succeeded',
        description: 'LaunchDarkly flag checkout-flow-v3 → 10% of iOS 5.12+ users. Android unaffected.',
      },
      {
        id: 'chg-8846',
        minutesAgo: 130,
        kind: 'infra',
        service: 'edge (ACM)',
        title: 'ACM: managed renewal eligibility notice for *.shopfast.io',
        author: 'aws-health',
        status: 'succeeded',
        description: 'Certificate 9d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6 becomes eligible for managed renewal on 2027-01-13. DNS validation record found — no action required.',
      },
    );
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'api-cname',
      label: 'api.shopfast.io is a CNAME (TTL 3600) to the legacy ALB’s DNS name',
      kind: 'key',
      match: /api\.shopfast\.io CNAME[^\n]*shopfast-legacy-alb|api\.shopfast\.io\.\s+\d+\s+IN\s+CNAME\s+shopfast-legacy-alb/,
      foundBy: { tool: 'route53' },
      explanation: 'The apex was migrated to an Alias A record last week; the api name never was. It still points at an AWS-generated name that belongs to the old load balancer.',
    },
    {
      id: 'nxdomain',
      label: 'The CNAME target returns NXDOMAIN — api.shopfast.io does not resolve',
      kind: 'key',
      match: /status: NXDOMAIN|Could not resolve host: api\.shopfast\.io|can't find shopfast-legacy-alb|shopfast-legacy-alb[^\n]*not found: 3\(NXDOMAIN\)/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'dig api.shopfast.io' },
      explanation: 'dig shows the full chain: api.shopfast.io → CNAME → shopfast-legacy-alb-….elb.amazonaws.com → NXDOMAIN. Clients never get an IP, so no request ever reaches any load balancer.',
    },
    {
      id: 'legacy-deleted',
      label: 'shopfast-legacy-alb was deleted at 08:40 (OPS-1432)',
      kind: 'key',
      match: /DeleteLoadBalancer[^\n]*shopfast-legacy-alb|Delete legacy ALB shopfast-legacy-alb/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'Deleting a load balancer also deletes its DNS name. This is the trigger, one minute before the first resolution failures.',
    },
    {
      id: 'legacy-traffic',
      label: 'The legacy ALB was still serving ~1,400 requests/min until it was deleted',
      kind: 'supporting',
      match: /RequestCount \[shopfast-legacy-alb\]/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.legacyRequests' },
      explanation: 'The clearest signal that the migration wasn’t finished: the "old" load balancer carried more traffic than the new one right up to the deletion.',
    },
    {
      id: 'apex-alias',
      label: 'shopfast.io (apex) is an Alias A record to the new ALB',
      kind: 'supporting',
      match: /shopfast\.io A ALIAS → dualstack\.shopfast-prod-alb/,
      foundBy: { tool: 'route53' },
      explanation: 'Explains why the website works: it resolves through a different record that was migrated correctly.',
    },
    {
      id: 'apex-works',
      label: 'https://shopfast.io/health returns 200',
      kind: 'supporting',
      match: /"status":"ok"/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'curl -s https://shopfast.io/health' },
      explanation: 'Same ALB, same targets, same app — healthy. The backend is fine; only the name is broken.',
    },
    {
      id: 'alb-5xx',
      label: 'ALB 5xx is near zero',
      kind: 'red-herring',
      match: /HTTPCode_(ELB|Target)_5XX_Count \[shopfast-prod-alb\]/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.elb5xx' },
      explanation: 'True and irrelevant: requests that never resolve never reach the ALB, so they can’t produce 5xx. "No errors" on a dashboard can mean "no traffic".',
    },
    {
      id: 'flag-v3',
      label: 'checkout-flow-v3 enabled for 10% of iOS users',
      kind: 'red-herring',
      match: /checkout-flow-v3/,
      foundBy: { tool: 'deploys' },
      explanation: 'Only 10% of iOS users, while Android and partners (who don’t use the flag) fail too — and an app-level change can’t make a DNS lookup fail.',
    },
    {
      id: 'acm-notice',
      label: 'ACM managed-renewal notice for *.shopfast.io',
      kind: 'red-herring',
      match: /ACM: managed renewal/,
      foundBy: { tool: 'deploys' },
      explanation: 'An informational notice about a renewal in January. Certificate problems produce TLS errors (curl 35/60), not "Could not resolve host".',
    },
  ],

  rootCauses: [
    {
      id: 'rc-stale-cname',
      correct: true,
      text: 'api.shopfast.io is still a CNAME (TTL 3600) to shopfast-legacy-alb\'s DNS name — only the apex was migrated last week — so deleting that ALB at 08:40 made the name NXDOMAIN.',
      explanation: 'Explains the exact split (apex works, api fails), the error ("Could not resolve host" before any HTTP), the timing (08:40 deletion), and why the healthy ALB sees nothing wrong.',
    },
    {
      id: 'rc-dns',
      partial: true,
      text: 'Route 53 returns NXDOMAIN for api.shopfast.io, so the mobile apps and partner integrations can\'t resolve the API hostname while shopfast.io still resolves normally.',
      explanation: 'Accurate symptom, but not a cause: it doesn’t say which record is wrong or why it broke today, so it doesn’t lead you to the right fix.',
    },
    {
      id: 'rc-route53',
      text: 'The VPC Route 53 Resolver (10.0.0.2) and public resolvers are failing lookups for shopfast.io subdomains because of a Route 53 control-plane incident in us-east-1.',
      explanation: 'shopfast.io and www.shopfast.io resolve fine through the same resolver and hosted zone; only one name fails, and it fails consistently with NXDOMAIN — an authoritative "this name does not exist", not SERVFAIL or timeouts.',
    },
    {
      id: 'rc-host-rule',
      text: 'shopfast-prod-alb\'s HTTPS:443 listener has no host-header rule for api.shopfast.io, so since the 08:40 cleanup API requests are rejected before reaching checkout-api-tg.',
      explanation: 'A missing host rule would return an HTTP response (404/503 from awselb). Clients here never get an IP address, so they never connect to any load balancer.',
    },
    {
      id: 'rc-flag',
      text: 'The checkout-flow-v3 flag enabled at 08:10 ships a new API base URL to iOS/Android clients via the shared remote config that partners also read, breaking their host lookups.',
      explanation: 'Only 10% of iOS users have the flag, but all mobile users and partners fail — with a DNS error that no app feature can cause.',
    },
    {
      id: 'rc-cert',
      text: 'ACM didn\'t renew the *.shopfast.io certificate served for api.shopfast.io, so clients abort the TLS handshake and report the API host as unreachable.',
      explanation: 'Certificate problems happen after DNS and TCP succeed and show up as TLS errors. Here name resolution itself fails.',
    },
  ],

  fixes: [
    {
      id: 'fx-alias',
      kind: 'correct',
      text: 'Replace the CNAME with Alias A/AAAA records api.shopfast.io → dualstack.shopfast-prod-alb-… in one change batch; verify with dig.',
      explanation: 'Restores resolution to the ALB that is already serving the same backend. Alias records follow the ALB’s changing IPs, cost nothing to query and can’t dangle silently. Expect stragglers for up to an hour: resolvers that cached the old CNAME (TTL 3600) keep following it until it expires.',
    },
    {
      id: 'fx-process',
      kind: 'correct',
      text: 'Migration runbook: inventory records pointing at the old LB, lower TTLs before cutover, and delete an LB only after days at ~0 RequestCount.',
      explanation: 'The cleanup ticket checked that the new ALB was healthy, but never that the old one was idle. Traffic on the thing you are about to delete is the only check that matters.',
    },
    {
      id: 'fx-cname-new',
      kind: 'partial',
      text: 'Change the CNAME\'s value to shopfast-prod-alb-1793452210.us-east-1.elb.amazonaws.com, keeping the CNAME type and TTL 3600.',
      explanation: 'It works, but a CNAME to an ELB name costs a second lookup, is billed per query, and keeps the hour-long TTL that slows every future change. An Alias record is the AWS-native answer.',
    },
    {
      id: 'fx-recreate',
      kind: 'harmful',
      text: 'Recreate an ALB named shopfast-legacy-alb with the same listeners and checkout-api-legacy-tg so the old DNS name resolves again.',
      explanation: 'ALB DNS names include a random identifier assigned at creation; a new ALB with the same name gets a different DNS name, so the CNAME still points at nothing. You burn time during a SEV1 and end up with a second ALB to secure and pay for.',
    },
    {
      id: 'fx-ttl-up',
      kind: 'harmful',
      text: 'Raise the TTL on api.shopfast.io from 3600 to 86400 so resolvers cache the answer longer and lookups stay stable during the incident.',
      explanation: 'A long TTL cannot fix an answer that is wrong; it only makes every future change (including the fix) take up to a day to reach clients.',
    },
    {
      id: 'fx-flush',
      kind: 'neutral',
      text: 'Flush DNS caches on the bastion and restart systemd-resolved on app-1..3 to drop the stale NXDOMAIN answers from local caches.',
      explanation: 'The authoritative answer is wrong, so a fresh lookup gets the same NXDOMAIN — and customers’ resolvers aren’t ours to flush anyway.',
    },
    {
      id: 'fx-flag-off',
      kind: 'neutral',
      text: 'Turn off the checkout-flow-v3 LaunchDarkly flag for iOS 5.12+ to rule out the mobile client change that went out at 08:10.',
      explanation: 'Harmless, but unrelated: the apps can’t resolve the API’s name regardless of which checkout flow they show.',
    },
  ],

  hints: [
    'The website works, the API doesn’t, and partners see "Could not resolve host". That error happens before any HTTP request is sent. Try resolving both names yourself from the bastion.',
    'Compare `dig api.shopfast.io` with `dig shopfast.io` and follow the answer chain. What does api.shopfast.io point to — and does that target still exist?',
    'Open Route 53 → shopfast.io and compare the apex record with the api record. Then check CloudTrail / Deploys around 08:40 for what happened to the load balancer the api record points to.',
  ],

  debrief: {
    summary: `Last Friday the team cut over from the console-built **shopfast-legacy-alb** to the Terraform-managed **shopfast-prod-alb**. The Route 53 change batch updated only the apex: \`shopfast.io\` became an **Alias A** record to the new ALB. \`api.shopfast.io\`, used by the mobile apps and partners, had always been a plain **CNAME** (TTL 3600) to the legacy ALB’s AWS-generated name, \`${LEGACY_DNS}\`. Nobody noticed: the legacy ALB still forwarded to the same instances, so the API kept working all week — through the "old" load balancer, which was quietly carrying ~1,400 requests/min, more than the new one.

At 08:40 the cleanup ticket disabled deletion protection and deleted shopfast-legacy-alb. Deleting a load balancer also deletes its DNS name, so the name the CNAME pointed at started returning **NXDOMAIN**. Every resolver following \`api.shopfast.io → CNAME → shopfast-legacy-alb-… → NXDOMAIN\` gave up, and clients failed with "Could not resolve host" before sending a single byte. The website kept working because the browser app calls same-origin \`/api/v1\` paths on the apex, which resolves through the migrated alias.

From the inside everything looked healthy: shopfast-prod-alb had near-zero 5xx and all targets were healthy — because requests that can’t be resolved never reach any load balancer. The cleanup checklist verified the new ALB but never asked the question that mattered: is anything still using the old one?

The fix is a one-record change (Alias A/AAAA to the new ALB). Because the broken CNAME had a 3600-second TTL, some resolvers will keep serving the cached CNAME for up to an hour after the fix — the long TTL works against you exactly when you need a change to propagate.`,
    timeline: [
      { minutesAgo: CUTOVER, event: 'OPS-1398: shopfast.io apex UPSERTed to an Alias A for shopfast-prod-alb; api.shopfast.io not touched' },
      { minutesAgo: 130, event: 'ACM renewal-eligibility notice (red herring)' },
      { minutesAgo: 55, event: 'checkout-flow-v3 enabled for 10% of iOS users (red herring)' },
      { minutesAgo: DELETED + 1.4, event: 'OPS-1432: deletion protection disabled on shopfast-legacy-alb' },
      { minutesAgo: DELETED, event: 'shopfast-legacy-alb deleted; its DNS name now returns NXDOMAIN' },
      { minutesAgo: DELETED - 1, event: 'Mobile apps and partners start failing with "Could not resolve host"; orders drop ~45%' },
      { minutesAgo: 23, event: 'Pingdom: API health DOWN (DNS), website UP' },
    ],
    concepts: [
      {
        title: 'How a name is resolved (and what NXDOMAIN means)',
        body: 'An application asks the local stub resolver, which asks a recursive resolver (in a VPC: the Route 53 Resolver at 10.0.0.2; at home: the ISP or 8.8.8.8). The recursive resolver walks from the root to the authoritative servers for the zone — Route 53’s `ns-*.awsdns-*` servers for shopfast.io — and follows CNAMEs to their targets, possibly in another zone (here `elb.amazonaws.com`). **NXDOMAIN** is an authoritative "this name does not exist", which is different from **SERVFAIL** (the resolver couldn’t get an answer) or a timeout. `dig` shows the whole chain, including where it breaks.',
      },
      {
        title: 'CNAME vs Route 53 Alias records',
        body: 'A CNAME says "this name is another name" — clients must do a second lookup, it cannot exist at the zone apex (shopfast.io), and it cannot coexist with other record types at the same name. A Route 53 **Alias** is a Route 53 feature: the authoritative server resolves the AWS target itself and returns plain A/AAAA records. Aliases work at the apex, are free to query for AWS targets, automatically follow an ALB’s changing IPs, use the target’s TTL (60 s for ELB), and can evaluate target health. For anything pointing at ELB, CloudFront, S3 websites or API Gateway, prefer Alias.',
      },
      {
        title: 'TTLs, caching and negative caching',
        body: 'Every answer is cached by resolvers for its TTL. The CNAME’s TTL of 3600 means a resolver that looked it up at 08:30 keeps believing it until 09:30 — even after you fix the record. Failures are cached too: an NXDOMAIN is cached for the SOA "minimum" of the zone that returned it (RFC 2308). Before a cutover, lower the TTL (e.g. to 60) at least one old-TTL in advance, so both the change and a rollback propagate in a minute; raise it again afterwards if you like.',
      },
      {
        title: 'Load balancer DNS names are not yours to keep',
        body: 'An ALB’s DNS name is `<name>-<random id>.<region>.elb.amazonaws.com`. The id is assigned at creation, so deleting and recreating an ALB with the same name yields a different DNS name, and its IP addresses change over time anyway. Never hard-code ALB IPs, and never point long-lived records at an ALB name with a CNAME when an Alias is available. Enable deletion protection on anything production traffic depends on.',
      },
      {
        title: 'Safe migration order: expand, switch, verify, contract',
        body: 'Treat a load-balancer or DNS migration like a schema migration. Expand: build the new path alongside the old. Switch: move **every** name (inventory with `list-resource-record-sets`, search for the old DNS name). Verify: watch the **old** resource’s RequestCount fall to ~0 and stay there for longer than the longest TTL plus a few days of client behaviour. Contract: only then remove it — ideally in stages (detach/disable first as a "scream test", delete later).',
      },
    ],
    commands: [
      { cmd: 'dig api.shopfast.io', why: 'Full answer chain with TTLs and status — shows the CNAME and the NXDOMAIN' },
      { cmd: 'dig +short shopfast.io', why: 'Quick comparison with a name that works' },
      { cmd: 'dig @ns-1204.awsdns-22.org api.shopfast.io', why: 'Ask Route 53’s authoritative server directly, bypassing every cache' },
      { cmd: `aws route53 list-resource-record-sets --hosted-zone-id ${ZONE}`, why: 'Every record in the zone — find anything still pointing at the old LB' },
      { cmd: 'aws elbv2 describe-load-balancers', why: 'Which load balancers (and DNS names) actually exist' },
      { cmd: 'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteLoadBalancer', why: 'Who deleted which load balancer, and when' },
      { cmd: 'curl -v https://api.shopfast.io/health', why: 'The client’s view: fails at "Could not resolve host" before any connection' },
    ],
    prevention: [
      'Before deleting any load balancer, require its RequestCount to be ~0 for several days, and keep deletion protection on until then.',
      'Inventory DNS during migrations: search every hosted zone for the old DNS name and migrate all records in one reviewed change.',
      'Use Route 53 Alias records for AWS targets instead of CNAMEs to ELB names; manage DNS in Terraform alongside the ALB.',
      'Lower TTLs ahead of cutovers so changes and rollbacks propagate quickly.',
      'Run external synthetic checks per public hostname (api., www., apex) and alert on DNS failures, not only HTTP errors.',
    ],
    reading: [
      { title: 'Route 53: Choosing between alias and non-alias records', url: 'https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/resource-record-sets-choosing-alias-non-alias.html' },
      { title: 'RFC 2308: Negative Caching of DNS Queries (DNS NCACHE)', url: 'https://www.rfc-editor.org/rfc/rfc2308' },
      { title: 'Application Load Balancer deletion protection', url: 'https://docs.aws.amazon.com/elasticloadbalancing/latest/application/application-load-balancers.html#deletion-protection' },
    ],
  },
};

export default incident;
