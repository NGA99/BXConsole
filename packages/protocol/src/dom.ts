/**
 * Elements tab. The tree itself comes from the Screen stream (snapshot +
 * mutations share node ids with these commands); this file covers what the
 * tab asks the page for on top of that: edits and style information.
 */

export interface Declaration {
  name: string;
  value: string;
  important: boolean;
}

export interface MatchedRule {
  /** full selector text of the rule */
  selector: string;
  /** stylesheet href, or a label for inline <style> / user agent */
  source: string;
  /** enclosing @media / @supports condition, if any */
  media?: string;
  declarations: Declaration[];
  /** [ids, classes+attrs+pseudo-classes, elements] of the part that matched */
  specificity: [number, number, number];
  /** document order of the rule, for cascade ties */
  order: number;
}

export interface InheritedStyles {
  /** selector-ish label of the ancestor: div#app.main */
  from: string;
  fromId: number | null;
  inline: Declaration[];
  rules: MatchedRule[];
}

export interface BoxModel {
  margin: [number, number, number, number];
  border: [number, number, number, number];
  padding: [number, number, number, number];
  /** content box */
  width: number;
  height: number;
}

export interface ElementStyles {
  inline: Declaration[];
  rules: MatchedRule[];
  inherited: InheritedStyles[];
  computed: Array<[string, string]>;
  box: BoxModel;
  /** stylesheets we could not read (cross-origin without CORS) */
  unreadableSheets: number;
}
