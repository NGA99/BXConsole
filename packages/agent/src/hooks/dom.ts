/**
 * Elements tab support: edits on screen-tree nodes and style information.
 *
 * Matched rules are found by walking document.styleSheets and testing each
 * style rule's selector with Element.matches(); cross-origin sheets without
 * CORS cannot be read and are only counted. Cascade order (specificity, then
 * document order) is computed here so the UI can strike out overridden
 * declarations; !important is left to the UI since it is per declaration.
 */
import type { BoxModel, Declaration, ElementStyles, InheritedStyles, MatchedRule } from '@bxconsole/protocol';
import { nodeByScreenId, screenIdOf } from './screen';
import { compareSpec, specificity, splitSelectorList } from '../css-selectors';

const INHERITED = new Set([
  'color', 'cursor', 'direction', 'font', 'font-family', 'font-size', 'font-style', 'font-variant', 'font-weight',
  'letter-spacing', 'line-height', 'list-style', 'list-style-type', 'quotes', 'text-align', 'text-indent',
  'text-transform', 'visibility', 'white-space', 'word-spacing', 'word-break', 'overflow-wrap', 'tab-size',
  'text-shadow', 'caption-side', 'border-collapse', 'border-spacing', 'empty-cells',
]);
const MAX_INHERITED_ANCESTORS = 8;

/** Custom properties inherit as well, and no fixed list can name them. */
function inherits(name: string): boolean {
  return INHERITED.has(name) || name.startsWith('--');
}

export function domSetAttribute(id: number, name: string, value: string | null): void {
  const el = elementOf(id);
  if (!el) return;
  if (value === null) el.removeAttribute(name);
  else el.setAttribute(name, value);
}

export function domSetText(id: number, text: string): void {
  const n = nodeByScreenId(id);
  if (n && (n.nodeType === Node.TEXT_NODE || n.nodeType === Node.COMMENT_NODE)) n.nodeValue = text;
}

export function domRemoveNode(id: number): void {
  nodeByScreenId(id)?.parentNode?.removeChild(nodeByScreenId(id)!);
}

