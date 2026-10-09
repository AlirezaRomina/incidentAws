import type { Database, Environment, Host, MetricPanel, PolicyDocument, Process, ServiceStatus } from '../engine/types';
import { series } from '../engine/timeseries';
import { MIN, isoSec, pgTime, syslogTime, systemdTime } from '../engine/time';
import { createRng } from '../engine/rng';

/**
 * The healthy ShopFast production environment (us-east-1).
 *
 *   Route 53 (api.shopfast.io) -> ALB shopfast-prod-alb -> ASG shopfast-checkout-asg
 *   (app-1, app-2, app-3: nginx :80 -> node checkout-api 127.0.0.1:3000)
 *   -> RDS PostgreSQL checkout-db (+ read replica checkout-db-replica-1), ElastiCache Redis,
 *   S3 shopfast-invoices-prod, SQS orders queue, NAT gateway for egress to PayBridge.
 *
 * Incidents mutate a fresh copy of this in their `build()`.
 */

export const IDS = {
  account: '481562039374',
  vpc: 'vpc-0e4a7c9b21f35d806',
  ami: 'ami-0c1d7a3b5e9f24a61',
  amiName: 'shopfast-app-al2023-2026.09.18',
  albSg: 'sg-0a71c3e9d5b2f4810',
  appSg: 'sg-0b52e8f1a6c3d7924',
  dbSg: 'sg-0c93f4a2b7e1d5036',
  bastionSg: 'sg-0d14a6b8c2e9f3157',
  workerSg: 'sg-0e25b7c9d3f1a4268',
  albDns: 'shopfast-prod-alb-1793452210.us-east-1.elb.amazonaws.com',
  albArn: 'arn:aws:elasticloadbalancing:us-east-1:481562039374:loadbalancer/app/shopfast-prod-alb/6f1e2d3c4b5a6978',
  tgArn: 'arn:aws:elasticloadbalancing:us-east-1:481562039374:targetgroup/checkout-api-tg/1a2b3c4d5e6f7081',
  rdsEndpoint: 'checkout-db.c9xk2mfq1abc.us-east-1.rds.amazonaws.com',
  replicaEndpoint: 'checkout-db-replica-1.c9xk2mfq1abc.us-east-1.rds.amazonaws.com',
  redisEndpoint: 'checkout-cache.u7fq2a.ng.0001.use1.cache.amazonaws.com',
  natGw: 'nat-0f3c2a91b8e7d6540',
  rtbPublic: 'rtb-0a1f2e3d4c5b6a798',
  rtbPrivateA: 'rtb-0b2e3f4a5c6d7e819',
  rtbPrivateB: 'rtb-0c3f4a5b6d7e8f920',
  igw: 'igw-0d4a5b6c7e8f9a031',
  subnets: {
    publicA: 'subnet-0a11b22c33d44e551',
    publicB: 'subnet-0b22c33d44e55f662',
    appA: 'subnet-0c33d44e55f66a773',
    appB: 'subnet-0d44e55f66a77b884',
    dbA: 'subnet-0e55f66a77b88c995',
    dbB: 'subnet-0f66a77b88c99d0a6',
  },
};

export const APP_HOSTS = ['app-1', 'app-2', 'app-3'] as const;

const HOSTS_META = {
  bastion: { hostname: 'ip-10-0-0-12', ip: '10.0.0.12', id: 'i-04d1e9b2a7c3f5e68', az: 'us-east-1a', subnet: IDS.subnets.publicA },
  'app-1': { hostname: 'ip-10-0-10-23', ip: '10.0.10.23', id: 'i-0a3f9c1e7b2d40851', az: 'us-east-1a', subnet: IDS.subnets.appA },
  'app-2': { hostname: 'ip-10-0-11-87', ip: '10.0.11.87', id: 'i-0b7e21d94c6a3f102', az: 'us-east-1b', subnet: IDS.subnets.appB },
  'app-3': { hostname: 'ip-10-0-10-142', ip: '10.0.10.142', id: 'i-0c58d0a6e19f7b334', az: 'us-east-1a', subnet: IDS.subnets.appA },
  'worker-1': { hostname: 'ip-10-0-11-204', ip: '10.0.11.204', id: 'i-09f2c4b6d8e1a3057', az: 'us-east-1b', subnet: IDS.subnets.appB },
} as const;
export type HostName = keyof typeof HOSTS_META;
export const hostMeta = HOSTS_META;

const json = (v: unknown) => JSON.stringify(v, null, 2);

function baseProcesses(role: Host['role'], seedOffset: number): Process[] {
  const common: Process[] = [
    { pid: 1, user: 'root', cpu: 0, mem: 0.1, vszKb: 108412, rssKb: 16840, stat: 'Ss', start: 'Sep27', time: '0:41', command: '/usr/lib/systemd/systemd --switched-root --system --deserialize=32' },
    { pid: 412, user: 'root', cpu: 0, mem: 0.2, vszKb: 52168, rssKb: 21544, stat: 'Ss', start: 'Sep27', time: '0:18', command: '/usr/lib/systemd/systemd-journald' },
    { pid: 798, user: 'chrony', cpu: 0, mem: 0, vszKb: 84652, rssKb: 3920, stat: 'S', start: 'Sep27', time: '0:02', command: '/usr/sbin/chronyd -F 2' },
    { pid: 812, user: 'root', cpu: 0, mem: 0.1, vszKb: 15420, rssKb: 9112, stat: 'Ss', start: 'Sep27', time: '0:00', command: 'sshd: /usr/sbin/sshd -D [listener] 0 of 10-100 startups' },
    { pid: 921, user: 'root', cpu: 0.1, mem: 0.3, vszKb: 1491268, rssKb: 27360, stat: 'Ssl', start: 'Sep27', time: '9:12', command: '/usr/bin/amazon-ssm-agent' },
    { pid: 1043, user: 'cwagent', cpu: 0.2, mem: 0.6, vszKb: 1820740, rssKb: 51288, stat: 'Ssl', start: 'Sep27', time: '21:44', command: '/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent -config /opt/aws/amazon-cloudwatch-agent/etc/amazon-cloudwatch-agent.toml' },
    { pid: 1102, user: 'root', cpu: 0, mem: 0, vszKb: 226128, rssKb: 3200, stat: 'Ss', start: 'Sep27', time: '0:01', command: '/usr/sbin/crond -n' },
  ];
  if (role === 'app') {
    return [
      ...common,
      { pid: 1311, user: 'root', cpu: 0, mem: 0.1, vszKb: 39876, rssKb: 6440, stat: 'Ss', start: 'Sep27', time: '0:00', command: 'nginx: master process /usr/sbin/nginx' },
      { pid: 1312, user: 'nginx', cpu: 0.6, mem: 0.2, vszKb: 41620, rssKb: 10212, stat: 'S', start: 'Sep27', time: '38:12', command: 'nginx: worker process' },
      { pid: 1313, user: 'nginx', cpu: 0.5, mem: 0.2, vszKb: 41620, rssKb: 10180, stat: 'S', start: 'Sep27', time: '37:55', command: 'nginx: worker process' },
      { pid: 2841 + seedOffset, user: 'shopfast', cpu: 11.4, mem: 7.1, vszKb: 11843960, rssKb: 584112, stat: 'Ssl', start: 'Oct08', time: '142:31', command: 'node --max-old-space-size=1536 /opt/checkout-api/dist/server.js' },
    ];
  }
  if (role === 'worker') {
    return [
      ...common,
      { pid: 3120, user: 'shopfast', cpu: 1.2, mem: 3.4, vszKb: 1083144, rssKb: 278120, stat: 'Ssl', start: 'Oct07', time: '12:03', command: 'node /opt/shopfast-worker/dist/consumer.js --queue orders-prod' },
    ];
  }
  return [...common, { pid: 30118, user: 'ec2-user', cpu: 0, mem: 0.1, vszKb: 222652, rssKb: 5112, stat: 'Ss', start: '14:41', time: '0:00', command: '-bash' }];
}

const APP_ENV: Record<string, string> = {
  NODE_ENV: 'production',
  PORT: '3000',
  LOG_LEVEL: 'info',
  APP_VERSION: '2.13.1',
  DB_HOST: 'db.internal.shopfast.io',
  DB_READ_HOST: 'db-ro.internal.shopfast.io',
  DB_NAME: 'checkout',
  DB_USER: 'checkout_app',
  DB_POOL_MAX: '20',
  DB_POOL_IDLE_TIMEOUT_MS: '10000',
  READS_FROM_REPLICA: 'false',
  REDIS_URL: `redis://cache.internal.shopfast.io:6379`,
  INVOICE_BUCKET: 'shopfast-invoices-prod',
  ORDERS_QUEUE_URL: `https://sqs.us-east-1.amazonaws.com/${IDS.account}/orders-prod`,
  PAYBRIDGE_API_URL: 'https://api.paybridge.com/v2',
  PAYBRIDGE_TIMEOUT_MS: '10000',
  HTTP_KEEPALIVE: 'true',
  AWS_REGION: 'us-east-1',
  WEB_CONCURRENCY: '2',
};

