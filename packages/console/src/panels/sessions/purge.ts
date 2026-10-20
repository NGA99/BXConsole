/**
 * How long something in the trash has left.
 *
 * Said out loud wherever a trashed thing is listed, because the trash is the
 * one place in this console where waiting is itself an action: leave a
 * recording there and in a week it is gone, with nobody to ask. A trash that
 * says "3 recordings" and nothing else looks like a list that will keep.
 */

/** Days, in milliseconds. */
const DAY = 24 * 60 * 60 * 1000;

/**
 * What to say about something trashed at `trashedAt`, or null when there is
 * nothing to say — nothing is purged on a timer, or it is not in the trash.
 *
 * Rounded up, and never to "0 days": the last stretch reads as "today",
 * because a thing with four hours left has neither a day left nor none.
 */
export function purgeNote(trashedAt: number | undefined, purgeDays: number, now = Date.now()): string | null {
  if (trashedAt === undefined || purgeDays <= 0) return null;
  const left = trashedAt + purgeDays * DAY - now;
  if (left <= 0) return 'deleted at the next sweep';
  const days = Math.ceil(left / DAY);
  if (days <= 1) return 'deleted today';
  return `deleted in ${days} days`;
}

/** The same thing as a sentence for a whole list, or null when there is none. */
export function purgeSummary(purgeDays: number): string | null {
  if (purgeDays <= 0) return null;
  return purgeDays === 1
    ? 'Anything left here is deleted for good after a day.'
    : `Anything left here is deleted for good after ${purgeDays} days.`;
}
