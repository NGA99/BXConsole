/**
 * Screen tab: live mirror of the remote page via DOM snapshot streaming,
 * with click-through and wheel forwarded to the page and the remote cursor
 * drawn on top. The agent only captures while this panel is mounted.
 *
 * Input never reaches the iframe: a transparent overlay above it captures
 * pointer and keyboard events, converts pointer positions to remote viewport
 * coordinates (undoing the fit scale) and sends `screen.input`. The agent
 * replays them on the page, and the resulting DOM changes stream back like
 * any other mutation. Keys go to the remote document.activeElement, whose
 * focus ring is mirrored so you can see where you are typing.
 *
 * Replay (DOM time travel) runs the same mirror off the relay's recording
 * instead of the live stream — play / pause / speed / one batch at a time, and
 * a jump from any point of the History timeline. Nothing is forwarded to the
 * page while replaying: you are looking at a moment that has already passed,
 * and clicking it would act on the page as it is now. The live stream keeps
 * arriving (so the recording goes on) and is ignored until Back to live.
 */

/** Browser shortcuts kept local even while the overlay has focus. */
const LOCAL_SHORTCUTS = new Set(['r', 'l', 't', 'w', 'n', 'q', 'Tab', '[', ']']);

/**
 * fill    the mirror takes the whole pane at 100% and reflows to its width, like a page next to docked DevTools
 * fit     the remote viewport, scaled down to fit the pane
 * actual  the remote viewport at 100%, scrollable
 */
type ViewMode = 'fill' | 'fit' | 'actual';
const MODE_KEY = 'bxconsole.screen.mode';
const MODES: Array<{ id: ViewMode; label: string; title: string }> = [
  { id: 'fill', label: 'Fill', title: 'Fill the pane and reflow to its width' },
  { id: 'fit', label: 'Fit', title: 'Remote viewport, scaled to fit' },
  { id: 'actual', label: '1:1', title: 'Remote viewport at actual size' },
];
import { useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type WheelEvent as ReactWheelEvent } from 'react';
import type { PointerSample, ScreenEvent, ScreenOp, ScreenSnapshot } from '@bxconsole/protocol';
import { subscribeScreen, refreshScreen, sendScreenInput } from '../../transport/client';
import { useActiveTab } from '../../state/active-tab';
import { useSessionsStore } from '../../state/sessions';
import { useScreenHighlight } from '../../state/screen-highlight';
import { useElementsSelection } from '../../state/elements-selection';
import { useInspectMode } from '../../state/inspect-mode';
import { navigate } from '../../app/router';
import { Toolbar, ToolbarButton, ToolbarDivider } from '../../devtools-ui/Toolbar';
import { CollapsePaneIcon, PauseIcon, PlayIcon, RefreshIcon, StepIcon } from '../../devtools-ui/icons';
import { DomMirror } from './mirror';
import { ScreenReplayer, SPEEDS, type ReplayStatus, type Speed } from './replay';
import { useScreenReplay } from '../../state/screen-replay';
import './ScreenPanel.css';

interface Status {
  state: 'connecting' | 'live' | 'stopped' | 'replay';
  viewport: { width: number; height: number };
  snapshotAt: number | null;
  batches: number;
  ops: number;
}

interface Ripple {
  id: number;
  x: number;
  y: number;
}

/**
 * Runs whose "recorded, not live" notice has been answered, by session id.
 *
 * Module-level so it outlives the panel: the dock remounts it on every shape
 * change, and local state would bring the notice back each time.
 */
const noticeRead = new Set<string>();

