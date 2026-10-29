/**
 * The three shapes every tab in the drawer is built out of: a collapsible
 * section, a name-and-value line, and the sentence shown in place of content
 * there is none of.
 *
 * They were at the bottom of the six-hundred-line file that held the drawer
 * and all seven of its tabs, under a comment reading `bits`.
 */
import { useState, type ReactNode } from 'react';

export function Section({
  title,
  note,
  action,
  children,
}: {
  title: string;
  note?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="detail-section">
      <div className="detail-section-title" onClick={() => setOpen((o) => !o)}>
        <span className={`otree-arrow${open ? ' open' : ''}`} />
        {title}
        {action && (
          <span className="detail-section-action" onClick={(e) => e.stopPropagation()}>
            {action}
          </span>
        )}
      </div>
      {open && (
        <div className="detail-section-body">
          {note && <div className="detail-note">{note}</div>}
          {children}
        </div>
      )}
    </div>
  );
}

export function KV({ name, value }: { name: string; value: ReactNode }) {
  return (
    <div className="detail-kv">
      <span className="detail-kv-name">{name}:</span>
      <span className="detail-kv-value">{value}</span>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="detail-empty">{children}</div>;
}
