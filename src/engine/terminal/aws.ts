import type { Environment, IamRole, PolicyDocument } from '../types';
import { MIN, isoSec } from '../time';
import type { Ctx } from './linux';
import { READ_ONLY } from './linux';
import { parseArgs, tokenize } from './shell';

const j = (v: unknown) => JSON.stringify(v, null, 4);

/* ------------------------- tiny IAM policy evaluator ------------------------- */

const wild = (pattern: string, value: string) =>
  new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i').test(value);

const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]) : v === undefined ? [] : [v as string]);

export interface EvalResult {
  decision: 'allowed' | 'explicitDeny' | 'implicitDeny';
  matched?: { policy: string; sid?: string };
}

export function evaluate(role: IamRole, action: string, resource: string): EvalResult {
  let allow: EvalResult | undefined;
  for (const p of role.policies) {
    for (const st of (p.document as PolicyDocument).Statement) {
      const actions = arr(st.Action);
      const resources = arr(st.Resource);
      const actionHit = actions.some(a => wild(a, action));
      const resHit = resources.some(r => wild(r, resource));
      if (actionHit && resHit) {
        if (st.Effect === 'Deny') return { decision: 'explicitDeny', matched: { policy: p.name, sid: st.Sid as string | undefined } };
        allow = allow ?? { decision: 'allowed', matched: { policy: p.name, sid: st.Sid as string | undefined } };
      }
    }
  }
  return allow ?? { decision: 'implicitDeny' };
}

function roleForHost(env: Environment, hostName: string): IamRole | undefined {
  const inst = env.ec2.instances.find(i => i.host === hostName);
  return env.iam.roles.find(r => r.instanceProfile === inst?.iamProfile);
}

function callerArn(env: Environment, hostName: string) {
  const inst = env.ec2.instances.find(i => i.host === hostName);
  const role = roleForHost(env, hostName);
  return `arn:aws:sts::${env.accountId}:assumed-role/${role?.name ?? 'unknown'}/${inst?.id ?? 'i-unknown'}`;
}

/* ------------------------------ main ------------------------------ */

