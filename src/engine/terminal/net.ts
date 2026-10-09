import type { Environment, HttpRule } from '../types';
import { dateCmd } from '../time';
import { hashString } from '../rng';
import type { Ctx } from './linux';
import { parseArgs } from './shell';

/* ------------------------------ DNS ------------------------------ */

export interface DnsAnswer {
  name: string;
  type: string;
  ttl: number;
  value: string;
}

export interface DnsResult {
  status: 'NOERROR' | 'NXDOMAIN' | 'SERVFAIL';
  answers: DnsAnswer[];
  authority?: DnsAnswer;
  addresses: string[];
}

const strip = (n: string) => n.replace(/\.$/, '').toLowerCase();

export function resolveDns(env: Environment, qname: string, qtype = 'A', depth = 0): DnsResult {
  const name = strip(qname);
  if (depth > 8) return { status: 'SERVFAIL', answers: [], addresses: [] };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(name)) return { status: 'NOERROR', answers: [], addresses: [name] };
  if (name === 'localhost') return { status: 'NOERROR', answers: [], addresses: ['127.0.0.1'] };
  for (const h of Object.values(env.hosts)) {
    if (name === h.hostname || name === `${h.hostname}.ec2.internal`) return { status: 'NOERROR', answers: [{ name: `${h.hostname}.ec2.internal`, type: 'A', ttl: 60, value: h.ip }], addresses: [h.ip] };
  }
  const zones = env.route53.zones.filter(z => name === z.name || name.endsWith('.' + z.name)).sort((a, b) => b.name.length - a.name.length);
  const zone = zones[0];
  if (zone) {
    const soa: DnsAnswer = { name: zone.name, type: 'SOA', ttl: 900, value: zone.records.find(r => r.type === 'SOA')?.values[0] ?? `ns-1204.awsdns-22.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 86400` };
    const recs = zone.records.filter(r => strip(r.name) === name);
    const cname = recs.find(r => r.type === 'CNAME');
    if (cname) {
      const target = strip(cname.values[0]);
      const next = resolveDns(env, target, qtype, depth + 1);
      return { ...next, answers: [{ name, type: 'CNAME', ttl: cname.ttl, value: target + '.' }, ...next.answers] };
    }
    const direct = recs.find(r => r.type === qtype);
    if (direct) {
      if (direct.alias) {
        const t = resolveDns(env, direct.alias.target, 'A', depth + 1);
        if (t.status !== 'NOERROR') return { ...t, answers: [], authority: soa };
        return { status: 'NOERROR', answers: t.addresses.map(a => ({ name, type: 'A', ttl: 60, value: a })), addresses: t.addresses };
      }
      return { status: 'NOERROR', answers: direct.values.map(v => ({ name, type: direct.type, ttl: direct.ttl, value: v })), addresses: direct.type === 'A' ? direct.values : [] };
    }
    if (recs.length) return { status: 'NOERROR', answers: [], authority: soa, addresses: [] };
    return { status: 'NXDOMAIN', answers: [], authority: soa, addresses: [] };
  }
  const ext = env.route53.external[name];
  if (ext === 'NXDOMAIN' || ext === undefined) {
    const tld = name.endsWith('.elb.amazonaws.com') ? 'elb.amazonaws.com' : name.split('.').slice(-2).join('.');
    return { status: 'NXDOMAIN', answers: [], authority: { name: tld, type: 'SOA', ttl: 60, value: name.endsWith('amazonaws.com') ? 'ns-1119.awsdns-11.org. awsdns-hostmaster.amazon.com. 1 7200 900 1209600 60' : `a.gtld-servers.net. nstld.verisign-grs.com. 1728492001 1800 900 604800 86400` }, addresses: [] };
  }
  if (ext === 'SERVFAIL') return { status: 'SERVFAIL', answers: [], addresses: [] };
  const ttl = name.endsWith('elb.amazonaws.com') ? 60 : name.endsWith('rds.amazonaws.com') ? 5 : 300;
  return { status: 'NOERROR', answers: ext.map(v => ({ name, type: 'A', ttl, value: v })), addresses: ext };
}