function appService(now: number, pid: number): ServiceStatus {
  const started = now - 18 * 60 * MIN - 22 * MIN;
  return {
    name: 'checkout-api',
    description: 'ShopFast checkout API (Node.js)',
    active: 'active (running)',
    since: `${systemdTime(started)}; 18h ago`,
    mainPid: pid,
    memory: '571.2M',
    tasks: 23,
    execStart: '/usr/bin/node --max-old-space-size=1536 /opt/checkout-api/dist/server.js',
    restarts: 0,
    journal: [
      `${syslogTime(started - 2000)} HOST systemd[1]: Starting checkout-api.service - ShopFast checkout API (Node.js)...`,
      `${syslogTime(started)} HOST systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`,
      `${syslogTime(started + 900)} HOST node[${pid}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20}}`,
      `${syslogTime(started + 1100)} HOST node[${pid}]: {"level":30,"msg":"connected to redis","url":"redis://cache.internal.shopfast.io:6379"}`,
      `${syslogTime(started + 1300)} HOST node[${pid}]: {"level":30,"msg":"checkout-api v2.13.1 listening on 127.0.0.1:3000"}`,
    ],
  };
}

function nginxService(now: number): ServiceStatus {
  const started = now - 12 * 1440 * MIN - 4 * 60 * MIN;
  return {
    name: 'nginx',
    description: 'The nginx HTTP and reverse proxy server',
    active: 'active (running)',
    since: `${systemdTime(started)}; 1 week 5 days ago`,
    mainPid: 1311,
    memory: '14.6M',
    tasks: 3,
    execStart: '/usr/sbin/nginx',
    journal: [
      `${syslogTime(started - 1200)} HOST systemd[1]: Starting nginx.service - The nginx HTTP and reverse proxy server...`,
      `${syslogTime(started - 400)} HOST nginx[1309]: nginx: the configuration file /etc/nginx/nginx.conf syntax is ok`,
      `${syslogTime(started - 380)} HOST nginx[1309]: nginx: configuration file /etc/nginx/nginx.conf test is successful`,
      `${syslogTime(started)} HOST systemd[1]: Started nginx.service - The nginx HTTP and reverse proxy server.`,
    ],
  };
}

function chronyService(now: number): ServiceStatus {
  const started = now - 12 * 1440 * MIN - 4 * 60 * MIN - 3 * MIN;
  return {
    name: 'chronyd',
    description: 'NTP client/server',
    active: 'active (running)',
    since: `${systemdTime(started)}; 1 week 5 days ago`,
    mainPid: 798,
    memory: '1.9M',
    tasks: 1,
    execStart: '/usr/sbin/chronyd -F 2',
    journal: [
      `${syslogTime(started)} HOST chronyd[798]: chronyd version 4.3 starting (+CMDMON +NTP +REFCLOCK +RTC +PRIVDROP +SCFILTER +SIGND +ASYNCDNS +NTS +SECHASH +IPV6 +DEBUG)`,
      `${syslogTime(started + 4000)} HOST chronyd[798]: Selected source 169.254.169.123`,
      `${syslogTime(started + 9000)} HOST chronyd[798]: System clock TAI offset set to 37 seconds`,
    ],
  };
}

const NGINX_CONF = `user nginx;
worker_processes auto;
error_log /var/log/nginx/error.log notice;
pid /run/nginx.pid;

events {
    worker_connections 4096;
}

http {
    log_format timed '$remote_addr - $remote_user [$time_local] "$request" $status $body_bytes_sent '
                     '"$http_referer" "$http_user_agent" rt=$request_time uct=$upstream_connect_time '
                     'urt=$upstream_response_time rid=$request_id';
    access_log /var/log/nginx/access.log timed;

    sendfile on;
    keepalive_timeout 75s;
    client_max_body_size 10m;
    client_body_temp_path /var/lib/nginx/tmp/client_body;
    proxy_temp_path /var/lib/nginx/tmp/proxy;

    include /etc/nginx/conf.d/*.conf;
}
`;

const CHECKOUT_CONF = `upstream checkout_api {
    server 127.0.0.1:3000;
    keepalive 64;
}

server {
    listen 80 default_server;
    server_name api.shopfast.io;

    location = /health {
        proxy_pass http://checkout_api/health;
        access_log /var/log/nginx/access.log timed;
    }

    location / {
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header X-Request-Id $request_id;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_connect_timeout 5s;
        proxy_read_timeout 30s;
        proxy_pass http://checkout_api;
    }
}
`;

const SYSCTL_DEFAULT: Record<string, string> = {
  'net.ipv4.ip_local_port_range': '32768\t60999',
  'net.ipv4.tcp_fin_timeout': '60',
  'net.ipv4.tcp_tw_reuse': '2',
  'net.core.somaxconn': '4096',
  'net.ipv4.tcp_max_syn_backlog': '4096',
  'net.netfilter.nf_conntrack_max': '262144',
  'fs.file-max': '9223372036854775807',
  'vm.swappiness': '60',
  'vm.overcommit_memory': '0',
  'kernel.pid_max': '4194304',
};

