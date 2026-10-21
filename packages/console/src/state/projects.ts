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

/**
 * Which project the console is looking at, kept across reloads.
 *
 * In storage rather than the URL. It is a scope, not a place: every route in
 * this console already names a session or a view, and threading a project
 * through all of them would mean a link that could disagree with the session
 * it points at. What it does mean is that opening a second browser tab starts
 * in the same project, which is what someone working one engagement wants.
 */
const SELECTED_KEY = 'bxconsole.project.selected';

function readSelected(): string {
  try {
    return localStorage.getItem(SELECTED_KEY) ?? '';
  } catch {
    return ''; // a private window still works, it just forgets
  }
}

function writeSelected(projectId: string): void {
  try {
    if (projectId) localStorage.setItem(SELECTED_KEY, projectId);
    else localStorage.removeItem(SELECTED_KEY);
  } catch {
    /* ignore */
  }
}

interface ProjectsState {
  byId: Record<string, Project>;
  order: string[];
  /**
   * Whether the relay has said what this account can read.
   *
   * Before it has, an empty list means "not yet" and not "none" — and the
   * two want opposite screens, so a console that could not tell them apart
   * would show "you have no projects" for a moment on every connection.
   */
  loaded: boolean;
  /** Where a new run lands, or '' when none of this account's projects is it. */
  homeId: string;
  /**
   * The project being looked at, or '' before the list has arrived.
   *
   * Only ever one this account can read: a stored id that is no longer in the
   * list — shared away, deleted, or belonging to whoever was signed in on
   * this browser before — is replaced rather than kept, because a console
   * scoped to a project it cannot see shows an empty list and no reason.
   */
  selectedId: string;
  setAll(list: Project[], homeId: string): void;
  upsert(project: Project): void;
  remove(projectId: string): void;
  select(projectId: string): void;
}

/** The selection to use, given what the account can actually read. */
function settleSelection(order: string[], wanted: string, homeId: string): string {
  if (wanted && order.includes(wanted)) return wanted;
  if (homeId && order.includes(homeId)) return homeId;
  // Newest, which is the engagement most likely being set up.
  return order[0] ?? '';
}

export const useProjectsStore = create<ProjectsState>((set) => ({
  byId: {},
  order: [],
  loaded: false,
  homeId: '',
  selectedId: '',
  setAll: (list, homeId) =>
    set((s) => {
      const order = list.map((p) => p.id);
      // The stored choice on the first snapshot, the live one afterwards, so
      // a project arriving or leaving does not move someone off what they
      // were looking at.
      const wanted = s.selectedId || readSelected();
      const selectedId = settleSelection(order, wanted, homeId);
      writeSelected(selectedId);
      return { byId: Object.fromEntries(list.map((p) => [p.id, p])), order, homeId, selectedId, loaded: true };
    }),
  upsert: (project) =>
    set((s) => {
      const order = s.order.includes(project.id) ? s.order : [project.id, ...s.order];
      const byId = { ...s.byId, [project.id]: project };
      // A project this console just made is the one it wants to be in. Any
      // other change leaves the selection alone.
      const selectedId = s.selectedId && order.includes(s.selectedId) ? s.selectedId : project.id;
      writeSelected(selectedId);
      return { byId, order, selectedId };
    }),
  remove: (projectId) =>
    set((s) => {
      const { [projectId]: _dropped, ...rest } = s.byId;
      const order = s.order.filter((id) => id !== projectId);
      // Not cleared: the relay only names a home project this account can
      // read, so one that has gone means it is no longer theirs and the
      // next snapshot says so.
      const homeId = s.homeId === projectId ? '' : s.homeId;
      const selectedId = s.selectedId === projectId ? settleSelection(order, '', homeId) : s.selectedId;
      writeSelected(selectedId);
      return { byId: rest, order, homeId, selectedId };
    }),
  select: (projectId) =>
    set((s) => {
      if (!s.order.includes(projectId)) return s;
      writeSelected(projectId);
      return { selectedId: projectId };
    }),
}));

export function useProjectList(): Project[] {
  return useProjectsStore(useShallow((s) => s.order.map((id) => s.byId[id]!)));
}

/**
 * The project a snippet made now would record into, or null when there is
 * none.
 *
 * Whatever is selected, which is what a switcher is for: the key in the
 * snippet and the runs in the list are then the same engagement, and there is
 * one thing to change rather than two to keep in step. Where the selection
 * comes from when nobody has chosen — the home project, else the newest — is
 * settleSelection's business.
 */
export function useSnippetProject(): Project | null {
  return useProjectsStore((s) => (s.selectedId ? (s.byId[s.selectedId] ?? null) : null));
}

/** The project being looked at, which is the same one. */
export const useSelectedProject = useSnippetProject;

export function selectProject(projectId: string): void {
  useProjectsStore.getState().select(projectId);
}