export function dig(ctx: Ctx, args: string[]): string {
  const env = ctx.env;
  const short = args.includes('+short');
  const rest = args.filter(a => !a.startsWith('+'));
  const server = rest.find(a => a.startsWith('@'))?.slice(1) ?? '10.0.0.2';
  const words = rest.filter(a => !a.startsWith('@') && !a.startsWith('-'));
  const types = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'ANY'];
  const qtype = (words.find(w => types.includes(w.toUpperCase())) ?? 'A').toUpperCase();
  const qname = words.find(w => !types.includes(w.toUpperCase()));
  if (!qname) return dig(ctx, ['.', 'NS']);
  const r = resolveDns(env, qname, qtype);
  if (short) return r.answers.map(a => a.value).join('\n');
  const fq = (n: string) => (n.endsWith('.') ? n : n + '.');
  const id = 10000 + (hashString(qname) % 50000);
  const out = [
    `; <<>> DiG 9.18.28 <<>> ${args.join(' ')}`,
    ';; global options: +cmd',
    ';; Got answer:',
    `;; ->>HEADER<<- opcode: QUERY, status: ${r.status}, id: ${id}`,
    `;; flags: qr rd ra; QUERY: 1, ANSWER: ${r.answers.length}, AUTHORITY: ${r.authority ? 1 : 0}, ADDITIONAL: 1`,
    '',
    ';; OPT PSEUDOSECTION:',
    '; EDNS: version: 0, flags:; udp: 4096',
    ';; QUESTION SECTION:',
    `;${fq(qname)}\t\t\tIN\t${qtype}`,
  ];
  if (r.answers.length) {
    out.push('', ';; ANSWER SECTION:');
    for (const a of r.answers) out.push(`${fq(a.name)}\t\t${a.ttl}\tIN\t${a.type}\t${a.value}`);
  }
  if (r.authority) {
    out.push('', ';; AUTHORITY SECTION:', `${fq(r.authority.name)}\t\t${r.authority.ttl}\tIN\tSOA\t${r.authority.value}`);
  }
  out.push('', `;; Query time: ${r.status === 'NOERROR' ? 2 : 31} msec`, `;; SERVER: ${server}#53(${server}) (UDP)`, `;; WHEN: ${dateCmd(env.now)}`, `;; MSG SIZE  rcvd: ${48 + r.answers.length * 16}`);
  return out.join('\n');
}

export function nslookup(ctx: Ctx, args: string[]): string {
  const name = args.find(a => !a.startsWith('-'));
  if (!name) return 'Usage: nslookup <name>';
  const r = resolveDns(ctx.env, name);
  const out = ['Server:\t\t10.0.0.2', 'Address:\t10.0.0.2#53', ''];
  if (r.status !== 'NOERROR') {
    const last = r.answers.filter(a => a.type === 'CNAME').pop();
    for (const a of r.answers.filter(a => a.type === 'CNAME')) out.push(`${a.name}\tcanonical name = ${a.value}`);
    out.push(`** server can't find ${last ? last.value.replace(/\.$/, '') : name}: ${r.status}`);
    return out.join('\n');
  }
  out.push('Non-authoritative answer:');
  for (const a of r.answers) {
    if (a.type === 'CNAME') out.push(`${a.name}\tcanonical name = ${a.value}`);
    else out.push(`Name:\t${a.name}`, `Address: ${a.value}`);
  }
  return out.join('\n');
}

export function hostCmd(ctx: Ctx, args: string[]): string {
  const name = args.find(a => !a.startsWith('-'));
  if (!name) return 'Usage: host [-v] name [server]';
  const r = resolveDns(ctx.env, name);
  const out: string[] = [];
  for (const a of r.answers) out.push(a.type === 'CNAME' ? `${a.name} is an alias for ${a.value}` : `${a.name} has address ${a.value}`);
  if (r.status !== 'NOERROR') {
    const last = r.answers.filter(a => a.type === 'CNAME').pop();
    out.push(`Host ${last ? last.value.replace(/\.$/, '') : name} not found: ${r.status === 'NXDOMAIN' ? '3(NXDOMAIN)' : '2(SERVFAIL)'}`);
  }
  return out.join('\n');
}