export function aws(ctx: Ctx, raw: string): string {
  const env = ctx.env;
  for (const o of env.awsCli) if (o.match.test(raw)) return o.output;

  // list-valued options (--action-names a b c) take every token up to the next --option
  const argv0 = tokenize(raw).slice(1);
  const argv: string[] = [];
  for (let i = 0; i < argv0.length; i++) {
    argv.push(argv0[i]);
    if (argv0[i] === '--action-names' || argv0[i] === '--resource-arns' || argv0[i] === '--instance-ids' || argv0[i] === '--group-ids') {
      const vals: string[] = [];
      while (i + 1 < argv0.length && !argv0[i + 1].startsWith('--')) vals.push(argv0[++i]);
      argv.push(vals.join(' '));
    }
  }
  const a = parseArgs(argv, [
    'region', 'output', 'query', 'instance-ids', 'group-ids', 'filters', 'target-group-arn', 'names', 'load-balancer-arn', 'db-instance-identifier', 'role-name', 'policy-name', 'policy-arn',
    'lookup-attributes', 'max-results', 'max-items', 'hosted-zone-id', 'auto-scaling-group-name', 'auto-scaling-group-names', 'state-value', 'log-group-name', 'filter-pattern', 'since', 'start-time',
    'end-time', 'policy-source-arn', 'action-names', 'resource-arns', 'nat-gateway-ids', 'route-table-ids', 'image-ids', 'source-identifier', 'source-type', 'duration', 'metric-name', 'namespace',
    'dimensions', 'statistics', 'period', 'alarm-names', 'secret-id', 'queue-url', 'attribute-names', 'subnet-ids', 'version-id',
  ]);
  const [service, op, ...rest] = a.positional;
  if (!service || service === 'help') return AWS_HELP;
  if (!op) return `usage: aws [options] <command> <subcommand> [<subcommand> ...] [parameters]\naws: error: the following arguments are required: operation`;

  // Clock skew breaks SigV4 for every API call from this host.
  const skew = ctx.host.time.offsetSeconds;
  if (Math.abs(skew) > 300 && service !== 'configure') {
    const signed = new Date(env.now + skew * 1000);
    const real = new Date(env.now);
    const f = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const opName = op.split('-').map(s => s[0].toUpperCase() + s.slice(1)).join('');
    if (service === 's3') return `An error occurred (RequestTimeTooSkewed) when calling the ListObjectsV2 operation: The difference between the request time and the current time is too large.`;
    return `\nAn error occurred (${service === 'sts' ? 'SignatureDoesNotMatch' : 'InvalidSignatureException'}) when calling the ${opName} operation: Signature ${skew > 0 ? 'not yet current' : 'expired'}: ${f(signed)} is now ${skew > 0 ? 'later' : 'earlier'} than ${f(new Date(real.getTime() + (skew > 0 ? 5 : -5) * MIN))} (${f(real)} ${skew > 0 ? '+' : '-'} 5 min.)`;
  }

  const ec2 = env.ec2;
  switch (`${service} ${op}`) {
    case 'sts get-caller-identity': {
      const inst = env.ec2.instances.find(i => i.host === ctx.host.name);
      return j({ UserId: `AROAXZ3KQ7ME2EXAMPLE:${inst?.id}`, Account: env.accountId, Arn: callerArn(env, ctx.host.name) });
    }
    case 'ec2 describe-instances': {
      const ids = a.opts['instance-ids']?.split(/[ ,]+/) ?? rest.filter(r => r.startsWith('i-'));
      const list = ec2.instances.filter(i => !ids.length || ids.includes(i.id));
      if (ids.length && !list.length) return `\nAn error occurred (InvalidInstanceID.NotFound) when calling the DescribeInstances operation: The instance ID '${ids[0]}' does not exist`;
      return j({
        Reservations: list.map(i => ({
          Instances: [
            {
              InstanceId: i.id, ImageId: i.amiId, InstanceType: i.type, LaunchTime: i.launchTime, Placement: { AvailabilityZone: i.az }, PrivateIpAddress: i.privateIp, ...(i.publicIp ? { PublicIpAddress: i.publicIp } : {}),
              State: { Code: i.state === 'running' ? 16 : 80, Name: i.state }, SubnetId: i.subnetId, VpcId: env.vpc.id,
              IamInstanceProfile: i.iamProfile ? { Arn: `arn:aws:iam::${env.accountId}:instance-profile/${i.iamProfile}` } : undefined,
              SecurityGroups: i.sgIds.map(id => ({ GroupId: id, GroupName: ec2.securityGroups.find(s => s.id === id)?.name })),
              Tags: Object.entries(i.tags).map(([Key, Value]) => ({ Key, Value })),
            },
          ],
        })),
      });
    }
    case 'ec2 describe-security-groups': {
      const ids = a.opts['group-ids']?.split(/[ ,]+/) ?? [];
      const list = ec2.securityGroups.filter(s => !ids.length || ids.includes(s.id));
      const perm = (r: { protocol: string; ports: string; source: string; description?: string }) => {
        const [from, to] = r.ports === 'All' ? [undefined, undefined] : r.ports.split('-').map(Number);
        const base: Record<string, unknown> = { IpProtocol: r.protocol, ...(from !== undefined ? { FromPort: from, ToPort: to ?? from } : {}) };
        if (r.source.startsWith('sg-')) base.UserIdGroupPairs = [{ GroupId: r.source, UserId: env.accountId, Description: r.description }];
        else base.IpRanges = [{ CidrIp: r.source, Description: r.description }];
        return base;
      };
      return j({ SecurityGroups: list.map(s => ({ GroupId: s.id, GroupName: s.name, Description: s.description, VpcId: env.vpc.id, IpPermissions: s.inbound.map(perm), IpPermissionsEgress: s.outbound.map(perm) })) });
    }
    case 'ec2 describe-route-tables':
      return j({ RouteTables: env.vpc.routeTables.map(rt => ({ RouteTableId: rt.id, VpcId: env.vpc.id, Associations: rt.subnets.map(s => ({ SubnetId: s, RouteTableId: rt.id })), Routes: rt.routes.map(r => ({ DestinationCidrBlock: r.destination, [r.target === 'local' ? 'GatewayId' : r.target.startsWith('nat-') ? 'NatGatewayId' : r.target.startsWith('vpce-') ? 'GatewayId' : 'GatewayId']: r.target, State: r.state, Origin: r.target === 'local' ? 'CreateRouteTable' : 'CreateRoute' })), Tags: [{ Key: 'Name', Value: rt.name }] })) });
    case 'ec2 describe-nat-gateways':
      return j({ NatGateways: env.vpc.natGateways.map(n => ({ NatGatewayId: n.id, State: n.state, SubnetId: n.subnetId, VpcId: env.vpc.id, CreateTime: n.created, ...(n.state === 'deleted' ? { DeleteTime: isoSec(env.now - 47 * MIN) } : {}), NatGatewayAddresses: [{ PublicIp: n.publicIp }], Tags: [{ Key: 'Name', Value: n.name }] })) });
    case 'ec2 describe-subnets':
      return j({ Subnets: env.vpc.subnets.map(s => ({ SubnetId: s.id, CidrBlock: s.cidr, AvailabilityZone: s.az, AvailableIpAddressCount: s.availableIps, MapPublicIpOnLaunch: s.public, Tags: [{ Key: 'Name', Value: s.name }] })) });
    case 'ec2 describe-images':
      return j({ Images: ec2.amis.map(i => ({ ImageId: i.id, Name: i.name, CreationDate: i.created, Description: i.description, State: 'available' })) });
    case 'elbv2 describe-load-balancers':
      return j({ LoadBalancers: env.elb.loadBalancers.map(l => ({ LoadBalancerArn: l.arn, DNSName: l.dnsName, LoadBalancerName: l.name, Scheme: l.scheme, VpcId: l.vpcId, State: { Code: l.state }, Type: 'application', AvailabilityZones: l.azs.map(z => ({ ZoneName: z })), SecurityGroups: l.sgIds, CreatedTime: l.created })) });
    case 'elbv2 describe-target-groups':
      return j({ TargetGroups: env.elb.targetGroups.map(t => ({ TargetGroupArn: t.arn, TargetGroupName: t.name, Protocol: t.protocol, Port: t.port, VpcId: env.vpc.id, HealthCheckProtocol: t.healthCheck.protocol, HealthCheckPort: t.healthCheck.port, HealthCheckPath: t.healthCheck.path, HealthCheckIntervalSeconds: t.healthCheck.intervalSec, HealthCheckTimeoutSeconds: t.healthCheck.timeoutSec, HealthyThresholdCount: t.healthCheck.healthyThreshold, UnhealthyThresholdCount: t.healthCheck.unhealthyThreshold, Matcher: { HttpCode: t.healthCheck.matcher }, LoadBalancerArns: [env.elb.loadBalancers.find(l => l.name === t.loadBalancer)?.arn] })) });
    case 'elbv2 describe-target-health': {
      const arn = a.opts['target-group-arn'];
      const tg = env.elb.targetGroups.find(t => !arn || t.arn === arn || arn.includes(t.name)) ?? env.elb.targetGroups[0];
      if (!arn) return `\naws: error: the following arguments are required: --target-group-arn\n(hint: ${tg.arn})`;
      return j({ TargetHealthDescriptions: tg.targets.map(t => ({ Target: { Id: t.id, Port: t.port, AvailabilityZone: t.az }, HealthCheckPort: String(t.port), TargetHealth: { State: t.state, ...(t.reason ? { Reason: t.reason } : {}), ...(t.description ? { Description: t.description } : {}) } })) });
    }
    case 'autoscaling describe-auto-scaling-groups':
      return j({ AutoScalingGroups: ec2.asgs.map(g => ({ AutoScalingGroupName: g.name, MinSize: g.min, MaxSize: g.max, DesiredCapacity: g.desired, LaunchTemplate: { LaunchTemplateName: g.launchTemplate.split(' ')[0], Version: g.launchTemplate.match(/version (\d+)/)?.[1] ?? '$Latest' }, Instances: g.instances.map(id => ({ InstanceId: id, LifecycleState: 'InService', HealthStatus: 'Healthy', AvailabilityZone: ec2.instances.find(i => i.id === id)?.az })), TargetGroupARNs: [env.elb.targetGroups[0].arn] })) });
    case 'autoscaling describe-scaling-activities':
      return j({ Activities: ec2.asgs.flatMap(g => g.activities.map(act => ({ AutoScalingGroupName: g.name, Description: act.description, Cause: act.cause, StartTime: isoSec(env.now - act.minutesAgo * MIN), StatusCode: act.status }))).sort((x, y) => (x.StartTime < y.StartTime ? 1 : -1)) });
    case 'rds describe-db-instances': {
      const id = a.opts['db-instance-identifier'];
      const list = env.rds.instances.filter(i => !id || i.id === id);
      if (!list.length) return `\nAn error occurred (DBInstanceNotFound) when calling the DescribeDBInstances operation: DBInstance ${id} not found.`;
      return j({ DBInstances: list.map(i => ({ DBInstanceIdentifier: i.id, DBInstanceClass: i.class, Engine: i.engine, EngineVersion: i.version, DBInstanceStatus: i.status, Endpoint: { Address: i.endpoint, Port: 5432 }, AvailabilityZone: i.az, MultiAZ: i.multiAz, StorageType: i.storage.type, AllocatedStorage: i.storage.sizeGb, ...(i.storage.iops ? { Iops: i.storage.iops } : {}), ...(i.storage.throughputMBps ? { StorageThroughput: i.storage.throughputMBps } : {}), DBParameterGroups: [{ DBParameterGroupName: i.parameterGroup, ParameterApplyStatus: 'in-sync' }], ...(i.replicaOf ? { ReadReplicaSourceDBInstanceIdentifier: i.replicaOf } : { ReadReplicaDBInstanceIdentifiers: env.rds.instances.filter(r => r.replicaOf === i.id).map(r => r.id) }), PerformanceInsightsEnabled: true })) });
    }
    case 'rds describe-events':
      return j({ Events: env.rds.events.slice().sort((x, y) => x.minutesAgo - y.minutesAgo).map(e => ({ SourceIdentifier: e.source, SourceType: 'db-instance', Message: e.message, Date: isoSec(env.now - e.minutesAgo * MIN) })) });
    case 'cloudwatch describe-alarms': {
      const state = a.opts['state-value'];
      return j({ MetricAlarms: env.alarms.filter(al => !state || al.state === state).map(al => ({ AlarmName: al.name, StateValue: al.state, MetricName: al.metric, StateUpdatedTimestamp: isoSec(env.now - al.minutesAgo * MIN), StateReason: al.condition })) });
    }
    case 'cloudwatch get-metric-statistics':
    case 'cloudwatch get-metric-data': {
      const name = a.opts['metric-name'];
      const panels = env.metrics.filter(p => !name || p.metric.toLowerCase() === name.toLowerCase());
      if (!panels.length) return j({ Label: name, Datapoints: [] });
      const p = panels[0];
      const s = p.series[0];
      return j({ Label: p.metric, Datapoints: s.points.slice(-10).map((v, i, arr2) => ({ Timestamp: isoSec(env.now - (arr2.length - 1 - i) * p.periodMinutes * MIN), [p.stat === 'Sum' ? 'Sum' : 'Average']: v, Unit: p.unit })) });
    }
    case 'logs describe-log-groups':
      return j({ logGroups: env.logGroups.map(g => ({ logGroupName: g.name, retentionInDays: g.retentionDays, storedBytes: g.events.length * 260 })) });
    case 'logs tail':
    case 'logs filter-log-events': {
      const name = op === 'tail' ? rest[0] : a.opts['log-group-name'];
      const g = env.logGroups.find(x => x.name === name);
      if (!g) return `\nAn error occurred (ResourceNotFoundException) when calling the FilterLogEvents operation: The specified log group does not exist.`;
      const pat = (a.opts['filter-pattern'] ?? '').replace(/^"|"$/g, '').toLowerCase();
      const terms = pat.split(/\s+/).filter(Boolean);
      const hits = g.events.filter(e => terms.every(t => e.msg.toLowerCase().includes(t))).slice(-50);
      return hits.map(e => `${isoSec(e.ts)} ${e.stream ?? ''} ${e.msg}`).join('\n');
    }
    case 'iam get-role': {
      const r = env.iam.roles.find(x => x.name === a.opts['role-name']);
      if (!r) return `\nAn error occurred (NoSuchEntity) when calling the GetRole operation: The role with name ${a.opts['role-name']} cannot be found.`;
      return j({ Role: { RoleName: r.name, Arn: r.arn, Description: r.description, AssumeRolePolicyDocument: r.trust, MaxSessionDuration: 3600 } });
    }
    case 'iam list-role-policies': {
      const r = env.iam.roles.find(x => x.name === a.opts['role-name']);
      if (!r) return `\nAn error occurred (NoSuchEntity) when calling the ListRolePolicies operation: The role with name ${a.opts['role-name']} cannot be found.`;
      return j({ PolicyNames: r.policies.filter(p => p.type === 'inline').map(p => p.name) });
    }
    case 'iam list-attached-role-policies': {
      const r = env.iam.roles.find(x => x.name === a.opts['role-name']);
      if (!r) return `\nAn error occurred (NoSuchEntity) when calling the ListAttachedRolePolicies operation: The role with name ${a.opts['role-name']} cannot be found.`;
      return j({ AttachedPolicies: r.policies.filter(p => p.type !== 'inline').map(p => ({ PolicyName: p.name, PolicyArn: p.arn })) });
    }
    case 'iam get-role-policy': {
      const r = env.iam.roles.find(x => x.name === a.opts['role-name']);
      const p = r?.policies.find(x => x.name === a.opts['policy-name'] && x.type === 'inline');
      if (!r || !p) return `\nAn error occurred (NoSuchEntity) when calling the GetRolePolicy operation: The role policy with name ${a.opts['policy-name']} cannot be found.`;
      return j({ RoleName: r.name, PolicyName: p.name, PolicyDocument: p.document });
    }
    case 'iam simulate-principal-policy': {
      for (const s of env.iam.simulations) if (s.match.test(raw)) return s.output;
      const src = a.opts['policy-source-arn'] ?? '';
      const r = env.iam.roles.find(x => src.includes(x.name));
      const actions = (a.opts['action-names'] ?? '').split(/[ ,]+/).filter(Boolean);
      const resources = (a.opts['resource-arns'] ?? '*').split(/[ ,]+/).filter(Boolean);
      if (!r) return `\nAn error occurred (NoSuchEntity) when calling the SimulatePrincipalPolicy operation: Principal ${src || '(missing --policy-source-arn)'} does not exist.`;
      if (!actions.length) return '\naws: error: the following arguments are required: --action-names';
      return j({
        EvaluationResults: actions.flatMap(act =>
          resources.map(res => {
            const e = evaluate(r, act, res);
            return { EvalActionName: act, EvalResourceName: res, EvalDecision: e.decision, MatchedStatements: e.matched ? [{ SourcePolicyId: e.matched.policy, SourcePolicyType: 'IAM Policy' }] : [], MissingContextValues: [] };
          }),
        ),
      });
    }
    case 'cloudtrail lookup-events': {
      const attr = a.opts['lookup-attributes'] ?? '';
      const m = attr.match(/AttributeKey=(\w+),AttributeValue=([^\s]+)/);
      let events = env.cloudtrail.slice().sort((x, y) => x.minutesAgo - y.minutesAgo);
      if (m) {
        const [, key, val] = m;
        events = events.filter(e => (key === 'EventName' ? e.eventName === val : key === 'Username' ? e.user.includes(val) : key === 'ResourceName' ? e.resources.includes(val) : key === 'EventSource' ? e.eventSource === val : true));
      }
      const max = Number(a.opts['max-results'] ?? a.opts['max-items'] ?? 20);
      return j({ Events: events.slice(0, max).map(e => ({ EventId: `${e.eventName.length}f3a${Math.round(e.minutesAgo * 60)}-9b1c-4e2d-8a7f-${String(Math.round(e.minutesAgo * 60)).padStart(12, '0')}`, EventName: e.eventName, EventTime: isoSec(env.now - e.minutesAgo * MIN), EventSource: e.eventSource, Username: e.user, Resources: [{ ResourceName: e.resources }], CloudTrailEvent: JSON.stringify({ sourceIPAddress: e.sourceIp, userIdentity: { arn: e.user }, ...(e.errorCode ? { errorCode: e.errorCode } : {}), requestParameters: e.request ?? null }) })) });
    }
    case 'route53 list-hosted-zones':
      return j({ HostedZones: env.route53.zones.map(z => ({ Id: `/hostedzone/${z.id}`, Name: z.name + '.', Config: { PrivateZone: z.private }, ResourceRecordSetCount: z.records.length })) });
    case 'route53 list-resource-record-sets': {
      const zid = (a.opts['hosted-zone-id'] ?? '').replace('/hostedzone/', '');
      const z = env.route53.zones.find(x => x.id === zid);
      if (!z) return `\nAn error occurred (NoSuchHostedZone) when calling the ListResourceRecordSets operation: No hosted zone found with ID: ${zid || '(missing --hosted-zone-id)'}\n(hint: aws route53 list-hosted-zones)`;
      return j({ ResourceRecordSets: z.records.map(r => ({ Name: r.name + '.', Type: r.type, ...(r.alias ? { AliasTarget: { HostedZoneId: 'Z35SXDOTRQ7X7K', DNSName: r.alias.target + '.', EvaluateTargetHealth: r.alias.evaluateHealth } } : { TTL: r.ttl, ResourceRecords: r.values.map(v => ({ Value: v })) }) })) });
    }
    case 's3 ls': {
      const target = rest[0];
      const role = roleForHost(env, ctx.host.name);
      if (!target) return ['2025-03-02 11:20:41 shopfast-artifacts', '2025-01-14 09:02:17 shopfast-invoices-prod', '2025-01-14 09:02:19 shopfast-logs-archive'].join('\n');
      const bucket = target.replace('s3://', '').split('/')[0];
      if (role && evaluate(role, 's3:ListBucket', `arn:aws:s3:::${bucket}`).decision !== 'allowed' && !role.policies.some(p => p.name === 'ReadOnlyAccess'))
        return `An error occurred (AccessDenied) when calling the ListObjectsV2 operation: User: ${callerArn(env, ctx.host.name)} is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::${bucket}" because no identity-based policy allows the s3:ListBucket action`;
      const d = isoSec(env.now - 21 * MIN);
      const ymd = d.slice(0, 10);
      return ['                           PRE 2026/', `${ymd} ${d.slice(11, 19)}      48211 ${ymd.replace(/-/g, '/')}/INV-${ymd.replace(/-/g, '')}-00412.pdf`].join('\n');
    }
    case 's3 cp': {
      const [src, dst] = rest;
      if (!src || !dst) return '\nusage: aws s3 cp <LocalPath> <S3Uri> or <S3Uri> <LocalPath> or <S3Uri> <S3Uri>';
      const role = roleForHost(env, ctx.host.name);
      const upload = dst.startsWith('s3://');
      const s3uri = upload ? dst : src;
      const key = s3uri.replace('s3://', '');
      const action = upload ? 's3:PutObject' : 's3:GetObject';
      const res = `arn:aws:s3:::${key}`;
      const allowed = role ? evaluate(role, action, res).decision === 'allowed' || (!upload && role.policies.some(p => p.name === 'ReadOnlyAccess')) : false;
      if (!allowed) return `${upload ? 'upload' : 'download'} failed: ${src} to ${dst} An error occurred (AccessDenied) when calling the ${upload ? 'PutObject' : 'GetObject'} operation: User: ${callerArn(env, ctx.host.name)} is not authorized to perform: ${action} on resource: "${res}" because no identity-based policy allows the ${action} action`;
      if (upload && !(src in ctx.host.files) && !src.startsWith('/') && !src.startsWith('-')) {
        return `upload: ${src} to ${dst}`;
      }
      return `${upload ? 'upload' : 'download'}: ${src} to ${dst}`;
    }
    case 'secretsmanager get-secret-value':
      return `\nAn error occurred (AccessDeniedException) when calling the GetSecretValue operation: [simulation] secrets are redacted in this training environment.`;
    case 'configure list':
      return `      Name                    Value             Type    Location\n      ----                    -----             ----    --------\n   profile                <not set>             None    None\naccess_key     ****************7Q2K         iam-role    \nsecret_key     ****************d9Xa         iam-role    \n    region                us-east-1      config-file    ~/.aws/config`;
  }
  if (/^(create|delete|put|update|modify|authorize|revoke|attach|detach|start|stop|terminate|reboot|set|run|register|deregister|associate|disassociate|replace|restore|promote|reset|add|remove)-/.test(op) || ['rm', 'mv', 'sync', 'mb', 'rb'].includes(op)) {
    return READ_ONLY;
  }
  return `[simulation] \`aws ${service} ${op}\` is not simulated.\n\n${AWS_HELP}`;
}

