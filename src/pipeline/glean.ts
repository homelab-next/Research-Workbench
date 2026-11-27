// What the values the workbench extracted open up (slice 9 goal 3): listed by code, for the planner; the model only chooses which to follow.
import type { CaseState } from "../core/state";
import { subgoalAnswered } from "../core/state";
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

/** A pivot that starts from a value's type: its id and title, what it costs and what it reveals. */
export interface Lead { pivot: string; title: string; cost: string; reveals: string }
/** An open sub-goal of the plan a value bears on: the type it wants and the first route the route finder offers from the value's type. */
export interface Bears { subgoal: string; title: string; want: string; route: string[] }
/**
 * A value an extract rule gave on a card made since the last accepted plan, with what it opens up. `visited`: a query has already been
 * bound to it; `covered`: an accepted step of the plan starts from it.
 */
export interface Opening {
  type: string; value: string; card: string; rule: string; column: string; marking: Marking;
  leads: Lead[]; bears: Bears[]; visited: boolean; covered: boolean;
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
 * What the extracted values new since the last accepted plan open up, in the order their cards were made; null when no plan was ever
 * accepted (the first Plan pass has nothing to glean). A value is new when no card made by then gave it and it is not a starting value.
 * The open sub-goals are those of the current plan its steps have not answered; each wants the type its last step finds.
 */
export function gleanOf(state: Readonly<CaseState>, entries: readonly Entry[], deps: { registry: Registry; seeker: Seeker }, limits: SeekLimits): { since: number; openings: Opening[] } | null {
  const since = lastAccepted(entries);
  if (since === null) return null;
  const known = new Set((state.meta?.starting ?? []).map((o) => key(o.type, o.value)));
  const cards = Object.values(state.cards).sort((a, b) => a.created_seq - b.created_seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const c of cards) if (c.created_seq <= since) for (const x of c.extracted ?? []) known.add(key(x.type, x.value));
  const plan = state.plan.current;
  const accepted = plan === null ? [] : plan.steps.filter((st) => state.plan.accepted_steps.includes(st.id));
  const open = plan === null ? [] : plan.subgoals.filter((g) => !subgoalAnswered(state, g)).flatMap((g) => {
    const last = plan.steps.find((st) => st.id === g.steps[g.steps.length - 1]);
    return last === undefined ? [] : [{ subgoal: g.id, title: g.title, want: last.to }];
  });
  const values = new Set(Object.values(state.queries).flatMap((q) => (q.value === null ? [] : [q.value])));
  const openings: Opening[] = [];
  for (const c of cards) {
    if (c.created_seq <= since || c.place === "discarded") continue;
    for (const x of c.extracted ?? []) {
      if (known.has(key(x.type, x.value))) continue;
      known.add(key(x.type, x.value));
      const bears: Bears[] = open.flatMap((g) => {
        const route = deps.seeker.routes([x.type], g.want, limits)[0];
        return route === undefined ? [] : [{ ...g, route: route.hops.map((h) => h.pivot) }];
      });
      const covered = accepted.some((st) => (st.from.type === x.type && st.from.value === x.value) || (st.playbook?.inputs ?? []).some((i) => i.type === x.type && i.value === x.value));
      openings.push({
        type: x.type, value: x.value, card: c.id, rule: x.rule, column: x.column, marking: c.marking,
        leads: leadsOf(deps.registry, x.type), bears, visited: values.has(x.value), covered,
      });
    }
  }
  return { since, openings };
}

/** The part's text: each value, the pivots from its type and the open sub-goals it bears on. */
export function gleanText(openings: readonly Opening[]): string {
  const lines = [
    "Values the workbench extracted from the cells of cards made since the plan was last accepted (by code, from the sources' field notes).",
    "Each is listed with the pivots that start from its type and the open sub-goals it opens a route to. Choose which, if any, to follow: a sub-goal may start from one of them (give it in `have`).",
  ];
  for (const o of openings) {
    lines.push(`- ${o.type} ${o.value} (card ${o.card}, rule ${o.rule} on column ${o.column}; code-derived)`);
    if (o.visited) lines.push("  already looked up in this case");
    if (o.covered) lines.push("  an accepted step already starts from it");
    if (o.leads.length === 0) lines.push(`  no pivot starts from ${o.type}`);
    else lines.push(`  pivots from ${o.type}: ${o.leads.map((l) => `${l.pivot} (${l.cost}): ${l.reveals}`).join("; ")}`);
    if (o.bears.length === 0) lines.push("  bears on no open sub-goal");
    for (const b of o.bears) lines.push(`  bears on: ${b.subgoal} "${b.title}" (wants ${b.want}) by ${b.route.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * The planner's part "What the new values open up", or null when nothing new was extracted since the last accepted plan (or none was ever
 * accepted). It is as strict as the cards the values came from and as the planner's requests that wrote the sub-goal titles it quotes.
 */
export function gleanPart(state: Readonly<CaseState>, entries: readonly Entry[], deps: { registry: Registry; seeker: Seeker }, limits: SeekLimits, planRequests: readonly Entry[]): PackPart | null {
  const g = gleanOf(state, entries, deps, limits);
  if (g === null || g.openings.length === 0) return null;
  return packPart({
    kind: "glean", id: "glean", title: "What the new values open up", text: gleanText(g.openings), fixed: false,
    entries, written_by: planRequests, floor: strictest(...g.openings.map((o) => o.marking)),
  });
}

/** The values a research stage sends back for: not yet looked up, no accepted step starts from them, and a route to an open sub-goal. */
export function followable(openings: readonly Opening[]): Opening[] {
  return openings.filter((o) => !o.visited && !o.covered && o.bears.length > 0);
}

/**
 * The reason a research stage sends the work back to Plan, or null when it does not: no value is followable, or the stage has already sent
 * back for new values `cap` times in this run (counted from its stage.finished entries whose reason starts with GLEAN_PREFIX).
 */
export function gleanSendBack(state: Readonly<CaseState>, entries: readonly Entry[], openings: readonly Opening[], opts: { cap: number; stage: string }): string | null {
  const follow = followable(openings);
  if (follow.length === 0) return null;
  const run = state.run.id;
  const sent = entries.filter((e) => e.type === "stage.finished" && e.run === run && e.payload.stage === opts.stage && e.payload.outcome === "fail"
    && typeof e.payload.reason === "string" && e.payload.reason.startsWith(GLEAN_PREFIX)).length;
  if (sent >= opts.cap) return null;
  const each = follow.map((o) => `${o.type} ${o.value} (card ${o.card}) opens ${o.bears.map((b) => `${b.route.join(", ")} to ${b.subgoal} "${b.title}" (wants ${b.want})`).join(" and ")}`);
  return `${GLEAN_PREFIX}: ${each.join("; ")}, and no accepted step starts from ${follow.length === 1 ? "it" : "them"}. Re-plan to follow ${follow.length === 1 ? "it" : "them"}, or leave ${follow.length === 1 ? "it" : "them"}.`;
}
