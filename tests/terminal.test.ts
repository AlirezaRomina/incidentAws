import { describe, expect, it } from 'vitest';
import { baseEnvironment } from '../src/env/base';
import { finalizeEnvironment } from '../src/env/finalize';
import { complete, execute, initialTermState, promptFor } from '../src/engine/terminal';
import { splitPipes, tokenize } from '../src/engine/terminal/shell';
import { evaluate } from '../src/engine/terminal/aws';

const env = finalizeEnvironment(baseEnvironment(Date.parse('2026-10-09T14:52:00Z')));
const run = (cmds: string[]) => {
  let st = initialTermState(env);
  let out = '';
  for (const c of cmds) {
    const r = execute(env, st, c);
    st = r.state;
    out = r.output;
  }
  return { out, st };
};

describe('shell parsing', () => {
  it('tokenizes quotes and escapes', () => {
    expect(tokenize(`grep -i "no space left" '/var/log/a b.log'`)).toEqual(['grep', '-i', 'no space left', '/var/log/a b.log']);
  });
  it('splits pipes but not quoted pipes or ||', () => {
    expect(splitPipes(`grep "a|b" f | wc -l`)).toEqual(['grep "a|b" f', 'wc -l']);
    expect(splitPipes('a || b')).toEqual(['a || b']);
  });
});

describe('terminal', () => {
  it('starts on the bastion and can ssh to app hosts and back', () => {
    const s0 = initialTermState(env);
    expect(promptFor(env, s0)).toContain('bastion');
    const { st } = run(['ssh app-2']);
    expect(st.host).toBe('app-2');
    expect(promptFor(env, st)).toContain('ip-10-0-11-87');
    expect(run(['ssh app-2', 'exit']).st.host).toBe('bastion');
    expect(run(['ssh 10.0.10.23']).st.host).toBe('app-1');
  });
  it('reads files, supports pipes and grep', () => {
    expect(run(['ssh app-1', 'cat /etc/hostname']).out).toBe('ip-10-0-10-23');
    const n = Number(run(['ssh app-1', 'cat /var/log/nginx/access.log | wc -l']).out);
    expect(n).toBeGreaterThan(100);
    expect(run(['ssh app-1', 'grep -c ELB-HealthChecker /var/log/nginx/access.log']).out).toMatch(/^\d+$/);
    expect(run(['ssh app-1', 'tail -n 3 /var/log/nginx/access.log']).out.split('\n')).toHaveLength(3);
  });
  it('renders system commands', () => {
    expect(run(['ssh app-1', 'df -h']).out).toMatch(/\/dev\/nvme0n1p1\s+50G/);
    expect(run(['ssh app-1', 'free -m']).out).toMatch(/^\s+total/);
    expect(run(['ssh app-1', 'systemctl status checkout-api']).out).toContain('active (running)');
    expect(run(['ssh app-1', 'ps aux | grep node']).out).toContain('/opt/checkout-api/dist/server.js');
  });
  it('resolves DNS through Route 53 and external names', () => {
    expect(run(['dig +short api.shopfast.io']).out).toBe('3.214.87.19\n52.71.140.6');
    expect(run(['dig db.internal.shopfast.io']).out).toContain('CNAME');
    expect(run(['dig nope.example.invalid']).out).toContain('NXDOMAIN');
  });
  it('curl and nc follow HTTP rules', () => {
    expect(run(['ssh app-1', 'curl -s http://localhost/health']).out).toContain('"status":"ok"');
    expect(run(['curl https://does-not-exist.invalid']).out).toContain('Could not resolve host');
    expect(run(['nc -zv db.internal.shopfast.io 5432']).out).toContain('Connected to 10.0.20.57:5432');
  });
  it('psql mode: connect, query, read-only, quit', () => {
    const { st, out } = run(['psql -h db.internal.shopfast.io -U ops_readonly checkout']);
    expect(st.mode).toBe('psql');
    expect(out).toContain('connected to checkout-db');
    expect(run(['psql -h db.internal.shopfast.io checkout', 'SHOW max_connections;']).out).toContain('1708');
    expect(run(['psql -h db.internal.shopfast.io checkout', 'DROP TABLE orders;']).out).toContain('read-only transaction');
    expect(run(['psql -h db.internal.shopfast.io checkout', '\\q']).st.mode).toBe('bash');
    expect(run(['psql']).out).toContain('No such file or directory');
  });
  it('blocks mutating commands and reports unknown ones', () => {
    expect(run(['ssh app-1', 'rm -rf /var/log']).out).toContain('read-only investigation');
    expect(run(['ssh app-1', 'sudo systemctl restart nginx']).out).toContain('read-only investigation');
    expect(run(['frobnicate']).out).toContain('command not found');
  });
  it('aws cli derives from the environment', () => {
    expect(run(['aws sts get-caller-identity']).out).toContain('shopfast-ops-role');
    expect(run(['ssh app-1', 'aws sts get-caller-identity']).out).toContain('shopfast-app-role');
    expect(run(['aws ec2 describe-security-groups']).out).toContain('shopfast-app-sg');
    expect(run(['aws ec2 terminate-instances --instance-ids i-1']).out).toContain('read-only');
  });
  it('clock skew breaks AWS signatures', () => {
    const e2 = finalizeEnvironment(baseEnvironment(Date.parse('2026-10-09T14:52:00Z')));
    e2.hosts['app-3'].time.offsetSeconds = 1020;
    let st = execute(e2, initialTermState(e2), 'ssh app-3').state;
    const r = execute(e2, st, 'aws sqs get-queue-attributes --queue-url x');
    st = r.state;
    expect(r.output).toMatch(/Signature (not yet current|expired)/);
  });
  it('tab completion', () => {
    expect(complete(env, initialTermState(env), 'jour')).toEqual(['journalctl']);
    expect(complete(env, initialTermState(env), 'ssh app')).toEqual(['app-1', 'app-2', 'app-3']);
    const st = run(['ssh app-1']).st;
    expect(complete(env, st, 'cat /var/log/ngi')).toEqual(['/var/log/nginx/']);
  });
});

describe('IAM evaluator', () => {
  const role = env.iam.roles.find(r => r.name === 'shopfast-app-role')!;
  it('allows object actions on object ARNs and denies elsewhere', () => {
    expect(evaluate(role, 's3:PutObject', 'arn:aws:s3:::shopfast-invoices-prod/2026/x.pdf').decision).toBe('allowed');
    expect(evaluate(role, 's3:PutObject', 'arn:aws:s3:::other-bucket/x').decision).toBe('implicitDeny');
    expect(evaluate(role, 's3:DeleteObject', 'arn:aws:s3:::shopfast-invoices-prod/x').decision).toBe('implicitDeny');
  });
});
