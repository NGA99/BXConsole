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
import { useState } from 'react';
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

  const make = () => {
    const name = making.trim();
    if (!name) return;
    createProject(name);
    setMaking('');
  };

  return (
    <div className="projects">
      <div className="projects-head">
        <span className="projects-title">Projects</span>
        <span className="projects-sub">
          A project owns its recordings and its agent key. Runs land in the project whose key the
          payload carries.
        </span>
      </div>

      <div className="projects-new">
        <input
          value={making}
          placeholder="New project name"
          spellCheck={false}
          onChange={(e) => setMaking(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && make()}
        />
        <button className="detail-link" disabled={!making.trim()} onClick={make}>
          create
        </button>
      </div>

      {order.length === 0 ? (
        <div className="projects-empty">
          You have no projects. Make one, and the snippets in the Agent tab will carry its key.
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
  sessions,
  purgeDays,
}: {
  project: Project;
  mine: boolean;
  home: boolean;
  selected: boolean;
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

  return (
    <div className={`project${selected ? ' selected' : ''}${trashed ? ' trashed' : ''}`}>
      <div className="project-top">
        {mine ? (
          <input
            className="project-name"
            value={name}
            spellCheck={false}
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== project.name && renameProject(project.id, name)}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
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
          <span className="project-tag bad" title={`Moved to the trash on ${new Date(project.trashedAt!).toLocaleString()}`}>
            {purgeNote(project.trashedAt, purgeDays) ?? 'in the trash'}
          </span>
        )}
        <div className="project-spacer" />
        <span className="project-count">
          {sessions} {sessions === 1 ? 'recording' : 'recordings'}
        </span>
        {!selected && (
          <button className="detail-link" onClick={() => (selectProject(project.id), navigateToView('sessions'))}>
            open
          </button>
        )}
      </div>

      <div className="project-key">
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
        <div className="project-actions">
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
    <div className="project-confirm">
      <span>{what}</span>
      <input
        autoFocus
        value={typed}
        placeholder={name}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && enabled) onGo();
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