const AWS_HELP = `Simulated AWS CLI commands:
  aws sts get-caller-identity
  aws ec2 describe-instances [--instance-ids i-...]
  aws ec2 describe-security-groups [--group-ids sg-...]
  aws ec2 describe-route-tables | describe-nat-gateways | describe-subnets | describe-images
  aws elbv2 describe-load-balancers | describe-target-groups
  aws elbv2 describe-target-health --target-group-arn <arn>
  aws autoscaling describe-auto-scaling-groups | describe-scaling-activities
  aws rds describe-db-instances [--db-instance-identifier id] | describe-events
  aws cloudwatch describe-alarms [--state-value ALARM]
  aws logs describe-log-groups | tail <group> | filter-log-events --log-group-name <g> --filter-pattern <p>
  aws iam get-role | list-role-policies | list-attached-role-policies --role-name <r>
  aws iam get-role-policy --role-name <r> --policy-name <p>
  aws iam simulate-principal-policy --policy-source-arn <role-arn> --action-names <a> --resource-arns <arn>
  aws cloudtrail lookup-events [--lookup-attributes AttributeKey=EventName,AttributeValue=<name>]
  aws route53 list-hosted-zones | list-resource-record-sets --hosted-zone-id <id>
  aws s3 ls [s3://bucket] | aws s3 cp <src> <dst>`;
