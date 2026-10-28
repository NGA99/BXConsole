/**
 * Managing this account's projects.
 *
 * A project is what recordings belong to, so most of what is here is about
 * consequences rather than settings: the key, which decides where a payload's
 * run lands and so whether it is recorded at all; rotating it, which stops
 * every payload already out there; and deleting one, which takes its
 * recordings with it.
 *
 * Only what this account can read is listed, and only its owner is offered
 * the controls. Being shared a project is being able to read its recordings,
 * not to rename or delete the engagement you were invited to look at. The
 * relay checks all of this again; hiding the buttons is so that what is shown
 * is what works.
 */
import { useEffect, useRef, useState } from 'react';
import type { Project } from '@bxconsole/protocol';
import { useProjectsStore, selectProject } from '../../state/projects';
import { useSessionList, useSessionsStore } from '../../state/sessions';
import { purgeNote } from './purge';
import { useAccount } from '../../state/whoami';
import {
  createProject,
  forgetProject,
  renameProject,
  restoreProject,
  rotateProjectKey,
  trashProject,
} from '../../transport/client';
import { navigateToView } from '../../app/router';
import { copyText } from '../network/copy';
import './ProjectsPanel.css';
import { fullTimestamp } from '../../devtools-ui/time';
import { isEnterSubmit } from '../../devtools-ui/enter-key';
import { projectCounts, liveness, type Liveness } from './project-counts';

