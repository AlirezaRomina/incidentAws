/** Shared shell helpers: tokenizing, pipes, arg parsing, path handling. */

export function tokenize(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let had = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === '\\')) cur += input[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      had = true;
      continue;
    }
    if (c === '\\' && i + 1 < input.length) {
      cur += input[++i];
      had = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || had) out.push(cur);
      cur = '';
      had = false;
      continue;
    }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

/** Split on unquoted `|` (but not `||`). */
export function splitPipes(input: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quote) {
      if (c === quote) quote = null;
      cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      cur += c;
      continue;
    }
    if (c === '|' && input[i + 1] !== '|' && input[i - 1] !== '|') {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += c;
  }
  parts.push(cur.trim());
  return parts.filter(p => p.length > 0);
}

export interface ParsedArgs {
  flags: Set<string>; // single letters and long names (without dashes)
  opts: Record<string, string>; // options that take values
  positional: string[];
}

/**
 * Parse argv. `valued` lists option names (short or long) that take a value,
 * e.g. ['n', 'm', 'max-time', 'h', 'U'].
 */
export function parseArgs(args: string[], valued: string[] = []): ParsedArgs {
  const flags = new Set<string>();
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith('--') && a.length > 2) {
      const [k, v] = a.slice(2).split(/=(.*)/s, 2);
      if (v !== undefined) opts[k] = v;
      else if (valued.includes(k) && i + 1 < args.length) opts[k] = args[++i];
      else flags.add(k);
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const letters = a.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const l = letters[j];
        if (valued.includes(l)) {
          const rest = letters.slice(j + 1);
          if (rest) opts[l] = rest;
          else if (i + 1 < args.length) opts[l] = args[++i];
          break;
        }
        flags.add(l);
      }
      continue;
    }
    positional.push(a);
  }
  return { flags, opts, positional };
}

export function resolvePath(cwd: string, p: string, home = '/home/ec2-user'): string {
  if (!p || p === '~') return home;
  if (p.startsWith('~/')) p = home + p.slice(1);
  const abs = p.startsWith('/') ? p : `${cwd.replace(/\/$/, '')}/${p}`;
  const parts: string[] = [];
  for (const seg of abs.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
}

export function globToRegex(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`);
}

export const lines = (s: string) => (s.endsWith('\n') ? s.slice(0, -1) : s).split('\n');

export function pad(s: string | number, n: number, right = false) {
  const str = String(s);
  return right ? str.padStart(n) : str.padEnd(n);
}

/** Format bytes like `ls -lh` / `df -h`. */
export function human(bytes: number): string {
  const units = ['', 'K', 'M', 'G', 'T'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  if (i === 0) return String(Math.round(v));
  return (v < 10 ? v.toFixed(1) : Math.round(v).toString()) + units[i];
}

/** Apply a pipeline filter (grep/head/tail/wc/sort/uniq/less) to text. */
export function applyFilter(text: string, segment: string): { out: string; error?: string } {
  const argv = tokenize(segment);
  const cmd = argv[0];
  const args = argv.slice(1);
  let ls = text === '' ? [] : lines(text);
  switch (cmd) {
    case 'grep':
    case 'egrep': {
      const a = parseArgs(args, ['e', 'm', 'A', 'B', 'C']);
      const pattern = a.opts.e ?? a.positional[0];
      if (pattern === undefined) return { out: '', error: 'Usage: grep [OPTION]... PATTERNS [FILE]...' };
      const re = makeGrepRegex(pattern, a.flags.has('i'), a.flags.has('E') || cmd === 'egrep', a.flags.has('F'));
      let res = ls.filter(l => re.test(l) !== a.flags.has('v'));
      if (a.opts.m) res = res.slice(0, Number(a.opts.m));
      if (a.flags.has('c')) return { out: String(res.length) };
      return { out: res.join('\n') };
    }
    case 'head': {
      const n = countArg(args, 10);
      return { out: ls.slice(0, n).join('\n') };
    }
    case 'tail': {
      const n = countArg(args, 10);
      return { out: ls.slice(Math.max(0, ls.length - n)).join('\n') };
    }
    case 'wc': {
      const a = parseArgs(args);
      if (a.flags.has('l')) return { out: String(ls.length) };
      const words = ls.join(' ').split(/\s+/).filter(Boolean).length;
      return { out: `${pad(ls.length, 7, true)} ${pad(words, 7, true)} ${pad(text.length, 7, true)}` };
    }
    case 'sort': {
      const a = parseArgs(args, ['k', 't']);
      if (a.flags.has('n')) ls = [...ls].sort((x, y) => parseFloat(x.trim()) - parseFloat(y.trim()));
      else ls = [...ls].sort();
      if (a.flags.has('r')) ls.reverse();
      return { out: ls.join('\n') };
    }
    case 'uniq': {
      const a = parseArgs(args);
      const res: [string, number][] = [];
      for (const l of ls) {
        if (res.length && res[res.length - 1][0] === l) res[res.length - 1][1]++;
        else res.push([l, 1]);
      }
      return { out: res.map(([l, c]) => (a.flags.has('c') ? `${pad(c, 7, true)} ${l}` : l)).join('\n') };
    }
    case 'less':
    case 'more':
    case 'cat':
      return { out: text };
    case 'jq':
      return { out: text };
    default:
      return { out: '', error: `${cmd}: not supported in pipelines here (try grep, head, tail, wc, sort, uniq)` };
  }
}

export function countArg(args: string[], def: number): number {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-\d+$/.test(a)) return Number(a.slice(1));
    if (a === '-n' && args[i + 1]) return Number(args[i + 1].replace('+', ''));
    if (/^-n\d+$/.test(a)) return Number(a.slice(2));
    if (a.startsWith('--lines=')) return Number(a.slice(8));
  }
  return def;
}

export function makeGrepRegex(pattern: string, ignoreCase: boolean, extended: boolean, fixed = false): RegExp {
  let src = pattern;
  if (fixed) src = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else if (!extended) {
    // Basic regex: \| \( \) are operators, bare | ( ) + ? are literals.
    src = src
      .replace(/\\\|/g, '\u0001')
      .replace(/\\\(/g, '\u0002')
      .replace(/\\\)/g, '\u0003')
      .replace(/([|()+?{}])/g, '\\$1')
      .replace(/\u0001/g, '|')
      .replace(/\u0002/g, '(')
      .replace(/\u0003/g, ')');
  }
  try {
    return new RegExp(src, ignoreCase ? 'i' : '');
  } catch {
    return new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ignoreCase ? 'i' : '');
  }
}
