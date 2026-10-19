/**
 * The script every payload that asks for it runs at install.
 *
 * It lives on the relay rather than in the snippet for two reasons: a payload
 * planted in a stored sink may not fire for weeks, so being able to change
 * what it does after planting is most of the value; and JS inside an
 * `<img onerror>` attribute is a quoting problem nobody needs.
 *
 * One script, shared by every payload that opts in — so what is typed here is
 * worth reading twice. It runs in someone else's browser.
 */
import { useEffect, useState } from "react";
import { PRE_PAYLOAD_MAX_BYTES } from "@bxconsole/protocol";

type Saved =
  | { state: "idle" }
  | { state: "saving" }
  | { state: "saved"; bytes: number }
  | { state: "failed"; why: string };

export function PrePayloadEditor({ armed }: { armed: boolean }) {
  const [source, setSource] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState<Saved>({ state: "idle" });

  useEffect(() => {
    let live = true;
    void fetch("/pre-payload")
      .then((r) => (r.ok ? r.json() : { source: "" }))
      .then((d: { source?: string }) => {
        if (!live) return;
        setSource(d.source ?? "");
        setLoaded(true);
      })
      .catch(() => live && setLoaded(true));
    return () => {
      live = false;
    };
  }, []);

  const save = async () => {
    setSaved({ state: "saving" });
    try {
      const res = await fetch("/pre-payload", { method: "PUT", body: source });
      if (!res.ok) return setSaved({ state: "failed", why: await res.text() });
      const { bytes } = (await res.json()) as { bytes: number };
      setSaved({ state: "saved", bytes });
    } catch (err) {
      setSaved({
        state: "failed",
        why: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const bytes = new TextEncoder().encode(source).length;
  const tooLong = bytes > PRE_PAYLOAD_MAX_BYTES;

  return (
    <div className="prepayload">
      <div className="install-snippet-head">
        <span>Primer script</span>
        <span className="install-source-meta">
          {bytes} / {PRE_PAYLOAD_MAX_BYTES} B
        </span>
        <div className="install-head-spacer" />
        <button
          className="detail-link"
          onClick={() => void save()}
          disabled={!loaded || tooLong || saved.state === "saving"}
        >
          {saved.state === "saving" ? "saving…" : "save"}
        </button>
      </div>
      <textarea
        className="prepayload-code mono"
        spellCheck={false}
        placeholder={loaded ? "document.cookie" : "loading…"}
        value={source}
        onChange={(e) => {
          setSource(e.target.value);
          setSaved({ state: "idle" });
        }}
      />
      <div className="install-hint">
        {tooLong ? (
          <strong>
            Too long — it travels inline with every agent.js request that asks
            for it.
          </strong>
        ) : saved.state === "failed" ? (
          <strong>Could not save: {saved.why}</strong>
        ) : saved.state === "saved" ? (
          saved.bytes > 0 ? (
            <>Saved. The next agent whose payload asks for it will run this.</>
          ) : (
            <>Cleared. No agent will receive a primer.</>
          )
        ) : (
          <>
            {armed ? (
              <>
                The value of the last expression is marked into History. Saving
                replaces it for <strong>every</strong> payload that asks —
                including ones already planted, which is the point and also the
                risk.
              </>
            ) : (
              /* The box stays so a script can be written and kept, but with
                 Primer off no payload asks for it, and an editor that looks
                 live while nothing runs it is the worse of the two. */
              <>
                Saved and kept, but <strong>Primer is off</strong>, so no
                payload asks for it. Snippets copied now will not run this.
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
