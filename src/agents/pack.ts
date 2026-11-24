import { sha256Hex } from "../core/hash";
import type { Marking, PackItem, Where } from "../core/types";
import { isMarking, MARKINGS, strictest } from "../core/types";
import type { PackPart } from "./context";

export const CHARS_PER_TOKEN = 3;
export const PACK_SHARE = 0.5;

export interface Pack { parts: PackPart[]; items: PackItem[]; left_out: PackItem[]; chars: number; budget: number; marking: Marking }

/** Characters of context a pack may use: half the model's context, at three characters a token. */
export function packBudget(contextTokens: number): number {
  return Math.floor(contextTokens * PACK_SHARE) * CHARS_PER_TOKEN;
}

const itemOf = (p: PackPart): PackItem => ({ kind: p.kind, id: p.id, title: p.title, hash: sha256Hex(p.text), chars: p.text.length, fixed: p.fixed });

/** True when a limit is set and the marking is stricter than it. A marking that is not one of MARKINGS is the strictest. */
export function tooStrict(marking: Marking | null, max: Marking | null): boolean {
  if (max === null || marking === null) return false;
  const rank = isMarking(marking) ? MARKINGS.indexOf(marking) : MARKINGS.length - 1;
  return rank > MARKINGS.indexOf(max);
}

/**
 * Takes parts in the order given, which is their priority. Fixed parts always go in (or there is no pack); the others go in
 * while they fit and while no limit forbids them. The pack's marking is the strictest of the case and what went in.
 */
export function assemblePack(parts: PackPart[], opts: { budget: number; case_marking: Marking; max_marking: Marking | null }): Pack | { too_big: PackItem[] } {
  const fixedParts = parts.filter((p) => p.fixed);
  const fixedChars = fixedParts.reduce((n, p) => n + p.text.length, 0);
  if (fixedChars > opts.budget) return { too_big: fixedParts.map(itemOf) };
  let room = opts.budget - fixedChars;
  const went: PackPart[] = [];
  const items: PackItem[] = [];
  const left_out: PackItem[] = [];
  for (const p of parts) {
    const item = itemOf(p);
    if (p.fixed) {
      went.push(p);
      items.push(item);
    } else if (!tooStrict(p.marking, opts.max_marking) && item.chars <= room) {
      room -= item.chars;
      went.push(p);
      items.push(item);
    } else {
      left_out.push(item);
    }
  }
  const marking = strictest(opts.case_marking, ...went.filter((p) => p.marking !== null).map((p) => p.marking));
  return { parts: went, items, left_out, chars: items.reduce((n, i) => n + i.chars, 0), budget: opts.budget, marking };
}

export function renderPack(pack: Pack): string {
  const blocks = pack.parts.map((p) => `## ${p.title}\n${p.text}`);
  if (pack.left_out.length > 0) blocks.push(`Left out of this turn: ${pack.left_out.map((i) => i.title).join(", ")}`);
  return blocks.join("\n\n");
}

/** Whether a call carrying this marking may go to a model at `where`. A marking the policy does not list may go nowhere. */
export function mayGo(marking: Marking, where: Where, policy: Record<Marking, Where[]>): boolean {
  return Object.hasOwn(policy, marking) && policy[marking].includes(where);
}
