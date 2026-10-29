/**
 * The player: step / play / speed / scrub, and the way back to the live page.
 * Modelled on Chrome's animation and performance playback bars.
 *
 * Its two clock formatters come with it — nothing else in the Screen panel
 * printed a position in a recording.
 */
import { useEffect, useRef, useState } from 'react';
import { PauseIcon, PlayIcon, StepIcon } from '../../devtools-ui/icons';
import { fullTimestamp } from '../../devtools-ui/time';
import { SPEEDS, type ReplayStatus, type Speed } from './replay';

export function ReplayBar({
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
        title={fullTimestamp(replay.ts)}
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
