/**
 * The projects this console may read, and which of them new runs land in.
 *
 * A project is what a recording belongs to: the account owns the project and
 * the runs sit in it. The relay sends this before the session list, because
 * the sessions are grouped by it.
 *
 * What the console needs it for right now is the agent key. A payload with no
 * key is refused, so the snippet the Sessions tab hands out has to carry one
 * — and it has to come from here rather than being saved with the rest of the
 * setup, because a key can be rotated and a saved copy would go on being
 * pasted into pages long after it stopped working.
 */
import { create } from 'zustand';
import { useShallow } from 'zustand/react/shallow';
import type { Project } from '@bxconsole/protocol';

interface ProjectsState {
  byId: Record<string, Project>;
  order: string[];
  /** Where a new run lands, or '' when none of this account's projects is it. */
  homeId: string;
  setAll(list: Project[], homeId: string): void;
  upsert(project: Project): void;
  remove(projectId: string): void;
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  byId: {},
  order: [],
  homeId: '',
  setAll: (list, homeId) =>
    set({
      byId: Object.fromEntries(list.map((p) => [p.id, p])),
      order: list.map((p) => p.id),
      homeId,
    }),
  upsert: (project) =>
    set((s) => ({
      byId: { ...s.byId, [project.id]: project },
      order: s.order.includes(project.id) ? s.order : [project.id, ...s.order],
    })),
  remove: (projectId) =>
    set((s) => {
      const { [projectId]: _dropped, ...rest } = s.byId;
      return {
        byId: rest,
        order: s.order.filter((id) => id !== projectId),
        // Not cleared: the relay only names a home project this account can
        // read, so one that has gone means it is no longer theirs and the
        // next snapshot says so.
        homeId: s.homeId === projectId ? '' : s.homeId,
      };
    }),
}));

export function useProjectList(): Project[] {
  return useProjectsStore(useShallow((s) => s.order.map((id) => s.byId[id]!)));
}

/**
 * The project a snippet made now would record into, or null when there is
 * none.
 *
 * The home project when this account can read it: that is where a payload
 * with no key lands, so it is the least surprising answer for whoever the
 * relay was set up by. Otherwise this account's newest project — because the
 * home one is relay-wide and belongs to somebody else, and the first version
 * of this returned nothing in that case, which handed every account but one a
 * snippet with no key in it and so a payload that would be refused.
 *
 * Newest rather than oldest because the list is in that order and the newest
 * project is the engagement being set up. Once there is a switcher this
 * becomes whatever is selected.
 */
export function useSnippetProject(): Project | null {
  return useProjectsStore((s) => {
    const home = s.homeId ? s.byId[s.homeId] : undefined;
    if (home) return home;
    const first = s.order[0];
    return first ? (s.byId[first] ?? null) : null;
  });
}
