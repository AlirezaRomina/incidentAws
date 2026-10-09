import type { Incident } from '../engine/types';
import { series } from '../engine/timeseries';
import { hex } from '../engine/rng';
import { MIN, iso, isoSec, nginxTime, syslogTime } from '../engine/time';
import { addPanel, ev, host, injectLog, logGroup, panel, setAlarm, setPoints, spread } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4231 — the production NAT gateway was deleted by an internal "cost-janitor"
 * Lambda. A Terraform module copied from staging left the tag env=staging on it,
 * and the janitor's idle check queried CloudWatch with the wrong dimension name
 * (NatGatewayID instead of NatGatewayId), got 0 datapoints and treated that as
 * "0 bytes in the last hour".
 */

const DEL = 47; // 14:33 — DeleteNatGateway
const RELEASE = 45.7; // ReleaseAddress of the NAT's EIP
const MARK = 1487; // yesterday 14:33 — janitor tagged the NAT janitor:idle-since
const JANITOR_DEPLOY = 1515; // yesterday 14:05 — cost-janitor 1.4.0
const TF_CHANGE = 19 * 1440 + 245; // 19 days ago — NAT moved into the vpc-egress module
const EIP_ALLOC = 'eipalloc-0a7d3c9e1b5f24680';
const NAT_IP = '34.198.77.140';
const JANITOR_ROLE = 'cost-janitor-lambda-role';
const JANITOR_ARN = `arn:aws:sts::${IDS.account}:assumed-role/${JANITOR_ROLE}/cost-janitor`;
const LAMBDA_IP = '3.83.201.47';

/** Destinations that leave the VPC via 0.0.0.0/0 (i.e. need the NAT gateway) when called from a private subnet. */
const NEEDS_NAT =
  /^(https?|tcp):\/\/([\w.-]*paybridge\.com|sqs\.|sts\.|ec2\.|elasticloadbalancing\.|rds\.us-east-1\.amazonaws|cloudtrail\.|iam\.amazonaws|route53\.amazonaws|lambda\.|events\.|autoscaling\.|(www\.)?google\.com|example\.com|registry\.npmjs\.org|shopfast\.statuspage\.io|status\.shopfast\.io|(api\.|www\.)?shopfast\.io|(dualstack\.)?shopfast-prod-alb|(?!10\.|127\.|169\.254\.)\d+\.\d+\.\d+\.\d+)/;

/** AWS services that have interface endpoints (or the S3 gateway endpoint) in this VPC. */
const ENDPOINT_SERVICES = ['s3', 's3api', 'logs', 'cloudwatch', 'ssm', 'secretsmanager', 'help', 'configure'];
const API_HOST: Record<string, string> = {
  sts: 'sts.us-east-1.amazonaws.com',
  ec2: 'ec2.us-east-1.amazonaws.com',
  sqs: 'sqs.us-east-1.amazonaws.com',
  elbv2: 'elasticloadbalancing.us-east-1.amazonaws.com',
  autoscaling: 'autoscaling.us-east-1.amazonaws.com',
  rds: 'rds.us-east-1.amazonaws.com',
  iam: 'iam.amazonaws.com',
  cloudtrail: 'cloudtrail.us-east-1.amazonaws.com',
  route53: 'route53.amazonaws.com',
  lambda: 'lambda.us-east-1.amazonaws.com',
  events: 'events.us-east-1.amazonaws.com',
  kms: 'kms.us-east-1.amazonaws.com',
};

const j = (v: unknown) => JSON.stringify(v, null, 4);

