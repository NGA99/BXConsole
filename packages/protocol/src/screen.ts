/**
 * Screen tab: remote viewing by DOM snapshot streaming (rrweb-style).
 *
 * The agent serialises the live document once (`screen.snapshot`), then
 * streams `screen.mutations` batches from a MutationObserver plus scroll /
 * input / viewport listeners. The viewer rebuilds the tree in a sandboxed,
 * script-less iframe and applies ops by node id.
 *
 * Both are persisted as a timeline (`screen.ndjson`, see `paths.ts`): the
 * relay asks the agent for a periodic keyframe (a snapshot that live viewers
 * never see, since their tree is already up to date), so restoring any point
 * in time is one keyframe plus the ops recorded after it. That is what the
 * History tab's DOM time travel replays.
 */

export type SnapshotNode =
  | { id: number; t: 'doctype'; name: string }
  | { id: number; t: 'el'; tag: string; ns?: string; attrs: Record<string, string>; children: SnapshotNode[] }
  | { id: number; t: 'tx'; text: string }
  | { id: number; t: 'cm'; text: string };

export type ScreenOp =
  | { op: 'add'; parentId: number; nextId: number | null; node: SnapshotNode }
  | { op: 'remove'; id: number }
  | { op: 'attr'; id: number; name: string; value: string | null }
  | { op: 'text'; id: number; text: string }
  | { op: 'input'; id: number; value?: string; checked?: boolean }
  /** id null = the document itself */
  | { op: 'scroll'; id: number | null; x: number; y: number }
  | { op: 'viewport'; width: number; height: number }
  /** document.activeElement changed; null = nothing focused */
  | { op: 'focus'; id: number | null };

/**
 * Remote pointer position. `x`/`y` are page viewport coordinates; `anchor`
 * says which element is under the pointer and where inside it (fractions of
 * its box), so a viewer whose mirror reflowed to a different width can still
 * place the cursor on the right spot.
 */
export interface ScreenCursor {
  type: 'screen.cursor';
  ts: number;
  x: number;
  y: number;
  visible: boolean;
  pressed: boolean;
  anchor?: {
    id: number;
    /** pointer position inside the element's box as fractions */
    fx: number;
    fy: number;
    /** and as pixels, with the element's size: exact when the mirrored box has the same size */
    dx: number;
    dy: number;
    w: number;
    h: number;
  } | null;
}

/** Input the viewer sends back to the page. `id` is the mirrored node under the pointer; the agent falls back to (x, y). */
/**
 * `x`/`y` are mirror viewport coordinates (only exact when the mirror has the
 * remote layout). `fx`/`fy` are the pointer's position inside the mirrored
 * element's box as fractions: the agent maps them onto the real element, which
 * stays correct when the mirror reflowed to another width.
 */
export type ScreenInput =
  | { kind: 'click'; id: number | null; x: number; y: number; fx?: number; fy?: number; button: number; detail: number }
  | { kind: 'move'; id: number | null; x: number; y: number; fx?: number; fy?: number }
  | { kind: 'wheel'; id: number | null; x: number; y: number; deltaX: number; deltaY: number }
  /** delivered to document.activeElement; the agent emulates the default action */
  | {
      kind: 'key';
      type: 'keydown' | 'keyup';
      key: string;
      code: string;
      altKey: boolean;
      ctrlKey: boolean;
      metaKey: boolean;
      shiftKey: boolean;
      repeat: boolean;
    }
  | { kind: 'paste'; text: string };

/** A whole document. The first one of a stream, and every later keyframe. */
export interface ScreenSnapshot {
  type: 'screen.snapshot';
  ts: number;
  url: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number };
  /** id of document.activeElement, if any */
  focus: number | null;
  /** top-level children of `document` (doctype + <html>) */
  doc: SnapshotNode[];
  /**
   * A keyframe taken for the recording only (answer to `screen.keyframe`).
   * Live viewers are already in sync, so the relay persists it and does not
   * forward it; forwarding would make their mirror flash for nothing.
   */
  keyframe?: boolean;
}

export interface ScreenMutations {
  type: 'screen.mutations';
  ts: number;
  ops: ScreenOp[];
}

export type ScreenEvent = ScreenCursor | ScreenSnapshot | ScreenMutations | { type: 'screen.stopped'; ts: number };

export function isScreenEvent(msg: { type: string }): msg is ScreenEvent {
  return msg.type.startsWith('screen.');
}

// -------------------------------------------------------------- the recording

/**
 * One line of `screen.ndjson`. `k` comes first so a scan can tell keyframe
 * lines from op lines by their prefix (`{"k":1`) without parsing them.
 */
export type ScreenRecord =
  | { k: 1; ts: number; snapshot: ScreenSnapshot }
  | { k: 0; ts: number; ops: ScreenOp[] };

/**
 * What the viewer needs to show a moment in the past: the keyframe at or
 * before it, then the op batches recorded after that keyframe.
 *
 * A seek asks for a point in time and gets its keyframe; playing on asks to
 * continue after the last batch it has (`snapshot` omitted), so playback runs
 * across keyframe boundaries without reloading the mirror.
 */
export interface ScreenSegment {
  /** the whole recording's extent, for the scrubber; null when nothing is recorded */
  bounds: { start: number; end: number } | null;
  snapshot?: ScreenSnapshot;
  batches: Array<{ ts: number; ops: ScreenOp[] }>;
  /** true when `batches` reaches the end of the recording */
  done: boolean;
  /**
   * How many batches of DOM changes the whole recording holds, counted when
   * the relay indexes it — so a viewer can say "change 12 of 4071" from the
   * first answer, rather than only knowing what it has loaded.
   */
  changes: number;
  /** batches recorded before this segment's keyframe, which is where `seek` puts the playhead */
  from: number;
}
