/** Right-click menu. Render once; open it with a position and items. */
import { useEffect, useRef, type ReactNode } from 'react';
import './ContextMenu.css';

export interface MenuItem {
  label?: ReactNode;
  separator?: boolean;
  checked?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function ContextMenu({ menu, onClose }: { menu: MenuState | null; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', close, true);
    document.addEventListener('wheel', close, true);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close, true);
      document.removeEventListener('wheel', close, true);
      document.removeEventListener('keydown', esc, true);
    };
  }, [menu, onClose]);

  // Keep inside the viewport.
  useEffect(() => {
    const el = ref.current;
    if (!el || !menu) return;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth) el.style.left = `${Math.max(0, window.innerWidth - r.width - 4)}px`;
    if (r.bottom > window.innerHeight) el.style.top = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
  }, [menu]);

  if (!menu) return null;
  return (
    <div ref={ref} className="context-menu" style={{ left: menu.x, top: menu.y }}>
      {menu.items.map((item, i) =>
        item.separator ? (
          <div key={i} className="context-menu-sep" />
        ) : (
          <button
            key={i}
            className="context-menu-item"
            disabled={item.disabled}
            onClick={() => {
              item.onClick?.();
              onClose();
            }}
          >
            <span className="context-menu-check">{item.checked ? '✓' : ''}</span>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}
