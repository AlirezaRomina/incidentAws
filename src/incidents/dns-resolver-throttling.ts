import type { Incident } from '../engine/types';
import { MIN, iso, syslogTime, systemdTime } from '../engine/time';
import { addPanel, host, injectLog, setAlarm, setPoints, spread } from '../env/helpers';
import { APP_HOSTS, IDS, hostMeta } from '../env/base';

/*
 * INC-4340 — checkout-api 2.17.0 removed the in-process DNS cache (cacheable-lookup) and
 * turned HTTP keep-alive off for outbound calls (catalog, PayBridge, SQS). The AMI has no
 * OS-level DNS cache (systemd-resolved Cache=no, stub disabled, resolv.conf → 10.0.0.2).
 * At the evening peak every app host sends more than 1,024 packets/s to the VPC resolver;
 * the per-ENI link-local allowance silently drops the excess (ethtool:
 * linklocal_allowance_exceeded), glibc times out after 5 s, retries, and finally returns
 * EAI_AGAIN. A single `dig` by hand is always fine.
 */

const NOW_ISO = '2026-10-07T18:45:00Z';
const NOW = Date.parse(NOW_ISO);

const DEPLOY_2170 = 4525; // Sun Oct 4 15:20 UTC
const DEPLOY_2171 = 1595; // Tue Oct 6 16:10 UTC
const DEPLOY_2162 = 10360; // Wed Sep 30 14:05 UTC
const SG_CHANGE = 1580;

const LIMIT = 1024; // packets/s per ENI to link-local services
const SHARE: Record<string, number> = { 'app-1': 0.97, 'app-2': 1.05, 'app-3': 0.98 };
const PKTS_PER_REQ_AFTER = 1.65; // A + AAAA per uncached lookup, ~0.8 lookups per request
const PKTS_PER_REQ_BEFORE = 0.06; // cacheable-lookup + keep-alive
const BACKGROUND_PPS = 15; // ssm-agent, cwagent, chrony (169.254.169.123), IMDS

/* ------------------------------------------------------------------ */
/* Traffic & DNS model                                                 */
/* ------------------------------------------------------------------ */

const DAY_MUL: Record<string, number> = { '2026-09-30': 0.97, '2026-10-01': 0.97, '2026-10-02': 0.96, '2026-10-03': 0.95, '2026-10-04': 0.92, '2026-10-05': 0.94, '2026-10-06': 0.97, '2026-10-07': 1.0 };

/** Total ALB requests per second at `minutesAgo` (evening peak around 19:35 UTC). */
function rps(minutesAgo: number): number {
  const t = NOW - minutesAgo * MIN;
  const d = new Date(t);
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  let dist = Math.abs(h - 19.6);
  dist = Math.min(dist, 24 - dist);
  const g = 0.42 + 0.58 * Math.exp(-((dist / 3.4) ** 2));
  const mul = DAY_MUL[d.toISOString().slice(0, 10)] ?? 0.96;
  const wobble = 1 + 0.015 * Math.sin(minutesAgo / 3.7) + 0.01 * Math.sin(minutesAgo / 11.3);
  return 2150 * g * mul * wobble;
}

function pps(hostName: string, minutesAgo: number): number {
  const perReq = minutesAgo > DEPLOY_2170 ? PKTS_PER_REQ_BEFORE : PKTS_PER_REQ_AFTER;
  return (rps(minutesAgo) / 3) * SHARE[hostName] * perReq + BACKGROUND_PPS;
}

/** Link-local packets dropped per minute: steady overflow plus sub-second bursts near the limit. */
function dropsPerMin(hostName: string, minutesAgo: number): number {
  const p = pps(hostName, minutesAgo);
  const steady = Math.max(0, p - LIMIT) * 60;
  const bursts = p > 960 ? (p - 960) * 60 * 0.06 : 0;
  return Math.round(steady + bursts);
}

const totalDrops = (m: number) => APP_HOSTS.reduce((s, h) => s + dropsPerMin(h, m), 0);

/** First minute (counting back from now) at which any host drops packets. */
const DROPS_START = (() => {
  let m = 0;
  while (m < 600 && totalDrops(m + 1) > 0) m++;
  return m;
})();

/** Cumulative counter since boot (12 days ago) per host — what `ethtool -S` reports. */
const CUMULATIVE: Record<string, number> = Object.fromEntries(
  APP_HOSTS.map(h => {
    let s = 0;
    for (let m = DEPLOY_2170; m >= 0; m--) s += dropsPerMin(h, m);
    return [h, s];
  }),
);

/* ------------------------------------------------------------------ */
/* ethtool -S ens5 (ENA driver)                                         */
/* ------------------------------------------------------------------ */

function ethtoolStats(seed: number, linklocal: number, busy: boolean): string {
  const big = (base: number, k: number) => Math.round(base * (1 + ((seed * 7919 + k * 104729) % 1000) / 4000));
  const q = (i: number) => {
    const tx = big(busy ? 1_840_000_000 : 41_000_000, i + 1);
    const rx = big(busy ? 2_110_000_000 : 52_000_000, i + 7);
    return [
      `     queue_${i}_tx_cnt: ${tx}`,
      `     queue_${i}_tx_bytes: ${tx * 611}`,
      `     queue_${i}_tx_queue_stop: 0`,
      `     queue_${i}_tx_queue_wakeup: 0`,
      `     queue_${i}_tx_dma_mapping_err: 0`,
      `     queue_${i}_tx_linearize: 0`,
      `     queue_${i}_tx_linearize_failed: 0`,
      `     queue_${i}_tx_napi_comp: ${big(busy ? 912_000_000 : 20_400_000, i + 3)}`,
      `     queue_${i}_tx_tx_poll: ${big(busy ? 913_200_000 : 20_410_000, i + 3)}`,
      `     queue_${i}_tx_doorbells: ${big(busy ? 1_702_000_000 : 39_800_000, i + 5)}`,
      `     queue_${i}_tx_prepare_ctx_err: 0`,
      `     queue_${i}_tx_bad_req_id: 0`,
      `     queue_${i}_tx_llq_buffer_copy: ${big(busy ? 1_190_000_000 : 30_100_000, i + 9)}`,
      `     queue_${i}_tx_missed_tx: 0`,
      `     queue_${i}_tx_unmask_interrupt: ${big(busy ? 912_000_000 : 20_400_000, i + 3)}`,
      `     queue_${i}_rx_cnt: ${rx}`,
      `     queue_${i}_rx_bytes: ${rx * 734}`,
      `     queue_${i}_rx_rx_copybreak_pkt: ${big(busy ? 1_400_000_000 : 33_000_000, i + 11)}`,
      `     queue_${i}_rx_csum_good: ${rx - 412}`,
      `     queue_${i}_rx_refil_partial: 0`,
      `     queue_${i}_rx_csum_bad: 0`,
      `     queue_${i}_rx_page_alloc_fail: 0`,
      `     queue_${i}_rx_skb_alloc_fail: 0`,
      `     queue_${i}_rx_dma_mapping_err: 0`,
      `     queue_${i}_rx_bad_desc_num: 0`,
      `     queue_${i}_rx_bad_req_id: 0`,
      `     queue_${i}_rx_empty_rx_ring: 0`,
      `     queue_${i}_rx_csum_unchecked: 0`,
      `     queue_${i}_rx_xdp_aborted: 0`,
      `     queue_${i}_rx_xdp_drop: 0`,
      `     queue_${i}_rx_xdp_pass: 0`,
      `     queue_${i}_rx_xdp_tx: 0`,
      `     queue_${i}_rx_xdp_invalid: 0`,
      `     queue_${i}_rx_xdp_redirect: 0`,
    ];
  };
  return [
    'NIC statistics:',
    '     tx_timeout: 0',
    '     suspend: 0',
    '     resume: 0',
    '     wd_expired: 0',
    '     interface_up: 1',
    '     interface_down: 0',
    '     admin_q_pause: 0',
    '     bw_in_allowance_exceeded: 0',
    '     bw_out_allowance_exceeded: 0',
    '     pps_allowance_exceeded: 0',
    `     conntrack_allowance_available: ${busy ? 118_402 + (seed % 900) : 136_814}`,
    '     conntrack_allowance_exceeded: 0',
    `     linklocal_allowance_exceeded: ${linklocal}`,
    ...q(0),
    ...q(1),
    `     ena_admin_q_aq_completed_cmd: ${3 + (seed % 5) * 0 + 41}`,
    '     ena_admin_q_out_of_space: 0',
    '     ena_admin_q_no_completion: 0',
  ].join('\n');
}