export function ProjectsPanel() {
  const { order, byId, homeId, selectedId } = useProjectsStore();
  const account = useAccount();
  const sessions = useSessionList();
  const purgeDays = useSessionsStore((s) => s.trashPurgeDays);
  const [making, setMaking] = useState('');

  const counts = new Map<string, number>();
  for (const s of sessions) {
    const id = s.projectId ?? homeId;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  // The live/dead split for the edge light, which — unlike the recordings
  // count above — leaves out the trash, the way the list itself does.
  const live = projectCounts(sessions, homeId);

  const [entering, setEntering] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  /*
   * Making a project is how you say what you are about to work on, so it
   * takes you in rather than leaving you on the list to click again. The
   * relay names it back with its id, which is what `entering` waits for.
   */
  const make = () => {
    const name = making.trim();
    /*
     * With no name yet the button is still the way in: it puts the cursor
     * where the name goes.
     *
     * Disabling it instead left the one filled control on the screen grey
     * every time the screen was opened, which is the state people arrive
     * on — and a grey button is exactly as easy to miss as the text link it
     * replaced.
     */
    if (!name) {
      nameRef.current?.focus();
      return;
    }
    createProject(name);
    setEntering(name);
    setMaking('');
  };

  useEffect(() => {
    if (!entering) return;
    const made = order.map((id) => byId[id]).find((p) => p?.name === entering.replace(/\s+/g, ' ').trim());
    if (!made) return;
    setEntering(null);
    selectProject(made.id);
    navigateToView('sessions');
  }, [entering, order, byId]);

  return (
    <div className="projects">
      {/*
        * No heading and no preamble. The tab row above already says Projects,
        * and the paragraph that stood here — what a project owns, where a run
        * lands — was read by nobody who did not already know it, while it
        * pushed the one control this screen is for further down the page.
        * What it said is on the cards: every card names its key, and the home
        * card says what a payload with no key does.
        */}
      {/*
        * A block with a heading, not a line with an input on it.
        *
        * It was an input and a `create` link, which is the shape of the
        * Sessions screen's filter box — same place on the screen, same size —
        * so people typed a name into it and waited for the list to narrow.
        * And `create` wore `.detail-link`, the style of the eight `copy`,
        * `rotate` and `move to the trash` under it, so the one thing this
        * screen is for looked like its smallest action.
        *
        * Not a <form>. Its submit-on-Enter fires on the Enter that commits an
        * IME composition, which is the bug that made "ㅁㄴㅇㄹ" into two
        * projects; isEnterSubmit is what knows the difference.
        */}
      <div className="projects-new">
        <h2 className="projects-new-title">New project</h2>
        <div className="projects-new-row">
          <input
            ref={nameRef}
            value={making}
            placeholder="Name it after the engagement"
            aria-label="New project name"
            spellCheck={false}
            onChange={(e) => setMaking(e.target.value)}
            onKeyDown={(e) => isEnterSubmit(e.nativeEvent) && make()}
          />
          <button className="projects-create" onClick={make}>
            Create project
          </button>
        </div>
      </div>

      {order.length === 0 ? (
        <div className="projects-empty">
          You have no projects yet. Make one above: a run is recorded into the project whose key its
          payload carries, so there has to be one before there can be a snippet to paste.
        </div>
      ) : (
        order.map((id) => {
          const project = byId[id];
          if (!project) return null;
          return (
            <ProjectRow
              key={id}
              project={project}
              mine={project.owner === account?.id}
              home={id === homeId}
              selected={id === selectedId}
              liveness={liveness(live.get(id))}
              sessions={counts.get(id) ?? 0}
              purgeDays={purgeDays}
            />
          );
        })
      )}
    </div>
  );
}

function ProjectRow({
  project,
  mine,
  home,
  selected,
  liveness,
  sessions,
  purgeDays,
}: {
  project: Project;
  mine: boolean;
  home: boolean;
  selected: boolean;
  /** which colour the left edge carries: live (green), dead (red), empty (blue) */
  liveness: Liveness;
  sessions: number;
  /** days in the trash before it is deleted; 0 when nothing is purged */
  purgeDays: number;
}) {
  const [name, setName] = useState(project.name);
  const [copied, setCopied] = useState(false);
  /*
   * Two confirmations, each armed by name.
   *
   * Rotating a key stops every payload carrying the old one, and deleting a
   * project destroys its recordings — and both are one click away from a list
   * you are reading. Typing the project's name is the slowest confirmation
   * that still fits, and it is the right one here because the mistake these
   * prevent is clicking the wrong row.
   */
  const [confirming, setConfirming] = useState<'rotate' | 'forget' | null>(null);
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === project.name;

  const arm = (what: 'rotate' | 'forget' | null) => {
    setConfirming(what);
    setTyped('');
  };

  const trashed = project.trashedAt !== undefined;

  /*
   * The card opens the project, the way a row opens a session. It used to take
   * a button on the right, which is a long way from wherever you were reading
   * and easy to miss when every other list in here opens on the row.
   *
   * Everything in the card that does something of its own — the name, the key,
   * the actions, a confirmation — stops the click before it gets here, so the
   * card means "go in" and nothing else does.
   */
  const open = () => {
    selectProject(project.id);
    navigateToView('sessions');
  };

  return (
    <div
      className={`project project-${liveness}${trashed ? ' trashed' : ''}`}
      role="button"
      tabIndex={0}
      title={selected ? `Showing ${project.name}` : `Show the recordings in ${project.name}`}
      onClick={open}
      onKeyDown={(e) => {
        // The card is a div, so Enter and Space are not free.
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        open();
      }}
    >
      <div className="project-top">
        {mine ? (
          <input
            className="project-name"
            value={name}
            spellCheck={false}
            // A bare text box with the name as its only content: nothing said
            // what it was, and a name cleared by accident left an empty box
            // with no hint of what belongs in it.
            aria-label="Project name"
            placeholder="Project name"
            title="Rename this project"
            // Clicking the name is a rename, not a way in.
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== project.name && renameProject(project.id, name)}
            onKeyDown={(e) => isEnterSubmit(e.nativeEvent) && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <span className="project-name readonly">{project.name}</span>
        )}
        {home && (
          <span className="project-tag" title="Where a payload with no key lands, when the relay is set up to accept one">
            home
          </span>
        )}
        {!mine && (
          <span className="project-tag" title="Shared with you: you can read its recordings, not change the project">
            shared with you
          </span>
        )}
        {trashed && (
          <span className="project-tag bad" title={`Moved to the trash on ${fullTimestamp(project.trashedAt!)}`}>
            {purgeNote(project.trashedAt, purgeDays) ?? 'in the trash'}
          </span>
        )}
        <div className="project-spacer" />
        <span className="project-count">
          {sessions} {sessions === 1 ? 'recording' : 'recordings'}
        </span>
      </div>

      <div className="project-key" onClick={(e) => e.stopPropagation()}>
        <span className="project-key-label">Agent key</span>
        <code className="mono">{project.agentKey}</code>
        <button
          className="detail-link"
          onClick={() => {
            void copyText(project.agentKey);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? 'copied' : 'copy'}
        </button>
        {mine && confirming !== 'rotate' && (
          <button className="detail-link" onClick={() => arm('rotate')}>
            rotate
          </button>
        )}
      </div>

      {mine && confirming === 'rotate' && (
        <Confirm
          what={`Every payload carrying the current key stops being recorded. Type “${project.name}” to draw a new one.`}
          name={project.name}
          typed={typed}
          setTyped={setTyped}
          enabled={matches}
          action="rotate the key"
          onGo={() => (rotateProjectKey(project.id), arm(null))}
          onCancel={() => arm(null)}
        />
      )}

      {mine && (
        <div className="project-actions" onClick={(e) => e.stopPropagation()}>
          {trashed ? (
            <>
              <button className="detail-link" onClick={() => restoreProject(project.id)}>
                take out of the trash
              </button>
              {purgeDays > 0 && sessions > 0 && (
                <span className="project-note">
                  Its {sessions} {sessions === 1 ? 'recording is' : 'recordings are'} deleted with it.
                </span>
              )}
              {confirming !== 'forget' && (
                <button className="detail-link bad" onClick={() => arm('forget')}>
                  delete for good
                </button>
              )}
            </>
          ) : home ? (
            <span className="project-note">
              The home project cannot be trashed or deleted: a payload with no key has to have
              somewhere to land.
            </span>
          ) : (
            <>
              <button className="detail-link" onClick={() => trashProject(project.id)}>
                move to the trash
              </button>
              {purgeDays > 0 && (
                <span className="project-note">
                  Reversible for {purgeDays} days, then it and its recordings are deleted.
                </span>
              )}
            </>
          )}
        </div>
      )}

      {mine && confirming === 'forget' && (
        <Confirm
          what={`This deletes the project and its ${sessions} ${sessions === 1 ? 'recording' : 'recordings'}, for good. Type “${project.name}” to confirm.`}
          name={project.name}
          typed={typed}
          setTyped={setTyped}
          enabled={matches}
          action="delete it"
          onGo={() => (forgetProject(project.id), arm(null))}
          onCancel={() => arm(null)}
        />
      )}
    </div>
  );
}

function Confirm({
  what,
  name,
  typed,
  setTyped,
  enabled,
  action,
  onGo,
  onCancel,
}: {
  what: string;
  name: string;
  typed: string;
  setTyped: (v: string) => void;
  enabled: boolean;
  action: string;
  onGo: () => void;
  onCancel: () => void;
}) {
  return (
    // Typing a project's name to arm a rotate or a delete must not also walk
    // into the project.
    <div className="project-confirm" onClick={(e) => e.stopPropagation()}>
      <span>{what}</span>
      <input
        autoFocus
        value={typed}
        placeholder={name}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (isEnterSubmit(e.nativeEvent) && enabled) onGo();
          if (e.key === 'Escape') onCancel();
        }}
      />
      <button className="detail-link bad" disabled={!enabled} onClick={onGo}>
        {action}
      </button>
      <button className="detail-link" onClick={onCancel}>
        cancel
      </button>
    </div>
  );
}
