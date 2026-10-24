/**
 * Whether a keydown is an Enter that should act, or one the IME still owns.
 *
 * Typing a Korean name is a run of compositions — each consonant commits the
 * one before it and starts the next — so when you press Enter the final jamo
 * is still being composed. That Enter commits the composition; it is not a
 * submit. A handler that saw `key === 'Enter'` and acted anyway fired on that
 * commit: it took the half-finished name, and because the field was cleared
 * out from under a composition that was still open, the last letter was left
 * behind as a second entry. So "ㅁㄴㅇㄹ" then Enter made two projects,
 * "ㅁㄴㅇㄹ" and "ㄹ".
 *
 * The browser says which Enter this is. `isComposing` is true on the keydown
 * that ends a composition; keyCode 229 is the older signal for the same thing,
 * for IMEs that report the key as Enter without setting it. Either way the
 * first Enter only finishes the word, and the next Enter — with nothing being
 * composed — is the one that submits it.
 */
export function isEnterSubmit(e: Pick<KeyboardEvent, 'key' | 'isComposing' | 'keyCode'>): boolean {
  return e.key === 'Enter' && !e.isComposing && e.keyCode !== 229;
}
