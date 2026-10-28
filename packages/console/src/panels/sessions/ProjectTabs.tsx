/**
 * The one tab row, on every screen there is.
 *
 * It used to be three rows wearing the same clothes: the Projects screen
 * showed `Projects` alone, a project's screens showed all five, and inside a
 * run there were two — `Projects` and `Sessions`. Moving between them moved
 * the tabs under the pointer, and the row people navigate by was a different
 * row depending on where they already were.
 *
 * So it is built once here and every screen renders it. A tab that has
 * nowhere to go is disabled rather than dropped, because a row that keeps
 * its shape is the whole point: the four are about one project — its runs,
 * what reaches it, what it has thrown away, and the snippet carrying its key
 * — and on the Projects and Admin screens, which are a level above a project
 * rather than inside one, there is no project for them to be about.
 *
 * Inside a run they are live. The run is in a project, so all four have
 * something to be about, and leaving a session to copy the snippet from the
 * Agent tab is an ordinary thing to want; it used to take two clicks through
 * the session list.
 */
import { useProjectsStore, selectProject } from '../../state/projects';
import { useSessionList } from '../../state/sessions';
import { navigateToView, type SessionView } from '../../app/router';
import { TabBar } from '../../devtools-ui/TabBar';
import '../../devtools-ui/strip.css';

export function ProjectTabs({
  active,
  sessionId,
}: {
  /** the project screen showing, or null inside a run, where none of them is */
  active: SessionView | null;
  /** the run being read, when one is open: the four are about its project */
  sessionId?: string;
}) {
  const sessions = useSessionList();
  const { selectedId, homeId, order, loaded } = useProjectsStore();

  /*
   * Which project the counts are about.
   *
   * With a run open that is the project the run is in, not whichever the
   * list was last left on: those differ as soon as somebody opens a session
   * from the picker and it belongs somewhere else, and the tabs would then
   * count another project's runs.
   */
  const open = sessionId ? sessions.find((s) => s.sessionId === sessionId) : undefined;
  const currentId = sessionId ? (open?.projectId ?? homeId) : selectedId;

  const all = order.length === 0 ? sessions : sessions.filter((s) => (s.projectId ?? homeId) === currentId);
  const trashed = all.filter((s) => s.trashedAt !== undefined).length;
  const live = all.filter((s) => s.trashedAt === undefined && s.connected).length;

  /*
   * Nothing to be in: no project has arrived, so the Projects screen is what
   * shows whatever the route says. Only once the relay has answered — before
   * that an empty list means "not yet".
   */
  const outside = active === 'projects' || active === 'admin';
  const nothingToBeIn = !sessionId && !outside && loaded && order.length === 0;
  const atProjects = active === 'projects' || nothingToBeIn;
  const stranded = outside || nothingToBeIn;

  return (
    <TabBar
      tabs={[
        { id: 'sessions' as const, label: live > 0 ? `Sessions (${live} live)` : 'Sessions', disabled: stranded },
        { id: 'webhook' as const, label: 'Webhook', disabled: stranded },
        { id: 'trash' as const, label: trashed > 0 ? `Trash (${trashed})` : 'Trash', disabled: stranded },
        { id: 'agent' as const, label: 'Agent', disabled: stranded },
      ]}
      // Nothing is selected inside a run: the screen showing is the run, not
      // one of these. `__none__` is a view that cannot be routed to, so no
      // tab matches it.
      active={active ?? ('__none__' as SessionView)}
      onSelect={(view) => {
        // From inside a run, take its project with you: the list may have
        // been left on a different one, and these tabs name this run's.
        if (sessionId && currentId) selectProject(currentId);
        navigateToView(view);
      }}
      /*
       * The way out sits in the tab row, divided off from it.
       *
       * It was a blue word in the thin row above, and QA rounds showed people
       * scanning the tabs and reading that row as decoration. A tab is what
       * they look at, so this is shaped like one — but it leaves the project
       * rather than choosing a view inside it, so the divider marks it as the
       * level above, and it takes the selected underline only when its own
       * screen is the one showing.
       */
      leading={
        <div className="strip-leading">
          <button
            className={`strip-item${atProjects ? ' selected' : ''}`}
            role="tab"
            aria-selected={atProjects}
            title="Every project you can read"
            onClick={() => navigateToView('projects')}
          >
            Projects
          </button>
        </div>
      }
    />
  );
}
