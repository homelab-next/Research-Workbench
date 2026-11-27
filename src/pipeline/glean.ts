// What the values the workbench extracted open up (slice 9 goal 3): listed by code, for the planner; the model only chooses which to follow.
import type { CaseState } from "../core/state";
import { subgoalAnswered } from "../core/state";
import { gapsText, playbookGaps } from "../core/state/gaps";
import type { Entry, Marking } from "../core/types";
import { strictest } from "../core/types";
import { packPart } from "../agents/context";
import type { PackPart } from "../agents/context";
import type { Registry } from "../modules/registry";
import type { Seeker, SeekLimits } from "../modules/seeker";
import { catalogueOf } from "pivot/catalogue/views";

/** The start of a research stage's reason when it sends the work back to Plan for new values; the per-run cap counts these. */
export const GLEAN_PREFIX = "New values open routes to open goals";
/** At most this many such send-backs in one run, unless the configuration's glean.max_sendbacks says otherwise. */
export const DEFAULT_GLEAN_SENDBACKS = 2;
/** The planner's part lists at most this many values, ranked; the rest are counted by card. */
export const GLEAN_LIST_MAX = 20;
/** A send-back's reason names at most this many values; the rest are counted. */
export const GLEAN_REASON_MAX = 3;

/** A pivot that starts from a value's type: its id and title, what it costs and what it reveals. */
export interface Lead { pivot: string; title: string; cost: string; reveals: string }
/** An open sub-goal of the plan a value bears on: the type it wants, and the first route the route finder offers from the value's type with its weight. */
export interface Bears { subgoal: string; title: string; want: string; route: string[]; weight: number }
/**
 * A value an extract rule gave, with what it opens up. `fresh`: first given on a card made since the last accepted plan (only a fresh value
 * sends work back); `visited`: a query has already been bound to it; `covered`: an accepted step of the plan starts from it.
 */
export interface Opening {
  type: string; value: string; card: string; rule: string; column: string; marking: Marking;
  leads: Lead[]; bears: Bears[]; visited: boolean; covered: boolean; fresh: boolean;
}

const key = (type: string, value: string): string => `${type}|${value}`;

/** The seq of the latest plan.accepted entry; null when no plan was ever accepted. */
export function lastAccepted(entries: readonly Entry[]): number | null {
  let at: number | null = null;
  for (const e of entries) if (e.type === "plan.accepted") at = e.seq;
  return at;
}

/** Each pivot whose `from` is the type, in catalogue order, as the catalogue shows it (text from an untrusted root withheld). */
function leadsOf(registry: Registry, type: string): Lead[] {
  return catalogueOf(registry).pivots.filter((p) => p.from === type).map((p) => {
    const notes = p.columns.filter((c) => c.reveals !== "").map((c) => `Its ${c.name} reveals: ${c.reveals}`);
    const reveals = [p.answers !== "" ? p.answers : p.title, `Finds ${p.to}.`, ...notes].join(" ");
    return { pivot: p.id, title: p.title, cost: p.free ? "free" : `costly (${p.weight} ${p.unit})`, reveals };
  });
}

/**
 * What the extracted values open up, in the order their cards were made; null when no plan was ever accepted (the first Plan pass has
 * nothing to glean). Listed: each value first given on a card made since the last accepted plan (fresh), and each value from an earlier card
 * that no query has been bound to yet (offered again). A starting value and a discarded card's values are never listed. The open sub-goals
 * are those of the current plan its steps have not answered; each wants the type its last step finds.
 */
