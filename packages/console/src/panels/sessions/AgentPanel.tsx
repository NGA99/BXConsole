/**
 * Agent tab: the agent's options, the ways to put it into a page, and its
 * source. Everything points at the relay this console is served from.
 *
 * The choices and the snippets they produce live in agent-setup.ts, which has
 * no React in it and can therefore be tested; this file is the controls.
 */
import { useState } from "react";
import { useSnippetProject } from "../../state/projects";
import { rotateProjectKey } from "../../transport/client";
import { copyText } from "../network/copy";
import { AgentSource } from "./AgentSource";
import { PrePayloadEditor } from "./PrePayloadEditor";
import { Confirm } from "./Confirm";
import {
  loadSetup,
  saveSetup,
  snippetsFor,
  type Options,
  type Setup,
} from "./agent-setup";

const OPTION_TEXT: Array<{
  key: keyof Options;
  name: string;
  label: string;
  hint: string;
}> = [
  {
    key: "record",
    // A flight recorder: it runs whether or not anyone is watching, which is
    // the whole difference from the default.
    name: "Blackbox",
    label: "Record the screen from boot",
    hint: "History can replay any moment of the run, at the cost of CPU in the page throughout. Off, it records only while a Screen tab is open.",
  },
  {
    key: "bodies",
    // The contents, not just the envelope. "Bodies" alone reads as a riddle.
    name: "Payloads",
    label: "Capture request and response bodies",
    hint: "Off, Network keeps headers and timing but no contents, which is what you want on a page that moves large or sensitive data.",
  },
  {
    key: "adopt",
    // It spreads by contact: a window this one touches catches the agent.
    name: "Spread",
    label: "Follow the run into other windows",
    hint: "Installs into the windows this page opens and the one that opened it, so a flow across several windows is one session.",
  },
  {
    key: "collect",
    // It gathers the page's files in and keeps them, which is what a magpie
    // is for. The alternative names all described the mechanism instead.
    name: "Magpie",
    label: "Keep the code the page loads",
    hint: "Fetches each script, stylesheet and document as the page loads it, so they are still readable after the run ends, when they can no longer be fetched. Only what the browser already loaded, never an API call.",
  },
  {
    key: "frame",
    // The app sits inside a frame the agent owns. Not "shell": in a tool for
    // programmers that word is a command line before it is anything else.
    name: "Nest",
    label: "Host the page in an iframe",
    hint: "Off by default. Puts the app one level down, in a frame the agent keeps, so navigating no longer ends the run. It changes the page: window.top is not the app, frame-busting code undoes it, and the address bar keeps the first URL. A page that refuses framing falls back to a single-document run rather than losing the session. Webhook says whether a page allows framing.",
  },
  {
    key: "pre",
    // It goes in before anyone is looking, which is the point of it.
    //
    // Last in the list, and not where it reads most naturally in prose: the
    // only option here that opens an editor should be the one the editor
    // appears under. Anywhere else and the script box turns up below two
    // unrelated checkboxes, with nothing saying which one put it there.
    name: "Primer",
    label: "Run a script the moment the agent lands",
    hint: "For the window that is gone before anyone can open a console to type into. It runs after the hooks, so what it fetches lands in Network with its body and what it logs lands in Console; what it returns is marked into History. The script lives on the relay, not in the payload.",
  },
];

