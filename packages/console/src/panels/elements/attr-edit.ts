/**
 * Parsing what the user typed into the attribute editor.
 *
 * Its own module because it is the part worth testing: the editor accepts
 * `name`, `name=value` and `name="value"`, and a value may contain quotes of
 * its own — a JSON attribute is the normal case, not an exotic one.
 */
export interface AttributeEdit {
  name: string;
  value: string;
}

export function parseAttributeEdit(text: string): AttributeEdit | null {
  // A quoted value is taken whole, inner quotes and all; an unquoted one runs
  // to the first space. Taking the value as [^"]* used to cut `{"a":1}` down
  // to `{` and set the attribute to that, silently.
  const m = /^\s*([^\s=]+)(?:\s*=\s*(?:"([\s\S]*)"|'([\s\S]*)'|(\S*)))?\s*$/.exec(text);
  if (!m) return null;
  return { name: m[1]!, value: m[2] ?? m[3] ?? m[4] ?? '' };
}
