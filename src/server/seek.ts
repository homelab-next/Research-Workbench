import type { Json } from "../core/canonical";
import { Refused } from "../core/refused";
import type { Schema } from "../core/schema";
import type { CaseSession } from "../core/session";
import type { Actor, Observable, TimeWindow } from "../core/types";
import type { RouteView } from "../core/wire";
import { runPivot } from "../modules/pivots";
import { revalidateCard } from "../modules/revalidate";
import { runRoute } from "../modules/routes";
import type { RouteInput } from "../modules/routes";
import type { SeekLimits } from "../modules/seeker";
import type { EngineDeps } from "../pipeline/engine";
import { defineCommand } from "./commands";
import { shown } from "./views";

const str: Schema = { type: "string" };
const obj = (properties: Record<string, Schema>, required: string[] = Object.keys(properties)): Schema => ({ type: "object", properties, required, additionalProperties: false });
const text = (a: Record<string, Json>, key: string): string => a[key] as string;
const windowSchema: Schema = obj({ from: { type: ["string", "null"] }, to: { type: ["string", "null"] } });

const UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const isUtcMs = (x: unknown): x is string => typeof x === "string" && UTC_MS.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x;

/** The window as a TimeWindow, or what is wrong with it: each end null or a UTC time with milliseconds, the first not after the second. */
function windowOf(w: Json): TimeWindow {
  const { from, to } = w as { from: string | null; to: string | null };
  for (const [end, v] of [["from", from], ["to", to]] as const) {
    if (v !== null && !isUtcMs(v)) throw new Refused(`the window's ${end} must be empty or a UTC time like 2026-11-20T00:00:00.000Z`);
  }
  if (from !== null && to !== null && Date.parse(from) > Date.parse(to)) throw new Refused("the window's start is after its end");
  return { from, to };
}

const whyOf = (a: Record<string, Json>): string => {
  const why = text(a, "why").trim();
  if (why === "") throw new Refused("say why: a lookup is recorded with its reason");
  return why;
};

const typeKnown = (deps: EngineDeps, id: string): boolean => deps.runner.registry.types().some((t) => t.id === id);
const typeTitle = (deps: EngineDeps, id: string): string => deps.runner.registry.types().find((t) => t.id === id)?.title ?? id;

/** The routes the finder offers for a question, from the registry alone: no source is asked and nothing is written. The reasons it is refused, else. */
export function routesFor(deps: EngineDeps, query: URLSearchParams): RouteView[] | string[] {
  const have = query.getAll("have");
  const want = query.get("want");
  const reasons: string[] = [];
  if (have.length === 0) reasons.push("have is needed: the types of the values you start from");
  for (const t of have) if (!typeKnown(deps, t)) reasons.push(`unknown type ${JSON.stringify(t.slice(0, 40))}`);
  if (want === null || !typeKnown(deps, want)) reasons.push(`unknown type to reach ${JSON.stringify((want ?? "").slice(0, 40))}`);
  const rawWeight = query.get("max_weight");
  let maxWeight: number | null = null;
  if (rawWeight !== null && rawWeight !== "") {
    maxWeight = /^\d+(?:\.\d+)?$/.test(rawWeight) ? Number(rawWeight) : Number.NaN;
    if (!Number.isFinite(maxWeight)) reasons.push("max_weight must be a number, zero or more");
  }
  const unconfirmed = query.get("unconfirmed");
  if (unconfirmed !== null && unconfirmed !== "0" && unconfirmed !== "1") reasons.push("unconfirmed must be 0 or 1");
  if (reasons.length > 0) return reasons;
  const limits: SeekLimits = { max_weight: maxWeight, allow_unconfirmed: unconfirmed === "1", max_hops: 4 };
  const { registry } = deps.runner;
  return deps.seeker.routes(have, want!, limits).map((r): RouteView => ({
    weight: r.weight,
    hops: r.hops.map((h) => ({
      pivot: h.pivot, title: shown(deps, h.title), source: h.source, source_title: shown(deps, registry.source(h.source)?.title ?? h.source), from: h.from, to: h.to,
      free: h.free, weight: h.weight, unit: h.unit, needs_window: h.needs_window, empty_means: h.empty_means, confirmed: h.confirmed,
    })),
  }));
}

/** What the case would write to end a route: only if its job is still running, in one commit. */
function endRoute(session: CaseSession, actor: Actor, job: string, make: () => { route: RouteEnd | null }): void {
  if (session.state.jobs[job]?.status !== "running") return;
  const { route } = make();
  session.commit((s) => {
    if (s.jobs[job]?.status !== "running") return [];
    return [
      ...(route === null ? [] : [{ type: "route.finished" as const, actor, job, payload: { job, ...route } }]),
      { type: "job.finished" as const, actor, job, payload: { job, outcome: route === null ? ("failed" as const) : ("done" as const) } },
    ];
  });
}
type RouteEnd = { want: string; outcome: "answered" | "blocked"; reached: Observable[]; blocked: string[]; caveats: string[]; cards: string[] };

