const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const p2 = (n: number) => String(n).padStart(2, '0');
const p3 = (n: number) => String(n).padStart(3, '0');

export const MIN = 60_000;

/** 2026-10-09T14:52:01.123Z */
export const iso = (ts: number) => new Date(ts).toISOString();
/** 2026-10-09T14:52:01Z */
export const isoSec = (ts: number) => new Date(ts).toISOString().replace(/\.\d{3}Z$/, 'Z');
/** 14:52:01 */
export const hms = (ts: number) => {
  const d = new Date(ts);
  return `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
};
/** 14:52 */
export const hm = (ts: number) => hms(ts).slice(0, 5);
/** 09/Oct/2026:14:52:01 +0000 (nginx access log) */
export const nginxTime = (ts: number) => {
  const d = new Date(ts);
  return `${p2(d.getUTCDate())}/${MON[d.getUTCMonth()]}/${d.getUTCFullYear()}:${hms(ts)} +0000`;
};
/** 2026/10/09 14:52:01 (nginx error log) */
export const nginxErrTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}/${p2(d.getUTCMonth() + 1)}/${p2(d.getUTCDate())} ${hms(ts)}`;
};
/** Oct 09 14:52:01 (syslog / journald) */
export const syslogTime = (ts: number) => {
  const d = new Date(ts);
  return `${MON[d.getUTCMonth()]} ${p2(d.getUTCDate())} ${hms(ts)}`;
};
/** 2026-10-09 14:52:01.123 UTC (postgres) */
export const pgTime = (ts: number) => {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hms(ts)}.${p3(d.getUTCMilliseconds())} UTC`;
};
/** Thu 2026-10-09 14:31:07 UTC */
export const systemdTime = (ts: number) => {
  const d = new Date(ts);
  return `${DOW[d.getUTCDay()]} ${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${hms(ts)} UTC`;
};
/** Thu Oct  9 14:52:01 UTC 2026 (`date`) */
export const dateCmd = (ts: number) => {
  const d = new Date(ts);
  return `${DOW[d.getUTCDay()]} ${MON[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${hms(ts)} UTC ${d.getUTCFullYear()}`;
};
/** Oct 9, 2026 14:52 UTC */
export const human = (ts: number) => {
  const d = new Date(ts);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()} ${hm(ts)} UTC`;
};
export const relative = (minutesAgo: number) => {
  if (minutesAgo < 1) return 'just now';
  if (minutesAgo < 60) return `${Math.round(minutesAgo)}m ago`;
  if (minutesAgo < 60 * 24) {
    const h = Math.floor(minutesAgo / 60);
    const m = Math.round(minutesAgo % 60);
    return m ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  const d = Math.floor(minutesAgo / 1440);
  return `${d}d ago`;
};
export const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}:${p2(m)}:${p2(sec)}` : `${p2(m)}:${p2(sec)}`;
};
