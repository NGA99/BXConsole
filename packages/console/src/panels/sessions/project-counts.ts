/**
 * How many runs a project has, as the path row says it.
 *
 * Its own file so the rule can be tested: this number sits one row above the
 * Sessions tab's own count and has to agree with it, and the two were counted
 * in different places by different code. With one recording in the trash the
 * path said "First project (3 recorded)" over a list headed "0 live · 2
 * recorded" and a tab reading "Trash (1)" — three numbers, all correct about
 * something, none of them about the same thing.
 *
 * So what is in the trash is not counted here, the same way the list does not
 * show it. The trash has its own count on its own tab.
 */
import type { SessionMeta } from '@bxconsole/protocol';

export interface ProjectCount {
  live: number;
  kept: number;
}

/**
 * @param homeId  where a run with no project of its own belongs — the relay
 *                reads them that way, so a count that left them out would be
 *                short by every keyless payload.
 */
export function projectCounts(sessions: SessionMeta[], homeId: string | null): Map<string, ProjectCount> {
  const counts = new Map<string, ProjectCount>();
  for (const s of sessions) {
    if (s.trashedAt !== undefined) continue;
    const id = s.projectId ?? homeId;
    if (!id) continue;
    const at = counts.get(id) ?? { live: 0, kept: 0 };
    if (s.connected) at.live++;
    else at.kept++;
    counts.set(id, at);
  }
  return counts;
}

/** The part of a project's label that says what is in it, or '' for nothing. */
export function describeCount(at: ProjectCount | undefined): string {
  return [at?.live ? `${at.live} live` : '', at?.kept ? `${at.kept} recorded` : ''].filter(Boolean).join(' · ');
}

/** The colour of the light on a project's left edge. */
export type Liveness = 'live' | 'dead' | 'empty';

/**
 * Green while a run in the project is connected, red once they have all gone
 * quiet but recordings remain, and the plain accent while it holds no runs.
 *
 * The trash does not count, the same as the counts above: a project whose
 * only recordings are in the trash reads as empty here too, because the list
 * you are looking at shows none.
 */
export function liveness(at: ProjectCount | undefined): Liveness {
  if (at?.live) return 'live';
  if (at?.kept) return 'dead';
  return 'empty';
}
