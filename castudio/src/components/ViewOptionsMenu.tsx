import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import { Popover, PopoverItem } from './Popover';

export type ViewMenuItem = { label: string; icon: ReactNode; checked?: boolean; disabled?: boolean; hint?: string; onSelect: () => void };

/** The viewer toolbar's overflow: less frequent view toggles and actions. */
export function ViewOptionsMenu({ items }: { items: ViewMenuItem[] }) {
  return <Popover label="更多视图选项" icon={<MoreHorizontal size={16}/>} className="tool-button">
    {items.map(item => <PopoverItem key={item.label} icon={item.icon} label={item.label} checked={item.checked} disabled={item.disabled} hint={item.hint} onSelect={item.onSelect}/>)}
  </Popover>;
}