const ETHTOOL_I = `driver: ena
version: 2.12.0g
firmware-version:
expansion-rom-version:
bus-info: 0000:00:05.0
supports-statistics: yes
supports-test: no
supports-eeprom-access: no
supports-register-dump: no
supports-priv-flags: yes`;

const RESOLV_CONF = `# This is /run/systemd/resolve/resolv.conf managed by man:systemd-resolved(8).
# Do not edit.
#
# This file might be symlinked as /etc/resolv.conf. If you're looking at
# /etc/resolv.conf and seeing this text, you have followed the symlink.
#
# This is a dynamic resolv.conf file for connecting local clients directly to
# all known uplink DNS servers. This file lists all configured search domains.
#
# Third party programs should typically not access this file directly, but only
# through the symlink at /etc/resolv.conf. To manage man:resolv.conf(5) in a
# different way, replace this symlink by a static file or a different symlink.
#
# See man:systemd-resolved.service(8) for details about the supported modes of
# operation for /etc/resolv.conf.

nameserver 10.0.0.2
search ec2.internal
options edns0 trust-ad
`;

const RESOLVED_CONF = `#  This file is part of systemd.
#
#  systemd is free software; you can redistribute it and/or modify it under the
#  terms of the GNU Lesser General Public License as published by the Free
#  Software Foundation; either version 2.1 of the License, or (at your option)
#  any later version.
#
# Entries in this file show the compile time defaults. Local configuration
# should be created by either modifying this file, or by creating "drop-ins" in
# the resolved.conf.d/ subdirectory.
#
# See resolved.conf(5) for details.

[Resolve]
#DNS=
#FallbackDNS=
#Domains=
#DNSSEC=no
#DNSOverTLS=no
#MulticastDNS=no
#LLMNR=no
# --- shopfast-app AMI hardening (packer/al2023/hardening.sh, PLAT-1702) ---
# Apps resolve directly against the VPC resolver (uplink resolv.conf); no local
# stub listener and no caching, so record changes are picked up immediately.
Cache=no
DNSStubListener=no
#ReadEtcHosts=yes
#ResolveUnicastSingleLabel=no
`;

const NSSWITCH = `# Generated by authselect
# Do not modify this file manually, use authselect instead.
# shopfast-app AMI: nss-resolve removed from hosts (PLAT-1702)

passwd:     files systemd
group:      files systemd
netgroup:   files
automount:  files
services:   files
shadow:     files

hosts:      files dns myhostname
`;

const RESOLVECTL_STATS = `DNSSEC supported by current servers: no

Transactions
Current Transactions: 0
  Total Transactions: 0

Cache
  Current Cache Size: 0
          Cache Hits: 0
        Cache Misses: 0

DNSSEC Verdicts
              Secure: 0
            Insecure: 0
               Bogus: 0
       Indeterminate: 0`;

const RESOLVECTL_STATUS = `Global
         Protocols: -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
  resolv.conf mode: uplink

Link 2 (ens5)
    Current Scopes: DNS
         Protocols: +DefaultRoute -LLMNR -mDNS -DNSOverTLS DNSSEC=no/unsupported
Current DNS Server: 10.0.0.2
       DNS Servers: 10.0.0.2
        DNS Domain: ec2.internal`;

const HTTP_JS = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.awsRequestHandler = exports.httpsAgent = void 0;
const node_https_1 = require("node:https");
const node_http_handler_1 = require("@smithy/node-http-handler");
// CHK-1442: PayBridge resets idle keep-alive sockets after ~5 s, which surfaced
// as sporadic ECONNRESET on the first request after a quiet period. Use a fresh
// connection per request for external calls — simpler and avoids stale sockets.
exports.httpsAgent = new node_https_1.Agent({ keepAlive: false, maxSockets: 256 });
exports.awsRequestHandler = new node_http_handler_1.NodeHttpHandler({
    httpsAgent: exports.httpsAgent,
    connectionTimeout: 2000,
    requestTimeout: 5000,
});
`;

const DIFF_2170 = `diff --git a/src/lib/http.ts b/src/lib/http.ts
--- a/src/lib/http.ts
+++ b/src/lib/http.ts
@@ -1,27 +1,18 @@
 import https from 'node:https';
-import CacheableLookup from 'cacheable-lookup';
 import { NodeHttpHandler } from '@smithy/node-http-handler';

-// One DNS cache shared by every outbound client (catalog, PayBridge, AWS SDK).
-const dnsCache = new CacheableLookup({ maxTtl: 60, errorTtl: 0.15 });
-
-export const httpsAgent = new https.Agent({
-  keepAlive: process.env.HTTP_KEEPALIVE !== 'false',
-  keepAliveMsecs: 1000,
-  maxSockets: 128,
-});
-dnsCache.install(httpsAgent);
+// CHK-1442: PayBridge resets idle keep-alive sockets after ~5 s, which surfaced
+// as sporadic ECONNRESET on the first request after a quiet period. Use a fresh
+// connection per request for external calls — simpler and avoids stale sockets.
+export const httpsAgent = new https.Agent({ keepAlive: false, maxSockets: 256 });

 export const awsRequestHandler = new NodeHttpHandler({
   httpsAgent,
   connectionTimeout: 2_000,
   requestTimeout: 5_000,
 });
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -14,7 +14,6 @@
     "@aws-sdk/client-sqs": "3.658.1",
     "@smithy/node-http-handler": "3.2.4",
