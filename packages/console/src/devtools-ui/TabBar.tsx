/** The DevTools top tab strip. */
import type { ReactNode } from 'react';
import { useSelectedInView } from './selected-in-view';
import './strip.css';
import './TabBar.css';

export interface Tab<T extends string> {
  id: T;
  label: string;
  disabled?: boolean;
}

export function TabBar<T extends string>({
  tabs,
  active,
  onSelect,
  trailing,
  leading,
}: {
  tabs: Tab<T>[];
  active: T;
  onSelect: (id: T) => void;
  trailing?: ReactNode;
  leading?: ReactNode;
}) {
  const bar = useSelectedInView(active);
  return (
    <div className="tabbar strip strip-scroll" role="tablist" ref={bar}>
      {leading}
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          className={`strip-item${t.id === active ? ' selected' : ''}`}
          aria-selected={t.id === active}
          disabled={t.disabled}
          onClick={() => onSelect(t.id)}
        >
          {t.label}
        </button>
      ))}
      <div className="strip-spacer" />
      {trailing}
    </div>
  );
}