export function ScreenPanel({ sessionId, onCollapse }: { sessionId: string; onCollapse?: () => void }) {
  const connected = useSessionsStore((s) => s.byId[sessionId]?.connected ?? false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const mirror = useRef<DomMirror | null>(null);
  const [status, setStatus] = useState<Status>({ state: 'connecting', viewport: { width: 1024, height: 768 }, snapshotAt: null, batches: 0, ops: 0 });
  const [mode, setModeState] = useState<ViewMode>(() => {
    try {
      const saved = localStorage.getItem(MODE_KEY) as ViewMode | null;
      return saved === 'fit' || saved === 'actual' ? saved : 'fill';
    } catch {
      return 'fill';
    }
  });
  const setMode = (m: ViewMode) => {
    setModeState(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {
      /* ignore */
    }
  };
  const [interact, setInteract] = useState(true);
  /** null while live; the player's state while showing the recording */
  const [replay, setReplay] = useState<ReplayStatus | null>(null);

  /**
   * Put the remote cursor where the page had it, live or recorded.
   *
   * The anchor is preferred over raw coordinates: it is exact even when the
   * mirror has reflowed to a different width, which it usually has. Pixel
   * offsets for a box that is still its recorded size, fractions for one that
   * is not. Passing null hides the cursor.
   */
  const drawCursor = useCallback((at: PointerSample | null) => {
    const el = cursorRef.current;
    if (!el) return;
    if (!at) {
      el.style.opacity = '0';
      return;
    }
    el.style.opacity = '1';
    const a = at.anchor;
    const r = a ? mirror.current?.rectOf(a.id) : null;
    const sameSize = r && a && Math.abs(r.width - a.w) < 2 && Math.abs(r.height - a.h) < 2;
    const x = r && a ? (sameSize ? r.left + a.dx : r.left + r.width * a.fx) : at.x;
    const y = r && a ? (sameSize ? r.top + a.dy : r.top + r.height * a.fy) : at.y;
    el.style.transform = `translate(${x * layoutRef.current.scale}px, ${y * layoutRef.current.scale}px)`;
    el.classList.toggle('pressed', at.pressed);
  }, []);
  /*
   * The ended-run notice, once it has been read.
   *
   * Kept outside the component because this panel is remounted whenever the
   * dock changes shape — collapsing the panels moves it to a different place
   * in the tree — and a notice that came back every time someone folded the
   * window away was worse than no notice at all.
   *
   * Not remembered across reloads: the grey is what stops a last frame being
   * mistaken for a live page, and that is worth saying once per visit.
   */
  const [endedDismissed, setEndedDismissedState] = useState(() => noticeRead.has(sessionId));
  const dismissEnded = () => {
    noticeRead.add(sessionId);
    setEndedDismissedState(true);
  };
  const replayer = useRef<ScreenReplayer | null>(null);
  const replayingRef = useRef(false);
  replayingRef.current = replay !== null;
  /** follow the page's scroll (default) or scroll the mirror independently */
  const [syncScroll, setSyncScrollState] = useState(() => {
    try {
      return localStorage.getItem('bxconsole.screen.syncScroll') !== '0';
    } catch {
      return true;
    }
  });
  const setSyncScroll = (on: boolean) => {
    setSyncScrollState(on);
    try {
      localStorage.setItem('bxconsole.screen.syncScroll', on ? '1' : '0');
    } catch {
      /* ignore */
    }
  };
  const [hostSize, setHostSize] = useState({ width: 0, height: 0 });
  const [ripples, setRipples] = useState<Ripple[]>([]);
  const [keyboard, setKeyboard] = useState(false);
  /** DevTools inspect mode (toggle lives in the tab strip): outline the hovered element with a size tooltip */
  const inspect = useInspectMode((s) => s.on);
  const [highlight, setHighlight] = useState<{ rect: DOMRect; label: string } | null>(null);
  // Highlight requested from elsewhere (a DOM node hovered in the Console).
  const external = useScreenHighlight();
  const [externalBox, setExternalBox] = useState<{ rect: DOMRect; label: string } | null>(null);
  useEffect(() => {
    if (external.screenId === null) return setExternalBox(null);
    const rect = mirror.current?.rectOf(external.screenId) ?? null;
    setExternalBox(rect ? { rect, label: external.label } : null);
  }, [external.screenId, external.label, status.batches]);
  const [hover, setHover] = useState<string>('');
  const wheelAcc = useRef<{ x: number; y: number; cx: number; cy: number; timer: number | null }>({ x: 0, y: 0, cx: 0, cy: 0, timer: null });
  /** the mirror holds a document with nothing in it to draw */
  const [blank, setBlank] = useState(false);
  const lastLocalMove = useRef(0);
  const moveTimer = useRef<number | null>(null);

  /** Rebuild the mirror from a snapshot. Shared by the live stream and replay. */
  const loadSnapshot = (snapshot: ScreenSnapshot, state: Status['state']) => {
    const frame = frameRef.current;
    if (!frame) return;
    mirror.current = new DomMirror(frame, sessionId, activeTab ?? undefined);
    mirror.current.followScroll = syncScrollRef.current;
    mirror.current.load(snapshot.doc, snapshot.url);
    mirror.current.setFocus(snapshot.focus);
    if (syncScrollRef.current) frame.contentWindow?.scrollTo(snapshot.scroll.x, snapshot.scroll.y);
    setStatus({ state, viewport: snapshot.viewport, snapshotAt: snapshot.ts, batches: 0, ops: 0 });
    setBlank(mirror.current.isBlank());
  };

  const applyOps = (ops: ScreenOp[]): { unknownIds: number } | undefined => {
    const result = mirror.current?.apply(ops);
    // The first batches of a boot recording are what put the body there.
    setBlank(mirror.current?.isBlank() ?? true);
    const vp = ops.find((o) => o.op === 'viewport');
    setStatus((s) => ({
      ...s,
      batches: s.batches + 1,
      ops: s.ops + ops.length,
      ...(vp && vp.op === 'viewport' ? { viewport: { width: vp.width, height: vp.height } } : {}),
    }));
    return result;
  };

  // Re-subscribing is what moves the mirror to another window: the relay stops the
  // old one streaming and the new one answers with a fresh snapshot.
  const activeTab = useActiveTab(sessionId);
  const tabCount = useSessionsStore((s) => s.byId[sessionId]?.tabs?.length ?? 0);
  const sessionTabs = useSessionsStore((s) => s.byId[sessionId]?.tabs) ?? [];
  /*
   * Which window the replay has landed on, named only when it is not the one
   * the strip points at. Scrubbing a run of several windows walks through all
   * of them — one streams at a time, so the recording is theirs in turn — and
   * it used to do that without a word, leaving a different page on screen
   * than the tab above it claimed.
   */
  const replayWindow = useMemo(() => {
    if (!replay?.tab || replay.tab === activeTab) return null;
    const i = sessionTabs.findIndex((t) => t.tabId === replay.tab);
    if (i < 0) return null;
    return `window ${i + 1}: ${sessionTabs[i]!.title || sessionTabs[i]!.url}`;
  }, [replay?.tab, activeTab, sessionTabs]);
  // Subscribing before the strip has picked a window would mirror an arbitrary
  // one for a moment; with tabs known, wait the one tick until there is a pick.
  const waitingForTab = tabCount > 1 && !activeTab;
  /** An empty screen in a run of several windows is about the window, not the run. */
  const emptyScope: 'run' | 'window' = tabCount > 1 && activeTab ? 'window' : 'run';

  useEffect(() => {
    if (waitingForTab) return;
    const unsubscribe = subscribeScreen(sessionId, (event: ScreenEvent) => {
      const frame = frameRef.current;
      if (!frame) return;
      // The stream keeps arriving while replaying (it is what gets recorded);
      // the mirror belongs to the player until Back to live.
      if (replayingRef.current) return;
      switch (event.type) {
        case 'screen.snapshot': {
          loadSnapshot(event, 'live');
          break;
        }
        case 'screen.mutations': {
          const result = applyOps(event.ops);
          if (result && result.unknownIds > 0) refreshScreen(sessionId);
          break;
        }
        case 'screen.cursor': {
          // Direct DOM update: mousemove is far too frequent for React state.
          // While the viewer's own pointer is over the mirror, it IS the
          // cursor: don't draw the echo.
          const localRecently = Date.now() - lastLocalMove.current < 1500;
          drawCursor(event.visible && !localRecently ? event : null);
          break;
        }
        case 'screen.stopped':
          setStatus((s) => ({ ...s, state: 'stopped' }));
          break;
      }
    });
    return unsubscribe;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `connected` is in here on purpose: when the page comes back the relay has
    // no record of us watching it, so only a fresh subscribe restarts the stream.
  }, [sessionId, activeTab, waitingForTab, connected]);

  /*
   * Blank the mirror when the strip moves to another window.
   *
   * Subscribing is what fetches the new window's frame, and until it lands the
   * mirror still holds the old one: the window just left, sitting under the
   * new one's name. Only one window of a run streams at a time, so a window
   * nobody ever opened this tab on recorded nothing and sends no frame — and
   * without this it kept the other window's page for good, which is what
   * "both tabs show the same thing" was.
   */
  const shownTab = useRef<string | null>(null);
  useEffect(() => {
    const was = shownTab.current;
    shownTab.current = activeTab;
    if (was === null || was === activeTab) return;
    mirror.current?.clear();
    mirror.current = null;
    setStatus((s) => ({ ...s, snapshotAt: null, batches: 0, ops: 0 }));
  }, [activeTab]);

  // Track the pane size; the frame geometry below derives from it and the mode.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const update = () => setHostSize({ width: host.clientWidth, height: host.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const layout = (() => {
    const vw = status.viewport.width;
    const vh = status.viewport.height;
    switch (mode) {
      case 'fill':
        return { frameW: Math.max(1, hostSize.width), frameH: Math.max(1, hostSize.height), scale: 1 };
      case 'actual':
        return { frameW: vw, frameH: vh, scale: 1 };
      default:
        return { frameW: vw, frameH: vh, scale: hostSize.width ? Math.min(1, hostSize.width / vw, hostSize.height / vh) : 1 };
    }
  })();
  const scale = layout.scale;
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  /**
   * Replay always follows the recorded scroll positions: the ops are what
   * moved the page back then, and a mirror parked somewhere else would show
   * the wrong part of it. The live setting comes back when replay ends.
   */
  const followScroll = syncScroll || replay !== null;
  const syncScrollRef = useRef(followScroll);
  syncScrollRef.current = followScroll;
  useEffect(() => {
    if (mirror.current) mirror.current.followScroll = followScroll;
  }, [followScroll]);

  // --------------------------------------------------------------- replay

  // A run that comes back to life, and then ends again, is a new last moment.
  useEffect(() => {
    if (!connected) return;
    noticeRead.delete(sessionId);
    setEndedDismissedState(false);
  }, [connected, sessionId]);

  const enterReplay = (ts?: number) => {
    replayer.current ??= new ScreenReplayer({
      sessionId,
      loadSnapshot: (snapshot) => loadSnapshot(snapshot, 'replay'),
      applyOps: (ops) => void applyOps(ops),
      onStatus: (next) => {
        setReplay(next);
        // Recorded runs put the cursor back where the page had it. Doing it
        // here rather than in a render effect keeps it off React's path, the
        // same reason the live stream writes to the element directly.
        drawCursor(next.pointer);
      },
    });
    // No moment asked for means the Replay button, which opens the recording
    // at its beginning. A moment asked for comes from the History timeline,
    // which means that moment.
    void (ts === undefined ? replayer.current.rewind() : replayer.current.seek(ts));
  };

  const backToLive = () => {
    replayer.current?.dispose();
    replayer.current = null;
    setReplay(null);
    drawCursor(null);
    useScreenReplay.getState().setPlayhead(null);
    setStatus((s) => ({ ...s, state: 'connecting' }));
    // A fresh snapshot, or the last recorded frame when the session is offline.
    refreshScreen(sessionId);
  };

  useEffect(() => () => replayer.current?.dispose(), []);

  /*
   * Pointing the strip at another window while replaying moves the playhead
   * to that window's recording. The relay answers a seek with the window the
   * request names, so the running player has to ask again — otherwise the
   * tab changes above a frame that stays where it was.
   */
  const replayingTab = useRef<string | null>(null);
  useEffect(() => {
    const player = replayer.current;
    const was = replayingTab.current;
    replayingTab.current = activeTab;
    // Nothing to move on the first run, or when no player is up.
    if (!player || was === null || was === activeTab) return;
    // Read the playhead off the player rather than a captured render: this
    // effect watches the window, and the time moves on its own while it plays.
    // refetch: the frames in hand are the window we just left.
    void player.seek(player.status.ts, { refetch: true });
  }, [activeTab]);

  // "Show the screen at this moment", from the History timeline.
  const requestedNonce = useScreenReplay((st) => st.nonce);
  useEffect(() => {
    if (requestedNonce === 0) return;
    const { sessionId: want, ts } = useScreenReplay.getState();
    if (want !== sessionId || ts === null) return;
    enterReplay(ts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedNonce, sessionId]);

  // Publish the playhead for the History timeline, coarsely: it moves every frame.
  const publishedAt = useRef(0);
  useEffect(() => {
    if (!replay) return;
    if (Math.abs(replay.ts - publishedAt.current) < 80 && !replay.atEnd) return;
    publishedAt.current = replay.ts;
    useScreenReplay.getState().setPlayhead({ sessionId, ts: replay.ts, playing: replay.playing });
  }, [replay, sessionId]);
  useEffect(() => {
    if (!replay) useScreenReplay.getState().setPlayhead(null);
  }, [replay]);
  useEffect(() => () => useScreenReplay.getState().setPlayhead(null), []);

  /** Overlay pixel -> remote viewport coordinates. */
  const toRemote = (e: ReactMouseEvent | ReactWheelEvent) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale, lx: e.clientX - rect.left, ly: e.clientY - rect.top };
  };

  const onClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (replay) return; // a past frame: nothing to click, and the live page must not move
    if (status.state !== 'live' && !inspect) return;
    e.preventDefault();
    const { x, y, lx, ly } = toRemote(e);
    const hit = mirror.current?.elementAt(x, y) ?? null;
    if (inspect) {
      // Inspect mode: pick the element in the Elements tab instead of clicking the page.
      if (hit?.id !== null && hit?.id !== undefined) {
        useElementsSelection.getState().select(sessionId, hit.id);
        navigate({ panel: 'elements', sessionId });
      }
      // One pick, then back to normal interaction, like Chrome.
      useInspectMode.getState().set(false);
      setHighlight(null);
      return;
    }
    if (!interact) return;
    sendScreenInput(sessionId, { kind: 'click', id: hit?.id ?? null, x, y, ...fractions(hit, x, y), button: e.button, detail: e.detail });
    const id = Date.now() + Math.random();
    setRipples((r) => [...r, { id, x: lx, y: ly }]);
    setTimeout(() => setRipples((r) => r.filter((p) => p.id !== id)), 500);
  };

  const onWheel = (e: ReactWheelEvent<HTMLDivElement>) => {
    /*
     * A frame with no live page behind it — a replay, or a run that has
     * ended — has nowhere to send a scroll, so scrolling can only mean
     * moving the mirror itself. It is a real DOM in a same-origin frame, so
     * that costs nothing and works exactly as the page did.
     *
     * The ended case used to fall through to the early return below and the
     * wheel did nothing at all, which read as the picture being frozen
     * rather than merely not live. Everything below the fold of the last
     * frame was recorded and unreachable.
     */
    if (replay || status.state !== 'live') {
      frameRef.current?.contentWindow?.scrollBy(e.deltaX, e.deltaY);
      return;
    }
    if (!syncScroll) {
      // Independent scrolling: move the mirror itself, nothing goes to the page.
      frameRef.current?.contentWindow?.scrollBy(e.deltaX, e.deltaY);
      return;
    }
    if (!interact) return;
    const acc = wheelAcc.current;
    const { x, y } = toRemote(e);
    acc.x += e.deltaX;
    acc.y += e.deltaY;
    acc.cx = x;
    acc.cy = y;
    if (acc.timer !== null) return;
    acc.timer = window.setTimeout(() => {
      acc.timer = null;
      const hit = mirror.current?.elementAt(acc.cx, acc.cy) ?? null;
      sendScreenInput(sessionId, { kind: 'wheel', id: hit?.id ?? null, x: acc.cx, y: acc.cy, deltaX: acc.x, deltaY: acc.y });
      acc.x = 0;
      acc.y = 0;
    }, 50);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (replay || !interact || status.state !== 'live') return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && LOCAL_SHORTCUTS.has(e.key)) return; // reload, new tab… stay with this browser
    e.preventDefault();
    e.stopPropagation();
    sendScreenInput(sessionId, {
      kind: 'key',
      type: e.type === 'keyup' ? 'keyup' : 'keydown',
      key: e.key,
      code: e.code,
      altKey: e.altKey,
      ctrlKey: e.ctrlKey,
      metaKey: e.metaKey,
      shiftKey: e.shiftKey,
      repeat: e.repeat,
    });
  };

  const onPaste = (e: ReactClipboardEvent<HTMLDivElement>) => {
    if (replay || !interact || status.state !== 'live') return;
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    e.preventDefault();
    sendScreenInput(sessionId, { kind: 'paste', text });
  };

  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (status.state !== 'live' && !replay) return;
    const { x, y } = toRemote(e);
    const hit = mirror.current?.elementAt(x, y);
    setHover(hit ? `${hit.label} @ ${Math.round(x)},${Math.round(y)}` : '');
    setHighlight(inspect && !replay && hit?.rect ? { rect: hit.rect, label: hit.label } : null);
    if (replay || !interact) return;
    // Forward the move (throttled) so the page's hover handlers run and the remote pointer follows.
    lastLocalMove.current = Date.now();
    if (cursorRef.current) cursorRef.current.style.opacity = '0';
    if (moveTimer.current !== null) return;
    moveTimer.current = window.setTimeout(() => {
      moveTimer.current = null;
      sendScreenInput(sessionId, { kind: 'move', id: hit?.id ?? null, x, y, ...fractions(hit ?? null, x, y) });
    }, 33);
  };

  return (
    <>
      <Toolbar wrap>
        {onCollapse && (
          <ToolbarButton title="Hide screen (stops streaming)" onClick={onCollapse}>
            <CollapsePaneIcon />
          </ToolbarButton>
        )}
        <ToolbarButton title={replay ? 'Reload this frame' : 'Take a fresh snapshot'} onClick={() => (replay ? replayer.current?.seek(replay.ts) : refreshScreen(sessionId))}>
          <RefreshIcon />
        </ToolbarButton>
        <ToolbarDivider />
        <span className={`screen-status ${status.state}`} title={status.snapshotAt ? `frame ${new Date(status.snapshotAt).toLocaleTimeString()}` : undefined}>
          <span className="dot" />
          {replay
            ? `replay · ${new Date(replay.ts).toLocaleTimeString()}${replayWindow ? ` · ${replayWindow}` : ''}`
            : !connected
              ? status.snapshotAt
                ? 'offline · last frame'
                : 'session offline'
              : status.state === 'live'
                ? 'live'
                : status.state === 'stopped'
                  ? 'stopped'
                  : 'waiting for snapshot…'}
        </span>
        <span className="screen-modes" title="Watch the page as it is now, or replay what was recorded">
          <button className={`screen-mode${replay ? '' : ' selected'}`} onClick={() => replay && backToLive()}>
            Live
          </button>
          <button className={`screen-mode${replay ? ' selected' : ''}`} onClick={() => !replay && enterReplay()}>
            Replay
          </button>
        </span>
        <ToolbarDivider />
        <span className="screen-meta mono" title="remote viewport · mirror">
          {status.viewport.width}×{status.viewport.height}
          {mode === 'fill' ? ` → ${layout.frameW}×${layout.frameH}` : ` · ${Math.round(scale * 100)}%`}
        </span>
        <ToolbarDivider />
        <span className="screen-modes">
          {MODES.map((m) => (
            <button key={m.id} className={`screen-mode${mode === m.id ? ' selected' : ''}`} title={m.title} onClick={() => setMode(m.id)}>
              {m.label}
            </button>
          ))}
        </span>
        <label className="toolbar-check" title={replay ? 'Input is off while replaying a past frame' : 'Forward clicks and wheel to the page'}>
          <input type="checkbox" checked={interact && !replay} disabled={!!replay} onChange={(e) => setInteract(e.target.checked)} /> Interact
        </label>
        <label
          className="toolbar-check"
          title={
            replay
              ? 'Replay follows the scroll positions it recorded; your setting comes back on Back to live'
              : "Follow the page's scroll position. Off: scroll the mirror on its own; wheel is not sent to the page"
          }
        >
          <input type="checkbox" checked={followScroll} disabled={!!replay} onChange={(e) => setSyncScroll(e.target.checked)} /> Sync scroll
        </label>

        {/* One shrinking box for the readouts: they change width on every batch,
            and a toolbar that wraps would resize the mirror underneath it. */}
        <div className="screen-toolbar-tail">
          {keyboard && interact && !replay && <span className="screen-kbd">⌨ keys → remote</span>}
          <span className="screen-meta mono hover">{hover}</span>
          <span className="screen-meta counts">
            {status.batches} batches · {status.ops} ops
          </span>
        </div>
      </Toolbar>
      {replay && (
        <ReplayBar
          replay={replay}
          onPlay={() => (replay.playing ? replayer.current?.pause() : replayer.current?.play())}
          onStep={(dir) => (dir > 0 ? replayer.current?.stepForward() : replayer.current?.stepBack())}
          onSpeed={(sp) => replayer.current?.setSpeed(sp)}
          onSeek={(ts) => replayer.current?.seek(ts)}
          onLive={backToLive}
        />
      )}
      <div className={`screen-host mode-${mode}`} ref={hostRef}>
        <div className="screen-frame-box" style={{ width: layout.frameW * scale, height: layout.frameH * scale }}>
          <iframe
            ref={frameRef}
            className="screen-frame"
            title="remote screen"
            sandbox="allow-same-origin"
            tabIndex={-1}
            style={{ width: layout.frameW, height: layout.frameH, transform: `scale(${scale})` }}
          />
          <div
            className={`screen-input-layer${interact && !replay ? ' interactive' : ''}${keyboard && !replay ? ' focused' : ''}${inspect && !replay ? ' inspecting' : ''}${replay ? ' replaying' : ''}`}
            tabIndex={0}
            onClick={onClick}
            onContextMenu={(e) => {
              // Always swallow it: on a stopped mirror onClick returns early,
              // and the browser's own menu would open over the picture.
              e.preventDefault();
              onClick(e);
            }}
            onWheel={onWheel}
            onMouseMove={onMove}
            onMouseEnter={() => useScreenHighlight.getState().set(null)}
            onMouseLeave={() => {
              setHover('');
              setHighlight(null);
            }}
            onKeyDown={onKey}
            onKeyUp={onKey}
            onPaste={onPaste}
            onFocus={() => setKeyboard(true)}
            onBlur={() => setKeyboard(false)}
          >
            {ripples.map((r) => (
              <span key={r.id} className="screen-ripple" style={{ left: r.x, top: r.y }} />
            ))}
            {(highlight ?? externalBox) && (
              <div
                className="screen-highlight"
                style={{
                  left: (highlight ?? externalBox)!.rect.left * scale,
                  top: (highlight ?? externalBox)!.rect.top * scale,
                  width: (highlight ?? externalBox)!.rect.width * scale,
                  height: (highlight ?? externalBox)!.rect.height * scale,
                }}
              >
                <span className="screen-highlight-label mono">
                  {(highlight ?? externalBox)!.label}{' '}
                  <span className="dim">
                    {Math.round((highlight ?? externalBox)!.rect.width)} × {Math.round((highlight ?? externalBox)!.rect.height)}
                  </span>
                </span>
              </div>
            )}
            <div ref={cursorRef} className="screen-cursor" style={{ opacity: 0 }}>
              <svg width="18" height="22" viewBox="0 0 18 22">
                <path d="M1 1l6 17 2.5-6.5L16 9z" fill="#111" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
              </svg>
            </div>
          </div>
          {status.snapshotAt === null && (
            <div className="screen-overlay">
              {replay ? (
                replay.loading ? (
                  'Loading the recording…'
                ) : (
                  <NothingRecorded scope={emptyScope} />
                )
              ) : !connected ? (
                <NothingRecorded scope={emptyScope} />
              ) : (
                'Waiting for the first snapshot…'
              )}
            </div>
          )}
          {/*
            A frame that really was empty, which is not the same as a mirror
            that did not load. A page recorded from boot has its first
            keyframe taken while the agent's script tag is still running, so
            the recording opens on a document the parser had not reached the
            body of yet — a blank pane that stays blank until the batch that
            builds the page. Without this it reads as a broken replay.
          */}
          {replay && !replay.loading && status.snapshotAt !== null && blank && (
            <div className="screen-overlay">
              The page had not been drawn yet at this point. Play, or step forward, to the moment it appears.
            </div>
          )}
          {/*
            The run ended, and what is on screen is its last moment rather
            than a page. Greying it says so at a glance — the picture staying
            bright read as a live page that had simply stopped responding.
          */}
          {status.snapshotAt !== null && !connected && !replay && !endedDismissed && (
            <div className="screen-ended">
              <div className="screen-ended-card">
                <strong>Recorded — not live</strong>
                <p>This is the last moment of the run, not a page you can click.</p>
                <div className="screen-ended-actions">
                  <button
                    className="screen-ended-replay"
                    onClick={() => {
                      dismissEnded();
                      enterReplay();
                    }}
                  >
                    Replay it
                  </button>
                  {/*
                    Taking the notice away rather than acting on it. The grey
                    is there to stop a last frame reading as a live page, but
                    once that has landed it is in the way of the one thing
                    left to do with the frame: look at it.
                  */}
                  <button className="screen-ended-ok" onClick={dismissEnded}>
                    OK, just look
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Why there is no picture, and what to do about it.
 *
 * `scope` is what the emptiness is about, and the two cases need different
 * things said. A run with nothing at all was almost certainly recorded with
 * Blackbox off, and the setting that would have caught it is one tab away.
 * One empty window inside a recorded run is not that: Blackbox is on by
 * default and records every window from boot, so the window being read simply
 * had nothing to record — it closed in a moment, or it was the one window
 * nobody watched on a run where Blackbox was off. Pointing at the setting
 * there sent people to a checkbox that was already ticked.
 */
function NothingRecorded({ scope }: { scope: 'run' | 'window' }) {
  return (
    <span>
      {scope === 'window' ? 'Nothing was recorded for this window.' : 'Nothing was recorded for this run.'}
      <br />
      <span className="screen-overlay-hint">
        {scope === 'window' ? (
          <>The other windows of this run have their own recordings — pick one from the strip above.</>
        ) : (
          <>
            With <a href="#/agent">Record the screen from boot</a> on, a page records from its first tick; off, it records only
            while a Screen tab is open on it.
          </>
        )}
      </span>
    </span>
  );
}

/**
 * The player: step / play / speed / scrub, and the way back to the live page.
 * Modelled on Chrome's animation and performance playback bars.
 */
function ReplayBar({
  replay,
  onPlay,
  onStep,
  onSpeed,
  onSeek,
  onLive,
}: {
  replay: ReplayStatus;
  onPlay: () => void;
  onStep: (dir: 1 | -1) => void;
  onSpeed: (speed: Speed) => void;
  onSeek: (ts: number) => void;
  onLive: () => void;
}) {
  const bounds = replay.bounds;
  const span = bounds ? Math.max(bounds.end - bounds.start, 1) : 1;
  const offset = bounds ? replay.ts - bounds.start : 0;

  /**
   * Narrow pane: the four speed chips fold into one button that cycles, and
   * the note gives up its reserved width. Everything else keeps its size, so
   * the readouts stay whole instead of all three ending in an ellipsis.
   */
  const barRef = useRef<HTMLDivElement>(null);
  const [barWidth, setBarWidth] = useState(0);
  useEffect(() => {
    const el = barRef.current;
    if (!el) return;
    const measure = () => setBarWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  /** too narrow for four speed chips and a slot held open for notes */
  const compact = barWidth > 0 && barWidth < 840;
  /** too narrow even for the word beside the counter */
  const tight = barWidth > 0 && barWidth < 620;
  const cycleSpeed = () => onSpeed(SPEEDS[(SPEEDS.indexOf(replay.speed) + 1) % SPEEDS.length]!);

  // Playback jumps over stretches where the page did nothing; without a word
  // about it the picture just moves on and the clock leaps.
  const [skipped, setSkipped] = useState<number | null>(null);
  const skipSeq = replay.skipped?.seq;
  useEffect(() => {
    if (skipSeq === undefined) return;
    setSkipped(replay.skipped?.ms ?? null);
    const t = setTimeout(() => setSkipped(null), 1600);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skipSeq]);

  return (
    <div className={`screen-replaybar${compact ? ' compact' : ''}${tight ? ' tight' : ''}`} ref={barRef}>
      <button className="screen-replay-button" title="Back one batch of mutations" aria-label="Back one batch of mutations" onClick={() => onStep(-1)}>
        <StepIcon dir={-1} />
      </button>
      <button
        className="screen-replay-button play"
        title={replay.playing ? 'Pause' : 'Play'}
        aria-label={replay.playing ? 'Pause' : 'Play'}
        onClick={onPlay}
      >
        {replay.playing ? <PauseIcon /> : <PlayIcon />}
      </button>
      <button className="screen-replay-button" title="Forward one batch of mutations" aria-label="Forward one batch of mutations" onClick={() => onStep(1)}>
        <StepIcon dir={1} />
      </button>
      <span className="screen-speeds">
        {compact ? (
          <button className="screen-mode selected" title={`Playing at ${replay.speed}× — click for the next speed`} onClick={cycleSpeed}>
            {replay.speed}×
          </button>
        ) : (
          SPEEDS.map((sp) => (
            <button key={sp} className={`screen-mode${replay.speed === sp ? ' selected' : ''}`} title={`Play at ${sp}×`} onClick={() => onSpeed(sp)}>
              {sp}×
            </button>
          ))
        )}
      </span>
      <input
        className="screen-scrubber"
        type="range"
        min={bounds?.start ?? 0}
        max={bounds?.end ?? 1}
        step={1}
        value={replay.ts}
        disabled={!bounds}
        title="Scrub the recording"
        onChange={(e) => onSeek(Number(e.target.value))}
      />
      {/*
        Both readouts hold a width from a figure that does not change while
        playing — the recording's length, and its total change count. Sized by
        their own text instead, they grew a character at every 10-second and
        every power-of-ten boundary, and the scrubber beside them twitched
        narrower each time.
      */}
      <span
        className="screen-meta mono clock"
        style={{ minWidth: `${formatClock(span).length * 2 + 3}ch` }}
        title={new Date(replay.ts).toLocaleString()}
      >
        {formatClock(offset)} / {formatClock(span)}
      </span>
      {/* How many batches of DOM changes this recording holds, and where we are
          in them — one "change" is one step of the ⏮ / ⏭ buttons. `0 / 0
          changes` is the answer to "why did that replay end at once?": the
          page never mutated, however long the session ran. */}
      <span
        className="screen-meta mono counts"
        style={{ minWidth: `${String(replay.total).length * 2 + (tight ? 3 : 11)}ch` }}
        title={
          replay.total === 0
            ? 'No DOM changes were recorded for this session: there is nothing to play'
            : `Change ${replay.step} of ${replay.total} — one step of the ⏮ / ⏭ buttons`
        }
      >
        {replay.step} / {replay.total}
        {tight ? '' : ' changes'}
      </span>
      {/* One slot for all three notes, always laid out: a note appearing must
          not resize the scrubber next to it. */}
      <span
        className={`screen-replay-note${skipped !== null ? ' skip' : ''}${compact ? ' compact' : ''}`}
        title={replay.atEnd ? 'End of the recording' : undefined}
      >
        {skipped !== null
          ? `skipped ${formatOffset(skipped)}`
          : replay.loading
            ? 'loading…'
            : replay.atEnd
              ? compact
                ? 'end'
                : 'end of recording'
              : ''}
      </span>
      <div style={{ flex: 1 }} />
      <button className="screen-replay-live" title="Stop replaying and follow the page again" onClick={onLive}>
        Back to live
      </button>
    </div>
  );
}

/** Position in the recording, as a media player writes it: m:ss, or h:mm:ss past the hour. */
function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** A length of time in prose, for the "skipped 4.2 s" note. */
function formatOffset(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)} s`;
  const m = Math.floor(ms / 60000);
  return `${m}m ${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}s`;
}

/** Pointer position inside the mirrored element as fractions, for the agent to map onto the real element. */
function fractions(hit: { rect: DOMRect | null } | null, x: number, y: number): { fx?: number; fy?: number } {
  const r = hit?.rect;
  if (!r || !r.width || !r.height) return {};
  return { fx: (x - r.left) / r.width, fy: (y - r.top) / r.height };
}