const incident: Incident = {
  id: 'nat-gateway-deleted',
  code: 'INC-4231',
  order: 8,
  title: 'Card payments time out, everything else works',
  teaser: 'Browsing, cart and login are fine. Every card payment hangs for 10 s and fails. PayBridge says they are green.',
  difficulty: 'advanced',
  tags: ['VPC', 'NAT gateway', 'Route tables', 'VPC endpoints', 'CloudTrail', 'Automation'],
  parMinutes: 20,
  seed: 4231,
  now: '2026-10-02T15:20:00Z',
  briefing: {
    severity: 'SEV1',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-alb-target-5xx-high — HTTPCode_Target_5XX_Count > 50',
      details: 'shopfast-prod-alb target 5XX count has been above 50/min for 3 consecutive datapoints (current 58). Runbook: https://wiki.shopfast.internal/runbooks/checkout-5xx',
      minutesAgo: 44,
    },
    reports: [
      { from: 'Jade Morales', role: 'Customer Support Lead', channel: '#incident-4231', message: 'Every card payment is failing since about 14:35 — customers see a spinner for ~10 seconds and then "We could not reach our payment provider". The couple of people who paid fully with gift cards got an order number but say the confirmation email never arrived. Password-reset emails are stuck too.', minutesAgo: 38 },
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-4231', message: "PayBridge status page is all green and I can hit api.paybridge.com from my laptop just fine. Our logs say connect timeout though. Did they block us? We haven't deployed checkout-api since yesterday.", minutesAgo: 31 },
      { from: 'Marta Kowalczyk', role: 'SRE (secondary on-call)', channel: '#incident-4231', message: "I ssh'd to app-1: DNS for api.paybridge.com resolves fine, the DB and Redis are fine, and invoice uploads to S3 are still working — so the network itself is OK? Terraform did touch the app security group an hour ago, maybe look at that.", minutesAgo: 22 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4231', message: "You're IC. We're losing roughly all card revenue right now. Find the cause; don't start re-architecting the network in the middle of this.", minutesAgo: 18 },
    ],
    impact: '~95% of checkouts fail after a 10 s wait (card payments). Order confirmation and password-reset emails are not being sent. Browsing, cart and login unaffected.',
    services: ['checkout-api', 'shopfast-worker (emails)', 'VPC networking', 'PayBridge (payment provider)'],
  },

  build(env, kit) {
    const rng = kit.rng;
    const at = (m: number) => env.now - Math.round(m * MIN);

    // ---------------- VPC: NAT deleted, default routes blackholed ----------------
    const nat = env.vpc.natGateways.find(n => n.id === IDS.natGw)!;
    nat.state = 'deleted';
    for (const rt of env.vpc.routeTables) {
      for (const r of rt.routes) if (r.target === IDS.natGw) r.state = 'blackhole';
    }

    // DNS: interface endpoints (private DNS) resolve to VPC addresses; everything else is public.
    Object.assign(env.route53.external, {
      'logs.us-east-1.amazonaws.com': ['10.0.10.61', '10.0.11.48'],
      'monitoring.us-east-1.amazonaws.com': ['10.0.10.77', '10.0.11.19'],
      'ssm.us-east-1.amazonaws.com': ['10.0.10.90', '10.0.11.112'],
      'ssmmessages.us-east-1.amazonaws.com': ['10.0.10.91', '10.0.11.113'],
      'ec2messages.us-east-1.amazonaws.com': ['10.0.10.92', '10.0.11.114'],
      'secretsmanager.us-east-1.amazonaws.com': ['10.0.10.58', '10.0.11.203'],
      'ec2.us-east-1.amazonaws.com': ['52.46.155.40'],
      'lambda.us-east-1.amazonaws.com': ['52.94.226.27'],
    });

    // Network behaviour from the private subnets (app hosts + worker). The bastion is in a
    // public subnet with its own public IP and goes out through the internet gateway.
    const privateHosts = ['app-1', 'app-2', 'app-3', 'worker-1'];
    env.http.unshift(
      { match: NEEDS_NAT, fromHosts: privateHosts, behaviour: 'timeout' },
      { match: /^https?:\/\/(logs|monitoring|ssm|ssmmessages|ec2messages|secretsmanager)\.us-east-1\.amazonaws\.com/, behaviour: 'ok', status: 404, headers: { 'Content-Type': 'application/x-amz-json-1.1', 'x-amzn-RequestId': '5b1e0c7a-3f2d-4e8a-9c41-7d2a6b0f9e13' }, body: '{"__type":"UnknownOperationException"}', timeMs: 3 },
      { match: /^https?:\/\/([\w-]+\.)?s3[.-][\w.-]*amazonaws\.com/, behaviour: 'ok', status: 403, headers: { 'Content-Type': 'application/xml', Server: 'AmazonS3' }, body: '<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', timeMs: 11 },
    );

    // AWS CLI on private hosts: only services with a VPC endpoint answer; the rest hang on connect.
    for (const h of privateHosts) {
      host(env, h).commandOverrides.push({
        match: new RegExp(`^aws\\s+(?!(${ENDPOINT_SERVICES.join('|')})\\b)[a-z0-9-]+\\b`),
        output: (cmd: string) => {
          const svc = cmd.trim().split(/\s+/)[1] ?? '';
          const endpoint = API_HOST[svc] ?? `${svc}.us-east-1.amazonaws.com`;
          return `\nConnect timeout on endpoint URL: "https://${endpoint}/"`;
        },
      });
    }

    // ---------------- AWS CLI answers (from the bastion) ----------------
    const natJson = j({
      NatGateways: [
        {
          CreateTime: nat.created,
          DeleteTime: isoSec(at(DEL - 1.2)),
          NatGatewayAddresses: [{ AllocationId: EIP_ALLOC, NetworkInterfaceId: 'eni-0e7f3a1c9b2d54086', PrivateIp: '10.0.0.183', PublicIp: NAT_IP, IsPrimary: true, Status: 'succeeded' }],
          NatGatewayId: IDS.natGw,
          State: 'deleted',
          SubnetId: IDS.subnets.publicA,
          VpcId: IDS.vpc,
          Tags: [
            { Key: 'Name', Value: 'shopfast-nat-a' },
            { Key: 'env', Value: 'staging' },
            { Key: 'module', Value: 'vpc-egress' },
            { Key: 'managed-by', Value: 'terraform' },
            { Key: 'janitor:idle-since', Value: '2026-10-01T14:33:05Z' },
          ],
          ConnectivityType: 'public',
        },
      ],
    });
    env.awsCli.unshift(
      { match: /aws ec2 describe-nat-gateways/, output: natJson },
      {
        match: /aws ec2 describe-vpc-endpoints/,
        output: j({
          VpcEndpoints: [
            { VpcEndpointId: 'vpce-0b1c2d3e4f5a6b7c8', VpcEndpointType: 'Gateway', VpcId: IDS.vpc, ServiceName: 'com.amazonaws.us-east-1.s3', State: 'available', RouteTableIds: [IDS.rtbPrivateA, IDS.rtbPrivateB], PrivateDnsEnabled: false },
            ...['logs', 'monitoring', 'ssm', 'ssmmessages', 'ec2messages', 'secretsmanager'].map((s, i) => ({
              VpcEndpointId: `vpce-0${(0x3a41c7 + i * 7919).toString(16)}e2b9d10${i}`,
              VpcEndpointType: 'Interface',
              VpcId: IDS.vpc,
              ServiceName: `com.amazonaws.us-east-1.${s}`,
              State: 'available',
              SubnetIds: [IDS.subnets.appA, IDS.subnets.appB],
              PrivateDnsEnabled: true,
            })),
          ],
        }),
      },
      {
        match: /aws ec2 describe-addresses/,
        output: j({ Addresses: [{ PublicIp: '54.163.22.91', AllocationId: 'eipalloc-04c2b9e7a1d3f5068', AssociationId: 'eipassoc-0b9d1e3f5a7c20461', Domain: 'vpc', InstanceId: hostMeta.bastion.id, PrivateIpAddress: '10.0.0.12', Tags: [{ Key: 'Name', Value: 'shopfast-bastion' }, { Key: 'env', Value: 'prod' }] }] }),
      },
      {
        match: /aws lambda (get-function|get-function-configuration)\b.*cost-janitor/,
        output: j({
          FunctionName: 'cost-janitor',
          FunctionArn: `arn:aws:lambda:us-east-1:${IDS.account}:function:cost-janitor`,
          Runtime: 'python3.12',
          Role: `arn:aws:iam::${IDS.account}:role/${JANITOR_ROLE}`,
          Handler: 'janitor.main.handler',
          Timeout: 300,
          MemorySize: 256,
          LastModified: iso(at(JANITOR_DEPLOY)).replace('Z', '+0000'),
          Version: '$LATEST',
          Description: 'Deletes idle resources tagged env=staging (owner: platform team)',
          Environment: { Variables: { JANITOR_VERSION: '1.4.0', SELECTOR_TAG_KEY: 'env', SELECTOR_TAG_VALUE: 'staging', DRY_RUN: 'false', GRACE_HOURS: '24', HANDLERS: 'ec2_instance,ebs_volume,eip,nat_gateway,rds_snapshot', SLACK_CHANNEL: '#platform-janitor' } },
          State: 'Active',
          LastUpdateStatus: 'Successful',
        }),
      },
      {
        match: /aws lambda list-functions/,
        output: j({
          Functions: [
            { FunctionName: 'cost-janitor', Runtime: 'python3.12', Role: `arn:aws:iam::${IDS.account}:role/${JANITOR_ROLE}`, LastModified: iso(at(JANITOR_DEPLOY)).replace('Z', '+0000'), Description: 'Deletes idle resources tagged env=staging (owner: platform team)' },
            { FunctionName: 'invoice-pdf-renderer', Runtime: 'nodejs20.x', Role: `arn:aws:iam::${IDS.account}:role/invoice-renderer-role`, LastModified: '2026-08-19T10:02:44.000+0000', Description: 'Renders invoice PDFs' },
          ],
        }),
      },
      {
        match: /aws events (list-rules|describe-rule)/,
        output: j({ Rules: [{ Name: 'cost-janitor-hourly', Arn: `arn:aws:events:us-east-1:${IDS.account}:rule/cost-janitor-hourly`, State: 'ENABLED', ScheduleExpression: 'cron(33 * * * ? *)', Description: 'Run cost-janitor every hour at :33' }] }),
      },
      {
        match: /aws sqs get-queue-attributes/,
        output: j({ Attributes: { QueueArn: `arn:aws:sqs:us-east-1:${IDS.account}:orders-prod`, ApproximateNumberOfMessages: '0', ApproximateNumberOfMessagesNotVisible: '0', ApproximateNumberOfMessagesDelayed: '0', LastModifiedTimestamp: '1717152034', VisibilityTimeout: '60' } }),
      },
    );

    // ---------------- IAM: the janitor's role ----------------
    env.iam.roles.push({
      name: JANITOR_ROLE,
      arn: `arn:aws:iam::${IDS.account}:role/${JANITOR_ROLE}`,
      description: 'Execution role for the cost-janitor Lambda (platform team)',
      lastModifiedMinutesAgo: JANITOR_DEPLOY + 1,
      trust: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] },
      policies: [
        {
          name: 'janitor-cleanup',
          type: 'inline',
          document: {
            Version: '2012-10-17',
            Statement: [
              { Sid: 'Discover', Effect: 'Allow', Action: ['ec2:Describe*', 'rds:Describe*', 'cloudwatch:GetMetricStatistics', 'tag:GetResources'], Resource: '*' },
              { Sid: 'MarkIdle', Effect: 'Allow', Action: ['ec2:CreateTags', 'ec2:DeleteTags'], Resource: '*', Condition: { 'ForAllValues:StringEquals': { 'aws:TagKeys': ['janitor:idle-since'] } } },
              { Sid: 'CleanupStaging', Effect: 'Allow', Action: ['ec2:TerminateInstances', 'ec2:DeleteVolume', 'ec2:DeleteNatGateway', 'ec2:ReleaseAddress', 'rds:DeleteDBSnapshot'], Resource: '*', Condition: { StringEquals: { 'aws:ResourceTag/env': 'staging' } } },
            ],
          },
        },
        { name: 'AWSLambdaBasicExecutionRole', type: 'aws-managed', arn: 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole', document: { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], Resource: '*' }] } },
      ],
    });

    // ---------------- CloudTrail ----------------
    const natRes = `arn:aws:ec2:us-east-1:${IDS.account}:natgateway/${IDS.natGw}`;
    env.cloudtrail.push(
      { minutesAgo: DEL - 0.06, eventName: 'DeleteNatGateway', eventSource: 'ec2.amazonaws.com', user: JANITOR_ARN, sourceIp: LAMBDA_IP, resources: natRes, request: { NatGatewayId: IDS.natGw } },
      { minutesAgo: DEL + 0.05, eventName: 'DescribeNatGateways', eventSource: 'ec2.amazonaws.com', user: JANITOR_ARN, sourceIp: LAMBDA_IP, resources: '-', request: { filter: [{ name: 'state', valueSet: [{ value: 'available' }] }] } },
      { minutesAgo: RELEASE, eventName: 'DisassociateAddress', eventSource: 'ec2.amazonaws.com', user: 'nat-gateway.amazonaws.com', sourceIp: 'nat-gateway.amazonaws.com', resources: EIP_ALLOC, request: { associationId: 'eipassoc-03f1d7a9c5e2b8460' } },
      { minutesAgo: RELEASE - 0.1, eventName: 'ReleaseAddress', eventSource: 'ec2.amazonaws.com', user: JANITOR_ARN, sourceIp: LAMBDA_IP, resources: `${EIP_ALLOC} (${NAT_IP})`, request: { allocationId: EIP_ALLOC } },
      { minutesAgo: MARK, eventName: 'CreateTags', eventSource: 'ec2.amazonaws.com', user: JANITOR_ARN, sourceIp: LAMBDA_IP, resources: IDS.natGw, request: { resourcesSet: { items: [{ resourceId: IDS.natGw }] }, tagSet: { items: [{ key: 'janitor:idle-since', value: '2026-10-01T14:33:05Z' }] } } },
      { minutesAgo: MARK - 0.02, eventName: 'CreateTags', eventSource: 'ec2.amazonaws.com', user: JANITOR_ARN, sourceIp: LAMBDA_IP, resources: EIP_ALLOC, request: { resourcesSet: { items: [{ resourceId: EIP_ALLOC }] }, tagSet: { items: [{ key: 'janitor:idle-since', value: '2026-10-01T14:33:05Z' }] } } },
      { minutesAgo: JANITOR_DEPLOY, eventName: 'UpdateFunctionCode20150331v2', eventSource: 'lambda.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'cost-janitor', request: { functionName: 'cost-janitor', s3Key: 'cost-janitor/1.4.0.zip' } },
      { minutesAgo: JANITOR_DEPLOY + 1, eventName: 'PutRolePolicy', eventSource: 'iam.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: JANITOR_ROLE, request: { roleName: JANITOR_ROLE, policyName: 'janitor-cleanup' } },
      { minutesAgo: 55, eventName: 'UpdateSecurityGroupRuleDescriptionsEgress', eventSource: 'ec2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: IDS.appSg, request: { groupId: IDS.appSg, ipPermissions: { items: [{ ipProtocol: '-1', ipRanges: { items: [{ cidrIp: '0.0.0.0/0', description: 'all egress (PayBridge, AWS APIs via NAT)' }] } }] } } },
      { minutesAgo: 82, eventName: 'UpdateWebACL', eventSource: 'wafv2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'shopfast-prod-waf', request: { name: 'shopfast-prod-waf', rules: [{ name: 'AWS-AWSManagedRulesKnownBadInputsRuleSet', overrideAction: { none: {} } }] } },
      { minutesAgo: 16, eventName: 'DescribeRouteTables', eventSource: 'ec2.amazonaws.com', user: 'sso/marta.kowalczyk', sourceIp: '203.0.113.48', resources: '-' },
    );
    // the base trail has an unrelated SG ingress change from terraform-ci 230 min ago — keep it

    // ---------------- Changes ----------------
    env.changes.unshift(
      {
        id: 'chg-8841',
        minutesAgo: 55,
        kind: 'infra',
        service: 'network',
        title: 'terraform: add descriptions to shopfast-app-sg egress rules',
        author: 'terraform-ci (PR #1219, tom.reyes)',
        status: 'succeeded',
        description: 'Audit follow-up (SEC-88): every SG rule needs a description. Plan: 0 to add, 1 to change, 0 to destroy. No functional change.',
        diff: `diff --git a/envs/prod/security_groups.tf b/envs/prod/security_groups.tf
--- a/envs/prod/security_groups.tf
+++ b/envs/prod/security_groups.tf
@@ -31,9 +31,10 @@ resource "aws_security_group" "app" {
   egress {
-    from_port   = 0
-    to_port     = 0
-    protocol    = "-1"
-    cidr_blocks = ["0.0.0.0/0"]
+    description = "all egress (PayBridge, AWS APIs via NAT)"
+    from_port   = 0
+    to_port     = 0
+    protocol    = "-1"
+    cidr_blocks = ["0.0.0.0/0"]
   }`,
      },
      {
        id: 'chg-8838',
        minutesAgo: 82,
        kind: 'config',
        service: 'edge',
        title: 'WAF: AWSManagedRulesKnownBadInputsRuleSet COUNT → BLOCK on shopfast-prod-alb',
        author: 'terraform-ci (PR #1217, tom.reyes)',
        status: 'succeeded',
        description: 'After 8 days in COUNT mode with 0 matches on /api/v1/checkout and 14 matches on obvious scanner traffic, switch KnownBadInputs to BLOCK. CommonRuleSet stays in COUNT.',
      },
      {
        id: 'chg-8829',
        minutesAgo: JANITOR_DEPLOY,
        kind: 'deploy',
        service: 'cost-janitor',
        title: 'cost-janitor 1.4.0 — clean up idle NAT gateways and unattached EIPs',
        author: 'ravi.menon',
        status: 'succeeded',
        version: '1.4.0',
        description: 'Platform cost initiative (FINOPS-31): idle staging NAT gateways cost ~$1.1k/month. New handlers: nat_gateway (idle = 0 bytes out in the last hour, deleted after a 24 h grace period) and eip (releases EIPs left behind). Dry-run in the shared account Sep 28 – Oct 1: "would mark 1 NAT gateway, 2 EIPs" — approved in #platform. Unit tests mock CloudWatch.',
        diff: `diff --git a/janitor/handlers/nat_gateway.py b/janitor/handlers/nat_gateway.py
new file mode 100644
--- /dev/null
+++ b/janitor/handlers/nat_gateway.py
@@ -0,0 +1,36 @@
+"""Delete NAT gateways matching the selector that moved no traffic for GRACE_HOURS."""
+from datetime import datetime, timedelta, timezone
+
+from janitor.aws import cloudwatch, ec2
+from janitor.selector import matches_selector
+from janitor.handlers.eip import release_after_nat_delete
+
+
+def bytes_out_last_hour(nat_id: str) -> float:
+    now = datetime.now(timezone.utc)
+    resp = cloudwatch.get_metric_statistics(
+        Namespace="AWS/NATGateway",
+        MetricName="BytesOutToDestination",
+        Dimensions=[{"Name": "NatGatewayID", "Value": nat_id}],
+        StartTime=now - timedelta(hours=1),
+        EndTime=now,
+        Period=3600,
+        Statistics=["Sum"],
+    )
+    # no datapoints means no traffic
+    return sum(dp["Sum"] for dp in resp["Datapoints"])
+
+
+def candidates():
+    resp = ec2.describe_nat_gateways(Filters=[{"Name": "state", "Values": ["available"]}])
+    return [n for n in resp["NatGateways"] if matches_selector(n.get("Tags", []))]
+
+
+def is_idle(nat) -> bool:
+    return bytes_out_last_hour(nat["NatGatewayId"]) == 0
+
+
+def delete(nat) -> None:
+    ec2.delete_nat_gateway(NatGatewayId=nat["NatGatewayId"])
+    release_after_nat_delete(nat)
diff --git a/janitor/config.py b/janitor/config.py
--- a/janitor/config.py
+++ b/janitor/config.py
@@ -4,5 +4,5 @@ SELECTOR = {"env": "staging"}
 GRACE_HOURS = int(os.environ.get("GRACE_HOURS", "24"))
 DRY_RUN = os.environ.get("DRY_RUN", "false") == "true"
-HANDLERS = ["ec2_instance", "ebs_volume", "rds_snapshot"]
+HANDLERS = ["ec2_instance", "ebs_volume", "eip", "nat_gateway", "rds_snapshot"]`,
      },
      {
        id: 'chg-8702',
        minutesAgo: TF_CHANGE,
        kind: 'infra',
        service: 'network',
        title: 'terraform: move prod NAT gateway into the shared vpc-egress module',
        author: 'terraform-ci (PR #1104, tom.reyes)',
        status: 'succeeded',
        description: 'De-duplicate network code: prod now uses modules/vpc-egress (copied from envs/staging, where it has been running for months). `moved` blocks keep the existing NAT gateway and EIP — no replacement. Plan: 0 to add, 3 to change, 0 to destroy (tag updates only).',
        diff: `diff --git a/envs/prod/network.tf b/envs/prod/network.tf
--- a/envs/prod/network.tf
+++ b/envs/prod/network.tf
@@ -40,24 +40,16 @@
-resource "aws_eip" "nat_a" {
-  domain = "vpc"
-  tags   = { Name = "shopfast-nat-a", env = "prod" }
-}
-
-resource "aws_nat_gateway" "a" {
-  allocation_id = aws_eip.nat_a.id
-  subnet_id     = aws_subnet.public_a.id
-  tags          = { Name = "shopfast-nat-a", env = "prod" }
-}
+module "egress" {
+  source = "../../modules/vpc-egress"
+
+  name                    = "shopfast-nat-a"
+  public_subnet_id        = aws_subnet.public_a.id
+  private_route_table_ids = [aws_route_table.private_a.id, aws_route_table.private_b.id]
+}
+
+moved {
+  from = aws_nat_gateway.a
+  to   = module.egress.aws_nat_gateway.this
+}
diff --git a/modules/vpc-egress/variables.tf b/modules/vpc-egress/variables.tf
new file mode 100644
--- /dev/null
+++ b/modules/vpc-egress/variables.tf
@@ -0,0 +1,14 @@
+variable "name" { type = string }
+variable "public_subnet_id" { type = string }
+variable "private_route_table_ids" { type = list(string) }
+
+variable "tags" {
+  type = map(string)
+  default = {
+    env    = "staging"
+    module = "vpc-egress"
+  }
+}`,
      },
    );

    // ---------------- Lambda logs: /aws/lambda/cost-janitor ----------------
    const lg = logGroup(env, '/aws/lambda/cost-janitor', 'cost-janitor Lambda (python3.12) — hourly cleanup of idle env=staging resources', 30);
    const uuid = () => `${hex(rng, 8)}-${hex(rng, 4)}-4${hex(rng, 3)}-${['8', '9', 'a', 'b'][Math.floor(rng() * 4)]}${hex(rng, 3)}-${hex(rng, 12)}`;
    const stream = (m: number) => `${new Date(at(m)).toISOString().slice(0, 10).replace(/-/g, '/')}/[$LATEST]${hex(rng, 32)}`;
    let streamName = stream(1700);
    const markIso = '2026-10-01T14:33:05Z';
    for (let m = DEL + 60 * 27; m >= DEL; m -= 60) {
      const rid = uuid();
      const v14 = m <= JANITOR_DEPLOY;
      if (m === JANITOR_DEPLOY - 28 || m === DEL + 60 * 27) streamName = stream(m); // new execution environment after the deploy
      const t0 = m - 0.004;
      const line = (dt: number, level: string, msg: string) => ev(env, t0 - dt / 60, `[${level}]\t${iso(at(t0 - dt / 60))}\t${rid}\t${msg}`, streamName);
      const events = [];
      if (m === JANITOR_DEPLOY - 28 || m === DEL + 60 * 27) events.push(ev(env, t0 + 0.012, `INIT_START Runtime Version: python:3.12.v38\tRuntime Version ARN: arn:aws:lambda:us-east-1::runtime:7b620fc2e66107a1046b140b9d320295811af3ad5d4c6a011fad1fa65127e9e6`, streamName));
      events.push(ev(env, t0, `START RequestId: ${rid} Version: $LATEST`, streamName));
      events.push(line(0.2, 'INFO', `cost-janitor ${v14 ? '1.4.0' : '1.3.2'} run started account=${IDS.account} region=us-east-1 selector=env=staging dry_run=false grace=24h handlers=${v14 ? 'ec2_instance,ebs_volume,eip,nat_gateway,rds_snapshot' : 'ec2_instance,ebs_volume,rds_snapshot'}`));
      events.push(line(1.1, 'INFO', `ec2_instance: 2 candidate(s), 0 idle`));
      events.push(line(1.6, 'INFO', `ebs_volume: 1 candidate(s): vol-0c4e81a2b7d3f9150 (staging-es-data-old) attached=no idle-since=2026-09-29T09:33:02Z -> skip: final snapshot snap-0d92e4b1a7c3f6058 still pending`));
      if (v14) {
        const sinceMark = MARK - m; // minutes since the NAT was marked
        events.push(line(2.2, 'INFO', `nat_gateway: 1 candidate(s): ${IDS.natGw}`));
        events.push(line(2.9, 'INFO', `nat_gateway ${IDS.natGw}: GetMetricStatistics AWS/NATGateway BytesOutToDestination dims=[NatGatewayID=${IDS.natGw}] period=3600 stat=Sum -> 0 datapoints; bytes_out_1h=0`));
        if (m === MARK) {
          events.push(line(3.1, 'INFO', `nat_gateway ${IDS.natGw}: idle (bytes_out_1h=0) -> CreateTags janitor:idle-since=${markIso}`));
        } else if (m > DEL) {
          const h = Math.floor(sinceMark / 60);
          events.push(line(3.1, 'INFO', `nat_gateway ${IDS.natGw}: idle since ${markIso} (${h}h00m < grace 24h) -> keep`));
        } else {
          events.push(line(3.1, 'WARNING', `nat_gateway ${IDS.natGw}: idle since ${markIso} (24h00m >= grace 24h) tags={'Name': 'shopfast-nat-a', 'env': 'staging', 'module': 'vpc-egress', 'managed-by': 'terraform', 'janitor:idle-since': '${markIso}'} -> DeleteNatGateway`));
          events.push(line(3.6, 'INFO', `nat_gateway ${IDS.natGw}: DeleteNatGateway accepted, state=deleting; waiting for 'deleted' before releasing ${EIP_ALLOC}`));
        }
        if (m === DEL) {
          events.push(line(78.2, 'INFO', `nat_gateway ${IDS.natGw}: state=deleted after 74.6s`));
          events.push(line(78.9, 'INFO', `eip: ${EIP_ALLOC} (${NAT_IP}) association=none tags={'Name': 'shopfast-nat-a', 'env': 'staging', 'module': 'vpc-egress'} -> ReleaseAddress`));
          events.push(line(79.4, 'INFO', `run finished: deleted=2 (nat_gateway=1, eip=1) marked=0 pending=1 dry_run=false`));
          events.push(line(79.5, 'INFO', `slack: posted summary to #platform-janitor (2 deletions)`));
        } else {
          events.push(line(3.4, 'INFO', `eip: ${m === MARK ? `1 candidate(s): ${EIP_ALLOC} (${NAT_IP}) association=${IDS.natGw} -> follows its NAT gateway: CreateTags janitor:idle-since=${markIso}` : `1 candidate(s): ${EIP_ALLOC} (${NAT_IP}) associated with ${IDS.natGw} -> follows its NAT gateway`}`));
          events.push(line(3.9, 'INFO', `run finished: deleted=0 marked=${m === MARK ? 2 : 0} pending=3 dry_run=false`));
        }
      } else {
        events.push(line(2.1, 'INFO', 'run finished: deleted=0 marked=0 pending=1 dry_run=false'));
      }
      const dur = m === DEL ? 79612.48 : v14 ? 4012.31 + ((m * 37) % 900) : 2210.12 + ((m * 13) % 400);
      const endM = t0 - dur / 60000;
      events.push(ev(env, endM, `END RequestId: ${rid}`, streamName));
      events.push(ev(env, endM - 0.0005, `REPORT RequestId: ${rid}\tDuration: ${dur.toFixed(2)} ms\tBilled Duration: ${Math.ceil(dur)} ms\tMemory Size: 256 MB\tMax Memory Used: ${v14 ? 97 : 88} MB${m === JANITOR_DEPLOY - 28 || m === DEL + 60 * 27 ? '\tInit Duration: 512.77 ms' : ''}`, streamName));
      lg.events.push(...events);
    }

    // ---------------- Application logs ----------------
    const apiHosts = [...APP_HOSTS];
    const clientIps = ['10.0.0.71', '10.0.1.163', '10.0.0.204', '10.0.1.38'];
    const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
    for (const [i, h] of apiHosts.entries()) {
      const meta = hostMeta[h];
      const pid = host(env, h).services['checkout-api'].mainPid!;
      const n = 54;
      const app = spread(env, DEL - 0.6, 0.3, n, (k, ts) => {
        const reqId = `req-${(0x51c200 + k * 1031 + i * 97).toString(16)}`;
        const order = `ord_${(0x4e1a0f3b2c + k * 7919 + i * 104729).toString(16).slice(-12)}`;
        return JSON.stringify({
          level: 50,
          time: iso(ts),
          pid,
          hostname: meta.hostname,
          reqId,
          provider: 'paybridge',
          op: 'charges.create',
          orderId: order,
          attempt: 1,
          err: {
            type: 'ConnectTimeoutError',
            message: 'Connect Timeout Error (attempted address: api.paybridge.com:443, timeout: 10000ms)',
            stack: 'ConnectTimeoutError: Connect Timeout Error (attempted address: api.paybridge.com:443, timeout: 10000ms)\n    at onConnectTimeout (/opt/checkout-api/node_modules/undici/lib/core/connect.js:237:24)\n    at Immediate._onImmediate (/opt/checkout-api/node_modules/undici/lib/core/connect.js:206:11)\n    at process.processImmediate (node:internal/timers:483:21)',
            code: 'UND_ERR_CONNECT_TIMEOUT',
            name: 'ConnectTimeoutError',
          },
          msg: 'payment provider request failed',
        });
      });
      const resp = app.map(e => {
        const o = JSON.parse(e.msg);
        const ms = 10004 + ((e.ts / 7) % 40);
        return {
          ts: e.ts + 6,
          msg: JSON.stringify({ level: 50, time: iso(e.ts + 6), pid, hostname: meta.hostname, reqId: o.reqId, req: { method: 'POST', url: '/api/v1/checkout' }, res: { statusCode: 502 }, err: { type: 'PaymentProviderUnavailableError', message: 'We could not reach our payment provider' }, responseTime: Math.round(ms * 10) / 10, msg: 'request errored' }),
        };
      });
      // a few gift-card orders still go through, but the confirmation can't be queued
      const outbox = spread(env, DEL - 3, 2, 5, (k, ts) =>
        JSON.stringify({ level: 40, time: iso(ts), pid, hostname: meta.hostname, reqId: `req-${(0x61f000 + k * 211 + i * 7).toString(16)}`, queue: 'orders-prod', orderId: `ord_${(0x7a2c91d0e4 + k * 4099 + i * 31).toString(16).slice(-12)}`, err: { type: 'TimeoutError', message: 'Connection timed out after 3000 ms', name: 'TimeoutError' }, msg: 'orders queue publish failed, stored in outbox for retry' }),
      );
      injectLog(env, h, '/var/log/checkout-api/app.log', [...app, ...resp, ...outbox]);
      injectLog(
        env,
        h,
        '/var/log/nginx/access.log',
        app.map(e => {
          const ts = e.ts + 7;
          const rt = (10.006 + ((e.ts / 11) % 40) / 1000).toFixed(3);
          return { ts, msg: `${clientIps[Math.floor(ts / 1000) % 4]} - - [${nginxTime(ts)}] "POST /api/v1/checkout HTTP/1.1" 502 96 "-" "${UA}" rt=${rt} uct=0.000 urt=${rt} rid=${hex(rng, 32)}` };
        }),
      );
    }

    // worker: SQS long-polls fail too (no interface endpoint for SQS in this VPC)
    const worker = host(env, 'worker-1');
    worker.services['shopfast-worker'].journal.push(
      `${syslogTime(at(DEL + 30))} ${hostMeta['worker-1'].hostname} node[3120]: {"level":30,"msg":"batch processed","queue":"orders-prod","received":7,"deleted":7}`,
      `${syslogTime(at(DEL + 2))} ${hostMeta['worker-1'].hostname} node[3120]: {"level":30,"msg":"batch processed","queue":"orders-prod","received":4,"deleted":4}`,
      ...Array.from({ length: 9 }, (_, k) => {
        const m = DEL - 0.4 - k * 5.1;
        return `${syslogTime(at(m))} ${hostMeta['worker-1'].hostname} node[3120]: {"level":50,"msg":"ReceiveMessage failed, backing off","queue":"orders-prod","err":{"name":"TimeoutError","message":"Connection timed out after 3000 ms"},"backoffMs":${Math.min(30000, 1000 * 2 ** Math.min(k, 5))}}`;
      }),
    );
    injectLog(env, 'worker-1', '/var/log/messages', worker.services['shopfast-worker'].journal.slice(-9).map((l, k) => ev(env, DEL - 0.4 - k * 5.1, l)));

    // ---------------- Metrics ----------------
    setPoints(env, 'alb.target5xx', series('n5xx', 1.4, { noise: 0.8 }).rampTo(DEL - 1, 57, 2).setNoise(0.08).clamp(0).round(0).build());
    setPoints(env, 'alb.latency', series('nlat', 0.41, { noise: 0.1 }).wave(0.05).rampTo(DEL - 1, 10.08, 2).setNoise(0.004).clamp(0).round(3).build());
    setPoints(env, 'app.checkoutLatency', series('nchk', 380, { noise: 0.1 }).rampTo(DEL - 1, 10040, 2).setNoise(0.003).clamp(0).round(0).build());
    setPoints(env, 'app.paymentErrors', series('npay', 0.3, { noise: 1 }).rampTo(DEL - 1, 56, 2).setNoise(0.08).clamp(0).round(0).build());
    setPoints(env, 'app.orders', series('nord', 61, { noise: 0.15 }).rampTo(DEL, 3, 2).setNoise(0.5).clamp(0).round(0).build());
    setPoints(env, 'nat.active', series('nact', 412, { noise: 0.1 }).stepTo(DEL, 0).clamp(0).round(0).build());
    setPoints(env, 'nat.bytesOut', series('nbytes', 38, { noise: 0.15 }).stepTo(DEL, 0).clamp(0).round(1).build());
    panel(env, 'nat.active').featured = true;
    panel(env, 'app.paymentErrors').featured = true;
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', series(`ncpu-${h}`, 18 + i * 1.5, { noise: 0.1 }).wave(0.06).rampTo(DEL, 13 + i, 3).clamp(0, 100).build(), h);
    }
    addPanel(env, {
      id: 'sqs.sent',
      group: 'SQS',
      namespace: 'AWS/SQS',
      metric: 'NumberOfMessagesSent',
      resource: 'orders-prod',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      featured: true,
      series: [{ name: 'orders-prod', points: series('nsqs', 64, { noise: 0.15 }).stepTo(DEL, 0).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'lambda.janitor',
      group: 'Lambda',
      namespace: 'AWS/Lambda',
      metric: 'Invocations',
      resource: 'cost-janitor',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      series: [{ name: 'cost-janitor', points: series('njan', 0, { noise: 0 }).map((v, m) => (Math.round(m) % 60 === DEL ? 1 : v)).round(0).build() }],
    });

    setAlarm(env, 'checkout-alb-target-5xx-high', 'ALARM', 44);
    setAlarm(env, 'checkout-alb-p99-latency-high', 'ALARM', 43);
    setAlarm(env, 'checkout-latency-p99-high', 'ALARM', 43);

    // traffic: browsing is unaffected; a little less load overall because checkouts fail fast-ish
    env.traffic.profile = (_h, m) => (m <= DEL ? { rpm: 6 } : {});
  },

  evidence: [
    {
      id: 'connect-timeout',
      label: 'checkout-api cannot even open a TCP connection to api.paybridge.com:443 (undici ConnectTimeoutError)',
      kind: 'key',
      match: /UND_ERR_CONNECT_TIMEOUT|Connect Timeout Error \(attempted address: api\.paybridge\.com|Failed to connect to api\.paybridge\.com port 443/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'A connect timeout (not a TLS error, not an HTTP 5xx) means the SYN never got an answer: the packets are not getting out, or the replies are not getting back. That points at the network path, not at PayBridge.',
    },
    {
      id: 'blackhole-route',
      label: 'Both private route tables send 0.0.0.0/0 to nat-0f3c2a91b8e7d6540, which is now a blackhole',
      kind: 'key',
      match: /0\.0\.0\.0\/0 → nat-0f3c2a91b8e7d6540 \(blackhole\)|"State": "blackhole"/,
      foundBy: { tool: 'vpc' },
      explanation: 'A route whose target no longer exists stays in the table with state "blackhole": packets matching it are silently dropped. Every internet-bound packet from the app and worker subnets is discarded at the VPC router.',
    },
    {
      id: 'delete-nat',
      label: 'CloudTrail: DeleteNatGateway at 14:33 by assumed-role/cost-janitor-lambda-role',
      kind: 'key',
      match: /DeleteNatGateway/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'Nobody "broke the network" by hand: the NAT gateway was deleted by the platform team\'s cost-janitor Lambda, which also released its Elastic IP a minute later.',
    },
    {
      id: 'staging-tag',
      label: 'The production NAT gateway carried the tag env=staging (vpc-egress module default)',
      kind: 'key',
      match: /'env': 'staging'|env\s+=\s+"staging"|"Key": "env",\s*"Value": "staging"/,
      foundBy: { tool: 'deploys' },
      explanation: 'The janitor only touches env=staging resources — and the prod NAT had that tag since PR #1104 moved it into a module copied from staging whose default tags say env = "staging". The plan showed it as a harmless "tag update".',
    },
    {
      id: 'nat-metrics',
      label: 'NAT gateway connections and bytes dropped to zero at 14:33',
      kind: 'supporting',
      match: /ActiveConnectionCount \[nat-0f3c2a91b8e7d6540\]|BytesOutToDestination \[nat-0f3c2a91b8e7d6540\]|NAT gateway nat-0f3c2a91b8e7d6540 \(shopfast-nat-a\)[^\n]* is deleted/,
      foundBy: { tool: 'cloudwatch', panel: 'nat.active' },
      explanation: 'The NAT gateway was carrying ~400 connections and ~38 MB/min right up to 14:33 — it was anything but idle. The janitor saw "0 bytes" only because it asked CloudWatch for the dimension NatGatewayID (wrong case) and treated "no datapoints" as zero.',
    },
    {
      id: 'bastion-ok',
      label: 'From the bastion (public subnet) PayBridge answers normally',
      kind: 'supporting',
      match: /"status":"operational"/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'curl -s https://api.paybridge.com/v2/health' },
      explanation: 'Same VPC, same destination, different result: the bastion egresses through the internet gateway with its own public IP. That isolates the problem to the private subnets\' egress path.',
    },
    {
      id: 'sqs-timeouts',
      label: 'SQS publishes (order confirmation emails) time out too',
      kind: 'supporting',
      match: /orders queue publish failed|ReceiveMessage failed/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'A second, unrelated internet destination (sqs.us-east-1.amazonaws.com — no VPC endpoint) fails the same way. Two providers failing at the same minute means the common path is broken.',
    },
    {
      id: 'sg-descriptions',
      label: 'Terraform updated the app security group egress rule 55 minutes ago',
      kind: 'red-herring',
      match: /UpdateSecurityGroupRuleDescriptionsEgress|add descriptions to shopfast-app-sg/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'Only the rule description changed; egress is still all traffic to 0.0.0.0/0. And security groups are stateful allow-lists — a broken SG would also break S3 and the endpoints, which still work.',
    },
    {
      id: 'waf-block',
      label: 'WAF KnownBadInputs rule switched to BLOCK at 13:58',
      kind: 'red-herring',
      match: /KnownBadInputs/,
      foundBy: { tool: 'deploys' },
      explanation: 'WAF filters inbound requests at the ALB and answers with 403. The failing checkouts reach the app (they are in its logs) and fail after exactly 10 s with 502 — an outbound connect timeout. It also started 35 minutes before the errors.',
    },
  ],

  rootCauses: [
    { id: 'rc-janitor', correct: true, text: 'The cost-janitor Lambda deleted NAT nat-0f3c2a91b8e7d6540: a copied Terraform module tagged it env=staging and a mis-dimensioned metric query made it look idle. Private 0.0.0.0/0 routes now blackhole.', explanation: 'Explains every observation: only internet-bound traffic from private subnets fails (PayBridge, SQS), while VPC-internal traffic, DNS, S3 (gateway endpoint) and the interface endpoints keep working, and the bastion — which uses the internet gateway — is fine.' },
    { id: 'rc-nat-gone', partial: true, text: 'NAT gateway nat-0f3c2a91b8e7d6540 is gone and 0.0.0.0/0 in rtb-0b2e3f4a5c6d7e819 and rtb-0c3f4a5b6d7e8f920 is in blackhole state, so the app and worker subnets have no internet egress.', explanation: 'That is the mechanism, but not the cause. Without knowing that an automated janitor did it because of a wrong tag, you would recreate the NAT with the same Terraform module — same env=staging tag — and the janitor would delete it again 24 hours later.' },
    { id: 'rc-paybridge', text: 'PayBridge started rate-limiting NAT IP 34.198.77.140 after a burst of declined charges and silently drops its SYNs, so undici hits its 10 s connect timeout on api.paybridge.com:443.', explanation: 'PayBridge answers from the bastion and from engineers\' laptops. A provider block would usually be a TCP reset or HTTP 403/429, not a connect timeout — and it would not explain SQS failing at the same minute. (That IP has in fact been released.)' },
    { id: 'rc-sg', text: 'Terraform PR #1219 replaced the shopfast-app-sg egress rule; the rule for 0.0.0.0/0 was lost during the replace, so the stateful SG now drops outbound SYNs from app-1..3.', explanation: 'The change only added a description; the egress rule is still -1 to 0.0.0.0/0 (check the SG). A security group problem would also break S3, Secrets Manager and CloudWatch Logs, which still work.' },
    { id: 'rc-dns', text: 'The VPC resolver at 10.0.0.2 serves stale A records for api.paybridge.com after a PayBridge IP migration, so undici keeps connecting to a decommissioned 104.18.32.7 and times out.', explanation: 'The bastion uses the same resolver, gets the same 104.18.32.7 and connects fine. DNS is not the problem — the packets to a valid address are not getting out of the private subnets.' },
    { id: 'rc-waf', text: 'WAF rule set KnownBadInputs, switched to BLOCK at 13:58 (PR #1217), matches the card-token payload of POST /api/v1/checkout and drops those requests at shopfast-prod-alb.', explanation: 'WAF acts at the ALB on inbound requests and returns 403. These requests reach checkout-api (they are in its logs) and fail with a 10 s outbound connect timeout and HTTP 502.' },
  ],

  fixes: [
    { id: 'fx-new-nat', kind: 'correct', text: 'Allocate a new EIP, create a NAT gateway in shopfast-public-a and replace-route 0.0.0.0/0 in both private route tables to point at it.', explanation: 'Restores egress in ~2 minutes, the time it takes a NAT gateway to become available. Deleted NAT gateways cannot be undeleted. Note the public egress IP changes — check whether any partner allowlists the old one (PayBridge authenticates by API key, so it does not).' },
    { id: 'fx-guardrails', kind: 'correct', text: 'Disable the cost-janitor schedule, set env=prod (no defaults) in the vpc-egress module, and add an SCP deny on deletes for env=prod or untagged resources.', explanation: 'Stops a repeat. Tag-based ABAC is only as good as the tags: the IAM condition aws:ResourceTag/env = staging was satisfied because the tag was wrong. Also protect the env tag itself, run new destructive handlers in dry-run with owner review, and treat "no datapoints" as unknown, not zero.' },
    { id: 'fx-terraform-apply', kind: 'partial', text: 'Re-run terraform apply on envs/prod/network so Terraform recreates module.egress\'s NAT gateway, EIP and default routes from state.', explanation: 'It does restore egress — but with the module\'s default tags, env=staging. Unless the janitor is stopped first, it will mark the new NAT within the hour and delete it again tomorrow at 14:33.' },
    { id: 'fx-nat-per-az', kind: 'partial', text: 'Add a second NAT gateway in shopfast-public-b for rtb-0c3f4a5b6d7e8f920 and alarm on blackhole routes and on NAT BytesOutToDestination = 0.', explanation: 'Good hardening: removes the single-AZ single point of failure and pages within minutes next time. It would not have prevented this incident — both NAT gateways would have carried the same wrong tag.' },
    { id: 'fx-public-ip', kind: 'harmful', text: 'Associate Elastic IPs with app-1..3 and move them into shopfast-public-a/b so checkout-api reaches PayBridge via igw-0d4a5b6c7e8f9a031.', explanation: 'Exposes the application tier directly to the internet, breaks the ASG/launch template network design, and takes longer than replacing the NAT. Never trade a network outage for a security incident.' },
    { id: 'fx-open-sg', kind: 'harmful', text: 'Open shopfast-app-sg to 0.0.0.0/0 on all ports inbound and outbound to rule out the security group as the source of the dropped SYNs.', explanation: 'Egress is already open; opening inbound to the world adds risk and fixes nothing. Security groups are not the problem when the route table has nowhere to send the packets.' },
    { id: 'fx-restart', kind: 'neutral', text: 'Rolling-restart checkout-api on app-1..3 to drop undici\'s pooled sockets to api.paybridge.com and force fresh DNS lookups and connections.', explanation: 'The application is healthy; the network path is gone. (It is only harmless because Secrets Manager has an interface endpoint — without it, restarted hosts could not fetch the DB password and would fail to start.)' },
    { id: 'fx-timeout', kind: 'neutral', text: 'Raise PAYBRIDGE_TIMEOUT_MS from 10000 to 30000 in /etc/checkout-api/env so slow TCP handshakes to api.paybridge.com can complete.', explanation: 'Nothing is slow — the SYN packets are dropped. A longer timeout just makes every customer wait 30 s instead of 10 s before seeing the same error, and holds more connections open.' },
  ],

  hints: [
    'Map what works and what doesn\'t: from where (bastion vs. app hosts) and to where (VPC-internal, DNS, S3, PayBridge, SQS). What is on the path from a private subnet to the internet that is not on the bastion\'s path?',
    'Open the VPC console: look at the route tables of the private subnets and at the NAT gateway they point to. Then ask CloudTrail who changed it, and when.',
    'The NAT gateway was deleted at 14:33 by the cost-janitor Lambda\'s role. Read /aws/lambda/cost-janitor and the infra changes for why it believed a production NAT gateway was an idle staging resource.',
  ],

  debrief: {
    summary: `At **14:33** the platform team's **cost-janitor** Lambda deleted the production NAT gateway \`nat-0f3c2a91b8e7d6540\` and, a minute later, released its Elastic IP. The janitor only deletes resources tagged \`env=staging\` — and the prod NAT had exactly that tag. Nineteen days earlier, PR #1104 moved the NAT into a \`vpc-egress\` Terraform module copied from staging; the module's default \`tags\` variable was \`{ env = "staging" }\` and prod did not override it. The plan showed "3 to change (tags)", which looked harmless.

Why did it look *idle*? cost-janitor 1.4.0 (deployed yesterday) added a NAT handler that asked CloudWatch for \`BytesOutToDestination\` with the dimension **\`NatGatewayID\`**. The real dimension is \`NatGatewayId\` — dimension names are case-sensitive, so CloudWatch returned **zero datapoints**, and the code treated "no data" as "0 bytes". It tagged the NAT \`janitor:idle-since\` yesterday at 14:33 and deleted it after the 24 h grace period. Its IAM policy even had a tag condition (\`aws:ResourceTag/env = staging\`) — which the wrong tag satisfied.

With the NAT gone, both private route tables kept \`0.0.0.0/0 → nat-0f3c…\` in state **blackhole**: every internet-bound packet from the app and worker subnets is dropped. That is why card payments (api.paybridge.com) failed with undici's \`ConnectTimeoutError\` after 10 s, and SQS publishes (order emails) timed out. Everything that does *not* use the default route kept working, which made the network look fine: VPC-internal traffic (RDS, Redis), DNS (the Route 53 Resolver lives inside the VPC), S3 (gateway endpoint route via the prefix list) and CloudWatch Logs / Secrets Manager (interface endpoints). The bastion lives in a public subnet and egresses through the internet gateway, so PayBridge worked from there.

The security-group description change and the WAF switch to BLOCK were real changes close in time, but neither touches outbound traffic from private subnets.`,
    timeline: [
      { minutesAgo: TF_CHANGE, event: 'PR #1104: prod NAT moved into the vpc-egress module; tag env changes prod → staging ("tag update only")' },
      { minutesAgo: JANITOR_DEPLOY, event: 'cost-janitor 1.4.0 deployed: new nat_gateway and eip handlers' },
      { minutesAgo: MARK, event: 'Janitor finds 0 datapoints (wrong dimension) and tags the prod NAT janitor:idle-since' },
      { minutesAgo: 82, event: 'WAF KnownBadInputs → BLOCK (red herring)' },
      { minutesAgo: 55, event: 'Terraform adds descriptions to app SG rules (red herring)' },
      { minutesAgo: DEL, event: 'Janitor: grace period over → DeleteNatGateway; private routes become blackhole' },
      { minutesAgo: RELEASE, event: 'Janitor releases the NAT\'s Elastic IP 34.198.77.140' },
      { minutesAgo: 44, event: 'checkout-alb-target-5xx-high pages on-call' },
    ],
    concepts: [
      { title: 'How private subnets reach the internet', body: 'A private subnet has no route to the internet gateway. Its route table sends `0.0.0.0/0` to a **NAT gateway** that lives in a *public* subnet; the NAT rewrites the source address to its Elastic IP and forwards via the IGW. Remove the NAT and the route has nowhere to go. AWS keeps the route but marks it **blackhole** — packets matching it are dropped silently, so clients see connect timeouts, not errors. `aws ec2 describe-route-tables --filters Name=route.state,Values=blackhole` finds them.' },
      { title: 'Why DNS, S3 and the DB kept working', body: 'Routing uses the **longest prefix match**. `10.0.0.0/16 → local` covers RDS and Redis. DNS goes to the **Route 53 Resolver** at VPC base + 2 (10.0.0.2), which is inside the VPC. S3 has a **gateway endpoint**: a route to the S3 prefix list (`pl-63a5400a`) that is more specific than 0.0.0.0/0. CloudWatch Logs, SSM and Secrets Manager have **interface endpoints** (ENIs with private IPs; private DNS makes `logs.us-east-1.amazonaws.com` resolve to 10.0.x.x). SQS had no endpoint, so it — like PayBridge — needed the NAT. "DNS works and S3 works" is not proof that egress works.' },
      { title: 'Gateway vs. interface VPC endpoints', body: '**Gateway endpoints** (S3, DynamoDB only) are free route-table entries pointing at a prefix list. **Interface endpoints** (PrivateLink, most other services) are ENIs in your subnets, cost per hour + per GB, and work via private DNS. Adding endpoints for the AWS APIs you depend on (SQS, STS, Secrets Manager…) removes the NAT from those paths — cheaper per GB and one less dependency.' },
      { title: 'Single NAT gateway = single point of failure', body: 'NAT gateways are redundant *within* one AZ, but a single NAT serving both AZs is a SPOF for egress (and adds cross-AZ data charges). The recommended pattern is one NAT per AZ with each AZ\'s private route table pointing at its local NAT. It limits blast radius for AZ failures — though not for a bad automation that deletes both.' },
      { title: 'Tag-based automation needs guardrails on the tags', body: 'The janitor\'s IAM policy only allowed deletes on `aws:ResourceTag/env = staging`. That is good ABAC — and it was defeated by a wrong tag. Protect the tags that guardrails depend on (deny `ec2:CreateTags`/`DeleteTags` on the `env` key except for the provisioning role; AWS Organizations tag policies), add an explicit Deny for `env=prod` in an SCP or permission boundary, keep production and staging in **separate accounts** where possible, and run new destructive handlers in dry-run with the candidate list reviewed by the owning team.' },
      { title: '"No data" is not zero', body: 'CloudWatch returns an empty `Datapoints` list for a metric that does not exist — including a typo in a dimension name or value, which are case-sensitive. Code that sums an empty list gets 0. Any automation that takes destructive action on "absence of activity" must treat *missing* data as *unknown* and fail safe.' },
    ],
    commands: [
      { cmd: 'curl -v --connect-timeout 5 https://api.paybridge.com/v2/health', why: 'Run it from an app host and from the bastion: hanging at "Trying 104.18.32.7:443..." means the TCP handshake never completes' },
      { cmd: 'aws ec2 describe-route-tables --filters Name=route.state,Values=blackhole', why: 'Find routes whose target (NAT, instance, ENI, peering) no longer exists' },
      { cmd: 'aws ec2 describe-nat-gateways', why: 'NAT state, DeleteTime and tags (deleted NAT gateways stay visible for about an hour)' },
      { cmd: 'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=DeleteNatGateway', why: 'Who deleted it, from where, and when' },
      { cmd: 'aws ec2 describe-vpc-endpoints', why: 'Which AWS services are reachable without the NAT' },
      { cmd: 'aws ec2 create-nat-gateway --subnet-id subnet-0a11b22c33d44e551 --allocation-id <new eipalloc> && aws ec2 replace-route --route-table-id rtb-0b2e3f4a5c6d7e819 --destination-cidr-block 0.0.0.0/0 --nat-gateway-id <new nat>', why: 'The mitigation: new NAT + repoint the default route of each private route table' },
    ],
    prevention: [
      'Separate AWS accounts for staging and production; never let cleanup automation run with delete rights in prod.',
      'SCP / permission boundary: explicit Deny on destructive actions for resources tagged env=prod or with no env tag; restrict who can create or change the env tag.',
      'Terraform modules must not default environment tags — make `tags` a required variable, and review tag diffs on core network resources.',
      'Janitor design: dry-run by default, owner review of candidate lists, treat missing metrics as unknown, Slack notification before (not after) deletion.',
      'One NAT gateway per AZ; CloudWatch alarm on NAT BytesOutToDestination == 0 / ErrorPortAllocation, and an AWS Config rule or EventBridge rule on DeleteNatGateway and blackhole routes.',
      'Add VPC interface endpoints for critical AWS APIs (SQS, STS) so they do not depend on the NAT.',
    ],
    reading: [
      { title: 'AWS: NAT gateways', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway.html' },
      { title: 'AWS: Gateway endpoints', url: 'https://docs.aws.amazon.com/vpc/latest/privatelink/gateway-endpoints.html' },
      { title: 'AWS: Amazon DNS server (Route 53 Resolver)', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/AmazonDNS-concepts.html' },
      { title: 'AWS: Monitor NAT gateways with CloudWatch', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/vpc-nat-gateway-cloudwatch.html' },
    ],
  },
};

export default incident;
