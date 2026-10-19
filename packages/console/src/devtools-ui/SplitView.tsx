/**
 * Two panes with a draggable divider; `side` on the right (or bottom) and
 * optional. With `storageKey` the divider position survives reloads.
 */
import { useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { clampSide } from './split-size';
import './SplitView.css';

export function SplitView({
  main,
  side,
  direction = 'horizontal',
  initialSide = 420,
  minMain = 120,
  minSide = 200,
  storageKey,
}: {
  main: ReactNode;
  side: ReactNode | null;
  direction?: 'horizontal' | 'vertical';
  initialSide?: number;
  minMain?: number;
  minSide?: number;
  storageKey?: string;
}) {
  const fallback = initialSide > 0 ? initialSide : minSide;
  const [sideSize, setSideSize] = useState(() => {
    if (!storageKey) return fallback;
    try {
      const saved = Number(localStorage.getItem(storageKey));
      return saved > 0 ? saved : fallback;
    } catch {
      return fallback;
    }
  });
  const container = useRef<HTMLDivElement>(null);
  const drag = useRef<{ start: number; size: number } | null>(null);
  const horizontal = direction === 'horizontal';

  /*
   * Keep the side within its bounds, in BOTH directions.
   *
   * Clamping only downwards let a side pane that started at zero stay there
   * for good: `initialSide` is worked out from the window, and a window that
   * is not laid out yet gives zero. The panel then had no width, no handle
   * wide enough to find, and nothing on screen to bring it back — a reload was
   * the only way out.
   *
   * The observer is the other half: a container that gets its size after the
   * first render does not re-render this component by itself, so without it
   * the correction would never run.
   */
  useLayoutEffect(() => {
    const box = container.current;
    if (!box || side === null || side === undefined) return;
    const clamp = () => {
      const total = horizontal ? box.clientWidth : box.clientHeight;
      if (!total) return; // not laid out yet; the observer will call back
      setSideSize((current) => clampSide(current, total, minMain, minSide));
    };
    clamp();
    const ro = new ResizeObserver(clamp);
    ro.observe(box);
    return () => ro.disconnect();
  }, [side, horizontal, minMain, minSide]);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { start: horizontal ? e.clientX : e.clientY, size: sideSize };
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const box = container.current?.getBoundingClientRect();
    if (!d || !box) return;
    const total = horizontal ? box.width : box.height;
    const delta = (horizontal ? e.clientX : e.clientY) - d.start;
    setSideSize(clampSide(d.size - delta, total, minMain, minSide));
  };
  const onUp = () => {
    drag.current = null;
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, String(sideSize));
    } catch {
      /* ignore */
    }
  };

  return (
    <div ref={container} className={`splitview ${direction}`}>
      <div className="splitview-main">{main}</div>
      {side !== null && side !== undefined && (
        <>
          <div className="splitview-divider" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
          <div className="splitview-side" style={horizontal ? { width: sideSize } : { height: sideSize }}>
            {side}
          </div>
        </>
      )}
    </div>
  );
}
