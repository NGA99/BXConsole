/**
 * What the Console's gear menu holds, and where it is kept.
 *
 * Its own file because the rows take it too: a row decides whether to draw a
 * timestamp from the same object the menu writes, and the panel was the only
 * thing that could name the type.
 */
export interface Settings {
  timestamps: boolean;
  groupSimilar: boolean;
  /** hide the "GET url 404" rows derived from network events */
  hideNetwork: boolean;
  /** preview the prompt's value while typing (side-effect-free expressions only) */
  eagerEval: boolean;
}

export const SETTINGS_KEY = 'bxconsole.console.settings';

export function loadSettings(): Settings {
  const defaults: Settings = { timestamps: false, groupSimilar: true, hideNetwork: false, eagerEval: true };
  try {
    return { ...defaults, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>) };
  } catch {
    return defaults;
  }
}
