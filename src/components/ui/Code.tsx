import type { ReactNode } from 'react';

/** Syntax-highlighted JSON. */
export function JsonView({ value }: { value: unknown }) {
  const text = JSON.stringify(value, null, 2);
  const parts: ReactNode[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[1] && m[2]) parts.push(<span key={i++} className="j-key">{m[1]}</span>, m[2]);
    else if (m[1]) parts.push(<span key={i++} className="j-str">{m[1]}</span>);
    else if (m[3]) parts.push(<span key={i++} className="j-bool">{m[3]}</span>);
    else parts.push(<span key={i++} className="j-num">{m[4]}</span>);
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <pre className="codeblock">{parts}</pre>;
}

export function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="codeblock">
      {diff.split('\n').map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('new file') || l.startsWith('index ') ? 'diff-meta' : l.startsWith('@@') ? 'diff-hunk' : l.startsWith('+') ? 'diff-add' : l.startsWith('-') ? 'diff-del' : '';
        return cls ? (
          <span key={i} className={cls}>
            {l || ' '}
          </span>
        ) : (
          <span key={i} style={{ display: 'block' }}>
            {l || ' '}
          </span>
        );
      })}
    </pre>
  );
}
