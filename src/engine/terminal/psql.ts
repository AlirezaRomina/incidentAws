import type { Database, Environment } from '../types';
import { pgTime } from '../time';
import { parseArgs, tokenize } from './shell';

/** psql-style aligned table. */
export function pgTable(cols: string[], rows: (string | number | null)[][]): string {
  const str = rows.map(r => r.map(v => (v === null ? '' : String(v))));
  const numeric = cols.map((_, i) => rows.length > 0 && rows.every(r => typeof r[i] === 'number'));
  const widths = cols.map((c, i) => Math.max(c.length, ...str.map(r => r[i].length)));
  const center = (s: string, w: number) => {
    const left = Math.floor((w - s.length) / 2);
    return ' '.repeat(left) + s + ' '.repeat(w - s.length - left);
  };
  const header = ' ' + cols.map((c, i) => center(c, widths[i])).join(' | ') + ' ';
  const sep = widths.map(w => '-'.repeat(w + 2)).join('+');
  const body = str.map(r => ' ' + r.map((v, i) => (numeric[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join(' | ').replace(/\s+$/, ''));
  return [header.replace(/\s+$/, ''), sep, ...body, `(${rows.length} ${rows.length === 1 ? 'row' : 'rows'})`].join('\n');
}

export function findDatabase(env: Environment, host: string | undefined): Database | undefined {
  if (!host) return undefined;
  const h = host.toLowerCase();
  return env.databases.find(d => d.host === h || d.alias.includes(h));
}

export interface PsqlConnect {
  db?: Database;
  output: string;
  /** one-shot -c result */
  oneShot?: boolean;
}

export function psqlConnect(env: Environment, raw: string): PsqlConnect {
  const argv = tokenize(raw).slice(1);
  const a = parseArgs(argv, ['h', 'host', 'U', 'username', 'd', 'dbname', 'p', 'port', 'c', 'command']);
  const host = a.opts.h ?? a.opts.host;
  const cmd = a.opts.c ?? a.opts.command;
  const url = a.positional.find(p => p.startsWith('postgres'));
  let dbHost = host;
  if (url) dbHost = url.replace(/^postgres(ql)?:\/\/([^@]*@)?/, '').split(/[:/]/)[0];
  if (!dbHost) {
    return { output: `psql: error: connection to server on socket "/run/postgresql/.s.PGSQL.5432" failed: No such file or directory\n\tIs the server running locally and accepting connections on that socket?\n\nhint: the database is on RDS — try: psql -h db.internal.shopfast.io -U ops_readonly checkout` };
  }
  const db = findDatabase(env, dbHost);
  if (!db) {
    return { output: `psql: error: could not translate host name "${dbHost}" to address: Name or service not known` };
  }
  const connectError = db.connectError;
  if (connectError) return { output: `psql: error: connection to server at "${db.host}" (${db.isReplica ? '10.0.21.33' : '10.0.20.57'}), port 5432 failed: ${connectError}` };
  if (cmd) return { db, output: runSql(env, db, cmd), oneShot: true };
  return {
    db,
    output: `psql (15.8, server ${db.serverVersion})\nSSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)\nType "help" for help.\n\n[connected to ${db.instanceId}${db.isReplica ? ' (read replica)' : ''} as ops_readonly — read-only role. Type \\q to quit, \\? for help]`,
  };
}

const READONLY_SQL = /^\s*(create|drop|alter|update|delete|insert|truncate|vacuum|reindex|grant|revoke|cluster|refresh|copy|lock|analyze\s+\w)/i;

export function runSql(env: Environment, db: Database, raw: string): string {
  const sql = raw.trim().replace(/;+\s*$/, '');
  if (!sql) return '';
  const lower = sql.toLowerCase();

  // meta-commands
  if (sql.startsWith('\\')) {
    const [meta, arg] = sql.split(/\s+/);
    switch (meta) {
      case '\\?':
      case '\\h':
        return PSQL_HELP;
      case '\\conninfo':
        return `You are connected to database "${db.dbName}" as user "ops_readonly" on host "${db.host}" (address "${db.isReplica ? '10.0.21.33' : '10.0.20.57'}") at port "5432".\nSSL connection (protocol: TLSv1.3, cipher: TLS_AES_256_GCM_SHA384, compression: off)`;
      case '\\l':
        return pgTable(['Name', 'Owner', 'Encoding', 'Collate', 'Ctype'], [['checkout', 'shopfast_admin', 'UTF8', 'en_US.UTF-8', 'en_US.UTF-8'], ['postgres', 'rdsadmin', 'UTF8', 'en_US.UTF-8', 'en_US.UTF-8'], ['rdsadmin', 'rdsadmin', 'UTF8', 'en_US.UTF-8', 'en_US.UTF-8']]).replace(/\(\d+ rows\)$/, '(3 rows)');
      case '\\dt':
      case '\\d':
      case '\\d+':
        if (arg && meta !== '\\dt') {
          const t = db.tables[arg.replace(/^public\./, '')];
          return t ? t.replace(/\n$/, '') : `Did not find any relation named "${arg}".`;
        }
        return pgTable(['Schema', 'Name', 'Type', 'Owner'], Object.keys(db.tables).sort().map(n => ['public', n, 'table', 'shopfast_admin']));
      case '\\di': {
        const rows: string[][] = [];
        for (const [t, def] of Object.entries(db.tables)) for (const ix of indexesOf(def)) rows.push(['public', ix.name, 'index', 'shopfast_admin', t]);
        return pgTable(['Schema', 'Name', 'Type', 'Owner', 'Table'], rows);
      }
      case '\\x':
        return 'Expanded display is not available in this simulator.';
      default:
        return `invalid command ${meta}\nTry \\? for help.`;
    }
  }

  for (const q of db.queries) if (q.match.test(sql)) return q.output;

  if (READONLY_SQL.test(sql) || /pg_terminate_backend|pg_cancel_backend|set\s+session/i.test(sql)) {
    const verb = sql.split(/\s+/).slice(0, 2).join(' ').toUpperCase();
    return `ERROR:  cannot execute ${verb} in a read-only transaction\n[simulation] You are connected as a read-only role. Put remediation steps in your diagnosis.`;
  }

  if (/^explain\b/i.test(sql)) {
    const target = sql.replace(/^explain\s*(\([^)]*\)|analyze|verbose|buffers|\s)*/i, '');
    for (const e of db.explains) if (e.match.test(target)) return e.output;
    return `                                 QUERY PLAN\n-----------------------------------------------------------------------------\n Result  (cost=0.00..0.01 rows=1 width=4) (actual time=0.002..0.002 rows=1 loops=1)\n Planning Time: 0.031 ms\n Execution Time: 0.012 ms\n(3 rows)\n\n[simulation] Nothing interesting in this plan. Try EXPLAIN ANALYZE on one of the queries from pg_stat_statements.`;
  }

  const show = sql.match(/^show\s+([\w.]+)/i);
  if (show) {
    const name = show[1].toLowerCase();
    if (name === 'all') return pgTable(['name', 'setting'], Object.entries(db.settings));
    const v = db.settings[name];
    if (v === undefined) return `ERROR:  unrecognized configuration parameter "${name}"`;
    return pgTable([name], [[v]]);
  }

  if (/version\(\)/.test(lower)) return pgTable(['version'], [[`PostgreSQL ${db.serverVersion} on aarch64-unknown-linux-gnu, compiled by gcc (GCC) 7.3.1 20180712 (Red Hat 7.3.1-6), 64-bit`]]);
  if (/pg_is_in_recovery\(\)/.test(lower)) return pgTable(['pg_is_in_recovery'], [[db.isReplica ? 't' : 'f']]);
  if (/^select\s+now\(\)/.test(lower) || /current_timestamp/.test(lower)) return pgTable(['now'], [[pgTime(env.now).replace(' UTC', '+00')]]);
  if (/pg_last_xact_replay_timestamp/.test(lower)) {
    if (!db.isReplica) return pgTable(['pg_last_xact_replay_timestamp'], [[null]]);
    return pgTable(['pg_last_xact_replay_timestamp', 'lag'], [[pgTime(env.now - 380).replace(' UTC', '+00'), '00:00:00.380']]);
  }
  if (/pg_stat_replication/.test(lower)) {
    if (db.isReplica) return pgTable(['pid', 'client_addr', 'state', 'replay_lag'], []);
    return pgTable(['pid', 'application_name', 'client_addr', 'state', 'sync_state', 'write_lag', 'flush_lag', 'replay_lag'], [[7790, 'checkout-db-replica-1', '10.0.21.33', 'streaming', 'async', '00:00:00.000412', '00:00:00.000901', '00:00:00.380114']]);
  }

  if (/pg_stat_activity/.test(lower)) return activity(db, lower);
  if (/pg_stat_statements/.test(lower)) return statements(db, lower);

  if (/pg_indexes/.test(lower)) {
    const t = lower.match(/tablename\s*=\s*'(\w+)'/)?.[1];
    const rows: string[][] = [];
    for (const [table, def] of Object.entries(db.tables)) {
      if (t && t !== table) continue;
      for (const ix of indexesOf(def)) rows.push([table, ix.name, `CREATE ${ix.unique ? 'UNIQUE ' : ''}INDEX ${ix.name} ON public.${table} USING ${ix.def}`]);
    }
    return pgTable(['tablename', 'indexname', 'indexdef'], rows);
  }

  if (/pg_stat_user_tables/.test(lower)) {
    const rows = Object.keys(db.tables).map(t => [t, t === 'orders' ? 8412339 : t === 'order_items' ? 21880412 : t === 'customers' ? 1904221 : 7801233, t === 'orders' ? 1204 : 3, t === 'orders' ? 2210443 : 7]);
    return pgTable(['relname', 'n_live_tup', 'seq_scan', 'idx_scan'], rows as (string | number)[][]);
  }

  if (/^select\s+1\b/.test(lower)) return pgTable(['?column?'], [[1]]);
  if (/count\(\*\)\s+from\s+(orders|order_items|customers|payments|products)/.test(lower)) {
    const t = lower.match(/from\s+(\w+)/)![1];
    const counts: Record<string, number> = { orders: 8412339, order_items: 21880412, customers: 1904221, payments: 7801233, products: 48211 };
    return pgTable(['count'], [[counts[t] ?? 0]]);
  }
  if (/^select/.test(lower) && /from\s+(orders|order_items|customers|payments|products)\b/.test(lower)) {
    return `[simulation] Customer data is not exposed in this training environment.\nUseful here: \\d <table>, pg_stat_activity, pg_stat_statements, pg_indexes, EXPLAIN ANALYZE <query>, SHOW <setting>.`;
  }
  const rel = lower.match(/from\s+([\w.]+)/)?.[1];
  if (rel) return `ERROR:  relation "${rel}" does not exist\nLINE 1: ${sql.slice(0, 60)}`;
  return `ERROR:  syntax error at or near "${sql.split(/\s+/)[0]}"\nLINE 1: ${sql.slice(0, 60)}`;
}

function indexesOf(def: string) {
  const out: { name: string; def: string; unique: boolean }[] = [];
  const lines = def.split('\n');
  const start = lines.findIndex(l => l.startsWith('Indexes:'));
  if (start < 0) return out;
  for (const l of lines.slice(start + 1)) {
    const m = l.match(/^\s+"([^"]+)"\s+(PRIMARY KEY, |UNIQUE CONSTRAINT, |UNIQUE, )?(btree|hash|gin|gist)\s+(\(.*\))/);
    if (!m) break;
    out.push({ name: m[1], def: `${m[3]} ${m[4]}`, unique: !!m[2] });
  }
  return out;
}

function activity(db: Database, lower: string): string {
  let rows = db.activity;
  const stateEq = lower.match(/state\s*=\s*'([\w ]+)'/);
  const stateNe = lower.match(/state\s*(<>|!=)\s*'([\w ]+)'/);
  if (stateEq) rows = rows.filter(r => r.state === stateEq[1]);
  if (stateNe) rows = rows.filter(r => r.state !== stateNe[2]);
  const appEq = lower.match(/application_name\s*=\s*'([\w.-]+)'/);
  if (appEq) rows = rows.filter(r => r.application.toLowerCase() === appEq[1]);
  const userEq = lower.match(/usename\s*=\s*'([\w.-]+)'/);
  if (userEq) rows = rows.filter(r => r.usename.toLowerCase() === userEq[1]);

  if (/count\(\*\)/.test(lower)) {
    const grp = lower.match(/group\s+by\s+([\w_, ]+)/)?.[1]?.split(',').map(s => s.trim()) ?? [];
    if (!grp.length) return pgTable(['count'], [[rows.length]]);
    const keyOf = (r: Database['activity'][number], g: string) => (g === 'state' ? r.state : g === 'usename' ? r.usename : g === 'application_name' ? r.application : g === 'client_addr' ? r.client : g === 'wait_event' ? r.waitEvent.split(': ')[1] ?? '' : g === 'wait_event_type' ? r.waitEvent.split(': ')[0] ?? '' : '');
    const counts = new Map<string, number>();
    for (const r of rows) {
      const k = grp.map(g => keyOf(r, g)).join('\u0000');
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    const out = [...counts.entries()].sort((x, y) => y[1] - x[1]).map(([k, c]) => [...k.split('\u0000'), c]);
    return pgTable([...grp, 'count'], out);
  }
  const limit = Number(lower.match(/limit\s+(\d+)/)?.[1] ?? 0);
  if (/order\s+by.*(query_start|duration|now\(\)\s*-)/.test(lower)) rows = [...rows].sort((x, y) => (x.queryStart < y.queryStart ? -1 : 1));
  if (limit) rows = rows.slice(0, limit);
  const trunc = (q: string) => q;
  return pgTable(
    ['pid', 'usename', 'application_name', 'client_addr', 'state', 'wait_event', 'duration', 'query'],
    rows.map(r => [r.pid, r.usename, r.application, r.client, r.state, r.waitEvent.split(': ')[1] ?? '', r.duration, trunc(r.query)]),
  );
}

function statements(db: Database, lower: string): string {
  let rows = [...db.statements];
  if (/order\s+by\s+mean/.test(lower)) rows.sort((a, b) => b.meanMs - a.meanMs);
  else if (/order\s+by\s+calls/.test(lower)) rows.sort((a, b) => b.calls - a.calls);
  else rows.sort((a, b) => b.totalMs - a.totalMs);
  const limit = Number(lower.match(/limit\s+(\d+)/)?.[1] ?? 10);
  rows = rows.slice(0, limit);
  const trunc = (q: string) => q;
  return pgTable(
    ['calls', 'total_exec_ms', 'mean_exec_ms', 'rows', 'query'],
    rows.map(r => [r.calls, Math.round(r.totalMs), Math.round(r.meanMs * 100) / 100, r.rows, trunc(r.query)]),
  );
}

const PSQL_HELP = `Simulated psql — useful commands:
  \\dt                      list tables
  \\d <table>               describe a table (columns + indexes)
  \\di                      list indexes
  \\conninfo                connection info
  \\q                       quit
  SELECT ... FROM pg_stat_activity [WHERE state = 'active']      current sessions
  SELECT state, count(*) FROM pg_stat_activity GROUP BY state     sessions by state
  SELECT * FROM pg_stat_statements ORDER BY total_exec_time DESC  heaviest queries
  SELECT * FROM pg_stat_statements ORDER BY mean_exec_time DESC   slowest queries
  SELECT * FROM pg_indexes WHERE tablename = 'orders'
  SELECT * FROM pg_stat_user_tables
  SELECT * FROM pg_stat_replication            (primary)   /  SELECT pg_is_in_recovery()
  SELECT now() - pg_last_xact_replay_timestamp() AS lag       (replica)
  EXPLAIN ANALYZE <query>
  SHOW <setting>            e.g. SHOW max_connections`;
