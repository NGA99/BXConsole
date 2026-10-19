/** Rendered frames of a stack: `fn @ file.js:12` rows, URLs clickable. */
import { parseStack, shortLocation } from './stack';
import { SourceLink } from '../../devtools-ui/SourceLink';

export function StackTrace({ stack }: { stack: string | undefined }) {
  const frames = parseStack(stack);
  if (!frames.length) return null;
  return (
    <div className="stack-trace">
      {frames.map((f, i) => (
        <div key={i} className="stack-frame">
          <span className="stack-fn">{f.fn || '(anonymous)'}</span>
          <span className="stack-at"> @ </span>
          <SourceLink className="stack-link" url={f.url} line={f.line} col={f.col} title={f.raw.trim()}>
            {shortLocation(f)}
          </SourceLink>
        </div>
      ))}
    </div>
  );
}
