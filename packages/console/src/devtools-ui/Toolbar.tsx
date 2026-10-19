/** The thin toolbar under a panel's tab (clear button, filter box, toggles). */
import type { ReactNode } from 'react';
import './Toolbar.css';

export function Toolbar({ children, wrap = false }: { children: ReactNode; wrap?: boolean }) {
  return <div className={`toolbar${wrap ? ' wrap' : ''}`}>{children}</div>;
}

export function ToolbarButton({
  title,
  onClick,
  children,
  disabled = false,
}: {
  title: string;
  onClick: () => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <button className="toolbar-button" title={title} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function ToolbarDivider() {
  return <div className="toolbar-divider" />;
}

export function ToolbarInput({
  placeholder,
  value,
  onChange,
  find = false,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  /** the input ⌘F / Ctrl+F should focus in this panel */
  find?: boolean;
}) {
  return (
    <input
      className="toolbar-input"
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      {...(find ? { 'data-find': '' } : {})}
    />
  );
}