export function AgentPanel({ onDiagnose }: { onDiagnose?: () => void }) {
  const [setup, setSetupState] = useState<Setup>(() => loadSetup());
  const [showSource, setShowSource] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Rotating is armed by typing the project's name; see Confirm for why.
  const [rotating, setRotating] = useState(false);
  const [typed, setTyped] = useState("");

  const setSetup = (patch: Partial<Setup>) => {
    setSetupState((prev) => {
      const next = { ...prev, ...patch };
      saveSetup(next);
      return next;
    });
  };

  const origin = location.origin;
  /*
   * The key comes from the project, not from the saved setup.
   *
   * Which project is not a choice yet, so this is the one a run would land
   * in — see useSnippetProject. Taken fresh each render, so a rotation is
   * picked up without a reload. With no project at all there is no key, and
   * the tab says so rather than handing out a payload that will be refused.
   */
  const project = useSnippetProject();
  const snippets = snippetsFor({ ...setup, key: project?.agentKey ?? "" }, origin);

  const copy = async (id: string, code: string) => {
    await copyText(code);
    setCopied(id);
    setTimeout(() => setCopied((c) => (c === id ? null : c)), 1200);
  };

  return (
    <div className="install">
      <div className="install-head">
        <span className="install-title">Install the agent</span>
        <label className="install-name">
          Session name{" "}
          <input
            className="field"
            value={setup.name}
            onChange={(e) => setSetup({ name: e.target.value })}
            spellCheck={false}
          />
        </label>
        <div className="install-head-spacer" />
        <button
          className="detail-link"
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? "hide source" : "view source"}
        </button>
      </div>

      {/*
        Two columns: what the agent will do on the left, what to paste on the
        right. They were stacked, which put the payload you came for below a
        screenful of checkboxes — and worse, hid the thing that makes the
        options worth reading, which is that every snippet changes as you tick
        them. Side by side, the change is in view while you make it.
      */}
      <div className="install-body">
        <div className="install-left">
          {/* The options are the agent's own; every snippet opposite follows them. */}
          <div className="install-options">
            {OPTION_TEXT.map(({ key, name, label, hint }) => (
              <label key={key} className="install-option">
                <input
                  type="checkbox"
                  checked={setup[key]}
                  onChange={(e) => setSetup({ [key]: e.target.checked })}
                />
                <span>
                  <span className="install-option-name">{name}</span>
                  <span className="install-option-label">{label}</span>
                  <span className="install-option-hint">{hint}</span>
                </span>
              </label>
            ))}
          </div>

          {/* Always here, whether or not Primer is on. A script worth writing
              is worth keeping while the option is off — it is stored on the
              relay either way, and hiding the box threw away what was typed
              in it the moment the checkbox was cleared. The editor says so
              itself when nothing is asking for it. */}
          <PrePayloadEditor armed={setup.pre} />
        </div>

        <div className="install-right">
          {showSource && <AgentSource origin={origin} />}
          {/*
            Where these runs end up.
            
            Worth a line of its own because the snippets carry a project key
            and nothing else here says which project it is for. The failure it
            heads off is the quiet one: a payload pasted for one engagement
            that records into another, or — with no project at all — one the
            relay refuses, in a browser nobody can reach.
          */}
          <div className={`install-lands${project ? "" : " bad"}`}>
            {project ? (
              <>
                Runs from these land in <strong>{project.name}</strong>.
              </>
            ) : (
              <>
                You have no project for these to record into, so the relay will refuse them. Make one
                first.
              </>
            )}
          </div>

          {/*
            * The key itself, and the one control that can change it.
            *
            * It was on the Projects screen, printed whole on every card, with
            * `rotate` beside it — a credential on a browsing screen and an
            * irreversible action repeated down a list. Here it sits with the
            * snippets that carry it, which is both where it is wanted and the
            * only place its consequence can be stated: rotating does not
            * change the payloads already out there, it stops them.
            */}
          {project && (
            <div className="install-key">
              <div className="install-key-row">
                <span className="install-key-label">Agent key</span>
                <code className="mono">{project.agentKey}</code>
                <button className="detail-link" title="Copy the whole key" onClick={() => void copy("key", project.agentKey)}>
                  {copied === "key" ? "copied" : "copy"}
                </button>
                {!rotating && (
                  <button className="detail-link" onClick={() => (setRotating(true), setTyped(""))}>
                    rotate
                  </button>
                )}
              </div>
              <p className="install-key-note">
                This is what tells the relay a run is <strong>{project.name}</strong>&rsquo;s; it is
                already in the snippets above. Rotate it when it has been seen — it ends up in the
                page you pasted it into, and in whatever logs that page&rsquo;s requests touch.
                Rotating draws a new one and <strong>every payload already planted with the old key
                stops recording</strong>, with no way to call them back. Recordings you already have
                are untouched.
              </p>
              {rotating && (
                <Confirm
                  what={`Every payload carrying the current key stops being recorded. Type “${project.name}” to draw a new one.`}
                  name={project.name}
                  typed={typed}
                  setTyped={setTyped}
                  enabled={typed.trim() === project.name.trim()}
                  action="rotate the key"
                  onGo={() => (rotateProjectKey(project.id), setRotating(false))}
                  onCancel={() => setRotating(false)}
                />
              )}
            </div>
          )}

          {snippets.map((s) => (
            <div key={s.id} className="install-snippet">
              <div className="install-snippet-head">
                <span>{s.title}</span>
                <button
                  className="detail-link"
                  onClick={() => void copy(s.id, s.code)}
                >
                  {copied === s.id ? "copied" : "copy"}
                </button>
              </div>
              <pre className="mono">{s.code}</pre>
              <div className="install-hint">{s.hint}</div>
            </div>
          ))}
          <div className="install-hint">
            A page on https needs the relay on https/wss too: put it behind a
            TLS proxy and set <code>PUBLIC_ORIGIN</code>. A strict CSP has to
            allow this origin in <code>script-src</code> and{" "}
            <code>connect-src</code>
            {onDiagnose ? (
              <>
                {" "}
                —{" "}
                <button className="detail-link" onClick={onDiagnose}>
                  Webhook
                </button>{" "}
                tells you which one a page blocks.
              </>
            ) : (
              "."
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