export function gleanOf(state: Readonly<CaseState>, entries: readonly Entry[], deps: { registry: Registry; seeker: Seeker }, limits: SeekLimits): { since: number; openings: Opening[] } | null {
  const since = lastAccepted(entries);
  if (since === null) return null;
  const known = new Set((state.meta?.starting ?? []).map((o) => key(o.type, o.value)));
  const cards = Object.values(state.cards).sort((a, b) => a.created_seq - b.created_seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const plan = state.plan.current;
  const accepted = plan === null ? [] : plan.steps.filter((st) => state.plan.accepted_steps.includes(st.id));
  const open = plan === null ? [] : plan.subgoals.filter((g) => !subgoalAnswered(state, g)).flatMap((g) => {
    const last = plan.steps.find((st) => st.id === g.steps[g.steps.length - 1]);
    return last === undefined ? [] : [{ subgoal: g.id, title: g.title, want: last.to }];
  });
  const values = new Set(Object.values(state.queries).flatMap((q) => (q.value === null ? [] : [q.value])));
  const openings: Opening[] = [];
  for (const c of cards) {
    if (c.place === "discarded") continue;
    const fresh = c.created_seq > since;
    for (const x of c.extracted ?? []) {
      if (known.has(key(x.type, x.value))) continue;
      known.add(key(x.type, x.value));
      const visited = values.has(x.value);
      // a value from before the plan was accepted is offered again only while nothing has looked it up
      if (!fresh && visited) continue;
      const bears: Bears[] = open.flatMap((g) => {
        const route = deps.seeker.routes([x.type], g.want, limits)[0];
        return route === undefined ? [] : [{ ...g, route: route.hops.map((h) => h.pivot), weight: route.weight }];
      });
      const covered = accepted.some((st) => (st.from.type === x.type && st.from.value === x.value) || (st.playbook?.inputs ?? []).some((i) => i.type === x.type && i.value === x.value));
      openings.push({
        type: x.type, value: x.value, card: c.id, rule: x.rule, column: x.column, marking: c.marking,
        leads: leadsOf(deps.registry, x.type), bears, visited, covered, fresh,
      });
    }
  }
  return { since, openings };
}

/** The cheapest route an opening offers to an open sub-goal; Infinity when it bears on none. */
const cheapest = (o: Opening): number => o.bears.reduce((m, b) => Math.min(m, b.weight), Infinity);
const rankOf = (o: Opening): number[] => [o.visited ? 1 : 0, o.bears.length > 0 ? 0 : 1, cheapest(o), o.fresh ? 0 : 1];

/** The openings best worth the planner's look first: not yet looked up, then reaching an open sub-goal, then by the cheapest route, then new; otherwise in card order. */
export function rankOpenings(openings: readonly Opening[]): Opening[] {
  return openings.map((o, i) => ({ o, i, r: rankOf(o) }))
    .sort((a, b) => { for (let k = 0; k < a.r.length; k++) if (a.r[k] !== b.r[k]) return a.r[k]! < b.r[k]! ? -1 : 1; return a.i - b.i; })
    .map((x) => x.o);
}

/** "card c1" or "cards c1, c4": the cards the values left out came from, in rank order; at most five are named. */
function onCards(openings: readonly Opening[]): string {
  const cards = [...new Set(openings.map((o) => o.card))];
  const named = cards.slice(0, 5).join(", ");
  return cards.length === 1 ? `card ${named}` : `cards ${named}${cards.length > 5 ? ` and ${cards.length - 5} others` : ""}`;
}

/**
 * The part's text: at most GLEAN_LIST_MAX values, ranked, grouped by type with the pivots from each type stated once, each with the open
 * sub-goals it bears on; then how many more values there are, and on which cards.
 */
export function gleanText(openings: readonly Opening[]): string {
  const ranked = rankOpenings(openings);
  const shown = ranked.slice(0, GLEAN_LIST_MAX);
  const rest = ranked.slice(GLEAN_LIST_MAX);
  const lines = [
    "Values the workbench extracted from the cells of cards (by code, from the sources' field notes): those new since the plan was last accepted, and earlier ones not yet looked up.",
    `Each is listed under its type, with the pivots that start from that type and the open sub-goals it opens a route to; at most ${GLEAN_LIST_MAX}, those not looked up and reaching an open sub-goal by the cheapest route first. Choose which, if any, to follow: a sub-goal may start from one of them (give it in \`have\`).`,
  ];
  const types = [...new Set(shown.map((o) => o.type))];
  for (const type of types) {
    const group = shown.filter((o) => o.type === type);
    const leads = group[0]!.leads;
    lines.push(`Type ${type}:`);
    if (leads.length === 0) lines.push(`  no pivot starts from ${type}`);
    else lines.push(`  pivots from ${type}: ${leads.map((l) => `${l.pivot} (${l.cost}): ${l.reveals}`).join("; ")}`);
    for (const o of group) {
      lines.push(`- ${o.type} ${o.value} (card ${o.card}, rule ${o.rule} on column ${o.column}; code-derived)`);
      if (!o.fresh) lines.push("  offered before, not yet looked up");
      if (o.visited) lines.push("  already looked up in this case");
      if (o.covered) lines.push("  an accepted step already starts from it");
      if (o.bears.length === 0) lines.push("  bears on no open sub-goal");
      for (const b of o.bears) lines.push(`  bears on: ${b.subgoal} "${b.title}" (wants ${b.want}) by ${b.route.join(", ")}`);
    }
  }
  if (rest.length > 0) lines.push(`and ${rest.length} more ${rest.length === 1 ? "value" : "values"} on ${onCards(rest)}, not listed`);
  return lines.join("\n");
}

/**
 * The planner's part "What the new values open up", or null when there is nothing to list (or no plan was ever accepted). It is as strict as
 * the cards the listed values came from and as the planner's requests that wrote the sub-goal titles it quotes.
 */
export function gleanPart(state: Readonly<CaseState>, entries: readonly Entry[], deps: { registry: Registry; seeker: Seeker }, limits: SeekLimits, planRequests: readonly Entry[]): PackPart | null {
  const g = gleanOf(state, entries, deps, limits);
  if (g === null || g.openings.length === 0) return null;
  const shown = rankOpenings(g.openings).slice(0, GLEAN_LIST_MAX);
  return packPart({
    kind: "glean", id: "glean", title: "What the new values open up", text: gleanText(g.openings), fixed: false,
    entries, written_by: planRequests, floor: strictest(...shown.map((o) => o.marking)),
  });
}

/** The values a research stage sends back for: new since the plan was accepted, not yet looked up, no accepted step starts from them, and a route to an open sub-goal; ranked. */
export function followable(openings: readonly Opening[]): Opening[] {
  return rankOpenings(openings.filter((o) => o.fresh && !o.visited && !o.covered && o.bears.length > 0));
}

/**
 * The reason a research stage sends the work back to Plan, or null when it does not: no value is followable, or the stage has already sent
 * back for new values `cap` times in this run (counted from its stage.finished entries whose reason starts with GLEAN_PREFIX). It names at
 * most GLEAN_REASON_MAX values, the best ranked, and counts the rest.
 */
export function gleanSendBack(state: Readonly<CaseState>, entries: readonly Entry[], openings: readonly Opening[], opts: { cap: number; stage: string }): string | null {
  const follow = followable(openings);
  if (follow.length === 0) return null;
  const run = state.run.id;
  const sent = entries.filter((e) => e.type === "stage.finished" && e.run === run && e.payload.stage === opts.stage && e.payload.outcome === "fail"
    && typeof e.payload.reason === "string" && e.payload.reason.startsWith(GLEAN_PREFIX)).length;
  if (sent >= opts.cap) return null;
  const named = follow.slice(0, GLEAN_REASON_MAX);
  const more = follow.length - named.length;
  const each = named.map((o) => `${o.type} ${o.value} (card ${o.card}) opens ${o.bears.map((b) => `${b.route.join(", ")} to ${b.subgoal} "${b.title}" (wants ${b.want})`).join(" and ")}`);
  const them = follow.length === 1 ? "it" : "them";
  return `${GLEAN_PREFIX}: ${each.join("; ")}${more > 0 ? `; and ${more} more on ${onCards(follow.slice(GLEAN_REASON_MAX))}` : ""}, and no accepted step starts from ${them}. Re-plan to follow ${them}, or leave ${them}.`;
}

/**
 * The planner's part "What the playbooks would also have fetched" (goal 5): for an accepted plan whose single pivots cover only part of a
 * playbook for the same start type, the lookups the playbook would also have made; null when there is none, or no plan is accepted. Titles
 * are the catalogue's (withheld from an untrusted root); the part is as strict as the plan.proposed that chose the pivots.
 */
export function gapsPart(state: Readonly<CaseState>, entries: readonly Entry[], registry: Registry): PackPart | null {
  const plan = state.plan.current;
  if (plan === null || (state.plan.status !== "accepted" && state.plan.status !== "replanning")) return null;
  const cat = catalogueOf(registry);
  const gaps = playbookGaps(plan, state.plan.accepted_steps.length > 0 ? state.plan.accepted_steps : null, cat.playbooks, cat.pivots);
  if (gaps.length === 0) return null;
  const proposed = [...entries].reverse().find((e) => e.type === "plan.proposed");
  const text = [
    "The accepted plan runs some of a playbook's lookups as single pivots. A playbook runs all of its lookups in code; these were left out:",
    gapsText(gaps),
    "Plan the playbook itself (give its id as \"playbook\") where what it would also have fetched bears on the question.",
  ].join("\n");
  return packPart({ kind: "playbook-gaps", id: "playbook-gaps", title: "What the playbooks would also have fetched", text, fixed: false, entries, written_by: proposed === undefined ? [] : [proposed], floor: null });
}
