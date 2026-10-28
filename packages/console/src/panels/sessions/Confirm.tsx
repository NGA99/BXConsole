/**
 * The slowest confirmation there is: type the project's name.
 *
 * It guards the two things that cannot be taken back — deleting a project
 * with its recordings, and rotating a key, which kills every payload already
 * planted with the old one. A dialog you dismiss by clicking is answered by
 * reflex; a name you have to read off the thing in front of you is not.
 *
 * It lives here rather than in the Projects screen because rotating moved to
 * the Agent tab, where the key is handed out and the consequence can be
 * spelled out beside the snippets it belongs to.
 */
import { isEnterSubmit } from '../../devtools-ui/enter-key';
import './Confirm.css';

export function Confirm({
  what,
  name,
  typed,
  setTyped,
  enabled,
  action,
  onGo,
  onCancel,
}: {
  /** what is about to happen, and whose name to type */
  what: string;
  name: string;
  typed: string;
  setTyped: (v: string) => void;
  enabled: boolean;
  /** the button's words, which say the deed rather than "OK" */
  action: string;
  onGo: () => void;
  onCancel: () => void;
}) {
  return (
    // Typing a project's name to arm a rotate or a delete must not also walk
    // into the project, on a screen where the card around this is the way in.
    <div className="confirm" onClick={(e) => e.stopPropagation()}>
      <span>{what}</span>
      <input
        autoFocus
        value={typed}
        placeholder={name}
        spellCheck={false}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          // isEnterSubmit, not e.key: the Enter that commits an IME
          // composition would otherwise fire the deed while you are still
          // typing the name that arms it.
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
