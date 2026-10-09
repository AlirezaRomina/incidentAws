import { useEffect, type ReactNode } from 'react';

export function Modal({ onClose, children, width }: { onClose: () => void; children: ReactNode; width?: number }) {
  useEffect(() => {
    const on = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={width ? { width: `min(${width}px, 100%)` } : undefined}>
        {children}
      </div>
    </div>
  );
}
