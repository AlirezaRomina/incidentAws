import type { Incident, LogEvent, PolicyDocument } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, iso, isoSec } from '../engine/time';
import { createRng, hashString } from '../engine/rng';
import { addPanel, ev, host, injectLog, logGroup } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4188 — a "least privilege" terraform PR (applied 10:02) merged the bucket-level
 * and object-level S3 statements of shopfast-app-role into one statement whose Resource
 * is the bucket ARN. s3:PutObject / s3:GetObject need the object ARN (bucket/*), so every
 * invoice upload is now implicitly denied; jobs retry 5x and land in the DLQ.
 */

const CHANGE = 88; // minutes ago: PutRolePolicy by terraform-ci (10:02)
const BUCKET = 'shopfast-invoices-prod';
const KMS_KEY = `arn:aws:kms:us-east-1:${IDS.account}:key/5e6f7a8b-9c0d-41e2-a3b4-c5d6e7f8a9b0`;
const INVOICE_Q = `https://sqs.us-east-1.amazonaws.com/${IDS.account}/invoices-prod`;
const INVOICE_DLQ = `https://sqs.us-east-1.amazonaws.com/${IDS.account}/invoices-prod-dlq`;
const LAST_OK_INVOICE = 612;

const pol = (Statement: Record<string, unknown>[]): PolicyDocument => ({ Version: '2012-10-17', Statement });

const COMMON_TAIL = [
  { Sid: 'OrdersQueue', Effect: 'Allow', Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes'], Resource: `arn:aws:sqs:us-east-1:${IDS.account}:orders-prod` },
  { Sid: 'InvoiceQueue', Effect: 'Allow', Action: ['sqs:SendMessage', 'sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'], Resource: `arn:aws:sqs:us-east-1:${IDS.account}:invoices-prod` },
];
const KMS_STMT = { Sid: 'KmsForInvoices', Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: KMS_KEY };

const NEW_POLICY = pol([
  { Sid: 'InvoiceBucket', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'], Resource: `arn:aws:s3:::${BUCKET}` },
  ...COMMON_TAIL,
  { Sid: 'DbSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:us-east-1:${IDS.account}:secret:prod/checkout/db-Xk2P9q` },
  KMS_STMT,
]);

const BUCKET_POLICY = {
  Version: '2012-10-17',
  Statement: [
    { Sid: 'DenyInsecureTransport', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`], Condition: { Bool: { 'aws:SecureTransport': 'false' } } },
    { Sid: 'DenyOutsideOrg', Effect: 'Deny', Principal: '*', Action: 's3:*', Resource: [`arn:aws:s3:::${BUCKET}`, `arn:aws:s3:::${BUCKET}/*`], Condition: { StringNotEquals: { 'aws:PrincipalOrgID': 'o-7k2xq9mp3d' } } },
  ],
};

const s3RequestId = (seed: string) => {
  const r = createRng(hashString(seed));
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 16 }, () => A[Math.floor(r() * A.length)]).join('');
};
const hostId = (seed: string) => {
  const r = createRng(hashString('h' + seed));
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return Array.from({ length: 76 }, () => A[Math.floor(r() * A.length)]).join('') + '=';
};
const uuid = (seed: string) => {
  const h = (n: number) => (hashString(seed + n) >>> 0).toString(16).padStart(8, '0');
  const s = h(1) + h(2) + h(3) + h(4);
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-4${s.slice(13, 16)}-a${s.slice(17, 20)}-${s.slice(20, 32)}`;
};
const inv = (n: number) => `INV-2026-1008-${String(n).padStart(5, '0')}`;
const keyOf = (n: number) => `2026/10/08/${inv(n)}.pdf`;

const incident: Incident = {
  id: 'iam-s3-access-denied',
  code: 'INC-4188',
  order: 6,
  title: 'Invoices stopped arriving',
  teaser: 'Checkout works, payments go through — but since ~10:05 nobody receives an invoice PDF.',
  difficulty: 'intermediate',
  tags: ['IAM', 'S3', 'CloudTrail', 'SQS', 'Least privilege'],
  parMinutes: 15,
  seed: 4188,
  now: '2026-10-08T11:30:00Z',
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'Zendesk → PagerDuty',
      title: '[Support spike] 34 tickets tagged "invoice-missing" in the last 60 min',
      details: 'Ticket volume for tag invoice-missing is 11× the 7-day hourly average. No CloudWatch alarm is in ALARM state.',
      minutesAgo: 25,
    },
    reports: [
      { from: 'Lucia Ferreira', role: 'Customer Support Lead', channel: '#incident-4188', message: 'Since about 10:05 customers say the "Your ShopFast invoice" email never arrives. Orders and payments are fine. Weirder: a B2B customer clicked "Download invoice" for an order from LAST WEEK and got an XML page that just says AccessDenied. Screenshot is in ZD-88213.', minutesAgo: 22 },
      { from: 'Kenji Watanabe', role: 'SRE (on-call secondary)', channel: '#incident-4188', message: 'I tried `aws s3 cp` of a test file into shopfast-invoices-prod from the bastion — AccessDenied for me too. And AWS Health has an S3 event open right now. Is S3 just having a bad day?', minutesAgo: 15 },
      { from: 'Nina Kowalczyk', role: 'Security Engineer', channel: '#incident-4188', message: 'FYI the SEC-212 least-privilege cleanup for the app role was applied by terraform this morning. Plan was clean and it only removed wildcards, so I doubt it is related — but happy to be proven wrong.', minutesAgo: 9 },
    ],
    impact: 'No invoice PDFs generated or emailed since ~10:02 (thousands of jobs parked in a dead-letter queue). Existing invoices cannot be downloaded. B2B customers need invoices for VAT today. Checkout and payments unaffected.',
    services: ['checkout-api invoice worker', 'S3 shopfast-invoices-prod', 'SQS invoices-prod / invoices-prod-dlq', 'IAM role shopfast-app-role'],
  },

  build(env) {
    env.traffic.minutes = 120;

    // ---------------- IAM ----------------
    const role = env.iam.roles.find(r => r.name === 'shopfast-app-role')!;
    role.policies.find(p => p.name === 'checkout-api-access')!.document = NEW_POLICY;
    role.lastModifiedMinutesAgo = CHANGE;

    // ---------------- Metrics ----------------
    addPanel(env, {
      id: 'invoices.generated', group: 'Application (ShopFast/Invoices)', namespace: 'ShopFast/Invoices', metric: 'InvoicesGenerated', resource: 'checkout-api', unit: 'Count', stat: 'Sum', periodMinutes: 1, featured: true,
      series: [{ name: 'checkout-api', points: series('inv-ok', 58, { noise: 0.14 }).wave(0.06).stepTo(CHANGE - 1, 0).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'invoices.failed', group: 'Application (ShopFast/Invoices)', namespace: 'ShopFast/Invoices', metric: 'InvoiceUploadFailures', resource: 'checkout-api', unit: 'Count', stat: 'Sum', periodMinutes: 1, featured: true,
      series: [{ name: 'checkout-api', points: series('inv-fail', 0, { noise: 0.1 }).map((_v, m) => (m >= CHANGE ? 0.2 : 58 * Math.min(5, 1 + Math.floor((CHANGE - m) / 1.1)))).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'sqs.invoices.dlq', group: 'SQS', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', resource: 'invoices-prod-dlq', unit: 'Count', stat: 'Maximum', periodMinutes: 1, featured: true,
      series: [{ name: 'invoices-prod-dlq', points: series('dlq', 0, { noise: 0.004 }).map((_v, m) => (m < CHANGE - 5 ? (CHANGE - 5 - m) * 58.3 : 0)).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'sqs.invoices.age', group: 'SQS', namespace: 'AWS/SQS', metric: 'ApproximateAgeOfOldestMessage', resource: 'invoices-prod', unit: 'Seconds', stat: 'Maximum', periodMinutes: 1,
      series: [{ name: 'invoices-prod', points: series('age', 3, { noise: 0.25 }).rampTo(CHANGE - 1, 296, 5).clamp(0).round(0).build() }],
    });
    addPanel(env, {
      id: 'sqs.orders.visible', group: 'SQS', namespace: 'AWS/SQS', metric: 'ApproximateNumberOfMessagesVisible', resource: 'orders-prod', unit: 'Count', stat: 'Maximum', periodMinutes: 1,
      series: [{ name: 'orders-prod', points: series('ordq', 4, { noise: 0.5 }).clamp(0).round(0).build() }],
    });

    // ---------------- App hosts / logs ----------------
    const okCounter = LAST_OK_INVOICE - 3 * 32;
    for (const [i, h] of APP_HOSTS.entries()) {
      const hh = host(env, h);
      const meta = hostMeta[h];
      const pid = 2841 + i * 17;
      hh.env.INVOICE_QUEUE_URL = INVOICE_Q;
      hh.env.INVOICE_KMS_KEY_ID = KMS_KEY;
      const caller = `arn:aws:sts::${IDS.account}:assumed-role/shopfast-app-role/${meta.id}`;
      const lines: LogEvent[] = [];
      // healthy uploads before the change
      for (let n = 0; n < 32; n++) {
        const m = 119 - n * ((119 - CHANGE - 0.3) / 31);
        const no = okCounter + n * 3 + i;
        const ts = env.now - Math.round(m * MIN);
        lines.push({ ts, msg: JSON.stringify({ level: 30, time: iso(ts), pid, hostname: meta.hostname, component: 'invoice-worker', invoiceNo: inv(no), bucket: BUCKET, key: keyOf(no), bytes: 41_000 + ((no * 7919) % 22_000), durationMs: 180 + ((no * 31) % 140), msg: 'invoice uploaded' }) });
        lines.push({ ts: ts + 41, msg: JSON.stringify({ level: 30, time: iso(ts + 41), pid, hostname: meta.hostname, component: 'invoice-worker', invoiceNo: inv(no), template: 'invoice-email-v3', msg: 'invoice email queued' }) });
      }
      // every job after 10:02 fails, retried by SQS up to maxReceiveCount=5
      const N = 44;
      for (let n = 0; n < N; n++) {
        const first = CHANGE - 0.28 - n * ((CHANGE - 1.5) / N);
        const no = LAST_OK_INVOICE + 1 + n * 3 + i;
        const order = `ord_${(hashString(`o${no}`) >>> 0).toString(16).padStart(8, '0')}${(hashString(`p${no}`) >>> 0).toString(16).slice(0, 4)}`;
        const job = uuid(`job${no}`);
        for (let r = 1; r <= 5; r++) {
          const m = first - (r - 1) * 1.02;
          if (m <= 0) break;
          const ts = env.now - Math.round(m * MIN);
          const rid = s3RequestId(`${no}-${r}`);
          const message = `User: ${caller} is not authorized to perform: s3:PutObject on resource: "arn:aws:s3:::${BUCKET}/${keyOf(no)}" because no identity-based policy allows the s3:PutObject action`;
          lines.push({
            ts,
            msg: JSON.stringify({
              level: 50, time: iso(ts), pid, hostname: meta.hostname, component: 'invoice-worker', jobId: job, orderId: order, invoiceNo: inv(no), receiveCount: r,
              err: {
                type: 'AccessDenied',
                message,
                stack: `AccessDenied: ${message}\n    at throwDefaultError (/opt/checkout-api/node_modules/@smithy/smithy-client/dist-cjs/index.js:840:20)\n    at de_CommandError (/opt/checkout-api/node_modules/@aws-sdk/client-s3/dist-cjs/index.js:4748:14)\n    at async uploadInvoice (/opt/checkout-api/dist/invoices/upload.js:41:5)`,
                name: 'AccessDenied',
                $fault: 'client',
                $metadata: { httpStatusCode: 403, requestId: rid, extendedRequestId: hostId(rid), attempts: 1, totalRetryDelay: 0 },
                Code: 'AccessDenied',
                RequestId: rid,
                HostId: hostId(rid),
              },
              msg: 'invoice upload failed',
            }),
          });
        }
      }
      injectLog(env, h, '/var/log/checkout-api/app.log', lines);
    }

    // ---------------- CloudTrail ----------------
    const ct = env.cloudtrail;
    ct.push(
      { minutesAgo: CHANGE + 1, eventName: 'GetRolePolicy', eventSource: 'iam.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'shopfast-app-role / checkout-api-access', request: { roleName: 'shopfast-app-role', policyName: 'checkout-api-access' } },
      { minutesAgo: CHANGE, eventName: 'PutRolePolicy', eventSource: 'iam.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: `arn:aws:iam::${IDS.account}:role/shopfast-app-role`, request: { roleName: 'shopfast-app-role', policyName: 'checkout-api-access', policyDocument: JSON.stringify(NEW_POLICY) } },
      { minutesAgo: 95, eventName: 'RotateKey', eventSource: 'kms.amazonaws.com', user: 'kms.amazonaws.com (AWS service)', sourceIp: 'kms.amazonaws.com', resources: KMS_KEY, request: { keyId: KMS_KEY, rotationType: 'AUTOMATIC' } },
      { minutesAgo: 101, eventName: 'PutObject', eventSource: 's3.amazonaws.com', user: `shopfast-app-role/${hostMeta['app-2'].id}`, sourceIp: hostMeta['app-2'].ip, resources: `${BUCKET}/${keyOf(LAST_OK_INVOICE - 40)}`, request: { bucketName: BUCKET, key: keyOf(LAST_OK_INVOICE - 40), 'x-amz-server-side-encryption': 'aws:kms' } },
    );
    [
      ['app-2', CHANGE - 1, LAST_OK_INVOICE + 2],
      ['app-2', 61, LAST_OK_INVOICE + 41],
      ['app-3', 33, LAST_OK_INVOICE + 84],
      ['app-1', 13, LAST_OK_INVOICE + 115],
      ['app-2', 2, LAST_OK_INVOICE + 128],
    ].forEach(([h, m, no]) => {
      const meta = hostMeta[h as 'app-1'];
      ct.push({ minutesAgo: m as number, eventName: 'PutObject', eventSource: 's3.amazonaws.com', user: `shopfast-app-role/${meta.id}`, sourceIp: meta.ip, resources: `${BUCKET}/${keyOf(no as number)}`, errorCode: 'AccessDenied', request: { bucketName: BUCKET, key: keyOf(no as number), 'x-amz-server-side-encryption': 'aws:kms' } });
    });
    ct.push({ minutesAgo: 42, eventName: 'GetObject', eventSource: 's3.amazonaws.com', user: `shopfast-app-role/${hostMeta['app-3'].id}`, sourceIp: '198.51.100.77', resources: `${BUCKET}/2026/10/01/INV-2026-1001-00218.pdf`, errorCode: 'AccessDenied', request: { bucketName: BUCKET, key: '2026/10/01/INV-2026-1001-00218.pdf', 'X-Amz-Expires': '300' } });
    ct.push({ minutesAgo: 16, eventName: 'PutObject', eventSource: 's3.amazonaws.com', user: `shopfast-ops-role/${hostMeta.bastion.id}`, sourceIp: hostMeta.bastion.ip, resources: `${BUCKET}/ops-test/kenji-test.txt`, errorCode: 'AccessDenied', request: { bucketName: BUCKET, key: 'ops-test/kenji-test.txt' } });
    ct.sort((a, b) => a.minutesAgo - b.minutesAgo);

    // ---------------- Changes ----------------
    env.changes.unshift({
      id: 'chg-9118',
      minutesAgo: CHANGE,
      kind: 'infra',
      service: 'iam',
      title: 'terraform: SEC-212 least-privilege cleanup for shopfast-app-role (PR #1207)',
      author: 'terraform-ci (PR #1207, nina.kowalczyk)',
      status: 'succeeded',
      description: 'Security review SEC-212: "no wildcards in app role policies". terraform plan: 0 to add, 1 to change, 0 to destroy (aws_iam_role_policy.checkout_api_access). terraform validate ✔ · tflint ✔. Applied by terraform-ci at 10:02:00.',
      diff: `diff --git a/iam/shopfast-app-role.tf b/iam/shopfast-app-role.tf
--- a/iam/shopfast-app-role.tf
+++ b/iam/shopfast-app-role.tf
@@ -14,18 +14,13 @@ resource "aws_iam_role_policy" "checkout_api_access" {
   policy = jsonencode({
     Version = "2012-10-17"
     Statement = [
-      {
-        Sid      = "InvoiceObjects"
-        Effect   = "Allow"
-        Action   = ["s3:PutObject", "s3:GetObject"]
-        Resource = "arn:aws:s3:::shopfast-invoices-prod/*"
-      },
-      {
-        Sid      = "InvoiceBucketList"
-        Effect   = "Allow"
-        Action   = ["s3:ListBucket"]
-        Resource = "arn:aws:s3:::shopfast-invoices-prod"
-      },
+      {
+        # SEC-212: one statement per resource, no wildcards
+        Sid      = "InvoiceBucket"
+        Effect   = "Allow"
+        Action   = ["s3:PutObject", "s3:GetObject", "s3:ListBucket"]
+        Resource = "arn:aws:s3:::shopfast-invoices-prod"
+      },
       {
         Sid      = "OrdersQueue"
         Effect   = "Allow"
@@ -44,7 +39,7 @@ resource "aws_iam_role_policy" "checkout_api_access" {
       {
         Sid      = "DbSecret"
         Effect   = "Allow"
         Action   = "secretsmanager:GetSecretValue"
-        Resource = "arn:aws:secretsmanager:us-east-1:481562039374:secret:prod/checkout/db-*"
+        Resource = "arn:aws:secretsmanager:us-east-1:481562039374:secret:prod/checkout/db-Xk2P9q"
       },`,
    });
    env.changes.unshift({
      id: 'chg-9121',
      minutesAgo: 64,
      kind: 'feature-flag',
      service: 'web-frontend',
      title: 'Enable new order-confirmation page layout for 50% of users',
      author: 'sara.okafor',
      status: 'succeeded',
      description: 'LaunchDarkly flag order-confirmation-v2 → 50%. Frontend only; reads the same order API.',
    });

    // ---------------- AWS Health (red herring) ----------------
    const health = logGroup(env, '/aws/events/aws-health', 'AWS Health events forwarded by EventBridge rule shopfast-health-to-logs', 30);
    const healthEvent = (m: number, desc: string, status: string) =>
      JSON.stringify({
        version: '0', id: uuid(`health${m}`), 'detail-type': 'AWS Health Event', source: 'aws.health', account: IDS.account, time: isoSec(env.now - m * MIN), region: 'eu-west-1', resources: [],
        detail: { eventArn: 'arn:aws:health:eu-west-1::event/S3/AWS_S3_OPERATIONAL_ISSUE/AWS_S3_OPERATIONAL_ISSUE_7B1C2_5D3E9A0F41B', service: 'S3', eventTypeCode: 'AWS_S3_OPERATIONAL_ISSUE', eventTypeCategory: 'issue', eventScopeCode: 'PUBLIC', statusCode: status, startTime: isoSec(env.now - 132 * MIN), eventRegion: 'eu-west-1', eventDescription: [{ language: 'en_US', latestDescription: desc }], affectedEntities: [] },
      });
    health.events.push(
      ev(env, 131, healthEvent(131, 'We are investigating increased error rates and latencies for S3 PUT and GET requests in the EU-WEST-1 Region.', 'open')),
      ev(env, 58, healthEvent(58, 'We have identified the root cause of increased PUT latencies in a single Availability Zone in the EU-WEST-1 Region and are working towards mitigation. Other Regions are not affected.', 'open')),
    );

    // ---------------- AWS CLI answers the engine does not derive ----------------
    const objLine = (minAgo: number, size: number, key: string) => {
      const d = new Date(env.now - minAgo * MIN);
      return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 19)} ${String(size).padStart(10)} ${key}`;
    };
    const todays: string[] = [];
    for (let n = 0; n < 14; n++) {
      const no = LAST_OK_INVOICE - 13 + n;
      todays.push(objLine(CHANGE + 0.4 + (13 - n) * 0.37, 41_000 + ((no * 7919) % 22_000), `${inv(no)}.pdf`));
    }
    env.awsCli.unshift(
      { match: /^aws s3 ls s3:\/\/shopfast-invoices-prod\/?(\s|$)/, output: '                           PRE 2025/\n                           PRE 2026/' },
      { match: /^aws s3 ls s3:\/\/shopfast-invoices-prod\/2026\/?(\s|$)/, output: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10'].map(m => `                           PRE ${m}/`).join('\n') },
      { match: /^aws s3 ls s3:\/\/shopfast-invoices-prod\/2026\/10\/?(\s|$)/, output: ['01', '02', '03', '04', '05', '06', '07', '08'].map(d => `                           PRE ${d}/`).join('\n') },
      { match: /^aws s3 ls s3:\/\/shopfast-invoices-prod\/2026\/10\/08/, output: `[... ${LAST_OK_INVOICE - 14} earlier objects ...]\n${todays.join('\n')}` },
      { match: /^aws s3api get-bucket-policy\b/, output: JSON.stringify({ Policy: JSON.stringify(BUCKET_POLICY) }, null, 4) },
      { match: /^aws s3api get-bucket-encryption\b/, output: JSON.stringify({ ServerSideEncryptionConfiguration: { Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms', KMSMasterKeyID: KMS_KEY }, BucketKeyEnabled: true }] } }, null, 4) },
      { match: /^aws kms get-key-rotation-status\b/, output: JSON.stringify({ KeyRotationEnabled: true, KeyId: KMS_KEY, RotationPeriodInDays: 365, NextRotationDate: '2027-10-08T09:55:02+00:00' }, null, 4) },
      { match: /^aws kms describe-key\b/, output: JSON.stringify({ KeyMetadata: { AWSAccountId: IDS.account, KeyId: '5e6f7a8b-9c0d-41e2-a3b4-c5d6e7f8a9b0', Arn: KMS_KEY, CreationDate: '2025-01-14T09:01:55+00:00', Enabled: true, Description: 'shopfast-invoices-prod SSE-KMS', KeyUsage: 'ENCRYPT_DECRYPT', KeyState: 'Enabled', Origin: 'AWS_KMS', KeyManager: 'CUSTOMER', KeySpec: 'SYMMETRIC_DEFAULT', MultiRegion: false } }, null, 4) },
      { match: /^aws sqs list-queues\b/, output: JSON.stringify({ QueueUrls: [`https://sqs.us-east-1.amazonaws.com/${IDS.account}/orders-prod`, `https://sqs.us-east-1.amazonaws.com/${IDS.account}/orders-prod-dlq`, INVOICE_Q, INVOICE_DLQ] }, null, 4) },
      { match: /^aws sqs get-queue-attributes\b.*invoices-prod-dlq/, output: JSON.stringify({ Attributes: { QueueArn: `arn:aws:sqs:us-east-1:${IDS.account}:invoices-prod-dlq`, ApproximateNumberOfMessages: '4840', ApproximateNumberOfMessagesNotVisible: '0', MessageRetentionPeriod: '1209600', RedriveAllowPolicy: '{"redrivePermission":"byQueue","sourceQueueArns":["arn:aws:sqs:us-east-1:481562039374:invoices-prod"]}' } }, null, 4) },
      { match: /^aws sqs get-queue-attributes\b.*invoices-prod/, output: JSON.stringify({ Attributes: { QueueArn: `arn:aws:sqs:us-east-1:${IDS.account}:invoices-prod`, ApproximateNumberOfMessages: '61', ApproximateNumberOfMessagesNotVisible: '233', VisibilityTimeout: '60', MessageRetentionPeriod: '345600', RedrivePolicy: '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:481562039374:invoices-prod-dlq","maxReceiveCount":5}' } }, null, 4) },
    );
  },

  evidence: [
    {
      id: 'access-denied',
      label: 'Invoice uploads fail: shopfast-app-role is not authorized to perform s3:PutObject on the invoice object (implicit deny)',
      kind: 'key',
      match: /shopfast-app-role\/i-[0-9a-f]+ is not authorized to perform: s3:PutObject/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'The SDK error names the principal (the app role), the action (s3:PutObject), the resource (an object ARN: bucket/key) and the reason: "no identity-based policy allows" — an implicit deny from the role\'s own policies, not a bucket-policy or KMS problem.',
    },
    {
      id: 'policy-bucket-arn',
      label: 'checkout-api-access now grants PutObject/GetObject only on the bucket ARN (no /*)',
      kind: 'key',
      match: /"s3:PutObject"[^\]]*"s3:ListBucket"\s*\]\s*,\s*"Resource"\s*:\s*"arn:aws:s3:::shopfast-invoices-prod"/,
      foundBy: { tool: 'iam' },
      explanation: 'Object-level actions are evaluated against arn:aws:s3:::bucket/key. A statement whose Resource is arn:aws:s3:::shopfast-invoices-prod matches only the bucket itself, so PutObject/GetObject never match — while ListBucket (a bucket-level action) keeps working, which makes "aws s3 ls" misleadingly fine.',
    },
    {
      id: 'policy-change',
      label: 'terraform-ci rewrote the inline policy at 10:02 (SEC-212, PR #1207)',
      kind: 'key',
      match: /PutRolePolicy|PR #1207/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'CloudTrail shows who changed what and when: PutRolePolicy on shopfast-app-role at 10:02:00 with the new document in requestParameters — about 17 seconds before the first failed upload.',
    },
    {
      id: 'simulate',
      label: 'simulate-principal-policy: s3:PutObject on an invoice object → implicitDeny',
      kind: 'supporting',
      match: /"EvalDecision": "implicitDeny"/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::481562039374:role/shopfast-app-role --action-names s3:PutObject --resource-arns arn:aws:s3:::shopfast-invoices-prod/2026/10/08/INV-2026-1008-00731.pdf' },
      explanation: 'The policy simulator reproduces the denial without touching production, and with the bucket ARN as resource it would say "allowed" — exactly the bucket-vs-object mismatch.',
    },
    {
      id: 'dlq',
      label: 'invoices-prod-dlq is filling at ~58 messages/min since 10:07',
      kind: 'supporting',
      match: /ApproximateNumberOfMessagesVisible \[invoices-prod-dlq\]/,
      foundBy: { tool: 'cloudwatch', panel: 'sqs.invoices.dlq' },
      explanation: 'Each invoice job is retried 5 times (maxReceiveCount) and then parked in the DLQ. The good news: nothing is lost yet — the jobs can be redriven once the permission is fixed (retention 14 days).',
    },
    {
      id: 'ct-access-denied',
      label: 'CloudTrail data events: PutObject by shopfast-app-role with errorCode AccessDenied',
      kind: 'supporting',
      match: /PutObject \(s3\.amazonaws\.com\) by shopfast-app-role[^\n]*\[AccessDenied\]/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'The same denial seen from the AWS side, from all three app hosts — ruling out a single bad instance or stale credentials.',
    },
    {
      id: 'aws-health',
      label: 'AWS Health: S3 operational issue in eu-west-1',
      kind: 'red-herring',
      match: /AWS_S3_OPERATIONAL_ISSUE/,
      foundBy: { tool: 'logs', group: '/aws/events/aws-health' },
      explanation: 'A real S3 event — in eu-west-1. Our bucket is in us-east-1, and a service problem shows up as 5xx/SlowDown/timeouts, never as a 403 AccessDenied naming an IAM policy.',
    },
    {
      id: 'kms-rotation',
      label: 'KMS automatic key rotation of the invoice key at 09:55',
      kind: 'red-herring',
      match: /RotateKey/,
      foundBy: { tool: 'cloudtrail' },
      explanation: 'Automatic rotation adds new key material but keeps the old material for decryption, and the key ARN does not change — it is invisible to callers. A KMS problem would surface as a KMS error (kms:GenerateDataKey, KMS.DisabledException), not s3:PutObject.',
    },
    {
      id: 'ops-denied',
      label: 'The ops role on the bastion also gets AccessDenied writing to the bucket',
      kind: 'red-herring',
      match: /shopfast-ops-role\/i-[0-9a-f]+ is not authorized to perform/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'aws s3 cp /home/ec2-user/.bash_history s3://shopfast-invoices-prod/ops-test/kenji-test.txt' },
      explanation: 'shopfast-ops-role is read-only by design (ReadOnlyAccess + IAMSimulate). It was never allowed to write, so its denial tells you nothing about the app role — testing with the wrong principal is a classic IAM debugging trap.',
    },
  ],

  rootCauses: [
    { id: 'rc-arn', correct: true, text: 'PR #1207 merged s3:PutObject/GetObject into a statement whose Resource is the bucket ARN; object actions need arn:aws:s3:::shopfast-invoices-prod/*, so every upload is implicitly denied.', explanation: 'The SDK error, the current policy document, the 10:02 PutRolePolicy and the simulator all agree: object-level actions are evaluated against the object ARN, which the merged statement no longer covers.' },
    { id: 'rc-removed', partial: true, text: "The 10:02 terraform apply (PR #1207) removed s3:PutObject from shopfast-app-role's checkout-api-access policy, so the invoice worker can no longer write PDFs.", explanation: 'Right change, wrong mechanism: s3:PutObject is still listed. It no longer matches because the Resource became the bucket ARN. Without that insight the obvious "fix" (re-add the action) does nothing.' },
    { id: 'rc-bucket-policy', text: "shopfast-invoices-prod's bucket policy (DenyOutsideOrg on aws:PrincipalOrgID) now explicitly denies the app role's PutObject requests made through the S3 gateway endpoint.", explanation: 'An explicit deny in a resource policy produces "…with an explicit deny in a resource-based policy". The error says "no identity-based policy allows" — an implicit deny from the role. The bucket policy was not changed.' },
    { id: 'rc-kms', text: 'The 09:55 automatic rotation of KMS key 5e6f7a8b… broke SSE-KMS: GenerateDataKey for the new key material fails, and S3 rejects the invoice PutObject requests with 403.', explanation: 'Rotation keeps the key ARN and all old material; callers do not notice. The error is about s3:PutObject and identity policies, and the role\'s KMS statement is unchanged.' },
    { id: 'rc-s3-outage', text: 'The open AWS_S3_OPERATIONAL_ISSUE event is degrading S3 PUTs; throttled requests come back as 403 AccessDenied and the worker gives up after five SQS receives.', explanation: 'That event is in eu-west-1, and S3 service trouble returns 500/503 SlowDown, not an AccessDenied naming an IAM policy. Reads of the bucket listing still work fine.' },
    { id: 'rc-creds', text: 'The instance-profile credentials on app-1..3 expired after the 10:02 role update and the AWS SDK credential provider never refreshed them from IMDS, so S3 rejects the requests.', explanation: 'Expired credentials produce ExpiredToken / InvalidAccessKeyId, not an AccessDenied that names the assumed-role ARN. ListBucket with the same credentials still succeeds.' },
  ],

  fixes: [
    { id: 'fx-restore', kind: 'correct', text: 'Restore two statements via a terraform PR: s3:PutObject/GetObject on arn:aws:s3:::shopfast-invoices-prod/* and s3:ListBucket on the bucket ARN.', explanation: 'Least privilege done right: each action paired with the resource type it acts on. `/*` here is not a broad wildcard — it means "objects in this one bucket". Applying it through terraform keeps code and reality in sync.' },
    { id: 'fx-redrive', kind: 'correct', text: 'After simulate-principal-policy shows "allowed", redrive invoices-prod-dlq back to invoices-prod (StartMessageMoveTask) so the ~4,800 parked invoices are generated.', explanation: 'The jobs are not lost; DLQ retention is 14 days. Verifying with the simulator first avoids redriving into the same failure.' },
    { id: 'fx-ci-tests', kind: 'correct', text: 'Add IAM checks to the terraform pipeline: simulate-custom-policy for the required action/resource matrix plus Access Analyzer validate-policy, and alarm on DLQ depth > 0.', explanation: 'terraform plan only shows that a policy changes, not what it allows. Policy tests encode "the app must be able to PutObject on bucket/*", and a DLQ alarm would have paged within minutes.' },
    { id: 'fx-console', kind: 'partial', text: 'Hot-fix it in the IAM console now: put-role-policy with the previous checkout-api-access document copied from the 10:02 CloudTrail event history.', explanation: 'Stops the failures fastest, but creates drift: the broken policy is still on main and the next terraform apply re-breaks invoices. Do it only together with the terraform fix.' },
    { id: 'fx-s3full', kind: 'harmful', text: 'Attach the AWS-managed AmazonS3FullAccess policy to shopfast-app-role so the invoice worker can write to the bucket while the policy is investigated.', explanation: 'Gives every checkout-api host s3:* on every bucket in the account (backups, logs, artifacts) — a huge blast radius for one compromised dependency — and the "temporary" grant tends to stay.' },
    { id: 'fx-purge', kind: 'harmful', text: 'Purge invoices-prod-dlq (sqs purge-queue) so the backlog alarm clears and new invoice jobs can be processed from a clean queue.', explanation: 'Deletes ~4,800 legally required invoices that could have been redriven. The DLQ is the safety net, not the problem.' },
    { id: 'fx-restart', kind: 'neutral', text: 'Restart checkout-api on app-1..3 so the AWS SDK fetches fresh instance-profile credentials from IMDS and re-initialises the S3 client.', explanation: 'The credentials are fine — the policy attached to the role is wrong. New credentials carry the same permissions.' },
    { id: 'fx-kms', kind: 'neutral', text: 'Disable automatic rotation on KMS key 5e6f7a8b… and re-encrypt the invoice bucket with the previous key material.', explanation: 'Rotation is not involved, and you cannot pick old key material for new encryptions anyway. This only weakens your key hygiene.' },
  ],

  hints: [
    'Checkout works but invoices do not. Find what produces invoices and read its errors: Logs → /shopfast/checkout-api, search for "invoice".',
    'It is an authorization failure. Read the whole message: which principal, which action, which resource, and "no identity-based policy allows" vs. "explicit deny". Then look at what that role may do (IAM) and when it changed (CloudTrail).',
    's3:PutObject and s3:GetObject act on objects (arn:aws:s3:::bucket/key); s3:ListBucket acts on the bucket. Compare the Resource in checkout-api-access with the resource in the error, and test it with `aws iam simulate-principal-policy` from the bastion.',
  ],

  debrief: {
    summary: `At 10:02 terraform applied **PR #1207** (security ticket SEC-212, "no wildcards in app role policies"). It merged the two S3 statements of \`checkout-api-access\` into one: \`["s3:PutObject","s3:GetObject","s3:ListBucket"]\` on \`arn:aws:s3:::shopfast-invoices-prod\`. The \`/*\` that was removed looked like a wildcard, but it was the only thing that made the object-level actions match: **PutObject and GetObject are authorized against the object ARN** (\`bucket/key\`), ListBucket against the bucket ARN.

From 10:02:31 every invoice upload by the in-process invoice worker failed with \`AccessDenied … because no identity-based policy allows the s3:PutObject action\` — an **implicit deny**: nothing allowed it, nothing explicitly denied it. SQS redelivered each job five times and then moved it to \`invoices-prod-dlq\`, which grew by ~58 messages a minute. Presigned download links (signed by the same role) failed with AccessDenied too, which is why even last week's invoices stopped downloading. Listing the bucket kept working, which made the bucket look healthy.

The traps were all real but irrelevant: an S3 Health event in **eu-west-1**, a transparent KMS key rotation, and the on-call engineer's own AccessDenied — from the read-only ops role, which has never been allowed to write. Always test permissions as the principal that is failing (or with the policy simulator), never as yourself.`,
    timeline: [
      { minutesAgo: 131, event: 'AWS Health opens an S3 operational issue in eu-west-1 (red herring)' },
      { minutesAgo: 95, event: 'KMS automatically rotates the invoice key (red herring)' },
      { minutesAgo: 88, event: 'terraform-ci PutRolePolicy on shopfast-app-role (PR #1207); last invoice INV-2026-1008-00612 uploaded seconds earlier' },
      { minutesAgo: 87.7, event: 'First s3:PutObject AccessDenied from the invoice worker' },
      { minutesAgo: 83, event: 'First jobs exceed maxReceiveCount=5 and land in invoices-prod-dlq' },
      { minutesAgo: 25, event: 'Support ticket spike pages on-call (no CloudWatch alarm existed)' },
    ],
    concepts: [
      { title: 'S3 bucket ARNs vs. object ARNs', body: 'Every S3 action is defined against a resource type. Bucket-level actions (`s3:ListBucket`, `s3:GetBucketPolicy`, `s3:GetBucketLocation`) match `arn:aws:s3:::bucket`. Object-level actions (`s3:GetObject`, `s3:PutObject`, `s3:DeleteObject`) match `arn:aws:s3:::bucket/key` — so a policy needs `arn:aws:s3:::bucket/*` (or a prefix like `bucket/2026/*`). A statement listing both kinds of action with only the bucket ARN silently grants just the bucket-level ones. The Service Authorization Reference lists the resource type for every action.' },
      { title: 'IAM policy evaluation: implicit vs. explicit deny', body: 'Requests start as denied. An explicit `Deny` in any applicable policy always wins; otherwise the request needs an `Allow` from an identity policy or (same account) a resource policy. The error text tells you which case you are in: "because no identity-based policy allows the … action" means implicit deny (nothing allowed it), while "with an explicit deny in a resource-based policy" / "…in an identity-based policy" means a Deny statement matched. SCPs and permission boundaries add their own variants.' },
      { title: 'Testing permissions: simulate-principal-policy', body: '`aws iam simulate-principal-policy --policy-source-arn <role> --action-names s3:PutObject --resource-arns arn:aws:s3:::bucket/key` evaluates the role\'s real policies and returns `allowed`, `implicitDeny` or `explicitDeny` with the matching statements. `simulate-custom-policy` does the same for a policy that is not applied yet — ideal for CI. Always test as the failing principal, with the exact resource ARN from the error.' },
      { title: 'CloudTrail as the change log of your permissions', body: 'Management events such as `PutRolePolicy`, `AttachRolePolicy` and `PutBucketPolicy` record who changed what, from where, and the full new document in `requestParameters`. Data events (if enabled for the bucket) record each `PutObject`/`GetObject` with `errorCode: AccessDenied`. Correlating the first error with the last permission change usually takes seconds.' },
      { title: 'Dead-letter queues and redrive', body: 'With a redrive policy (`maxReceiveCount: 5`) SQS moves a message to the DLQ after five failed receives instead of retrying forever. A DLQ turns an outage into a backlog: once the cause is fixed, `StartMessageMoveTask` (DLQ redrive) sends the messages back to the source queue. Keep DLQ retention longer than the source queue\'s, alarm on DLQ depth > 0, and never purge a DLQ to make an alarm go away.' },
    ],
    commands: [
      { cmd: 'aws iam get-role-policy --role-name shopfast-app-role --policy-name checkout-api-access', why: 'Read the exact inline policy the app is running with' },
      { cmd: 'aws iam simulate-principal-policy --policy-source-arn arn:aws:iam::481562039374:role/shopfast-app-role --action-names s3:PutObject --resource-arns arn:aws:s3:::shopfast-invoices-prod/2026/10/08/INV-2026-1008-00731.pdf', why: 'Evaluate the real policy for the failing action and object' },
      { cmd: 'aws cloudtrail lookup-events --lookup-attributes AttributeKey=EventName,AttributeValue=PutRolePolicy', why: 'Find who changed role policies and when' },
      { cmd: 'aws sqs get-queue-attributes --queue-url https://sqs.us-east-1.amazonaws.com/481562039374/invoices-prod-dlq --attribute-names ApproximateNumberOfMessages', why: 'How many jobs are parked waiting for redrive' },
      { cmd: 'aws accessanalyzer validate-policy --policy-type IDENTITY_POLICY --policy-document file://checkout-api-access.json', why: 'Lint a policy for errors and security warnings before applying it' },
    ],
    prevention: [
      'Test IAM changes in CI: run simulate-custom-policy for the actions/resources each service needs (e.g. PutObject on bucket/*) and fail the plan if any become denied.',
      'Run IAM Access Analyzer validate-policy on every policy change and review its findings in the PR.',
      'Alarm on DLQ depth > 0 and on business metrics like InvoicesGenerated dropping to zero — this outage was detected by customers after 60 minutes.',
      'Write least-privilege guidance that distinguishes resource scoping (`bucket/*` is fine) from action wildcards (`s3:*`), and pair security reviews with the owning team.',
      'Keep a documented redrive procedure for every DLQ, with retention longer than the source queue.',
    ],
    reading: [
      { title: 'IAM policy evaluation logic', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic.html' },
      { title: 'Actions, resources and condition keys for Amazon S3', url: 'https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazons3.html' },
      { title: 'Testing IAM policies with the IAM policy simulator', url: 'https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_testing-policies.html' },
    ],
  },
};

export default incident;
