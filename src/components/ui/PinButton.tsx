import type { Pinnable } from '../../engine/types';
import { useIncidentSession } from '../../state/progress';
import { Icon } from './Icon';

export function PinButton({ item, label }: { item: Pinnable; label?: string }) {
  const { isPinned, togglePin } = useIncidentSession();
  const on = isPinned(item.key);
  return (
    <button
      type="button"
      className={`pin${on ? ' on' : ''}`}
      title={on ? 'Unpin from case notes' : label ?? 'Pin as evidence'}
      aria-label={on ? 'Unpin evidence' : 'Pin as evidence'}
      aria-pressed={on}
      onClick={e => {
        e.stopPropagation();
        togglePin(item);
      }}
    >
      <Icon name="pin" size={14} strokeWidth={on ? 2.4 : 1.9} />
    </button>
  );
}