export function domScrollIntoView(id: number): void {
  elementOf(id)?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

export function domStyles(id: number): ElementStyles | null {
  const el = elementOf(id);
  if (!el) return null;
  const sheets = collectRules();
  const inherited: InheritedStyles[] = [];
  let depth = 0;
  for (let p = el.parentElement; p && depth < MAX_INHERITED_ANCESTORS; p = p.parentElement, depth++) {
    const rules = matchedRules(p, sheets.rules)
      .map((r) => ({ ...r, declarations: r.declarations.filter((d) => inherits(d.name)) }))
      .filter((r) => r.declarations.length);
    const inline = inlineDeclarations(p).filter((d) => inherits(d.name));
    if (rules.length || inline.length) {
      inherited.push({ from: label(p), fromId: screenIdOrNull(p), inline, rules });
    }
  }
  const cs = getComputedStyle(el);
  const computed: Array<[string, string]> = [];
  for (let i = 0; i < cs.length; i++) {
    const name = cs[i]!;
    computed.push([name, cs.getPropertyValue(name)]);
  }
  return {
    inline: inlineDeclarations(el),
    rules: matchedRules(el, sheets.rules),
    inherited,
    computed,
    box: boxModel(cs),
    unreadableSheets: sheets.unreadable,
  };
}

// ------------------------------------------------------------------ helpers

function elementOf(id: number): Element | null {
  const n = nodeByScreenId(id);
  return n && n.nodeType === Node.ELEMENT_NODE ? (n as Element) : null;
}

function screenIdOrNull(el: Element): number | null {
  return screenIdOf(el) ?? null;
}

function label(el: Element): string {
  const id = el.id ? `#${el.id}` : '';
  const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : '';
  return `${el.tagName.toLowerCase()}${id}${cls}`;
}

function inlineDeclarations(el: Element): Declaration[] {
  const style = (el as HTMLElement).style;
  if (!style) return [];
  const out: Declaration[] = [];
  for (let i = 0; i < style.length; i++) {
    const name = style[i]!;
    out.push({ name, value: style.getPropertyValue(name), important: style.getPropertyPriority(name) === 'important' });
  }
  return out;
}

interface IndexedRule {
  rule: CSSStyleRule;
  source: string;
  media?: string;
  order: number;
}

function collectRules(): { rules: IndexedRule[]; unreadable: number } {
  const rules: IndexedRule[] = [];
  let unreadable = 0;
  let order = 0;
  const sheets = Array.from(document.styleSheets);
  for (const sheet of sheets) {
    let list: CSSRuleList;
    try {
      list = sheet.cssRules;
    } catch {
      unreadable++;
      continue;
    }
    const owner = sheet.ownerNode as Element | null;
    const source = sheet.href ?? (owner?.tagName === 'STYLE' ? `<style>${owner.id ? '#' + owner.id : ''}` : 'stylesheet');
    const walk = (rulesList: CSSRuleList, media: string | undefined) => {
      for (const r of Array.from(rulesList)) {
        if (r instanceof CSSStyleRule) {
          rules.push({ rule: r, source, ...(media ? { media } : {}), order: order++ });
          // nested rules (CSS nesting)
          const nested = (r as CSSStyleRule & { cssRules?: CSSRuleList }).cssRules;
          if (nested && nested.length) walk(nested, media);
        } else if (r instanceof CSSMediaRule || r instanceof CSSSupportsRule) {
          // A rule inside a condition that does not hold right now does not
          // apply, so it has no business in the matched list — showing it made
          // the pane claim a phone's layout rules were styling a desktop page.
          if (!conditionHolds(r)) continue;
          const cond = `@${r instanceof CSSMediaRule ? 'media' : 'supports'} ${r.conditionText}`;
          walk(r.cssRules, media ? `${media} and ${cond}` : cond);
        } else if ('cssRules' in r && (r as CSSGroupingRule).cssRules) {
          walk((r as CSSGroupingRule).cssRules, media);
        }
      }
    };
    walk(list, undefined);
  }
  return { rules, unreadable };
}

/** Whether an @media / @supports block applies as the page stands. */
function conditionHolds(r: CSSMediaRule | CSSSupportsRule): boolean {
  try {
    if (r instanceof CSSMediaRule) {
      const text = r.media.mediaText;
      return !text || matchMedia(text).matches;
    }
    return CSS.supports(r.conditionText);
  } catch {
    // An unparseable condition is not a reason to hide the rules.
    return true;
  }
}

function matchedRules(el: Element, rules: IndexedRule[]): MatchedRule[] {
  const out: MatchedRule[] = [];
  for (const r of rules) {
    const part = matchingPart(el, r.rule.selectorText);
    if (part === null) continue;
    const declarations: Declaration[] = [];
    const st = r.rule.style;
    for (let i = 0; i < st.length; i++) {
      const name = st[i]!;
      declarations.push({ name, value: st.getPropertyValue(name), important: st.getPropertyPriority(name) === 'important' });
    }
    if (!declarations.length) continue;
    out.push({
      selector: r.rule.selectorText,
      source: r.source,
      ...(r.media ? { media: r.media } : {}),
      declarations,
      specificity: specificity(part),
      order: r.order,
    });
  }
  // Cascade: higher specificity first, then later rules first. The UI walks this order.
  return out.sort((a, b) => {
    for (let i = 0; i < 3; i++) if (a.specificity[i] !== b.specificity[i]) return b.specificity[i]! - a.specificity[i]!;
    return b.order - a.order;
  });
}

/** The most specific comma-separated part of the selector that matches the element, or null. */
function matchingPart(el: Element, selectorText: string): string | null {
  const parts = splitSelectorList(selectorText);
  let best: string | null = null;
  let bestSpec: [number, number, number] | null = null;
  for (const part of parts) {
    // Pseudo-elements never match the element itself; keep rules for ::before etc. out.
    if (/::|:(before|after|first-line|first-letter|selection|placeholder|marker)\b/.test(part)) continue;
    let ok = false;
    try {
      ok = el.matches(part);
    } catch {
      ok = false;
    }
    if (!ok) continue;
    const spec = specificity(part);
    if (!bestSpec || compareSpec(spec, bestSpec) > 0) {
      best = part;
      bestSpec = spec;
    }
  }
  return best;
}

function boxModel(cs: CSSStyleDeclaration): BoxModel {
  const px = (v: string) => Math.round(parseFloat(v) || 0);
  return {
    margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
    border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
    padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    width: px(cs.width),
    height: px(cs.height),
  };
}
