/** Parse V8 / SpiderMonkey stack strings into frames for the UI. */

export interface Frame {
  fn: string;
  url: string;
  line: number;
  col: number;
  raw: string;
}

// "    at fn (http://h/a.js:1:2)" | "    at http://h/a.js:1:2" | "fn@http://h/a.js:1:2"
const V8 = /^\s*at\s+(?:async\s+)?(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/;
const SM = /^(.*?)@(.+?):(\d+):(\d+)\s*$/;

export function parseStack(stack: string | undefined): Frame[] {
  // A stack is whatever the page put in the field. Anything but a string used
  // to throw here, out of the render of every row that shows a stack.
  if (!stack || typeof stack !== 'string') return [];
  const frames: Frame[] = [];
  for (const raw of stack.split('\n')) {
    if (!raw.trim() || /^\w*Error\b/.test(raw.trim()) && !raw.includes('@') && !/^\s*at\s/.test(raw)) continue;
    const m = V8.exec(raw) ?? SM.exec(raw);
    if (!m) {
      frames.push({ fn: '', url: raw.trim(), line: 0, col: 0, raw });
      continue;
    }
    frames.push({ fn: (m[1] ?? '').trim(), url: m[2]!, line: Number(m[3]), col: Number(m[4]), raw });
  }
  return frames;
}

/** "a.js:12" for the right-hand source link. */
export function shortLocation(frame: Frame | undefined): string {
  if (!frame) return '';
  const file = frame.url.split('?')[0]!.split('/').filter(Boolean).pop() ?? frame.url;
  return frame.line ? `${file}:${frame.line}` : file;
}
