import { Fragment, type ReactNode } from 'react';

/** Minimal inline markup: `code`, **bold**, paragraphs separated by blank lines. */
export function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>);
    const tok = m[0];
    if (tok.startsWith('`')) out.push(<code key={i++}>{tok.slice(1, -1)}</code>);
    else out.push(<strong key={i++}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<Fragment key={i++}>{text.slice(last)}</Fragment>);
  return out;
}

export function Rich({ text, className }: { text: string; className?: string }) {
  const paras = text.split(/\n\s*\n/);
  return (
    <div className={`rich ${className ?? ''}`}>
      {paras.map((p, i) => (
        <p key={i}>{inline(p.trim())}</p>
      ))}
    </div>
  );
}