function makeHost(name: HostName, now: number, idx: number): Host {
  const m = HOSTS_META[name];
  const role: Host['role'] = name === 'bastion' ? 'bastion' : name.startsWith('app') ? 'app' : 'worker';
  const isApp = role === 'app';
  const appPid = 2841 + idx * 17;
  const mem =
    role === 'bastion'
      ? { totalMb: 1910, usedMb: 412, freeMb: 702, buffCacheMb: 796, swapTotalMb: 0, swapUsedMb: 0 }
      : { totalMb: 7802, usedMb: isApp ? 1840 + idx * 61 : 1310, freeMb: isApp ? 3920 - idx * 40 : 4200, buffCacheMb: isApp ? 2042 : 2292, swapTotalMb: 0, swapUsedMb: 0 };
  const cpuUser = isApp ? 9.8 + idx * 1.3 : 1.1;
  const services: Record<string, ServiceStatus> = {
    chronyd: chronyService(now),
    sshd: {
      name: 'sshd',
      description: 'OpenSSH server daemon',
      active: 'active (running)',
      since: `${systemdTime(now - 12 * 1440 * MIN)}; 1 week 5 days ago`,
      mainPid: 812,
      memory: '5.1M',
      tasks: 1,
      execStart: '/usr/sbin/sshd -D $OPTIONS',
      journal: [`${syslogTime(now - 11 * MIN)} HOST sshd[30112]: Accepted publickey for ec2-user from 10.0.0.12 port 51844 ssh2: ED25519 SHA256:q2yR8m3N0pXb5u...`],
    },
    'amazon-cloudwatch-agent': {
      name: 'amazon-cloudwatch-agent',
      description: 'Amazon CloudWatch Agent',
      active: 'active (running)',
      since: `${systemdTime(now - 12 * 1440 * MIN)}; 1 week 5 days ago`,
      mainPid: 1043,
      memory: '49.8M',
      tasks: 11,
      execStart: '/opt/aws/amazon-cloudwatch-agent/bin/start-amazon-cloudwatch-agent',
      journal: [],
    },
  };
  if (isApp) {
    services['checkout-api'] = appService(now, appPid);
    services.nginx = nginxService(now);
  }
  if (role === 'worker') {
    services['shopfast-worker'] = {
      name: 'shopfast-worker',
      description: 'ShopFast order queue consumer',
      active: 'active (running)',
      since: `${systemdTime(now - 2 * 1440 * MIN)}; 2 days ago`,
      mainPid: 3120,
      memory: '271.4M',
      tasks: 12,
      execStart: '/usr/bin/node /opt/shopfast-worker/dist/consumer.js --queue orders-prod',
      journal: [],
    };
  }
  for (const s of Object.values(services)) s.journal = s.journal.map(l => l.replace(' HOST ', ` ${m.hostname} `));

  const files: Record<string, string> = {
    '/etc/os-release': `NAME="Amazon Linux"\nVERSION="2023"\nID="amzn"\nVERSION_ID="2023"\nPLATFORM_ID="platform:al2023"\nPRETTY_NAME="Amazon Linux 2023.5.20240916"\n`,
    '/etc/hostname': m.hostname + '\n',
    '/etc/resolv.conf': `# Generated by systemd-resolved\nnameserver 10.0.0.2\nsearch ec2.internal\noptions edns0 trust-ad\n`,
    '/etc/hosts': `127.0.0.1   localhost localhost.localdomain\n::1         localhost6 localhost6.localdomain6\n${m.ip}  ${m.hostname}.ec2.internal ${m.hostname}\n`,
    '/etc/chrony.conf': `# Use the Amazon Time Sync Service (link-local, available in every VPC)\nserver 169.254.169.123 prefer iburst minpoll 4 maxpoll 4\n\n# Use public servers from the pool.ntp.org project as backup\npool 2.amazon.pool.ntp.org iburst\n\ndriftfile /var/lib/chrony/drift\nmakestep 1.0 3\nrtcsync\nlogdir /var/log/chrony\n`,
    '/etc/sysctl.conf': `# sysctl settings are defined through files in\n# /usr/lib/sysctl.d/, /run/sysctl.d/, and /etc/sysctl.d/.\nvm.swappiness = 60\nnet.core.somaxconn = 4096\n`,
    '/var/log/messages': '',
    '/home/ec2-user/.bash_history': `sudo systemctl status checkout-api\ndf -h\ntail -f /var/log/nginx/access.log\n`,
  };
  if (isApp) {
    files['/etc/nginx/nginx.conf'] = NGINX_CONF;
    files['/etc/nginx/conf.d/checkout.conf'] = CHECKOUT_CONF;
    files['/etc/checkout-api/env'] = Object.entries(APP_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\nDB_PASSWORD_SECRET_ARN=arn:aws:secretsmanager:us-east-1:481562039374:secret:prod/checkout/db-Xk2P9q\n';
    files['/etc/systemd/system/checkout-api.service'] = `[Unit]\nDescription=ShopFast checkout API (Node.js)\nAfter=network-online.target\n\n[Service]\nUser=shopfast\nEnvironmentFile=/etc/checkout-api/env\nExecStart=/usr/bin/node --max-old-space-size=1536 /opt/checkout-api/dist/server.js\nRestart=always\nRestartSec=2\nLimitNOFILE=65535\n\n[Install]\nWantedBy=multi-user.target\n`;
    files['/opt/checkout-api/package.json'] = json({ name: 'checkout-api', version: '2.13.1', main: 'dist/server.js', dependencies: { fastify: '4.28.1', pg: '8.12.0', ioredis: '5.4.1', '@aws-sdk/client-s3': '3.658.1', '@aws-sdk/client-sqs': '3.658.1', undici: '6.19.8', pino: '9.4.0' } }) + '\n';
    files['/var/log/nginx/access.log'] = '';
    files['/var/log/nginx/error.log'] = '';
    files['/var/log/checkout-api/app.log'] = '';
  }
  if (role === 'worker') {
    files['/opt/shopfast-worker/config.json'] = json({ queue: 'orders-prod', concurrency: 8, visibilityTimeoutSec: 60 }) + '\n';
  }

  const rootUsed = isApp ? 11.6 + idx * 0.7 : role === 'worker' ? 8.9 : 4.1;
  return {
    name,
    hostname: m.hostname,
    ip: m.ip,
    role,
    instanceId: m.id,
    user: 'ec2-user',
    os: 'Amazon Linux 2023',
    kernel: '6.1.109-118.189.amzn2023.x86_64',
    uptime: '12 days,  4:11',
    users: 1,
    load: isApp ? [0.42 + idx * 0.05, 0.47, 0.51] : [0.03, 0.05, 0.01],
    cpu: { cores: role === 'bastion' ? 1 : 2, user: cpuUser, system: 2.1, iowait: 0.1, steal: 0.0, idle: 100 - cpuUser - 2.2 },
    memory: mem,
    disks: [
      { fs: '/dev/nvme0n1p1', type: 'xfs', sizeGb: role === 'bastion' ? 8 : 50, usedGb: rootUsed, mount: '/', inodesUsedPct: 4 },
      { fs: 'devtmpfs', type: 'devtmpfs', sizeGb: 4, usedGb: 0, mount: '/dev' },
      { fs: 'tmpfs', type: 'tmpfs', sizeGb: 3.9, usedGb: 0, mount: '/dev/shm' },
      { fs: 'tmpfs', type: 'tmpfs', sizeGb: 1.6, usedGb: 0.0005, mount: '/run' },
      { fs: '/dev/nvme0n1p128', type: 'vfat', sizeGb: 0.01, usedGb: 0.0013, mount: '/boot/efi' },
    ],
    du: isApp
      ? {
          '/var/log': [['1.3G', '/var/log/journal'], ['412M', '/var/log/nginx'], ['188M', '/var/log/checkout-api'], ['21M', '/var/log/amazon'], ['3.1M', '/var/log/messages'], ['1.9G', '/var/log']],
          '/': [['2.9G', '/usr'], ['1.9G', '/var'], ['5.6G', '/opt'], ['412M', '/home'], ['78M', '/etc'], ['11G', '/']],
          '/var/log/checkout-api': [['188M', '/var/log/checkout-api/app.log'], ['188M', '/var/log/checkout-api']],
        }
      : { '/var/log': [['640M', '/var/log/journal'], ['2.2M', '/var/log/messages'], ['650M', '/var/log']] },
    processes: baseProcesses(role, idx * 17),
    sockets: isApp
      ? {
          established: 142 + idx * 9,
          timeWait: 311 + idx * 23,
          closeWait: 0,
          listen: [
            { addr: '0.0.0.0:80', process: 'nginx' },
            { addr: '127.0.0.1:3000', process: 'node' },
            { addr: '0.0.0.0:22', process: 'sshd' },
            { addr: '127.0.0.1:25', process: 'master' },
          ],
          sample: [
            { state: 'ESTAB', local: `${m.ip}:80`, peer: '10.0.0.71:41922', process: 'nginx' },
            { state: 'ESTAB', local: `${m.ip}:80`, peer: '10.0.1.163:28410', process: 'nginx' },
            { state: 'ESTAB', local: '127.0.0.1:48812', peer: '127.0.0.1:3000', process: 'nginx' },
            { state: 'ESTAB', local: '127.0.0.1:3000', peer: '127.0.0.1:48812', process: 'node' },
            { state: 'ESTAB', local: `${m.ip}:51210`, peer: '10.0.20.57:5432', process: 'node' },
            { state: 'ESTAB', local: `${m.ip}:51224`, peer: '10.0.20.57:5432', process: 'node' },
            { state: 'ESTAB', local: `${m.ip}:51236`, peer: '10.0.20.57:5432', process: 'node' },
            { state: 'ESTAB', local: `${m.ip}:40112`, peer: '10.0.20.88:6379', process: 'node' },
            { state: 'ESTAB', local: `${m.ip}:58630`, peer: '104.18.32.7:443', process: 'node' },
            { state: 'TIME-WAIT', local: `${m.ip}:80`, peer: '10.0.0.204:61002' },
            { state: 'ESTAB', local: `${m.ip}:22`, peer: '10.0.0.12:51844', process: 'sshd' },
          ],
        }
      : {
          established: role === 'worker' ? 18 : 3,
          timeWait: 4,
          closeWait: 0,
          listen: [{ addr: '0.0.0.0:22', process: 'sshd' }],
          sample: [{ state: 'ESTAB', local: `${m.ip}:22`, peer: role === 'bastion' ? '203.0.113.48:60214' : '10.0.0.12:51902', process: 'sshd' }],
        },
    sysctl: { ...SYSCTL_DEFAULT },
    env: isApp ? { ...APP_ENV } : role === 'worker' ? { NODE_ENV: 'production', DB_HOST: 'db.internal.shopfast.io', AWS_REGION: 'us-east-1' } : { AWS_REGION: 'us-east-1', AWS_DEFAULT_OUTPUT: 'json' },
    services,
    files,
    fileMeta: {},
    dmesg: [
      '[    0.000000] Linux version 6.1.109-118.189.amzn2023.x86_64 (mockbuild@ip-10-0-56-120) (gcc (GCC) 11.4.1 20230605) #1 SMP PREEMPT_DYNAMIC',
      '[    0.000000] Command line: BOOT_IMAGE=(hd0,gpt1)/boot/vmlinuz-6.1.109 root=UUID=7b1c3f0e-1a2b-4c5d-9e8f-0a1b2c3d4e5f ro console=tty0 console=ttyS0,115200n8 nvme_core.io_timeout=4294967295',
      '[    0.412088] ena 0000:00:05.0: Elastic Network Adapter (ENA) v2.12.0g',
      '[    1.201644] nvme nvme0: 2/0/0 default/read/poll queues',
      '[    1.889103] XFS (nvme0n1p1): Mounting V5 Filesystem 7b1c3f0e-1a2b-4c5d-9e8f-0a1b2c3d4e5f',
      '[    2.011410] XFS (nvme0n1p1): Ending clean mount',
      '[    4.556201] ena 0000:00:05.0 ens5: Link is up',
    ],
    time: { offsetSeconds: 0, ntpSynced: true, chronyRunning: true, timezone: 'UTC' },
    commandOverrides: [],
  };
}

/* ------------------------------------------------------------------ */

function panels(now: number): MetricPanel[] {
  const appCpu = (name: string, base: number) => ({ name, points: series(`cpu-${name}-${now}`, base, { noise: 0.12 }).wave(0.08).clamp(0, 100).build() });
  const p = (
    id: string,
    group: string,
    namespace: string,
    metric: string,
    resource: string,
    unit: string,
    stat: string,
    points: number[],
    extra: Partial<MetricPanel> = {},
  ): MetricPanel => ({ id, group, namespace, metric, resource, unit, stat, periodMinutes: 1, series: [{ name: resource, points }], ...extra });
  const s = (id: string, base: number, noise = 0.08, dec = 1) => series(`${id}-${now}`, base, { noise }).wave(0.06).clamp(0).round(dec).build();
  return [
    p('alb.requests', 'Application Load Balancer', 'AWS/ApplicationELB', 'RequestCount', 'shopfast-prod-alb', 'Count', 'Sum', s('alb.requests', 2380, 0.05, 0), { featured: true }),
    p('alb.latency', 'Application Load Balancer', 'AWS/ApplicationELB', 'TargetResponseTime', 'shopfast-prod-alb', 'Seconds', 'p99', s('alb.latency', 0.41, 0.12, 3), { featured: true, threshold: 2 }),
    p('alb.target5xx', 'Application Load Balancer', 'AWS/ApplicationELB', 'HTTPCode_Target_5XX_Count', 'shopfast-prod-alb', 'Count', 'Sum', s('alb.t5xx', 1.4, 0.9, 0), { featured: true, threshold: 50 }),
    p('alb.elb5xx', 'Application Load Balancer', 'AWS/ApplicationELB', 'HTTPCode_ELB_5XX_Count', 'shopfast-prod-alb', 'Count', 'Sum', s('alb.e5xx', 0.3, 1, 0), { threshold: 50 }),
    p('alb.healthy', 'Application Load Balancer', 'AWS/ApplicationELB', 'HealthyHostCount', 'checkout-api-tg', 'Count', 'Minimum', new Array(180).fill(3)),
    p('alb.unhealthy', 'Application Load Balancer', 'AWS/ApplicationELB', 'UnHealthyHostCount', 'checkout-api-tg', 'Count', 'Maximum', new Array(180).fill(0), { threshold: 1 }),
    {
      id: 'ec2.cpu', group: 'EC2', namespace: 'AWS/EC2', metric: 'CPUUtilization', resource: 'shopfast-checkout-asg', unit: '%', stat: 'Average', periodMinutes: 1, featured: true,
      series: [appCpu('app-1', 18), appCpu('app-2', 21), appCpu('app-3', 19)],
    },
    {
      id: 'ec2.mem', group: 'EC2', namespace: 'CWAgent', metric: 'mem_used_percent', resource: 'shopfast-checkout-asg', unit: '%', stat: 'Average', periodMinutes: 1,
      series: ['app-1', 'app-2', 'app-3'].map((n, i) => ({ name: n, points: series(`mem-${n}-${now}`, 23.6 + i * 0.8, { noise: 0.01 }).build() })),
    },
    {
      id: 'ec2.disk', group: 'EC2', namespace: 'CWAgent', metric: 'disk_used_percent', resource: 'shopfast-checkout-asg (path=/)', unit: '%', stat: 'Maximum', periodMinutes: 1, threshold: 85,
      series: ['app-1', 'app-2', 'app-3'].map((n, i) => ({ name: n, points: series(`disk-${n}-${now}`, 23.2 + i * 1.4, { noise: 0.002 }).build() })),
    },
    p('rds.cpu', 'RDS', 'AWS/RDS', 'CPUUtilization', 'checkout-db', '%', 'Average', s('rds.cpu', 24, 0.1), { featured: true, threshold: 80 }),
    p('rds.connections', 'RDS', 'AWS/RDS', 'DatabaseConnections', 'checkout-db', 'Count', 'Average', s('rds.conn', 64, 0.05, 0), { featured: true }),
    p('rds.memory', 'RDS', 'AWS/RDS', 'FreeableMemory', 'checkout-db', 'MB', 'Average', s('rds.mem', 6120, 0.01, 0)),
    p('rds.readiops', 'RDS', 'AWS/RDS', 'ReadIOPS', 'checkout-db', 'Count/Second', 'Average', s('rds.riops', 310, 0.15, 0)),
    p('rds.writeiops', 'RDS', 'AWS/RDS', 'WriteIOPS', 'checkout-db', 'Count/Second', 'Average', s('rds.wiops', 540, 0.12, 0)),
    p('rds.readlatency', 'RDS', 'AWS/RDS', 'ReadLatency', 'checkout-db', 'ms', 'Average', s('rds.rlat', 0.9, 0.15, 2)),
    p('rds.writelatency', 'RDS', 'AWS/RDS', 'WriteLatency', 'checkout-db', 'ms', 'Average', s('rds.wlat', 1.4, 0.15, 2)),
    p('rds.queue', 'RDS', 'AWS/RDS', 'DiskQueueDepth', 'checkout-db', 'Count', 'Average', s('rds.queue', 0.6, 0.3, 2)),
    p('rds.storage', 'RDS', 'AWS/RDS', 'FreeStorageSpace', 'checkout-db', 'GB', 'Average', series(`rds.storage-${now}`, 251.4, { noise: 0.0005 }).round(1).build()),
    p('replica.lag', 'RDS', 'AWS/RDS', 'ReplicaLag', 'checkout-db-replica-1', 'Seconds', 'Maximum', s('replica.lag', 0.4, 0.6, 1), { threshold: 30 }),
    p('replica.cpu', 'RDS', 'AWS/RDS', 'CPUUtilization', 'checkout-db-replica-1', '%', 'Average', s('replica.cpu', 9, 0.15)),
    p('cache.cpu', 'ElastiCache', 'AWS/ElastiCache', 'EngineCPUUtilization', 'checkout-cache-001', '%', 'Average', s('cache.cpu', 6.5, 0.12)),
    p('cache.hitrate', 'ElastiCache', 'AWS/ElastiCache', 'CacheHitRate', 'checkout-cache-001', '%', 'Average', series(`cache.hit-${now}`, 94.2, { noise: 0.01 }).clamp(0, 100).build()),
    p('cache.evictions', 'ElastiCache', 'AWS/ElastiCache', 'Evictions', 'checkout-cache-001', 'Count', 'Sum', s('cache.evict', 0.2, 1, 0)),
    p('app.checkoutLatency', 'Application (ShopFast/Checkout)', 'ShopFast/Checkout', 'CheckoutLatency', 'checkout-api', 'ms', 'p99', s('app.lat', 380, 0.12, 0), { featured: true, threshold: 2000 }),
    p('app.orders', 'Application (ShopFast/Checkout)', 'ShopFast/Checkout', 'OrdersPlaced', 'checkout-api', 'Count', 'Sum', s('app.orders', 61, 0.15, 0), { featured: true }),
    p('app.paymentErrors', 'Application (ShopFast/Checkout)', 'ShopFast/Checkout', 'PaymentProviderErrors', 'checkout-api', 'Count', 'Sum', s('app.payerr', 0.3, 1, 0)),
    p('nat.active', 'VPC', 'AWS/NATGateway', 'ActiveConnectionCount', IDS.natGw, 'Count', 'Maximum', s('nat.active', 412, 0.1, 0)),
    p('nat.bytesOut', 'VPC', 'AWS/NATGateway', 'BytesOutToDestination', IDS.natGw, 'MB', 'Sum', s('nat.bytes', 38, 0.15, 1)),
  ];
}

/* ------------------------------------------------------------------ */

const pol = (Statement: Record<string, unknown>[]): PolicyDocument => ({ Version: '2012-10-17', Statement });

const TABLE_ORDERS = `                                        Table "public.orders"
     Column      |           Type           | Collation | Nullable |              Default
-----------------+--------------------------+-----------+----------+-----------------------------------
 id              | bigint                   |           | not null | nextval('orders_id_seq'::regclass)
 public_id       | text                     |           | not null |
 customer_id     | bigint                   |           | not null |
 status          | text                     |           | not null | 'pending'::text
 total_cents     | integer                  |           | not null |
 currency        | character(3)             |           | not null | 'USD'::bpchar
 payment_ref     | text                     |           |          |
 created_at      | timestamp with time zone |           | not null | now()
 updated_at      | timestamp with time zone |           | not null | now()
Indexes:
    "orders_pkey" PRIMARY KEY, btree (id)
    "orders_public_id_key" UNIQUE CONSTRAINT, btree (public_id)
    "idx_orders_created_at" btree (created_at)
    "idx_orders_customer_id_status" btree (customer_id, status)
Foreign-key constraints:
    "orders_customer_id_fkey" FOREIGN KEY (customer_id) REFERENCES customers(id)
Referenced by:
    TABLE "order_items" CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id)
    TABLE "payments" CONSTRAINT "payments_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id)
`;

const TABLE_ORDER_ITEMS = `                                   Table "public.order_items"
   Column    |  Type   | Collation | Nullable |                 Default
-------------+---------+-----------+----------+-----------------------------------------
 id          | bigint  |           | not null | nextval('order_items_id_seq'::regclass)
 order_id    | bigint  |           | not null |
 sku         | text    |           | not null |
 quantity    | integer |           | not null |
 price_cents | integer |           | not null |
Indexes:
    "order_items_pkey" PRIMARY KEY, btree (id)
    "idx_order_items_order_id" btree (order_id)
Foreign-key constraints:
    "order_items_order_id_fkey" FOREIGN KEY (order_id) REFERENCES orders(id)
`;

const TABLE_CUSTOMERS = `                                         Table "public.customers"
   Column   |           Type           | Collation | Nullable |                Default
------------+--------------------------+-----------+----------+---------------------------------------
 id         | bigint                   |           | not null | nextval('customers_id_seq'::regclass)
 email      | citext                   |           | not null |
 name       | text                     |           |          |
 created_at | timestamp with time zone |           | not null | now()
Indexes:
    "customers_pkey" PRIMARY KEY, btree (id)
    "customers_email_key" UNIQUE CONSTRAINT, btree (email)
`;

const TABLE_PAYMENTS = `                                         Table "public.payments"
    Column     |           Type           | Collation | Nullable |               Default
---------------+--------------------------+-----------+----------+--------------------------------------
 id            | bigint                   |           | not null | nextval('payments_id_seq'::regclass)
 order_id      | bigint                   |           | not null |
 provider      | text                     |           | not null | 'paybridge'::text
 provider_ref  | text                     |           |          |
 status        | text                     |           | not null |
 amount_cents  | integer                  |           | not null |
 created_at    | timestamp with time zone |           | not null | now()
Indexes:
    "payments_pkey" PRIMARY KEY, btree (id)
    "idx_payments_order_id" btree (order_id)
`;

function primaryDb(now: number): Database {
  const qs = (minAgo: number) => pgTime(now - minAgo * 1000);
  return {
    host: IDS.rdsEndpoint,
    alias: ['db.internal.shopfast.io', 'checkout-db'],
    instanceId: 'checkout-db',
    dbName: 'checkout',
    serverVersion: '15.7',
    isReplica: false,
    settings: {
      max_connections: '1708',
      shared_buffers: '4006MB',
      work_mem: '8MB',
      effective_cache_size: '8012MB',
      statement_timeout: '0',
      idle_in_transaction_session_timeout: '86400000',
      log_min_duration_statement: '1000',
      random_page_cost: '1.1',
      max_standby_streaming_delay: '30s',
      hot_standby_feedback: 'off',
      server_version: '15.7',
      'rds.force_ssl': '1',
      autovacuum: 'on',
    },
    activity: [
      { pid: 18231, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.23', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(1.2), duration: '00:00:00.0012', query: 'COMMIT' },
      { pid: 18232, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.23', state: 'active', waitEvent: '', queryStart: qs(0.01), duration: '00:00:00.004', query: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)' },
      { pid: 18240, usename: 'checkout_app', application: 'checkout-api', client: '10.0.11.87', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(0.4), duration: '00:00:00.0009', query: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT 20' },
      { pid: 18241, usename: 'checkout_app', application: 'checkout-api', client: '10.0.11.87', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(2.1), duration: '00:00:00.0011', query: 'COMMIT' },
      { pid: 18255, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.142', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(0.8), duration: '00:00:00.0021', query: 'INSERT INTO order_items (order_id, sku, quantity, price_cents) VALUES ($1,$2,$3,$4)' },
      { pid: 18260, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.142', state: 'active', waitEvent: '', queryStart: qs(0.02), duration: '00:00:00.006', query: 'SELECT c.id, c.email FROM customers c WHERE c.id = $1' },
      { pid: 19011, usename: 'worker', application: 'shopfast-worker', client: '10.0.11.204', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(3.5), duration: '00:00:00.0018', query: 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2' },
      { pid: 20118, usename: 'rdsadmin', application: 'PostgreSQL JDBC Driver', client: '127.0.0.1', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: qs(30), duration: '00:00:00.0004', query: 'SELECT 1' },
    ],
    statements: [
      { query: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)', calls: 4120331, totalMs: 9884210, meanMs: 2.4, rows: 12360993 },
      { query: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT $3', calls: 1893012, totalMs: 3218120, meanMs: 1.7, rows: 9844112 },
      { query: 'INSERT INTO orders (public_id, customer_id, status, total_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING id', calls: 402118, totalMs: 1407413, meanMs: 3.5, rows: 402118 },
      { query: 'INSERT INTO order_items (order_id, sku, quantity, price_cents) VALUES ($1,$2,$3,$4)', calls: 1180442, totalMs: 1298486, meanMs: 1.1, rows: 1180442 },
      { query: 'SELECT c.id, c.email FROM customers c WHERE c.id = $1', calls: 2210092, totalMs: 1105046, meanMs: 0.5, rows: 2210092 },
      { query: 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', calls: 801224, totalMs: 1041591, meanMs: 1.3, rows: 801224 },
      { query: 'SELECT * FROM payments WHERE order_id = $1', calls: 690331, totalMs: 483231, meanMs: 0.7, rows: 690331 },
    ],
    tables: { orders: TABLE_ORDERS, order_items: TABLE_ORDER_ITEMS, customers: TABLE_CUSTOMERS, payments: TABLE_PAYMENTS },
    explains: [
      {
        match: /from\s+orders.*customer_id/is,
        output: ` Limit  (cost=0.56..41.23 rows=20 width=58) (actual time=0.041..0.118 rows=20 loops=1)
   ->  Index Scan Backward using idx_orders_customer_id_status on orders o  (cost=0.56..203.11 rows=98 width=58) (actual time=0.040..0.112 rows=20 loops=1)
         Index Cond: ((customer_id = 4412093) AND (status = 'completed'::text))
 Planning Time: 0.142 ms
 Execution Time: 0.139 ms
(5 rows)`,
      },
    ],
    queries: [],
  };
}

function replicaDb(now: number): Database {
  const p = primaryDb(now);
  return {
    ...p,
    host: IDS.replicaEndpoint,
    alias: ['db-ro.internal.shopfast.io', 'checkout-db-replica-1'],
    instanceId: 'checkout-db-replica-1',
    isReplica: true,
    activity: [
      { pid: 7712, usename: 'checkout_app', application: 'checkout-api', client: '10.0.10.23', state: 'idle', waitEvent: 'Client: ClientRead', queryStart: pgTime(now - 4000), duration: '00:00:00.0010', query: 'SELECT 1' },
      { pid: 7790, usename: 'rdsrepladmin', application: 'walreceiver', client: '', state: 'active', waitEvent: 'Activity: WalReceiverMain', queryStart: pgTime(now - 4 * 86400000), duration: '4 days 02:11:09', query: '' },
    ],
  };
}

/* ------------------------------------------------------------------ */

export function baseEnvironment(now: number): Environment {
  const rng = createRng(now % 100000);
  void rng;
  const hosts: Record<string, Host> = {};
  (Object.keys(HOSTS_META) as HostName[]).forEach((h, i) => (hosts[h] = makeHost(h, now, i)));

  const launch = (daysAgo: number, h = 0) => isoSec(now - daysAgo * 1440 * MIN - h * 60 * MIN);

  const env: Environment = {
    now,
    region: 'us-east-1',
    accountId: IDS.account,
    hosts,
    startHost: 'bastion',
    metrics: panels(now),
    alarms: [
      { name: 'checkout-alb-target-5xx-high', state: 'OK', metric: 'HTTPCode_Target_5XX_Count', condition: 'Sum > 50 for 3 datapoints within 5 minutes', minutesAgo: 4 * 1440, panelId: 'alb.target5xx' },
      { name: 'checkout-alb-p99-latency-high', state: 'OK', metric: 'TargetResponseTime', condition: 'p99 > 2 s for 5 datapoints within 5 minutes', minutesAgo: 3 * 1440, panelId: 'alb.latency' },
      { name: 'checkout-unhealthy-hosts', state: 'OK', metric: 'UnHealthyHostCount', condition: 'Maximum >= 1 for 2 datapoints within 2 minutes', minutesAgo: 6 * 1440, panelId: 'alb.unhealthy' },
      { name: 'checkout-db-cpu-high', state: 'OK', metric: 'CPUUtilization', condition: 'Average > 80 % for 5 datapoints within 5 minutes', minutesAgo: 9 * 1440, panelId: 'rds.cpu' },
      { name: 'checkout-db-free-storage-low', state: 'OK', metric: 'FreeStorageSpace', condition: 'Average < 40 GB for 1 datapoint within 5 minutes', minutesAgo: 30 * 1440, panelId: 'rds.storage' },
      { name: 'checkout-app-disk-used-high', state: 'OK', metric: 'disk_used_percent', condition: 'Maximum > 85 % for 3 datapoints within 3 minutes', minutesAgo: 14 * 1440, panelId: 'ec2.disk' },
      { name: 'checkout-replica-lag-high', state: 'OK', metric: 'ReplicaLag', condition: 'Maximum > 30 s for 5 datapoints within 5 minutes', minutesAgo: 21 * 1440, panelId: 'replica.lag' },
      { name: 'checkout-latency-p99-high', state: 'OK', metric: 'CheckoutLatency', condition: 'p99 > 2000 ms for 5 datapoints within 5 minutes', minutesAgo: 3 * 1440, panelId: 'app.checkoutLatency' },
    ],
    logGroups: [
      {
        name: '/aws/rds/instance/checkout-db/postgresql',
        description: 'PostgreSQL log exported from RDS',
        retentionDays: 7,
        events: [
          ...Array.from({ length: 9 }, (_, i) => ({
            ts: now - (170 - i * 20) * MIN,
            msg: `${pgTime(now - (170 - i * 20) * MIN)}::@:[612]:LOG:  checkpoint complete: wrote ${1200 + i * 37} buffers (0.2%); 0 WAL file(s) added, 0 removed, 1 recycled; write=29.871 s, sync=0.004 s, total=29.902 s; sync files=41, longest=0.002 s, average=0.001 s; distance=21843 kB, estimate=22012 kB`,
          })),
          { ts: now - 96 * MIN, msg: `${pgTime(now - 96 * MIN)}::@:[18871]:LOG:  automatic vacuum of table "checkout.public.order_items": index scans: 1 pages: 0 removed, 48211 remain, 48211 scanned (100.00% of total) tuples: 3201 removed, 4821331 remain` },
        ],
      },
    ],
    ec2: {
      instances: [
        { id: hostMeta.bastion.id, name: 'shopfast-bastion', host: 'bastion', type: 't3.micro', state: 'running', az: 'us-east-1a', privateIp: '10.0.0.12', publicIp: '54.163.22.91', amiId: 'ami-0a8b6c4d2e1f30579', launchTime: launch(41), subnetId: IDS.subnets.publicA, sgIds: [IDS.bastionSg], iamProfile: 'shopfast-ops-profile', statusChecks: '2/2 checks passed', tags: { Name: 'shopfast-bastion', env: 'prod', team: 'platform' } },
        ...(['app-1', 'app-2', 'app-3'] as const).map((h, i) => ({
          id: hostMeta[h].id,
          name: 'shopfast-checkout',
          host: h,
          type: 'm6i.large',
          state: 'running' as const,
          az: hostMeta[h].az,
          privateIp: hostMeta[h].ip,
          amiId: IDS.ami,
          launchTime: launch(12, 4 + i),
          subnetId: hostMeta[h].subnet,
          sgIds: [IDS.appSg],
          iamProfile: 'shopfast-app-profile',
          statusChecks: '2/2 checks passed',
          asg: 'shopfast-checkout-asg',
          tags: { Name: 'shopfast-checkout', env: 'prod', service: 'checkout-api', team: 'payments', 'aws:autoscaling:groupName': 'shopfast-checkout-asg' },
        })),
        { id: hostMeta['worker-1'].id, name: 'shopfast-worker', host: 'worker-1', type: 'm6i.large', state: 'running', az: 'us-east-1b', privateIp: hostMeta['worker-1'].ip, amiId: IDS.ami, launchTime: launch(19), subnetId: IDS.subnets.appB, sgIds: [IDS.workerSg], iamProfile: 'shopfast-worker-profile', statusChecks: '2/2 checks passed', tags: { Name: 'shopfast-worker', env: 'prod', service: 'orders-worker', team: 'payments' } },
      ],
      securityGroups: [
        { id: IDS.albSg, name: 'shopfast-alb-sg', description: 'Public ALB', inbound: [{ protocol: 'tcp', ports: '443', source: '0.0.0.0/0', description: 'HTTPS from internet' }, { protocol: 'tcp', ports: '80', source: '0.0.0.0/0', description: 'HTTP redirect' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] },
        { id: IDS.appSg, name: 'shopfast-app-sg', description: 'checkout-api instances', inbound: [{ protocol: 'tcp', ports: '80', source: IDS.albSg, description: 'HTTP from ALB' }, { protocol: 'tcp', ports: '22', source: IDS.bastionSg, description: 'SSH from bastion' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] },
        { id: IDS.dbSg, name: 'shopfast-db-sg', description: 'RDS PostgreSQL', inbound: [{ protocol: 'tcp', ports: '5432', source: IDS.appSg, description: 'app' }, { protocol: 'tcp', ports: '5432', source: IDS.workerSg, description: 'worker' }, { protocol: 'tcp', ports: '5432', source: IDS.bastionSg, description: 'ops via bastion' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] },
        { id: IDS.bastionSg, name: 'shopfast-bastion-sg', description: 'Bastion host', inbound: [{ protocol: 'tcp', ports: '22', source: '203.0.113.0/24', description: 'office VPN' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] },
        { id: IDS.workerSg, name: 'shopfast-worker-sg', description: 'Queue workers', inbound: [{ protocol: 'tcp', ports: '22', source: IDS.bastionSg, description: 'SSH from bastion' }], outbound: [{ protocol: '-1', ports: 'All', source: '0.0.0.0/0' }] },
      ],
      amis: [
        { id: IDS.ami, name: IDS.amiName, created: launch(21), description: 'ShopFast app base image (AL2023, node 20.17, nginx 1.24, cwagent)' },
        { id: 'ami-0a8b6c4d2e1f30579', name: 'al2023-ami-2023.5.20240805.0-kernel-6.1-x86_64', created: launch(65), description: 'Amazon Linux 2023 AMI' },
      ],
      asgs: [
        {
          name: 'shopfast-checkout-asg',
          min: 3,
          max: 12,
          desired: 3,
          launchTemplate: 'shopfast-checkout-lt (version 14)',
          instances: [hostMeta['app-1'].id, hostMeta['app-2'].id, hostMeta['app-3'].id],
          activities: [
            { minutesAgo: 12 * 1440 + 4 * 60, status: 'Successful', description: `Launching a new EC2 instance: ${hostMeta['app-1'].id}`, cause: 'An instance was started in response to an instance refresh (launch template version 14).' },
            { minutesAgo: 12 * 1440 + 5 * 60, status: 'Successful', description: `Launching a new EC2 instance: ${hostMeta['app-2'].id}`, cause: 'An instance was started in response to an instance refresh (launch template version 14).' },
            { minutesAgo: 12 * 1440 + 6 * 60, status: 'Successful', description: `Launching a new EC2 instance: ${hostMeta['app-3'].id}`, cause: 'An instance was started in response to an instance refresh (launch template version 14).' },
          ],
        },
      ],
    },
    elb: {
      loadBalancers: [
        {
          name: 'shopfast-prod-alb',
          arn: IDS.albArn,
          dnsName: IDS.albDns,
          scheme: 'internet-facing',
          state: 'active',
          vpcId: IDS.vpc,
          azs: ['us-east-1a', 'us-east-1b'],
          sgIds: [IDS.albSg],
          created: launch(212),
          listeners: [
            { port: 443, protocol: 'HTTPS', certificate: 'arn:aws:acm:us-east-1:481562039374:certificate/9d1e2f3a-4b5c-6d7e-8f90-a1b2c3d4e5f6 (*.shopfast.io, expires 2027-03-14)', action: 'forward → checkout-api-tg' },
            { port: 80, protocol: 'HTTP', action: 'redirect → HTTPS:443 (HTTP_301)' },
          ],
        },
      ],
      targetGroups: [
        {
          name: 'checkout-api-tg',
          arn: IDS.tgArn,
          protocol: 'HTTP',
          port: 80,
          loadBalancer: 'shopfast-prod-alb',
          healthCheck: { protocol: 'HTTP', path: '/health', port: 'traffic-port', intervalSec: 10, timeoutSec: 5, healthyThreshold: 3, unhealthyThreshold: 2, matcher: '200' },
          targets: (['app-1', 'app-2', 'app-3'] as const).map(h => ({ id: hostMeta[h].id, port: 80, az: hostMeta[h].az, state: 'healthy' as const })),
        },
      ],
    },
    rds: {
      instances: [
        { id: 'checkout-db', role: 'primary', engine: 'postgres', version: '15.7', class: 'db.r6g.large', status: 'available', endpoint: IDS.rdsEndpoint, az: 'us-east-1a', multiAz: true, storage: { type: 'gp3', sizeGb: 400, iops: 12000, throughputMBps: 500 }, parameterGroup: 'shopfast-pg15', maxConnections: 1708, vCpu: 2, memoryGb: 16 },
        { id: 'checkout-db-replica-1', role: 'replica', replicaOf: 'checkout-db', engine: 'postgres', version: '15.7', class: 'db.r6g.large', status: 'available', endpoint: IDS.replicaEndpoint, az: 'us-east-1b', multiAz: false, storage: { type: 'gp3', sizeGb: 400, iops: 12000, throughputMBps: 500 }, parameterGroup: 'shopfast-pg15', maxConnections: 1708, vCpu: 2, memoryGb: 16 },
      ],
      events: [
        { minutesAgo: 1440 + 312, source: 'checkout-db', message: 'Backing up DB instance' },
        { minutesAgo: 1440 + 296, source: 'checkout-db', message: 'Finished DB Instance backup' },
        { minutesAgo: 312, source: 'checkout-db', message: 'Backing up DB instance' },
        { minutesAgo: 297, source: 'checkout-db', message: 'Finished DB Instance backup' },
      ],
      topSql: {
        'checkout-db': [
          { sql: 'SELECT id, sku, name, price_cents FROM products WHERE sku = ANY($1)', calls: 3410, meanMs: 2.4, loadAas: 0.14, rowsPerCall: 3, waitEvent: 'CPU' },
          { sql: 'SELECT o.id, o.public_id, o.status, o.total_cents, o.created_at FROM orders o WHERE o.customer_id = $1 AND o.status = $2 ORDER BY o.created_at DESC LIMIT $3', calls: 1590, meanMs: 1.7, loadAas: 0.05, rowsPerCall: 5.2, waitEvent: 'CPU' },
          { sql: 'INSERT INTO orders (public_id, customer_id, status, total_cents, currency) VALUES ($1,$2,$3,$4,$5) RETURNING id', calls: 342, meanMs: 3.5, loadAas: 0.02, rowsPerCall: 1, waitEvent: 'IO:WALWrite' },
          { sql: 'UPDATE orders SET status = $1, updated_at = now() WHERE id = $2', calls: 660, meanMs: 1.3, loadAas: 0.01, rowsPerCall: 1, waitEvent: 'CPU' },
        ],
        'checkout-db-replica-1': [{ sql: 'SELECT 1', calls: 120, meanMs: 0.1, loadAas: 0.0, rowsPerCall: 1, waitEvent: 'CPU' }],
      },
    },
    databases: [primaryDb(now), replicaDb(now)],
    vpc: {
      id: IDS.vpc,
      cidr: '10.0.0.0/16',
      subnets: [
        { id: IDS.subnets.publicA, name: 'shopfast-public-a', cidr: '10.0.0.0/24', az: 'us-east-1a', public: true, routeTableId: IDS.rtbPublic, availableIps: 238 },
        { id: IDS.subnets.publicB, name: 'shopfast-public-b', cidr: '10.0.1.0/24', az: 'us-east-1b', public: true, routeTableId: IDS.rtbPublic, availableIps: 241 },
        { id: IDS.subnets.appA, name: 'shopfast-app-a', cidr: '10.0.10.0/24', az: 'us-east-1a', public: false, routeTableId: IDS.rtbPrivateA, availableIps: 243 },
        { id: IDS.subnets.appB, name: 'shopfast-app-b', cidr: '10.0.11.0/24', az: 'us-east-1b', public: false, routeTableId: IDS.rtbPrivateB, availableIps: 243 },
        { id: IDS.subnets.dbA, name: 'shopfast-db-a', cidr: '10.0.20.0/24', az: 'us-east-1a', public: false, routeTableId: IDS.rtbPrivateA, availableIps: 248 },
        { id: IDS.subnets.dbB, name: 'shopfast-db-b', cidr: '10.0.21.0/24', az: 'us-east-1b', public: false, routeTableId: IDS.rtbPrivateB, availableIps: 248 },
      ],
      routeTables: [
        { id: IDS.rtbPublic, name: 'shopfast-public-rt', subnets: [IDS.subnets.publicA, IDS.subnets.publicB], routes: [{ destination: '10.0.0.0/16', target: 'local', state: 'active' }, { destination: '0.0.0.0/0', target: IDS.igw, state: 'active' }] },
        { id: IDS.rtbPrivateA, name: 'shopfast-private-a-rt', subnets: [IDS.subnets.appA, IDS.subnets.dbA], routes: [{ destination: '10.0.0.0/16', target: 'local', state: 'active' }, { destination: '0.0.0.0/0', target: IDS.natGw, state: 'active' }, { destination: 'pl-63a5400a (com.amazonaws.us-east-1.s3)', target: 'vpce-0b1c2d3e4f5a6b7c8', state: 'active' }] },
        { id: IDS.rtbPrivateB, name: 'shopfast-private-b-rt', subnets: [IDS.subnets.appB, IDS.subnets.dbB], routes: [{ destination: '10.0.0.0/16', target: 'local', state: 'active' }, { destination: '0.0.0.0/0', target: IDS.natGw, state: 'active' }, { destination: 'pl-63a5400a (com.amazonaws.us-east-1.s3)', target: 'vpce-0b1c2d3e4f5a6b7c8', state: 'active' }] },
      ],
      natGateways: [{ id: IDS.natGw, name: 'shopfast-nat-a', subnetId: IDS.subnets.publicA, state: 'available', publicIp: '34.198.77.140', created: launch(212) }],
    },
    route53: {
      zones: [
        {
          id: 'Z04812763KQ1ZP9X0ABCD',
          name: 'shopfast.io',
          private: false,
          records: [
            { name: 'shopfast.io', type: 'NS', ttl: 172800, values: ['ns-1204.awsdns-22.org.', 'ns-311.awsdns-38.com.', 'ns-1830.awsdns-36.co.uk.', 'ns-655.awsdns-17.net.'] },
            { name: 'shopfast.io', type: 'SOA', ttl: 900, values: ['ns-1204.awsdns-22.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400'] },
            { name: 'shopfast.io', type: 'A', ttl: 60, values: [], alias: { target: `dualstack.${IDS.albDns}`, evaluateHealth: true } },
            { name: 'shopfast.io', type: 'MX', ttl: 300, values: ['10 inbound-smtp.us-east-1.amazonaws.com.'] },
            { name: 'shopfast.io', type: 'TXT', ttl: 300, values: ['"v=spf1 include:amazonses.com -all"'] },
            { name: 'api.shopfast.io', type: 'A', ttl: 60, values: [], alias: { target: `dualstack.${IDS.albDns}`, evaluateHealth: true } },
            { name: 'www.shopfast.io', type: 'CNAME', ttl: 300, values: ['shopfast.io'] },
            { name: 'status.shopfast.io', type: 'CNAME', ttl: 300, values: ['shopfast.statuspage.io'] },
          ],
        },
        {
          id: 'Z09912345PRIVATE7XYZ',
          name: 'internal.shopfast.io',
          private: true,
          records: [
            { name: 'db.internal.shopfast.io', type: 'CNAME', ttl: 30, values: [IDS.rdsEndpoint] },
            { name: 'db-ro.internal.shopfast.io', type: 'CNAME', ttl: 30, values: [IDS.replicaEndpoint] },
            { name: 'cache.internal.shopfast.io', type: 'CNAME', ttl: 60, values: [IDS.redisEndpoint] },
          ],
        },
      ],
      external: {
        [IDS.albDns]: ['3.214.87.19', '52.71.140.6'],
        [`dualstack.${IDS.albDns}`]: ['3.214.87.19', '52.71.140.6'],
        [IDS.rdsEndpoint]: ['10.0.20.57'],
        [IDS.replicaEndpoint]: ['10.0.21.33'],
        [IDS.redisEndpoint]: ['10.0.20.88'],
        'api.paybridge.com': ['104.18.32.7', '104.18.33.7'],
        'shopfast.statuspage.io': ['52.215.192.131'],
        's3.us-east-1.amazonaws.com': ['52.217.130.88'],
        'shopfast-invoices-prod.s3.us-east-1.amazonaws.com': ['52.217.105.172'],
        'sqs.us-east-1.amazonaws.com': ['3.236.169.0'],
        'sts.us-east-1.amazonaws.com': ['209.54.177.164'],
        'google.com': ['142.251.163.100'],
        'example.com': ['93.184.215.14'],
        'registry.npmjs.org': ['104.16.30.34'],
      },
    },
    iam: {
      roles: [
        {
          name: 'shopfast-app-role',
          arn: `arn:aws:iam::${IDS.account}:role/shopfast-app-role`,
          description: 'checkout-api EC2 instances',
          instanceProfile: 'shopfast-app-profile',
          lastModifiedMinutesAgo: 40 * 1440,
          trust: pol([{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
          policies: [
            {
              name: 'checkout-api-access',
              type: 'inline',
              document: pol([
                { Sid: 'InvoiceObjects', Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: 'arn:aws:s3:::shopfast-invoices-prod/*' },
                { Sid: 'InvoiceBucketList', Effect: 'Allow', Action: ['s3:ListBucket'], Resource: 'arn:aws:s3:::shopfast-invoices-prod' },
                { Sid: 'OrdersQueue', Effect: 'Allow', Action: ['sqs:SendMessage', 'sqs:GetQueueAttributes'], Resource: `arn:aws:sqs:us-east-1:${IDS.account}:orders-prod` },
                { Sid: 'DbSecret', Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:us-east-1:${IDS.account}:secret:prod/checkout/db-*` },
                { Sid: 'KmsForInvoices', Effect: 'Allow', Action: ['kms:GenerateDataKey', 'kms:Decrypt'], Resource: `arn:aws:kms:us-east-1:${IDS.account}:key/5e6f7a8b-9c0d-41e2-a3b4-c5d6e7f8a9b0` },
              ]),
            },
            { name: 'CloudWatchAgentServerPolicy', type: 'aws-managed', arn: 'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy', document: pol([{ Effect: 'Allow', Action: ['cloudwatch:PutMetricData', 'ec2:DescribeVolumes', 'ec2:DescribeTags', 'logs:PutLogEvents', 'logs:DescribeLogStreams', 'logs:DescribeLogGroups', 'logs:CreateLogStream', 'logs:CreateLogGroup'], Resource: '*' }]) },
            { name: 'AmazonSSMManagedInstanceCore', type: 'aws-managed', arn: 'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore', document: pol([{ Effect: 'Allow', Action: ['ssm:UpdateInstanceInformation', 'ssmmessages:*', 'ec2messages:*'], Resource: '*' }]) },
          ],
        },
        {
          name: 'shopfast-worker-role',
          arn: `arn:aws:iam::${IDS.account}:role/shopfast-worker-role`,
          description: 'orders queue workers',
          instanceProfile: 'shopfast-worker-profile',
          lastModifiedMinutesAgo: 60 * 1440,
          trust: pol([{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
          policies: [
            { name: 'worker-access', type: 'inline', document: pol([{ Effect: 'Allow', Action: ['sqs:ReceiveMessage', 'sqs:DeleteMessage', 'sqs:ChangeMessageVisibility'], Resource: `arn:aws:sqs:us-east-1:${IDS.account}:orders-prod` }, { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: `arn:aws:secretsmanager:us-east-1:${IDS.account}:secret:prod/checkout/db-*` }]) },
          ],
        },
        {
          name: 'shopfast-ops-role',
          arn: `arn:aws:iam::${IDS.account}:role/shopfast-ops-role`,
          description: 'On-call engineers via bastion (read-only + break-glass)',
          instanceProfile: 'shopfast-ops-profile',
          lastModifiedMinutesAgo: 90 * 1440,
          trust: pol([{ Effect: 'Allow', Principal: { Service: 'ec2.amazonaws.com' }, Action: 'sts:AssumeRole' }]),
          policies: [
            { name: 'ReadOnlyAccess', type: 'aws-managed', arn: 'arn:aws:iam::aws:policy/ReadOnlyAccess', document: pol([{ Effect: 'Allow', Action: ['*:Describe*', '*:Get*', '*:List*'], Resource: '*' }]) },
            { name: 'IAMSimulate', type: 'customer-managed', arn: `arn:aws:iam::${IDS.account}:policy/IAMSimulate`, document: pol([{ Effect: 'Allow', Action: ['iam:SimulatePrincipalPolicy'], Resource: '*' }]) },
          ],
        },
      ],
      simulations: [],
    },
    cloudtrail: [
      { minutesAgo: 3, eventName: 'AssumeRole', eventSource: 'sts.amazonaws.com', user: 'ec2.amazonaws.com', sourceIp: 'ec2.amazonaws.com', resources: `arn:aws:iam::${IDS.account}:role/shopfast-app-role` },
      { minutesAgo: 9, eventName: 'GetSecretValue', eventSource: 'secretsmanager.amazonaws.com', user: 'shopfast-worker-role/i-09f2c4b6d8e1a3057', sourceIp: '10.0.11.204', resources: 'prod/checkout/db-Xk2P9q' },
      { minutesAgo: 14, eventName: 'DescribeInstances', eventSource: 'ec2.amazonaws.com', user: 'shopfast-ops-role/i-04d1e9b2a7c3f5e68', sourceIp: '10.0.0.12', resources: '-' },
      { minutesAgo: 27, eventName: 'ConsoleLogin', eventSource: 'signin.amazonaws.com', user: 'sso/maria.chen', sourceIp: '203.0.113.48', resources: '-' },
      { minutesAgo: 58, eventName: 'CreateLogStream', eventSource: 'logs.amazonaws.com', user: 'shopfast-app-role/i-0a3f9c1e7b2d40851', sourceIp: '10.0.10.23', resources: '/shopfast/checkout-api' },
      { minutesAgo: 95, eventName: 'PutObject', eventSource: 's3.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'shopfast-artifacts/catalog-service/1.42.0.tgz' },
      { minutesAgo: 140, eventName: 'UpdateService', eventSource: 'ecs.amazonaws.com', user: 'github-actions-deploy', sourceIp: '140.82.112.4', resources: 'catalog-service' },
      { minutesAgo: 230, eventName: 'AuthorizeSecurityGroupIngress', eventSource: 'ec2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'sg-0e25b7c9d3f1a4268', request: { groupId: 'sg-0e25b7c9d3f1a4268', ipPermissions: { items: [{ ipProtocol: 'tcp', fromPort: 9100, toPort: 9100, groups: { items: [{ groupId: 'sg-0d14a6b8c2e9f3157' }] } }] } } },
      { minutesAgo: 1440 + 120, eventName: 'CreateWebACL', eventSource: 'wafv2.amazonaws.com', user: 'terraform-ci', sourceIp: '140.82.112.9', resources: 'shopfast-prod-waf' },
    ],
    changes: [
      { id: 'chg-8811', minutesAgo: 140, kind: 'deploy', service: 'catalog-service', title: 'catalog-service 1.42.0 — product image CDN rewrite', author: 'dev.patel', status: 'succeeded', version: '1.42.0', description: 'Rewrites product image URLs to the new CDN host. Separate ECS service; does not touch checkout.' },
      { id: 'chg-8807', minutesAgo: 300, kind: 'feature-flag', service: 'web-frontend', title: 'Enable "recently-viewed" carousel for 25% of users', author: 'sara.okafor', status: 'succeeded', description: 'LaunchDarkly flag recently-viewed-carousel → 25% rollout.' },
      { id: 'chg-8790', minutesAgo: 26 * 60, kind: 'deploy', service: 'checkout-api', title: 'checkout-api 2.13.1 — fix rounding of tax on multi-currency carts', author: 'li.wang', status: 'succeeded', version: '2.13.1', description: 'Patch release. Changes tax rounding from half-up to banker\'s rounding for EUR/GBP carts.' },
      { id: 'chg-8774', minutesAgo: 1440 + 120, kind: 'infra', service: 'edge', title: 'terraform: attach WAF web ACL to shopfast-prod-alb', author: 'terraform-ci (PR #1182, tom.reyes)', status: 'succeeded', description: 'Adds AWS managed rule groups (CommonRuleSet, KnownBadInputs) in COUNT mode.' },
      { id: 'chg-8751', minutesAgo: 3 * 1440, kind: 'deploy', service: 'checkout-api', title: 'checkout-api 2.13.0 — saved payment methods', author: 'li.wang', status: 'succeeded', version: '2.13.0', description: 'Adds saved payment methods (PayBridge vault tokens).' },
    ],
    http: [
      { match: /^https?:\/\/(localhost|127\.0\.0\.1)(:80)?\/health/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', Server: 'nginx/1.24.0' }, body: '{"status":"ok","version":"2.13.1","db":"ok","redis":"ok"}', timeMs: 4 },
      { match: /^https?:\/\/(localhost|127\.0\.0\.1):3000\/health/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"status":"ok","version":"2.13.1","db":"ok","redis":"ok"}', timeMs: 3 },
      { match: /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/, behaviour: 'ok', status: 404, headers: { 'Content-Type': 'application/json' }, body: '{"message":"Route GET:/ not found","error":"Not Found","statusCode":404}', timeMs: 3 },
      { match: /^https:\/\/api\.shopfast\.io\/health/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', Server: 'awselb/2.0' }, body: '{"status":"ok","version":"2.13.1","db":"ok","redis":"ok"}', timeMs: 38 },
      { match: /^https?:\/\/(api\.)?shopfast\.io/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: '{"message":"ShopFast API"}', timeMs: 41 },
      { match: /paybridge\.com/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json', 'X-PayBridge-Region': 'us-east' }, body: '{"status":"operational","api":"v2"}', timeMs: 92 },
      // shopfast-app-sg only allows :80 from the ALB security group, so direct requests from other hosts time out
      { match: /^(https?|tcp):\/\/10\.0\.(10|11)\.\d+(:80)?(\/|$)/, behaviour: 'timeout' },
      { match: /:5432|rds\.amazonaws\.com|db(-ro)?\.internal/, behaviour: 'ok', status: 0, timeMs: 1 },
      { match: /:6379|cache\.internal|cache\.amazonaws\.com/, behaviour: 'ok', status: 0, timeMs: 1 },
    ],
    awsCli: [],
    traffic: { minutes: 75, rpmPerHost: 7, p50Ms: 42 },
    hostLogs: {},
  };
  return env;
}
