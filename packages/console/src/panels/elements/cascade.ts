/**
 * Which declaration wins for each property, over the rules in cascade order
 * (element.style first, then matched rules as the agent sorted them, then
 * inherited blocks). `!important` beats everything else; among important
 * declarations the first in cascade order wins. Within one block the last
 * declaration of a property wins, as CSS has it.
 */
import type { Declaration, ElementStyles } from '@bxconsole/protocol';

export interface DeclRef {
  /** 'inline' | rule index | `inherited:${i}:inline` | `inherited:${i}:${j}` */
  block: string;
  index: number;
}

export function computeWinners(styles: ElementStyles): Map<string, DeclRef> {
  const blocks: Array<{ key: string; decls: Declaration[] }> = [
    { key: 'inline', decls: styles.inline },
    ...styles.rules.map((r, i) => ({ key: String(i), decls: r.declarations })),
    ...styles.inherited.flatMap((inh, i) => [
      { key: `inherited:${i}:inline`, decls: inh.inline },
      ...inh.rules.map((r, j) => ({ key: `inherited:${i}:${j}`, decls: r.declarations })),
    ]),
  ];
  const winners = new Map<string, DeclRef>();
  const importantSeen = new Set<string>();
  // Inherited blocks only apply to properties the element itself does not set.
  for (const b of blocks) {
    const inherited = b.key.startsWith('inherited');
    // Within one block CSS takes the last declaration of a property, not the
    // first: `color: red; color: blue` is blue. Earlier copies are struck out
    // like any other loser.
    const last = new Map<string, number>();
    b.decls.forEach((d, index) => last.set(d.name, index));
    b.decls.forEach((d, index) => {
      if (last.get(d.name) !== index) return;
      const existing = winners.get(d.name);
      if (d.important && !inherited) {
        if (!importantSeen.has(d.name)) {
          importantSeen.add(d.name);
          winners.set(d.name, { block: b.key, index });
        }
        return;
      }
      if (!existing) winners.set(d.name, { block: b.key, index });
    });
  }
  return winners;
}

export function isWinner(winners: Map<string, DeclRef>, block: string, index: number, name: string): boolean {
  const w = winners.get(name);
  return !!w && w.block === block && w.index === index;
}
