/**
 * The one token every trace the agent leaves in the page is built from.
 *
 * A payload that runs in someone else's browser writes a handful of things
 * the page can see: a global, a few window markers, two sessionStorage keys,
 * the name of the frame it hosts in. Spelling the product's name into all of
 * them hands a defender a grep to find every host that has ever been hit, and
 * hands an incident responder the vendor on a plate.
 *
 * So they all come from here. The default is deliberately dull — it reads as
 * the kind of noise a bundler leaves behind — and `data-mark` / `?mark=`
 * replaces it per engagement, which matters because a fixed neutral token is
 * only one grep better than a fixed obvious one.
 *
 * All of them but one, and the exception is worth knowing about. The relay
 * prepends its configuration to the bundle under a name that cannot be
 * derived from the mark, because the mark is read out of it. That one is
 * dealt with by not keeping it: readConfig takes it off the window before it
 * reads anything else, so it is gone before any of the page's code runs
 * again. See INJECT_GLOBAL in the protocol package.
 *
 * It has to be stable within a window: the session and tab keys are read back
 * after a reload to rejoin the run, so a value that changed per load would
 * start a new session on every navigation.
 */
export const DEFAULT_MARK = '__wv';

let mark = DEFAULT_MARK;

/** Called once at boot, before anything touches the page. */
export function setMark(value: string | null | undefined): void {
  // Must be a usable property name, or every derived key silently breaks.
  if (value && /^[A-Za-z_$][A-Za-z0-9_$]{0,30}$/.test(value)) mark = value;
}

/** The operator-facing handle: `window.<mark>.mark('name')`. */
export function markName(): string {
  return mark;
}

/** An internal flag on `window`, e.g. `__wvHosting`. */
export function flagName(suffix: string): string {
  return `${mark}${suffix}`;
}

/** A sessionStorage key, e.g. `__wv_session`. */
export function storeKey(suffix: string): string {
  return `${mark}_${suffix}`;
}

/**
 * The marks are property names now, not identifiers, so they are reached
 * through these rather than through a typed `Window` declaration. The casts
 * live here instead of at a dozen call sites.
 */
export interface PageHandle {
  sessionId: string;
  tabId: string;
  [key: string]: unknown;
}

const bag = (win: Window): Record<string, unknown> => win as unknown as Record<string, unknown>;

export function getHandle(win: Window): PageHandle | undefined {
  return bag(win)[markName()] as PageHandle | undefined;
}

export function setHandle(win: Window, value: PageHandle): void {
  put(win, markName(), value);
}

export function getFlag(win: Window, suffix: string): unknown {
  return bag(win)[flagName(suffix)];
}

export function setFlag(win: Window, suffix: string, value: unknown): void {
  put(win, flagName(suffix), value);
}

/**
 * Put a value on a window without adding it to the list of its globals.
 *
 * A plain assignment makes an enumerable own property, so `Object.keys(window)`
 * hands every one of these to the page — which costs `data-mark` most of its
 * point. Renaming the traces is only worth something if finding them takes
 * knowing the name; a page that can list them does not have to guess. Defined
 * this way they answer to the name and to nothing else.
 *
 * `configurable: false` so the page cannot `delete` them either, and
 * `writable: true` because these are flags the agent sets more than once —
 * the second write is an assignment, which is why `put` re-assigns rather
 * than redefining when the property is already ours.
 */
function put(win: Window, key: string, value: unknown): void {
  const o = bag(win);
  try {
    if (Object.getOwnPropertyDescriptor(o, key)) {
      o[key] = value;
      return;
    }
    Object.defineProperty(o, key, { value, writable: true, enumerable: false, configurable: false });
  } catch {
    // A page that locked this name first. Better a visible trace than none.
    try {
      o[key] = value;
    } catch {
      /* nothing more to try */
    }
  }
}