-    "cacheable-lookup": "7.0.0",
     "fastify": "4.28.1",
     "ioredis": "5.4.1",
     "pg": "8.12.0",`;

/* ------------------------------------------------------------------ */

const incident: Incident = {
  id: 'dns-resolver-throttling',
  code: 'INC-4340',
  order: 12,
  title: 'Checkout fails at peak with EAI_AGAIN — but DNS works when you test it',
  teaser: 'Evening peak. 2–5% of payments fail with getaddrinfo EAI_AGAIN. Every dig you run answers in 2 ms.',
  difficulty: 'expert',
  tags: ['DNS', 'VPC', 'ENA', 'Node.js', 'Keep-alive', 'Rate limits'],
  parMinutes: 25,
  seed: 4340,
  now: NOW_ISO,
  briefing: {
    severity: 'SEV2',
    alert: {
      source: 'PagerDuty',
      title: '[ALARM] checkout-alb-target-5xx-high — HTTPCode_Target_5XX_Count > 50',
      details:
        'shopfast-prod-alb HTTPCode_Target_5XX_Count Sum > 50 for 3 datapoints within 5 minutes (current 68). checkout-alb-p99-latency-high is also in ALARM (p99 5.2 s). Same alarms fired Mon and Tue evening and cleared after ~21:30 UTC.',
      minutesAgo: 31,
    },
    reports: [
      { from: 'Li Wang', role: 'Backend Engineer (payments)', channel: '#incident-4340', message: "PayBridge errors again, all `getaddrinfo EAI_AGAIN api.paybridge.com`. I ssh'd to app-2 and ran dig and curl against api.paybridge.com ~30 times — instant answer every single time. PayBridge had an incident this morning, I bet their DNS is still flaky.", minutesAgo: 27 },
      { from: 'Tom Reyes', role: 'SRE', channel: '#incident-4340', message: "It's not just PayBridge: I see the same EAI_AGAIN for sqs.us-east-1.amazonaws.com and even a couple for db.internal.shopfast.io. Only at peak, third evening in a row, gone by ~21:30. Traffic is at a record tonight — are we hitting some NAT limit? Also someone touched the app security group yesterday.", minutesAgo: 22 },
      { from: 'Sam Kowalski', role: 'Engineering Manager', channel: '#incident-4340', message: 'Every failed payment is a lost order and Friday is the big sale. I need a real root cause, not "DNS is flaky". You are IC.', minutesAgo: 18 },
    ],
    impact: '~3% of checkouts fail with 502 at peak (PaymentProviderErrors ×20), p99 latency ~5 s. Product pages mostly fine. Started around 17:30 UTC.',
    services: ['checkout-api', 'shopfast-prod-alb', 'PayBridge API', 'Amazon SQS'],
  },

  build(env) {
    const now = env.now;

    /* ---------------- Metrics (3 h) ---------------- */
    const pts3h = (f: (m: number) => number) => Array.from({ length: 180 }, (_, i) => f(179 - i));
    setPoints(env, 'alb.requests', pts3h(m => Math.round(rps(m) * 60)));
    setPoints(env, 'alb.target5xx', pts3h(m => Math.round(totalDrops(m) * 0.0021 + ((m * 7) % 3 === 0 ? 1 : 0))));
    setPoints(env, 'alb.latency', pts3h(m => {
      const d = totalDrops(m);
      const v = d > 1500 ? 5.08 + ((m * 37) % 29) / 100 : 0.42 + (d / 1500) * 4.6 + ((m * 13) % 7) / 100;
      return Math.round(v * 1000) / 1000;
    }));
    setPoints(env, 'app.checkoutLatency', pts3h(m => {
      const d = totalDrops(m);
      return Math.round(d > 1500 ? 5300 + ((m * 997) % 4800) : 390 + (d / 1500) * 4900 + ((m * 31) % 60));
    }));
    setPoints(env, 'app.paymentErrors', pts3h(m => Math.round(totalDrops(m) * 0.00055 + ((m * 11) % 5 === 0 ? 1 : 0))));
    setPoints(env, 'app.orders', pts3h(m => Math.round((rps(m) / 2150) * 92 - totalDrops(m) * 0.0004)));
    for (const [i, h] of APP_HOSTS.entries()) {
      setPoints(env, 'ec2.cpu', pts3h(m => Math.round((9 + (rps(m) / 2150) * 21 * SHARE[h] + ((m * 7 + i * 3) % 10) / 5) * 10) / 10), h);
    }
    setAlarm(env, 'checkout-alb-target-5xx-high', 'ALARM', 31);
    setAlarm(env, 'checkout-alb-p99-latency-high', 'ALARM', DROPS_START - 14);
    setAlarm(env, 'checkout-latency-p99-high', 'ALARM', DROPS_START - 15);

    addPanel(env, {
      id: 'ec2.linklocal',
      group: 'EC2',
      namespace: 'CWAgent',
      metric: 'ethtool_linklocal_allowance_exceeded',
      resource: 'shopfast-checkout-asg (interface=ens5)',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      series: APP_HOSTS.map(h => ({ name: h, points: pts3h(m => dropsPerMin(h, m)) })),
    });
    addPanel(env, {
      id: 'ec2.linklocal.7d',
      group: 'EC2 · last 7 days',
      namespace: 'CWAgent',
      metric: 'ethtool_linklocal_allowance_exceeded',
      resource: 'shopfast-checkout-asg (interface=ens5)',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 60,
      series: APP_HOSTS.map(h => ({
        name: h,
        points: Array.from({ length: 168 }, (_, i) => {
          const end = (167 - i) * 60;
          let s = 0;
          for (let m = end; m < end + 60; m++) s += dropsPerMin(h, m);
          return s;
        }),
      })),
    });
    addPanel(env, {
      id: 'alb.requests.7d',
      group: 'Application Load Balancer · last 7 days',
      namespace: 'AWS/ApplicationELB',
      metric: 'RequestCount',
      resource: 'shopfast-prod-alb',
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 60,
      series: [{ name: 'shopfast-prod-alb', points: Array.from({ length: 168 }, (_, i) => Math.round(rps((167 - i) * 60 + 30) * 3600)) }],
    });
    addPanel(env, {
      id: 'nat.errorPort',
      group: 'VPC',
      namespace: 'AWS/NATGateway',
      metric: 'ErrorPortAllocation',
      resource: IDS.natGw,
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      series: [{ name: IDS.natGw, points: new Array(180).fill(0) }],
    });
    addPanel(env, {
      id: 'nat.packetsDrop',
      group: 'VPC',
      namespace: 'AWS/NATGateway',
      metric: 'PacketsDropCount',
      resource: IDS.natGw,
      unit: 'Count',
      stat: 'Sum',
      periodMinutes: 1,
      series: [{ name: IDS.natGw, points: pts3h(m => ((m * 17) % 41 === 0 ? 1 : 0)) }],
    });
    // keep-alive off: connection churn through the NAT is up, but no errors
    setPoints(env, 'nat.active', pts3h(m => Math.round(380 + (rps(m) / 2150) * 2900 + ((m * 31) % 70))));

    /* ---------------- Hosts ---------------- */
    for (const [i, h] of APP_HOSTS.entries()) {
      const hh = host(env, h);
      const meta = hostMeta[h];
      hh.env.APP_VERSION = '2.17.1';
      hh.files['/etc/resolv.conf'] = RESOLV_CONF;
      hh.files['/etc/systemd/resolved.conf'] = RESOLVED_CONF;
      hh.files['/etc/nsswitch.conf'] = NSSWITCH;
      hh.files['/opt/checkout-api/dist/lib/http.js'] = HTTP_JS;
      hh.files['/opt/checkout-api/package.json'] = JSON.stringify(
        { name: 'checkout-api', version: '2.17.1', main: 'dist/server.js', dependencies: { '@aws-sdk/client-s3': '3.658.1', '@aws-sdk/client-sqs': '3.658.1', '@smithy/node-http-handler': '3.2.4', fastify: '4.28.1', ioredis: '5.4.1', pg: '8.12.0', pino: '9.4.0', undici: '6.19.8' } },
        null,
        2,
      ) + '\n';
      hh.commandOverrides.push(
        { match: /^ethtool\s+(-S|--statistics)\s+ens5\b/, output: ethtoolStats(i + 3, CUMULATIVE[h], true) },
        { match: /^ethtool\s+(-i|--driver)\s+ens5\b/, output: ETHTOOL_I },
        { match: /^ethtool\b/, output: (cmd: string) => (/\bens5\b/.test(cmd) ? 'Settings for ens5:\n\tSupported ports: [ ]\n\tSpeed: Unknown!\n\tDuplex: Unknown! (255)\n\tLink detected: yes' : `netlink error: no device matches name (offset 24)\nnetlink error: No such device\n(the primary interface on Nitro instances is ens5)`) },
        { match: /^resolvectl\s+statistics/, output: RESOLVECTL_STATS },
        { match: /^(resolvectl(\s+status)?|systemd-resolve\s+--status)\s*$/, output: RESOLVECTL_STATUS },
      );
      hh.services['systemd-resolved'] = {
        name: 'systemd-resolved',
        description: 'Network Name Resolution',
        active: 'active (running)',
        since: `${systemdTime(now - 12 * 1440 * MIN - 4 * 60 * MIN)}; 1 week 5 days ago`,
        mainPid: 701,
        memory: '6.2M',
        tasks: 1,
        execStart: '/usr/lib/systemd/systemd-resolved',
        journal: [
          `${syslogTime(now - 12 * 1440 * MIN - 4 * 60 * MIN)} ${meta.hostname} systemd-resolved[701]: Positive Trust Anchors:`,
          `${syslogTime(now - 12 * 1440 * MIN - 4 * 60 * MIN + 200)} ${meta.hostname} systemd-resolved[701]: Using system hostname '${meta.hostname}'.`,
          `${syslogTime(now - 12 * 1440 * MIN - 4 * 60 * MIN + 400)} ${meta.hostname} systemd[1]: Started systemd-resolved.service - Network Name Resolution.`,
        ],
      };
      hh.processes.push({ pid: 701, user: 'systemd-resolve', cpu: 0, mem: 0.2, vszKb: 22104, rssKb: 12880, stat: 'Ss', start: 'Sep25', time: '0:01', command: '/usr/lib/systemd/systemd-resolved' });
      const node = hh.processes.find(p => p.command.includes('checkout-api'));
      if (node) node.start = 'Oct06';
      // keep-alive off → lots of short-lived outbound connections in TIME-WAIT
      hh.sockets.timeWait = Math.round(14_800 * SHARE[h] + i * 410);
      hh.sockets.established = 118 + i * 7;
      hh.sockets.sample = hh.sockets.sample.filter(r => !r.peer.startsWith('104.18.'));
      hh.sockets.sample.push(
        { state: 'TIME-WAIT', local: `${meta.ip}:41210`, peer: '10.0.10.201:443' },
        { state: 'TIME-WAIT', local: `${meta.ip}:41226`, peer: '10.0.11.198:443' },
        { state: 'TIME-WAIT', local: `${meta.ip}:52904`, peer: '104.18.32.7:443' },
        { state: 'TIME-WAIT', local: `${meta.ip}:52918`, peer: '3.236.169.0:443' },
        { state: 'SYN-SENT', local: `${meta.ip}:41240`, peer: '10.0.10.201:443', process: 'node' },
        { state: 'ESTAB', local: `${meta.ip}:41252`, peer: '10.0.11.198:443', process: 'node' },
      );
      const svc = hh.services['checkout-api'];
      const started = now - DEPLOY_2171 * MIN + 40_000;
      const pid = svc.mainPid ?? 2841;
      svc.since = `${systemdTime(started)}; 1 day 2h ago`;
      svc.journal = [
        `${syslogTime(started - 2000)} ${meta.hostname} systemd[1]: Stopping checkout-api.service - ShopFast checkout API (Node.js)...`,
        `${syslogTime(started - 1500)} ${meta.hostname} systemd[1]: checkout-api.service: Deactivated successfully.`,
        `${syslogTime(started - 1400)} ${meta.hostname} systemd[1]: Started checkout-api.service - ShopFast checkout API (Node.js).`,
        `${syslogTime(started + 700)} ${meta.hostname} node[${pid}]: {"level":30,"msg":"outbound http agent configured","keepAlive":false,"maxSockets":256}`,
        `${syslogTime(started + 900)} ${meta.hostname} node[${pid}]: {"level":30,"msg":"connected to postgres","host":"db.internal.shopfast.io","pool":{"max":20,"idleTimeoutMillis":10000}}`,
        `${syslogTime(started + 1100)} ${meta.hostname} node[${pid}]: {"level":30,"msg":"connected to redis","url":"redis://cache.internal.shopfast.io:6379"}`,
        `${syslogTime(started + 1300)} ${meta.hostname} node[${pid}]: {"level":30,"msg":"checkout-api v2.17.1 listening on 127.0.0.1:3000"}`,
      ];

      /* app logs: EAI_AGAIN + 5 s DNS stalls, proportional to this host's drops */
      const errCount = Math.round(16 + (SHARE[h] - 0.95) * 260);
      const lines = spread(env, DROPS_START - 3, 0.3, errCount, (k, ts) => {
        const base = { level: 50, time: iso(ts), pid, hostname: meta.hostname, reqId: `req-${(0x91a400 + k * 1777 + i * 53).toString(16)}` };
        const err = (name: string, extra: Record<string, unknown> = {}) => ({
          type: 'Error',
          message: `getaddrinfo EAI_AGAIN ${name}`,
          stack: `Error: getaddrinfo EAI_AGAIN ${name}\n    at GetAddrInfoReqWrap.onlookupall [as oncomplete] (node:dns:120:26)`,
          errno: -3001,
          code: 'EAI_AGAIN',
          syscall: 'getaddrinfo',
          hostname: name,
          ...extra,
        });
        const kind = (k * 7 + i) % 10;
        if (kind <= 3)
          return JSON.stringify({ ...base, route: 'POST /api/v1/checkout', provider: 'paybridge', op: k % 2 ? 'authorize' : 'tokenize', durationMs: 10008 + ((k * 31) % 40), err: err('api.paybridge.com'), msg: 'paybridge request failed' });
        if (kind <= 5)
          return JSON.stringify({ ...base, route: 'POST /api/v1/checkout', queueUrl: `https://sqs.us-east-1.amazonaws.com/${IDS.account}/orders-prod`, err: err('sqs.us-east-1.amazonaws.com', { $metadata: { attempts: 3, totalRetryDelay: 300 + ((k * 53) % 200) } }), msg: 'failed to publish OrderPlaced event' });
        if (kind <= 8)
          return JSON.stringify({ ...base, level: 40, route: k % 2 ? 'GET /api/v1/products/{sku}' : 'POST /api/v1/cart/items', upstream: 'catalog', attempt: 1, err: err('catalog.internal.shopfast.io'), msg: 'catalog request failed, retrying' });
        return JSON.stringify({ ...base, err: err('db.internal.shopfast.io'), msg: 'pg pool: error creating client' });
      });
      const stalls = spread(env, DROPS_START - 1, 0.6, Math.round(errCount * 0.7), (k, ts) => {
        const target = [
          ['api.paybridge.com', 'POST', '/v2/payments/authorize'],
          ['catalog.internal.shopfast.io', 'GET', '/v1/products'],
          ['sqs.us-east-1.amazonaws.com', 'POST', '/'],
        ][(k + i) % 3];
        const lookup = 5000 + ((k * 397 + i * 101) % 90) / 10 + 2;
        return JSON.stringify({ level: 40, time: iso(ts), pid, hostname: meta.hostname, reqId: `req-${(0x5e2100 + k * 911 + i * 29).toString(16)}`, msg: 'slow outbound request', host: target[0], method: target[1], path: target[2], status: 200, timings: { lookup: Math.round(lookup * 10) / 10, connect: Math.round((lookup + 1.9) * 10) / 10, secureConnect: Math.round((lookup + 24.6) * 10) / 10, response: Math.round((lookup + 188.2) * 10) / 10 }, durationMs: Math.round(lookup + 191) });
      });
      injectLog(env, h, '/var/log/checkout-api/app.log', [...lines, ...stalls]);
    }
    for (const name of ['bastion', 'worker-1']) {
      const hh = host(env, name);
      hh.commandOverrides.push(
        { match: /^ethtool\s+(-S|--statistics)\s+ens5\b/, output: ethtoolStats(name === 'bastion' ? 1 : 2, 0, false) },
        { match: /^ethtool\s+(-i|--driver)\s+ens5\b/, output: ETHTOOL_I },
      );
      hh.files['/etc/resolv.conf'] = RESOLV_CONF;
    }

    /* traffic-generated request failures: the catalog lookups that failed twice */
    env.traffic.minutes = 120;
    env.traffic.profile = (h, m) => {
      const p = pps(h, m);
      const frac = Math.max(0, (p - 960) / p);
      return frac > 0
        ? { errorRate: Math.min(0.05, frac * 0.18), errorStatus: 502, errorUpstream: '10.006', errorMsg: 'getaddrinfo EAI_AGAIN catalog.internal.shopfast.io', errorExtra: { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'catalog.internal.shopfast.io' } }
        : {};
    };

    /* ---------------- DNS / HTTP ---------------- */
    const priv = env.route53.zones.find(z => z.private)!;
    priv.records.push({ name: 'catalog.internal.shopfast.io', type: 'CNAME', ttl: 60, values: ['internal-catalog-svc-1520876431.us-east-1.elb.amazonaws.com'] });
    env.route53.external['internal-catalog-svc-1520876431.us-east-1.elb.amazonaws.com'] = ['10.0.10.201', '10.0.11.198'];
    env.route53.external['status.paybridge.com'] = ['104.18.40.12'];
    env.http.unshift(
      {
        match: /status\.paybridge\.com/,
        behaviour: 'ok',
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', Server: 'cloudflare' },
        body: JSON.stringify({
          page: { name: 'PayBridge', url: 'https://status.paybridge.com' },
          incidents: [
            {
              name: 'Elevated API error rates in us-east',
              status: 'resolved',
              impact: 'minor',
              created_at: '2026-10-07T12:58:00Z',
              resolved_at: '2026-10-07T13:52:00Z',
              incident_updates: [
                { status: 'resolved', body: 'A faulty config push to one edge cluster caused 0.4% of /v2/payments requests to return 503. The change was rolled back at 13:41 UTC; error rates are back to normal.', created_at: '2026-10-07T13:52:00Z' },
                { status: 'investigating', body: 'We are investigating elevated 503 responses from the payments API in us-east.', created_at: '2026-10-07T12:58:00Z' },
              ],
            },
          ],
        }),
        timeMs: 71,
      },
      { match: /catalog\.internal\.shopfast\.io/, behaviour: 'ok', status: 200, headers: { 'Content-Type': 'application/json', Server: 'awselb/2.0' }, body: '{"status":"ok","service":"catalog-service","version":"1.42.0"}', timeMs: 6 },
    );

    /* ---------------- EC2 / SG / AMI ---------------- */
    const appSg = env.ec2.securityGroups.find(s => s.id === IDS.appSg)!;
    appSg.inbound.push({ protocol: 'tcp', ports: '9100', source: IDS.bastionSg, description: 'node_exporter scrape (prometheus on bastion)' });
    env.cloudtrail.push({
      minutesAgo: SG_CHANGE,
      eventName: 'AuthorizeSecurityGroupIngress',
      eventSource: 'ec2.amazonaws.com',
      user: 'terraform-ci',
      sourceIp: '140.82.112.9',
      resources: IDS.appSg,
      request: { groupId: IDS.appSg, ipPermissions: { items: [{ ipProtocol: 'tcp', fromPort: 9100, toPort: 9100, groups: { items: [{ groupId: IDS.bastionSg, description: 'node_exporter scrape (prometheus on bastion)' }] } }] } },
    });
    const ami = env.ec2.amis.find(a => a.id === IDS.ami);
    if (ami) ami.description = 'ShopFast app base image (AL2023, node 20.17, nginx 1.24, cwagent with ethtool metrics; CIS L1 hardening PLAT-1702)';

    /* ---------------- Changes ---------------- */
    env.changes = env.changes.filter(c => c.service !== 'checkout-api');
    env.changes.push(
      {
        id: 'chg-8798',
        minutesAgo: DEPLOY_2171,
        kind: 'deploy',
        service: 'checkout-api',
        title: 'checkout-api 2.17.1 — zero-decimal currencies (JPY/KRW) in order totals',
        author: 'li.wang',
        status: 'succeeded',
        version: '2.17.1',
        description: 'Patch release: formats JPY and KRW totals without minor units on receipts and invoices. Rolling deploy, no config changes.',
        diff: `diff --git a/src/lib/money.ts b/src/lib/money.ts
--- a/src/lib/money.ts
+++ b/src/lib/money.ts
@@ -3,6 +3,8 @@
+const ZERO_DECIMAL = new Set(['JPY', 'KRW']);
+
 export function formatMinor(amount: number, currency: string): string {
-  return (amount / 100).toFixed(2);
+  if (ZERO_DECIMAL.has(currency)) return String(amount);
+  return (amount / 100).toFixed(2);
 }`,
      },
      {
        id: 'chg-8805',
        minutesAgo: SG_CHANGE + 2,
        kind: 'infra',
        service: 'shopfast-app-sg',
        title: 'terraform: allow node_exporter (tcp/9100) from the bastion Prometheus to app instances',
        author: 'terraform-ci (PR #1219, tom.reyes)',
        status: 'succeeded',
        description: 'Adds one inbound rule to shopfast-app-sg. No outbound changes.',
      },
      {
        id: 'chg-8771',
        minutesAgo: DEPLOY_2170,
        kind: 'deploy',
        service: 'checkout-api',
        title: 'checkout-api 2.17.0 — outbound HTTP client cleanup (CHK-1442), remove unused dependencies',
        author: 'nadia.osei',
        status: 'succeeded',
        version: '2.17.0',
        description: 'Fixes sporadic ECONNRESET on PayBridge calls after idle periods (CHK-1442) by no longer reusing sockets for outbound calls. Removes dependencies flagged by depcheck. Canary on app-1 for 30 min (Sunday afternoon) showed no errors.',
        diff: DIFF_2170,
      },
      {
        id: 'chg-8702',
        minutesAgo: DEPLOY_2162,
        kind: 'deploy',
        service: 'checkout-api',
        title: "checkout-api 2.16.2 — fix tax rounding on multi-currency carts",
        author: 'li.wang',
        status: 'succeeded',
        version: '2.16.2',
        description: "Patch release. Changes tax rounding from half-up to banker's rounding for EUR/GBP carts.",
      },
    );
    env.changes.sort((a, b) => a.minutesAgo - b.minutesAgo);
  },

  evidence: [
    {
      id: 'linklocal',
      label: 'ENA counter linklocal_allowance_exceeded is non-zero and climbing at peak on every app host',
      kind: 'key',
      match: /linklocal_allowance_exceeded:\s*[1-9]\d*|ethtool_linklocal_allowance_exceeded/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'ethtool -S ens5' },
      explanation: 'The ENA driver counts packets the Nitro card dropped because traffic to link-local services (the VPC resolver, IMDS, Time Sync) exceeded 1,024 packets/s on this interface. It is the only place this throttling is visible — no error is returned to the sender.',
    },
    {
      id: 'eai-again',
      label: 'checkout-api logs getaddrinfo EAI_AGAIN for PayBridge, SQS, catalog and even the database',
      kind: 'key',
      match: /getaddrinfo EAI_AGAIN/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: 'EAI_AGAIN ("temporary failure in name resolution") means the resolver never answered — not NXDOMAIN, not a refused connection. That it hits every hostname, including the private db.internal.shopfast.io, rules out any single provider.',
    },
    {
      id: 'deploy-2170',
      label: 'checkout-api 2.17.0 removed cacheable-lookup and set keepAlive: false',
      kind: 'key',
      match: /cacheable-lookup|keepAlive: false/,
      foundBy: { tool: 'deploys' },
      explanation: 'Before 2.17.0 each process resolved a name once per TTL and reused connections. After it, every outbound request opens a new connection and calls getaddrinfo (A + AAAA) — DNS traffic went up by an order of magnitude. It shipped on a quiet Sunday, so the first peak to hit the limit was Sunday evening.',
    },
    {
      id: 'no-os-cache',
      label: 'No OS-level DNS cache: resolved Cache=no, stub disabled, glibc goes straight to 10.0.0.2',
      kind: 'key',
      match: /^Cache=no|Current Cache Size: 0|^hosts:\s+files dns myhostname/m,
      foundBy: { tool: 'terminal', host: 'app-1', command: 'cat /etc/systemd/resolved.conf' },
      explanation: 'The AMI hardening disabled systemd-resolved\'s cache and stub listener and removed nss-resolve, so nothing between the app and the VPC resolver absorbs repeated lookups. With the app cache gone too, every lookup becomes packets on the wire.',
    },
    {
      id: 'dns-stall',
      label: 'Outbound requests stall for exactly ~5 s in the DNS lookup phase',
      kind: 'supporting',
      match: /"lookup":50\d\d/,
      foundBy: { tool: 'logs', group: '/shopfast/checkout-api' },
      explanation: '5 s is glibc\'s default resolver timeout (resolv.conf `timeout:5`). A dropped query is simply never answered; glibc waits 5 s and resends. Two misses in a row (10 s) become EAI_AGAIN — which is also why ALB p99 sits at ~5 s.',
    },
    {
      id: 'time-wait',
      label: '~15,000 sockets in TIME-WAIT on each app host: a new TCP connection per outbound call',
      kind: 'supporting',
      match: /timewait 1\d{4}/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'ss -s' },
      explanation: 'Without keep-alive every call opens and closes a connection, leaving it in TIME-WAIT for 60 s. ~15k TIME-WAIT sockets ≈ 250 new connections per second per host — each one preceded by a fresh DNS lookup.',
    },
    {
      id: 'p99-5s',
      label: 'ALB p99 latency jumps to ~5.2 s at peak',
      kind: 'supporting',
      match: /TargetResponseTime \[shopfast-prod-alb\]/,
      foundBy: { tool: 'cloudwatch', panel: 'alb.latency' },
      explanation: 'A latency plateau at almost exactly 5 s is a fingerprint: it matches the resolver timeout, not any application or database timeout in this stack.',
    },
    {
      id: 'paybridge-status',
      label: 'PayBridge had an incident earlier today',
      kind: 'red-herring',
      match: /Elevated API error rates in us-east/,
      foundBy: { tool: 'terminal', host: 'bastion', command: 'curl -s https://status.paybridge.com/api/v2/incidents.json' },
      explanation: 'It was resolved at 13:52 UTC, returned 503s (not DNS failures), and cannot explain EAI_AGAIN for SQS, catalog or our own private zone.',
    },
    {
      id: 'dig-works',
      label: 'dig api.paybridge.com answers instantly',
      kind: 'red-herring',
      match: /api\.paybridge\.com\.\s+\d+\s+IN\s+A\s/,
      foundBy: { tool: 'terminal', host: 'app-2', command: 'dig api.paybridge.com' },
      explanation: 'One query is far below a 1,024 packets/s limit, so a manual test always succeeds. Rate-based failures cannot be reproduced one request at a time; it proves the records are fine, not that resolution is.',
    },
    {
      id: 'sg-change',
      label: 'shopfast-app-sg gained a tcp/9100 rule yesterday',
      kind: 'red-herring',
      match: /tcp\/9100|"fromPort":9100/,
      foundBy: { tool: 'ec2' },
      explanation: 'An inbound TCP rule cannot drop outbound UDP DNS (security groups are stateful, and traffic to the VPC resolver is not filtered by them anyway). The errors also started two days before the change.',
    },
    {
      id: 'catalog-deploy',
      label: 'catalog-service 1.42.0 was deployed this afternoon',
      kind: 'red-herring',
      match: /catalog-service 1\.42\.0/,
      foundBy: { tool: 'deploys' },
      explanation: 'catalog-service is healthy (its endpoint answers in milliseconds) — the failures happen before a connection is even attempted, while resolving its name, and the same failures existed on the previous two evenings.',
    },
  ],

  rootCauses: [
    {
      id: 'rc-dns-pps',
      correct: true,
      text: '2.17.0 removed the app\'s DNS cache and keep-alive; with no OS cache on the AMI each host sends >1,024 DNS packets/s to the VPC resolver at peak, and the ENI\'s link-local limit silently drops the excess.',
      explanation: 'ethtool shows linklocal_allowance_exceeded rising only at peak and only since Sunday\'s 2.17.0 deploy; resolved has no cache; the app logs show 5 s lookup stalls and EAI_AGAIN for every hostname, public and private.',
    },
    {
      id: 'rc-resolver',
      partial: true,
      text: 'The Route 53 Resolver at 10.0.0.2 throttles the checkout instances at peak, dropping DNS queries above its per-instance quota so getaddrinfo fails with EAI_AGAIN.',
      explanation: 'The mechanism is right, but it misses why: the quota has not changed — our lookup volume did. Without the 2.17.0 change and the missing OS cache, you would "fix" it by asking AWS for a limit that cannot be raised.',
    },
    {
      id: 'rc-paybridge',
      text: 'PayBridge\'s us-east edge is still degraded after this morning\'s incident; the authoritative DNS for api.paybridge.com times out intermittently under evening load.',
      explanation: 'The same EAI_AGAIN hits sqs.us-east-1.amazonaws.com, catalog.internal.shopfast.io and db.internal.shopfast.io, which PayBridge does not serve. Their incident was resolved hours earlier and produced 503s, not DNS failures.',
    },
    {
      id: 'rc-nat',
      text: 'NAT gateway nat-0f3c2a91b8e7d6540 exhausts its 55,000 source ports per destination at record traffic, so outbound DNS and HTTPS from the app subnets is dropped intermittently.',
      explanation: 'ErrorPortAllocation is 0, and queries to the VPC resolver (10.0.0.2) and to private names never traverse the NAT gateway at all.',
    },
    {
      id: 'rc-threadpool',
      text: 'Node\'s libuv threadpool (UV_THREADPOOL_SIZE=4) saturates at peak; getaddrinfo calls queue behind fs and crypto work for over 10 s and time out with EAI_AGAIN.',
      explanation: 'Queuing in the threadpool adds latency, but getaddrinfo returns EAI_AGAIN only when the resolver does not answer. The ENA drop counter proves packets were lost on the wire. (The tiny pool does make every 5 s stall hurt more.)',
    },
    {
      id: 'rc-sg',
      text: 'The tcp/9100 rule Terraform added to shopfast-app-sg 26 h ago pushed the group near its rule quota, and replies from the resolver on UDP 53 are intermittently dropped at high packet rates.',
      explanation: 'Security groups are stateful and a single extra inbound rule changes nothing for DNS replies; the failures also began two evenings before this change.',
    },
  ],

  fixes: [
    {
      id: 'fx-local-cache',
      kind: 'correct',
      text: 'Run a local caching resolver on the app AMI (systemd-resolved with Cache=yes and the 127.0.0.53 stub, or dnsmasq/unbound) and restore cacheable-lookup in checkout-api.',
      explanation: 'A cache that honours TTLs turns hundreds of lookups per second for the same few names into a handful of upstream queries per TTL. Two layers (app + OS) mean losing one no longer takes you over the limit.',
    },
    {
      id: 'fx-keepalive',
      kind: 'correct',
      text: 'Restore keep-alive for PayBridge, SQS and catalog, and fix CHK-1442 properly by retiring idle sockets before PayBridge\'s 5 s idle timeout.',
      explanation: 'Reused connections need no new lookup, TCP or TLS handshake. CHK-1442 is solved by a client idle timeout shorter than the server\'s (e.g. freeSocketTimeout 4 s) plus a retry of idempotent requests on ECONNRESET — not by disabling reuse.',
    },
    {
      id: 'fx-rollback',
      kind: 'partial',
      text: 'Roll checkout-api back to 2.16.2, which still had cacheable-lookup and keep-alive enabled, until a proper fix ships.',
      explanation: 'A good immediate mitigation for tonight, but it brings back CHK-1442 and leaves the AMI one dependency removal away from the same outage.',
    },
    {
      id: 'fx-scale-out',
      kind: 'partial',
      text: 'Raise shopfast-checkout-asg desired capacity from 3 to 6 so each ENI\'s 1,024 pps link-local allowance carries half the DNS traffic.',
      explanation: 'It works because the limit is per ENI: half the requests per host means half the packets per ENI. But it doubles cost to work around waste, and traffic growth will catch up.',
    },
    {
      id: 'fx-retry',
      kind: 'partial',
      text: 'Wrap PayBridge, SQS and catalog calls in a retry (3 attempts, jittered backoff) on EAI_AGAIN and ENOTFOUND.',
      explanation: 'Fewer user-visible failures, but every retry is more DNS packets against the same limit and each failed attempt already costs 10 s — latency gets worse.',
    },
    {
      id: 'fx-bigger',
      kind: 'neutral',
      text: 'Change the instance type from m6i.large to m6i.2xlarge for 4× the vCPUs and a higher network bandwidth and packets-per-second allowance.',
      explanation: 'Bandwidth and PPS allowances grow with instance size, but the 1,024 pps link-local limit is per ENI and identical on every instance type — and fewer, bigger instances would concentrate even more DNS traffic per ENI.',
    },
    {
      id: 'fx-restart',
      kind: 'neutral',
      text: 'Restart checkout-api on all three hosts to clear stuck getaddrinfo calls from the libuv threadpool and reset the HTTP agents.',
      explanation: 'Nothing is stuck; the process comes back with the same code and immediately generates the same lookup rate.',
    },
    {
      id: 'fx-public-dns',
      kind: 'harmful',
      text: 'Point /etc/resolv.conf on the app hosts at 8.8.8.8 and 1.1.1.1 so DNS no longer depends on the VPC resolver\'s per-ENI limits.',
      explanation: 'Public resolvers cannot see the private hosted zone, so db.internal.shopfast.io, cache.internal.shopfast.io and catalog.internal.shopfast.io stop resolving entirely (a full outage), VPC endpoint private DNS breaks, and DNS now depends on the NAT gateway.',
    },
    {
      id: 'fx-threadpool',
      kind: 'harmful',
      text: 'Set UV_THREADPOOL_SIZE=128 so far more getaddrinfo calls can run in parallel during the peak.',
      explanation: 'More concurrent lookups means more DNS packets per second against the same 1,024 pps allowance — more drops, more 5 s stalls.',
    },
  ],

  hints: [
    'It fails only at peak and never when someone tests by hand. That is the signature of a rate limit, not a broken record. Which per-instance limits exist that no default CloudWatch metric shows, and what rate grows with traffic?',
    'EAI_AGAIN means the resolver did not answer in time. Look at the network driver\'s own counters on an app host (`ethtool -S ens5`) and at how the host resolves names (/etc/resolv.conf, systemd-resolved). Then ask why the app suddenly makes so many lookups.',
    'The VPC resolver accepts 1,024 packets/s per network interface and silently drops the rest (linklocal_allowance_exceeded). Compare checkout-api 2.17.0\'s diff — DNS cache and keep-alive — with how the AMI caches DNS.',
  ],

  debrief: {
    summary: `On Sunday afternoon checkout-api **2.17.0** shipped a "cleanup" of the outbound HTTP client: to fix sporadic ECONNRESETs from PayBridge (CHK-1442) it set \`keepAlive: false\`, and depcheck flagged \`cacheable-lookup\` as unused, so it was removed. Neither looked dangerous and a 30-minute canary on a quiet Sunday was clean.

Together they changed how often the app talks to DNS. Every outbound call (catalog on most requests, PayBridge and SQS on checkout, pg reconnects) now opens a fresh connection, and every connection starts with \`getaddrinfo\` — an A *and* an AAAA query. The AMI gives no relief: its hardening set \`Cache=no\` and \`DNSStubListener=no\` in systemd-resolved and removed nss-resolve, so glibc sends every query straight to the VPC resolver at **10.0.0.2**.

The Amazon-provided resolver is reached through the instance's Nitro card as a **link-local service**, and each ENI may send at most **1,024 packets per second** to link-local services. At the evening peak each host needs ~1,100–1,250 packets/s (bursting past 1,400 in the busiest seconds). The excess is dropped **silently**: no ICMP, no error, just a counter in the ENA driver (\`linklocal_allowance_exceeded\`). glibc waits its 5 s timeout and retries; two misses and the app gets \`EAI_AGAIN\`. Hence the ~5 s p99, the failures spread across *every* hostname, and why a hand-run \`dig\` — one packet — always succeeds.

PayBridge's morning incident, the NAT gateway, the security-group rule and the catalog deploy were all coincidences. The only thing that changed on Sunday was the volume of DNS packets per ENI.`,
    timeline: [
      { minutesAgo: 21 * 1440, event: 'AMI shopfast-app-al2023-2026.09.18 built with resolved Cache=no / no stub (no visible effect: the app had its own DNS cache)' },
      { minutesAgo: DEPLOY_2170, event: 'Sun 15:20 — checkout-api 2.17.0: cacheable-lookup removed, keepAlive: false (canary clean on a quiet afternoon)' },
      { minutesAgo: DEPLOY_2170 - 150, event: 'Sun evening peak — first linklocal_allowance_exceeded drops and EAI_AGAIN errors' },
      { minutesAgo: DEPLOY_2171, event: 'Tue 16:10 — checkout-api 2.17.1 (currency formatting, unrelated); errors again that evening' },
      { minutesAgo: SG_CHANGE, event: 'tcp/9100 rule added to shopfast-app-sg (unrelated)' },
      { minutesAgo: 352, event: 'PayBridge minor incident 12:58–13:52 UTC (503s, resolved — unrelated)' },
      { minutesAgo: DROPS_START, event: 'Tonight\'s peak pushes app hosts past 1,024 DNS packets/s; drops and 5 s stalls begin' },
      { minutesAgo: 31, event: 'checkout-alb-target-5xx-high pages on-call' },
    ],
    concepts: [
      {
        title: 'How DNS resolution works on EC2',
        body: 'Every VPC has the Amazon-provided DNS server (Route 53 Resolver) at the VPC CIDR base **+2** (here 10.0.0.2) and at **169.254.169.253**. It answers for private hosted zones associated with the VPC (`internal.shopfast.io`), VPC endpoint private DNS and EC2 hostnames, and recurses for public names. Queries never leave the host as ordinary VPC traffic: the Nitro card hands them to the resolver as a link-local service, which is why security groups and the NAT gateway are not in the path.',
      },
      {
        title: 'ENA allowances and the 1,024 pps link-local limit',
        body: 'Nitro instances enforce several per-ENI allowances and report drops through the ENA driver: `bw_in/out_allowance_exceeded` (bandwidth), `pps_allowance_exceeded` (packets/s), `conntrack_allowance_exceeded` (tracked connections) and `linklocal_allowance_exceeded` — packets to the Route 53 Resolver, IMDS and Amazon Time Sync beyond **1,024 packets/s per ENI**. The link-local limit is the same on every instance size and cannot be raised. Read the counters with `ethtool -S ens5` and publish them with the CloudWatch agent\'s ethtool plugin so you can alarm on them.',
      },
      {
        title: 'getaddrinfo and the libuv threadpool in Node.js',
        body: '`dns.lookup()` — used by `net`, `http`, `https` and the AWS SDK — calls glibc `getaddrinfo()`, which is blocking, so libuv runs it on its threadpool (default **4** threads, shared with fs, crypto and zlib). It honours /etc/hosts, nsswitch and resolv.conf, but Node does no caching of its own. When a packet is dropped, a pool thread sits in the 5 s timeout, so a few drops can back up every other lookup. `dns.resolve*()` uses c-ares on the event loop instead, but skips /etc/hosts and nsswitch.',
      },
      {
        title: 'DNS caching layers and TTLs',
        body: 'There are three places to cache: in the application (cacheable-lookup, or the SDK reusing connections), on the host (systemd-resolved, nscd, dnsmasq, unbound), and at the resolver itself. Each layer that honours the record TTL collapses repeated lookups of the same name into one query per TTL. Here, catalog (TTL 60) and PayBridge (TTL 300) were being resolved hundreds of times per second when one query per minute would do. A TTL-honouring cache does not make failovers slower than the TTL you chose.',
      },
      {
        title: 'Why manual testing does not reproduce rate-based failures',
        body: '`dig` sends one packet; the limit is about the *aggregate* rate from the interface in a given second. Any failure that only appears at peak, only on some requests, and never by hand points to a shared per-second budget: link-local allowances, conntrack, ephemeral ports, API rate limits, connection pools. Look for counters, not reproductions.',
      },
      {
        title: 'Keep-alive is a DNS feature too',
        body: 'A reused HTTP connection skips DNS, TCP and TLS handshakes entirely. Disabling keep-alive to dodge stale-socket ECONNRESETs multiplies DNS queries, TLS CPU, TIME-WAIT sockets and NAT connection churn. The correct fix for servers that close idle connections is a client idle timeout shorter than the server\'s and a retry of idempotent requests on ECONNRESET.',
      },
    ],
    commands: [
      { cmd: 'ethtool -S ens5 | grep allowance', why: 'ENA allowance counters — the only place link-local, PPS, bandwidth and conntrack drops are visible' },
      { cmd: 'cat /etc/resolv.conf; resolvectl status; resolvectl statistics', why: 'Which resolver the host uses and whether a local cache sits in front of it' },
      { cmd: 'grep -c EAI_AGAIN /var/log/checkout-api/app.log', why: 'How often name resolution failed, and for which hostnames' },
      { cmd: 'ss -s', why: 'A huge TIME-WAIT count means connections are not being reused' },
      { cmd: 'dig +stats api.paybridge.com @10.0.0.2', why: 'Proves the records are fine — and that a single query will never reproduce a rate limit' },
    ],
    prevention: [
      'Bake a TTL-honouring local DNS cache into the AMI and keep an app-level cache; treat removing either as a behavioural change that needs review.',
      'Publish ENA ethtool allowance counters with the CloudWatch agent and alarm on any non-zero linklocal/pps/conntrack_allowance_exceeded.',
      'Load-test changes to networking code at peak traffic, not with a quiet-hour canary; track DNS queries/s per host as a metric.',
      'Keep HTTP keep-alive on for outbound clients; handle server idle timeouts with shorter client idle timeouts and idempotent retries.',
      'Enable Route 53 Resolver query logging to see query volume per instance.',
    ],
    reading: [
      { title: 'Amazon VPC: DNS attributes and quotas (1,024 packets per second per network interface)', url: 'https://docs.aws.amazon.com/vpc/latest/userguide/AmazonDNS-concepts.html' },
      { title: 'Monitor network performance for ENA settings on your EC2 instance', url: 'https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/monitoring-network-performance-ena.html' },
      { title: 'Node.js dns module — implementation considerations (lookup vs resolve, threadpool)', url: 'https://nodejs.org/api/dns.html#implementation-considerations' },
    ],
  },
};

export default incident;
