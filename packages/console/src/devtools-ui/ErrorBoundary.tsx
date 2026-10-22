/**
 * Keeps one panel's failure to itself.
 *
 * Every byte these panels render came from a page the operator does not
 * control, and an uncaught error in render unmounts the whole React tree —
 * so one unusable value used to leave the operator with a blank page and no
 * way back. A malformed `page.navigated` reaching the Sessions list, the
 * console's front page, locked them out of every session at once.
 *
 * The error is not swallowed: it goes to this page's own console with the
 * component stack, which is where it has to be to debug the panel.
 */
import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react';
import { describeError } from './error-text';
import './ErrorBoundary.css';

interface Props {
  /** what failed, named as the operator sees it: "Console", "the session list" */
  label: string;
  /** offered as a way out when there is somewhere better to go */
  onLeave?: { label: string; go: () => void };
  children: ReactNode;
}

interface State {
  error: unknown;
  /** bumped by "Try again" so the children remount rather than re-throwing from the same state */
  attempt: number;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[bxconsole] ${this.props.label} failed to render`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render(): ReactNode {
    const { error, attempt } = this.state;
    const { label, onLeave, children } = this.props;
    if (error === null) {
      // A keyed Fragment, not a wrapper element: the panels below size
      // themselves against their parent, and an extra div would change that.
      // The key is what makes "Try again" a real retry — without it React
      // keeps the subtree that threw, and its state with it.
      return <Fragment key={attempt}>{children}</Fragment>;
    }
    return (
      <div className="error-boundary">
        <div className="error-boundary-title">{label} stopped rendering</div>
        <div className="error-boundary-message mono">{describeError(error)}</div>
        <p className="error-boundary-note">
          Something in this session's data could not be displayed. The rest of the console still works, and the full error
          is in this page's own devtools console.
        </p>
        <div className="error-boundary-actions">
          <button className="error-boundary-button" onClick={this.retry}>
            Try again
          </button>
          {onLeave && (
            <button className="error-boundary-button" onClick={onLeave.go}>
              {onLeave.label}
            </button>
          )}
        </div>
      </div>
    );
  }
}
