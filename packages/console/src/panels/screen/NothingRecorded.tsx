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
export function NothingRecorded({ scope }: { scope: 'run' | 'window' }) {
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