defineCommand("run_route", {
  args: obj({
    have: { type: "array", items: obj({ type: str, value: str }), minItems: 1 }, want: str, window: windowSchema, why: str,
    max_weight: { type: ["number", "null"] }, allow_unconfirmed: { type: "boolean" }, subgoal: str,
  }, ["have", "want", "window", "why", "max_weight", "allow_unconfirmed"]),
  then: "nothing",
  perform: ({ hub, session, deps, actor }, a) => {
    // everything that can be checked from the record and the registry is checked here, in the queue; the sources are asked afterwards
    const why = whyOf(a);
    const want = text(a, "want");
    if (!typeKnown(deps, want)) throw new Refused(`unknown type to reach: ${want.slice(0, 40)}`);
    const have = (a.have as { type: string; value: string }[]).map((o): Observable => ({ type: o.type, value: o.value }));
    for (const o of have) {
      if (!typeKnown(deps, o.type)) throw new Refused(`unknown type: ${o.type.slice(0, 40)}`);
      if (!deps.runner.observables.matches(o.type, o.value)) throw new Refused(`"${o.value.slice(0, 80)}" is not a ${o.type}`);
    }
    const window = windowOf(a.window as Json);
    const maxWeight = a.max_weight as number | null;
    if (maxWeight !== null && (!Number.isFinite(maxWeight) || maxWeight < 0)) throw new Refused("the cost limit must be a number, zero or more");
    const input: RouteInput = {
      have, want, window, why, actor,
      limits: { max_weight: maxWeight, allow_unconfirmed: a.allow_unconfirmed as boolean, max_hops: 4 },
      ...(a.subgoal === undefined ? {} : { subgoal: text(a, "subgoal") }),
    };
    let job = "";
    session.commit((_s, ids) => {
      job = ids.next("job");
      return [{ type: "job.started", actor, job, payload: { job, title: `Route to ${typeTitle(deps, want)} from ${have[0]!.value}`, kind: "query", source: null } }];
    });
    const mine: RouteInput = { ...input, job };
    hub.background((async () => {
      let found: RouteEnd | null = null;
      try {
        const r = await runRoute(session, deps.runner, deps.seeker, mine);
        found = { want, outcome: r.outcome, reached: r.reached, blocked: r.blocked, caveats: r.caveats, cards: r.cards };
      } finally {
        // the final commit looks at the case as it is now: a job that is no longer running is not written to again
        endRoute(session, actor, job, () => ({ route: found }));
      }
    })());
  },
});

defineCommand("run_pivot", {
  args: obj({ pivot: str, value: str, window: windowSchema, why: str, budget: { type: "number" }, subgoal: str }, ["pivot", "value", "window", "why"]),
  then: "nothing",
  // One lookup, waited for: the source is asked here, before the case's queue is entered, so nothing slow ever holds it.
  async prepare({ case: id, session, deps, hub }, a) {
    const why = whyOf(a);
    const budget = a.budget === undefined ? null : (a.budget as number);
    if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw new Refused("the budget must be a number above zero");
    hub.engine(id);                                  // recovers the case, once, before anything is written for it
    const r = await runPivot(session, deps.runner, {
      pivot: text(a, "pivot"), value: text(a, "value"), window: windowOf(a.window as Json), why, actor: { kind: "human", id: deps.config.user }, budget,
      ...(a.subgoal === undefined ? {} : { subgoal: text(a, "subgoal") }),
    });
    if (r.status === "refused") throw new Refused(r.reasons.join("; "), r.reasons);
    if (r.status === "needs_budget") {
      throw new Refused(r.estimate === null ? "this lookup is costly; give a budget" : `this lookup is costly: the estimate is ${r.estimate.amount} ${r.estimate.unit}; give a budget`);
    }
    return null;
  },
  perform: () => { /* a done or failed lookup is in the ledger already */ },
});

defineCommand("verify_card", {
  args: obj({ card: str, budget: { type: "number" } }, ["card"]), then: "nothing",
  perform: ({ hub, session, deps, actor }, a) => {
    const card = text(a, "card");
    if (!Object.hasOwn(session.state.cards, card)) throw new Refused(`unknown card: ${card.slice(0, 40)}`);
    const budget = a.budget === undefined ? null : (a.budget as number);
    if (budget !== null && (!Number.isFinite(budget) || budget <= 0)) throw new Refused("the budget must be a number above zero");
    // the re-run asks the source outside the queue; verify.run is written when it ends, whatever it found
    hub.background(revalidateCard(session, deps.runner, { card, actor, why: `verify card ${card}`, budget }).then(() => undefined, (error: unknown) => { if (!(error instanceof Refused)) throw error; }));
  },
});
