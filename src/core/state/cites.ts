/**
 * A card named in text: `[c3]`, `[c3, c2]`, `[Card c3]` or a bare `c3`; only lower-case ids cite (`C3 traffic` does not). Check 6 (sample/checks/06-assumptions-and-judgments.ts)
 * runs alone as a program and cannot import this, so it spells the same pattern; a test holds the two together. Browser-safe: the interface reads citations with it too.
 */
export const CARD_REF = /(?<![\w])c\d+(?![\w])/g;

/** The card ids a text names, lower-cased, in the order they appear. */
export function cardRefs(text: string): string[] {
  return [...text.matchAll(CARD_REF)].map((m) => m[0].toLowerCase());
}
