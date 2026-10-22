/**
 * DevTools-style data grid: fixed-layout table with resizable, sortable
 * column headers, single selection, and ↑/↓ keyboard navigation.
 * Not virtualised yet; fine up to a few thousand rows.
 */
import React, { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import './DataGrid.css';

export interface Column<T> {
  id: string;
  title: string;
  /** initial width in px; the last column always stretches */
  width: number;
  minWidth?: number;
  align?: 'left' | 'right' | 'center';
  render: (row: T) => ReactNode;
  sortValue?: (row: T) => string | number;
  /** rendered in the header instead of `title` (e.g. a waterfall time scale) */
  header?: ReactNode;
}

export interface SortState {
  column: string;
  direction: 'asc' | 'desc';
}

export function DataGrid<T>({
  columns,
  rows,
  rowKey,
  selectedKey,
  onSelect,
  rowClassName,
  sort,
  onSortChange,
  striped = true,
  onRowContextMenu,
  onHeaderContextMenu,
  rowHeight = 'normal',
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  selectedKey: string | null;
  onSelect: (key: string | null, row: T | null) => void;
  rowClassName?: (row: T) => string;
  sort?: SortState | null;
  onSortChange?: (sort: SortState | null) => void;
  striped?: boolean;
  onRowContextMenu?: (row: T, e: React.MouseEvent) => void;
  onHeaderContextMenu?: (e: React.MouseEvent) => void;
  rowHeight?: 'normal' | 'big';
}) {
  const [widths, setWidths] = useState<Record<string, number>>({});
  const drag = useRef<{ id: string; startX: number; startW: number } | null>(null);

  // Fit to the available width: when the configured column widths do not fit, scale the fixed
  // columns down proportionally (never below minWidth); when the grid widens again they come back.
  const rootRef = useRef<HTMLDivElement>(null);
  const [available, setAvailable] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const update = () => setAvailable(el.clientWidth);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const LAST_MIN = 90;
  const fitted = useMemo(() => {
    const fixed = columns.slice(0, -1);
    const want = fixed.reduce((sum, c) => sum + (widths[c.id] ?? c.width), 0);
    const room = Math.max(0, available - LAST_MIN);
    const scale = available > 0 && want > room ? room / want : 1;
    const out: Record<string, number> = {};
    for (const c of fixed) out[c.id] = Math.max(c.minWidth ?? 40, Math.round((widths[c.id] ?? c.width) * scale));
    return out;
  }, [columns, widths, available]);

  /*
   * The width the table needs for the last column to keep its share.
   *
   * `room` reserves LAST_MIN for it, but the scale that reservation is worked
   * out from is then overridden column by column by `minWidth` — so once
   * enough columns are at their floor the fixed ones take more than `room`
   * and the last column, which has no width of its own, is left with
   * whatever is over. In a dock narrow enough that was nothing: the Network
   * waterfall measured 0px, the whole timeline gone rather than merely tight.
   *
   * Asking the table for that width instead makes the grid scroll sideways,
   * which it is already set up to do, and the last column keeps its 90px.
   * While everything fits this is smaller than the grid and `width: 100%`
   * wins, so nothing changes.
   */
  const tableMin = useMemo(
    () => columns.slice(0, -1).reduce((sum, c) => sum + (fitted[c.id] ?? c.width), 0) + LAST_MIN,
    [columns, fitted],
  );

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.column);
    if (!col?.sortValue) return rows;
    const sv = col.sortValue;
    const dir = sort.direction === 'asc' ? 1 : -1;
    // Keys up front: a comparator runs O(n log n) times, and sortValue is not
    // always cheap (URL parsing, date formatting).
    return rows
      .map((row) => ({ row, key: sv(row) }))
      .sort((a, b) => (a.key === b.key ? 0 : (a.key < b.key ? -1 : 1) * dir))
      .map((x) => x.row);
  }, [rows, sort, columns]);

  const onHeaderClick = (col: Column<T>) => {
    if (!col.sortValue || !onSortChange) return;
    if (sort?.column !== col.id) onSortChange({ column: col.id, direction: 'asc' });
    else if (sort.direction === 'asc') onSortChange({ column: col.id, direction: 'desc' });
    else onSortChange(null);
  };

  const onResizeStart = (e: PointerEvent<HTMLDivElement>, col: Column<T>) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    // Take the widths as drawn, not as configured. While the grid is narrow
    // enough to be scaling them down, dragging from the configured width made
    // the column jump to its full size under the pointer on the first pixel.
    setWidths({ ...fitted });
    drag.current = { id: col.id, startX: e.clientX, startW: fitted[col.id] ?? widths[col.id] ?? col.width };
  };
  const onResizeMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const col = columns.find((c) => c.id === d.id);
    const min = col?.minWidth ?? 40;
    setWidths((w) => ({ ...w, [d.id]: Math.max(min, d.startW + e.clientX - d.startX) }));
  };
  const onResizeEnd = () => {
    drag.current = null;
  };

  // Keep the selected row visible: without this ArrowDown walked the selection
  // off the bottom of the grid with nothing moving on screen.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || selectedKey === null) return;
    const row = root.querySelector<HTMLElement>('tr.selected');
    if (!row) return;
    const head = root.querySelector('thead')?.clientHeight ?? 0;
    const top = row.offsetTop;
    const bottom = top + row.offsetHeight;
    if (top < root.scrollTop + head) root.scrollTop = Math.max(0, top - head);
    else if (bottom > root.scrollTop + root.clientHeight) root.scrollTop = bottom - root.clientHeight;
  }, [selectedKey]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const idx = sorted.findIndex((r) => rowKey(r) === selectedKey);
    const next = e.key === 'ArrowDown' ? Math.min(sorted.length - 1, idx + 1) : Math.max(0, idx - 1);
    const row = sorted[next];
    if (row) onSelect(rowKey(row), row);
  };

  return (
    <div className={`datagrid rows-${rowHeight}`} tabIndex={0} onKeyDown={onKeyDown} ref={rootRef}>
      <table style={{ minWidth: tableMin }}>
        <colgroup>
          {columns.map((c, i) => (
            <col key={c.id} style={i === columns.length - 1 ? undefined : { width: fitted[c.id] }} />
          ))}
        </colgroup>
        <thead>
          <tr onContextMenu={onHeaderContextMenu}>
            {columns.map((c, i) => (
              <th
                key={c.id}
                className={`${c.sortValue ? 'sortable' : ''} ${sort?.column === c.id ? `sorted ${sort.direction}` : ''} align-${c.align ?? 'left'}`}
                onClick={() => onHeaderClick(c)}
              >
                <span className="datagrid-th-label">{c.header ?? c.title}</span>
                {sort?.column === c.id && <span className="datagrid-sort-arrow">{sort.direction === 'asc' ? '▲' : '▼'}</span>}
                {i < columns.length - 1 && (
                  <div
                    className="datagrid-resizer"
                    onPointerDown={(e) => onResizeStart(e, c)}
                    onPointerMove={onResizeMove}
                    onPointerUp={onResizeEnd}
                    onClick={(e) => e.stopPropagation()}
                  />
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={striped ? 'striped' : ''}>
          {sorted.map((row) => {
            const key = rowKey(row);
            return (
              <tr
                key={key}
                className={`${key === selectedKey ? 'selected' : ''} ${rowClassName?.(row) ?? ''}`}
                onClick={() => onSelect(key, row)}
                onContextMenu={(e) => {
                  if (!onRowContextMenu) return;
                  e.preventDefault();
                  onSelect(key, row);
                  onRowContextMenu(row, e);
                }}
              >
                {columns.map((c) => (
                  <td key={c.id} className={`align-${c.align ?? 'left'}`}>
                    {c.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