/* ------------------------------ HTTP / TCP ------------------------------ */

interface Target {
  scheme: string;
  host: string;
  port: number;
  path: string;
  url: string;
}

function parseUrl(raw: string): Target | null {
  let s = raw;
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  const m = s.match(/^([a-z]+):\/\/([^/:?#]+)(?::(\d+))?([^#]*)?/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = m[3] ? Number(m[3]) : scheme === 'https' ? 443 : 80;
  const path = m[4] || '/';
  return { scheme, host: m[2].toLowerCase(), port, path, url: `${scheme}://${m[2].toLowerCase()}${m[3] ? ':' + m[3] : ''}${path}` };
}

export function findRule(ctx: Ctx, url: string): HttpRule | undefined {
  return ctx.env.http.find(r => r.match.test(url) && (!r.fromHosts || r.fromHosts.includes(ctx.host.name)));
}

function localize(ctx: Ctx, t: Target): Target {
  if (t.host === ctx.host.ip || t.host === ctx.host.hostname) {
    const url = `${t.scheme}://localhost${t.port !== (t.scheme === 'https' ? 443 : 80) ? ':' + t.port : ''}${t.path}`;
    return { ...t, host: 'localhost', url };
  }
  return t;
}

const STATUS_TEXT: Record<number, string> = { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Time-out' };

export function curl(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args, ['m', 'max-time', 'connect-timeout', 'o', 'w', 'X', 'H', 'd', 'data', 'u', 'A', 'request', 'header', 'write-out', 'output']);
  const rawUrl = a.positional[0];
  if (!rawUrl) return "curl: try 'curl --help' or 'curl --manual' for more information";
  const parsed = parseUrl(rawUrl);
  if (!parsed) return `curl: (3) URL using bad/illegal format or missing URL`;
  const t = localize(ctx, parsed);
  const verbose = a.flags.has('v') || a.flags.has('verbose');
  const headOnly = a.flags.has('I') || a.flags.has('head');
  const silent = a.flags.has('s') || a.flags.has('silent');
  const includeHeaders = a.flags.has('i') || a.flags.has('include');
  const maxTime = Number(a.opts.m ?? a.opts['max-time'] ?? a.opts['connect-timeout'] ?? 0);
  const writeOut = a.opts.w ?? a.opts['write-out'];
  const toNull = (a.opts.o ?? a.opts.output) === '/dev/null';
  const method = (a.opts.X ?? a.opts.request ?? (a.opts.d || a.opts.data ? 'POST' : headOnly ? 'HEAD' : 'GET')).toUpperCase();

  const out: string[] = [];
  const v = (s: string) => verbose && out.push(s);

  const dns = resolveDns(ctx.env, t.host);
  if (!dns.addresses.length) {
    v(`* Could not resolve host: ${t.host}`);
    out.push(`curl: (6) Could not resolve host: ${t.host}`);
    return out.join('\n');
  }
  const rule = findRule(ctx, t.url);
  const ip = rule?.ip ?? dns.addresses[0];
  v(`*   Trying ${ip}:${t.port}...`);
  const behaviour = rule?.behaviour ?? 'ok';
  const timeoutMs = maxTime ? maxTime * 1000 : 130000 + (hashString(t.url) % 900);
  if (behaviour === 'timeout') {
    if (maxTime) out.push(`curl: (28) Connection timed out after ${timeoutMs + 1} milliseconds`);
    else out.push(`curl: (28) Failed to connect to ${t.host} port ${t.port} after ${timeoutMs} ms: Couldn't connect to server`);
    return out.join('\n');
  }
  if (behaviour === 'refused') {
    out.push(`curl: (7) Failed to connect to ${t.host} port ${t.port} after 0 ms: Couldn't connect to server`);
    return out.join('\n');
  }
  if (behaviour === 'dns-fail') {
    out.push(`curl: (6) Could not resolve host: ${t.host}`);
    return out.join('\n');
  }
  v(`* Connected to ${t.host} (${ip}) port ${t.port}`);
  if (t.scheme === 'https') {
    v('* ALPN: curl offers h2,http/1.1');
    v('* TLSv1.3 (OUT), TLS handshake, Client hello (1):');
    v('* TLSv1.3 (IN), TLS handshake, Server hello (2):');
    if (behaviour === 'tls-error') {
      v('* TLSv1.3 (OUT), TLS alert, certificate expired (557):');
      out.push(`curl: (60) ${rule?.tlsError ?? 'SSL certificate problem: certificate has expired'}`, 'More details here: https://curl.se/docs/sslcerts.html');
      return out.join('\n');
    }
    v('* SSL connection using TLSv1.3 / TLS_AES_128_GCM_SHA256 / X25519 / RSASSA-PSS');
    v('* Server certificate:');
    v(`*  subject: CN=${t.host.endsWith('shopfast.io') ? '*.shopfast.io' : t.host}`);
    v('*  SSL certificate verify ok.');
  }
  if (behaviour === 'reset') {
    v(`> ${method} ${t.path} HTTP/1.1`);
    out.push('curl: (56) Recv failure: Connection reset by peer');
    return out.join('\n');
  }
  const status = rule?.status ?? 200;
  if (status === 0) {
    // non-HTTP service (postgres, redis): connected, then garbage/empty reply
    out.push('curl: (52) Empty reply from server');
    return out.join('\n');
  }
  v(`> ${method} ${t.path} HTTP/1.1`);
  v(`> Host: ${t.host}${t.port !== 80 && t.port !== 443 ? ':' + t.port : ''}`);
  v('> User-Agent: curl/8.5.0');
  v('> Accept: */*');
  v('>');
  const headers = { Date: dateCmd(ctx.env.now).replace(/^(\w+) (\w+)\s+(\d+) ([\d:]+) UTC (\d+)$/, '$1, $3 $2 $5 $4 GMT'), 'Content-Type': 'text/html', ...(rule?.headers ?? {}) };
  const body = rule?.body ?? (rule ? '' : '<!doctype html><html><head><title>Example</title></head><body>OK</body></html>');
  const headerLines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}`.trim(), ...Object.entries(headers).map(([k, val]) => `${k}: ${val}`), `Content-Length: ${body.length}`, 'Connection: keep-alive'];
  if (verbose) for (const h of headerLines) out.push('< ' + h);
  v('<');
  if (headOnly) {
    if (!verbose) out.push(...headerLines);
  } else if (!toNull) {
    if (includeHeaders && !verbose) out.push(...headerLines, '');
    out.push(body);
  }
  v(`* Connection #0 to host ${t.host} left intact`);
  if (writeOut) {
    const time = ((rule?.timeMs ?? 40) / 1000).toFixed(6);
    out.push(
      writeOut
        .replace(/%\{http_code\}/g, String(status))
        .replace(/%\{time_total\}/g, time)
        .replace(/%\{time_starttransfer\}/g, time)
        .replace(/%\{time_connect\}/g, (0.0011).toFixed(6))
        .replace(/%\{time_namelookup\}/g, (0.0004).toFixed(6))
        .replace(/\\n/g, '\n'),
    );
  }
  void silent;
  return out.join('\n');
}

export function nc(ctx: Ctx, args: string[]): string {
  const a = parseArgs(args, ['w']);
  const [hostArg, portArg] = a.positional;
  if (!hostArg || !portArg) return 'Ncat: You must specify a host to connect to. QUITTING.';
  let host = hostArg.toLowerCase();
  if (host === ctx.host.ip || host === ctx.host.hostname) host = 'localhost';
  const dns = resolveDns(ctx.env, host);
  if (!dns.addresses.length) return `Ncat: Version 7.93 ( https://nmap.org/ncat )\nNcat: Could not resolve hostname "${hostArg}": Name or service not known. QUITTING.`;
  const port = Number(portArg);
  const scheme = port === 443 ? 'https' : 'http';
  const url = `${scheme}://${host}${port === 80 || port === 443 ? '' : ':' + port}/`;
  const tcpUrl = `tcp://${host}:${port}`;
  const rule = ctx.env.http.find(r => (r.match.test(tcpUrl) || r.match.test(url)) && (!r.fromHosts || r.fromHosts.includes(ctx.host.name)));
  const ip = dns.addresses[0];
  const out = ['Ncat: Version 7.93 ( https://nmap.org/ncat )'];
  const b = rule?.behaviour ?? (host === 'localhost' && !ctx.host.sockets.listen.some(l => l.addr.endsWith(':' + port)) ? 'refused' : 'ok');
  if (b === 'timeout') out.push('Ncat: TIMEOUT.');
  else if (b === 'refused') out.push('Ncat: Connection refused.');
  else if (b === 'dns-fail') out.push(`Ncat: Could not resolve hostname "${hostArg}". QUITTING.`);
  else out.push(`Ncat: Connected to ${ip}:${port}.`, 'Ncat: 0 bytes sent, 0 bytes received in 0.02 seconds.');
  return out.join('\n');
}

export function ping(ctx: Ctx, args: string[]): string {
  const name = args.filter(a => !a.startsWith('-') && !/^\d+$/.test(a))[0];
  if (!name) return 'ping: usage error: Destination address required';
  const dns = resolveDns(ctx.env, name);
  if (!dns.addresses.length) return `ping: ${name}: Name or service not known`;
  const ip = dns.addresses[0];
  const internal = ip.startsWith('10.');
  const egress = findRule(ctx, `https://${name}/`);
  const lost = (internal && ip !== ctx.host.ip) || egress?.behaviour === 'timeout';
  const out = [`PING ${name} (${ip}) 56(84) bytes of data.`];
  if (!lost) for (let i = 1; i <= 4; i++) out.push(`64 bytes from ${ip}: icmp_seq=${i} ttl=${internal ? 64 : 52} time=${(internal ? 0.3 : 1.6 + i * 0.07).toFixed(2)} ms`);
  out.push('', `--- ${name} ping statistics ---`, lost ? '4 packets transmitted, 0 received, 100% packet loss, time 3077ms' : '4 packets transmitted, 4 received, 0% packet loss, time 3004ms');
  if (lost && internal) out.push('', '[note] Security groups in this VPC do not allow ICMP between instances, so ping is not a reliable reachability test here — try nc -zv or curl.');
  return out.join('\n');
}

export function traceroute(ctx: Ctx, args: string[]): string {
  const name = args.find(a => !a.startsWith('-'));
  if (!name) return 'Usage: traceroute host';
  const dns = resolveDns(ctx.env, name);
  if (!dns.addresses.length) return `${name}: Name or service not known\nCannot handle "host" cmdline arg \`${name}' on position 1 (argc 1)`;
  const ip = dns.addresses[0];
  const egress = findRule(ctx, `https://${name}/`);
  const out = [`traceroute to ${name} (${ip}), 30 hops max, 60 byte packets`];
  if (egress?.behaviour === 'timeout') {
    for (let i = 1; i <= 6; i++) out.push(` ${i}  * * *`);
    out.push(' ...', '30  * * *');
  } else if (ip.startsWith('10.')) {
    out.push(` 1  ${ip}  0.412 ms  0.398 ms  0.391 ms`);
  } else {
    out.push(' 1  * * *', ' 2  * * *', ' 3  240.4.88.34 (240.4.88.34)  1.812 ms  1.802 ms  1.790 ms', ` 4  ${ip} (${ip})  2.118 ms  2.091 ms  2.087 ms`);
  }
  return out.join('\n');
}
