/** The "Default levels ▾" dropdown with Verbose / Info / Warnings / Errors checkboxes. */
import { useEffect, useRef, useState } from 'react';
import { ALL_LEVELS, DEFAULT_LEVELS, type LevelFilter } from './group-tree';
import { useKeepInViewport } from '../../devtools-ui/in-viewport';

const ITEMS: Array<{ key: keyof LevelFilter; label: string }> = [
  { key: 'verbose', label: 'Verbose' },
  { key: 'info', label: 'Info' },
  { key: 'warning', label: 'Warnings' },
  { key: 'error', label: 'Errors' },
];

export function LevelMenu({ value, onChange }: { value: LevelFilter; onChange: (v: LevelFilter) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  useKeepInViewport(popup, open);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const label = same(value, DEFAULT_LEVELS)
    ? 'Default levels'
    : same(value, ALL_LEVELS)
      ? 'All levels'
      : ITEMS.filter((i) => value[i.key]).map((i) => i.label).join(', ') || 'Hide all';

  return (
    <div className="level-menu" ref={ref}>
      <button className="toolbar-button level-menu-button" onClick={() => setOpen((o) => !o)}>
        {label} <span className="level-menu-caret">▾</span>
      </button>
      {open && (
        <div className="level-menu-popup" ref={popup}>
          <button className="level-menu-item" onClick={() => onChange(DEFAULT_LEVELS)}>
            <span className="level-menu-check" /> Default
          </button>
          <div className="level-menu-sep" />
          {ITEMS.map((i) => (
            <button key={i.key} className="level-menu-item" onClick={() => onChange({ ...value, [i.key]: !value[i.key] })}>
              <span className="level-menu-check">{value[i.key] ? '✓' : ''}</span> {i.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function same(a: LevelFilter, b: LevelFilter): boolean {
  return a.verbose === b.verbose && a.info === b.info && a.warning === b.warning && a.error === b.error;
}
