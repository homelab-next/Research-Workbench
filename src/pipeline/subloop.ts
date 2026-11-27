// A sub-loop: what a parent case gives a child case of another loop, and what comes back. Pure: it reads states and writes nothing.
import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { IdAllocator } from "../core/ids";
import { Refused } from "../core/refused";
import { CARD_REF, cardFields, cardRefs, latestDraft } from "../core/state";
import type { CaseState, SubloopState } from "../core/state";
import { SECTIONS, strictest } from "../core/types";
import type { Card, Entry, EntryInput, Finding, Marking, Product, Section } from "../core/types";
import type { ChildLink, NewCase } from "../core/workbench";
import type { RunSummary } from "./engine";
import type { LoopInput, LoopOutput } from "./loops";
import { DEFAULT_LOOP } from "./loops";
import type { InputSelector, SubloopSpec } from "./manifests";

const ENGINE = { kind: "system", id: "engine" } as const;
/** The most of a finding's statement a returned card's title keeps. */
const TITLE_CHARS = 60;

const cardNumber = (id: string): number => Number.parseInt(id.slice(1), 10);
const byCardId = (a: Card, b: Card): number => cardNumber(a.id) - cardNumber(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** The cards a case keeps in its lanes, in card-id order (so the order they were kept in does not matter), as cardFields gives them. */
function keptCards(state: Readonly<CaseState>): Card[] {
  const out: Card[] = [];
  for (const lane of state.lanes) for (const id of lane.cards) if (Object.hasOwn(state.cards, id)) out.push(cardFields(state.cards[id]!));
  return out.sort(byCardId);
}

/** The latest published product of a case; null when none was published. */
function publishedProduct(state: Readonly<CaseState>): Product | null {
  const last = state.published.at(-1);
  if (last === undefined) return null;
  return state.drafts.findLast((d) => d.hash === last.draft_hash)?.product ?? null;
}

/** One selector's value from the parent's state; the reason when the parent cannot give it. */
function select(state: Readonly<CaseState>, sel: InputSelector): Json | { missing: string } {
  const meta = state.meta!;
  const draft = latestDraft(state as CaseState);
  switch (sel) {
    case "case.question": return meta.asked;
    case "case.observables": return meta.starting.map((o) => ({ type: o.type, value: o.value }));
    case "case.window": return { ...meta.window } as unknown as Json;
    case "cards.kept": return keptCards(state) as unknown as Json;
    case "findings.latest": return draft === null ? { missing: "the parent has no draft to give findings from" } : draft.product.key_findings as unknown as Json;
    case "product.latest": return draft === null ? { missing: "the parent has no draft to give a product from" } : draft.product as unknown as Json;
  }
}
const isMissing = (x: Json | { missing: string }): x is { missing: string } =>
  typeof x === "object" && x !== null && !Array.isArray(x) && Object.keys(x).length === 1 && typeof (x as { missing?: unknown }).missing === "string";

/**
 * The child's inputs from the parent's state, by the stage's mapping. Throws Refused when a required one is not there ("the parent has no draft to give
 * findings from"). `head` is the parent's head hash, named in each input card's origin; it is not part of the input hash, so a retry of the same
 * attempt finds the same child.
 */
export function inputsOf(state: Readonly<CaseState>, spec: SubloopSpec, child: Record<string, LoopInput>, head = ""): { inputs: Record<string, Json>; input_hash: string; case: NewCase; cards: Card[] } {
  const meta = state.meta;
  if (meta === null) throw new Refused("the parent case has not been made");
  const inputs: Record<string, Json> = {};
  for (const name of Object.keys(spec.inputs).sort()) {
    const value = select(state, spec.inputs[name]!);
    if (isMissing(value)) {
      if (child[name]?.required ?? true) throw new Refused(`input "${name}" of loop "${spec.loop}": ${value.missing}`);
      continue;
    }
    inputs[name] = value;
  }
  const typeOf = (name: string): LoopInput["type"] | null => child[name]?.type ?? null;
  const given = (type: LoopInput["type"]): Json | undefined => {
    const name = Object.keys(inputs).find((n) => typeOf(n) === type);
    return name === undefined ? undefined : inputs[name];
  };
  const run = state.run.id ?? "";
  const loop = state.loop.bound?.loop ?? state.loop.id ?? DEFAULT_LOOP;
  const cards: Card[] = [];
  for (const name of Object.keys(inputs)) {
    if (typeOf(name) !== "cards") continue;
    for (const c of inputs[name] as unknown as Card[]) {
      // a person's statement in the parent is not the person's in the child: the child is given it as the workbench's copy
      const { person: _person, ...rest } = c;
      cards.push({ ...rest, from: { case: meta.id, loop, run, card: c.id, head } });
    }
  }
  const stageTitle = state.run.stages.find((s) => s.id === state.run.current)?.title ?? state.run.current ?? "a sub-loop stage";
  const asked = given("question");
  const starting = given("observables");
  const window = given("window");
  const marking = strictest(meta.marking, ...cards.map((c) => c.marking));
  const made: NewCase = {
    title: `${meta.title} (from ${meta.id} · ${stageTitle})`,
    asked: typeof asked === "string" ? asked : meta.asked,
    why: `asked by ${meta.id} at its ${stageTitle} stage, run ${run}`,
    starting: Array.isArray(starting) ? (starting as unknown as NewCase["starting"]) : meta.starting.map((o) => ({ ...o })),
    window: window !== undefined && window !== null && typeof window === "object" && !Array.isArray(window) ? (window as unknown as NewCase["window"]) : { ...meta.window },
    objective: meta.objective,
    marking,
  };
  return { inputs, input_hash: sha256Hex(canonical(inputs as Json)), case: made, cards };
}

/**
 * What a finished case gives for its loop's outputs. product: the latest published product (null when none); findings: the latest draft's findings, with
 * that draft's marking ({ marking, findings }, null when there is no draft); cards.kept: the kept cards, as cardFields gives them.
 */
export function outputsOf(state: Readonly<CaseState>, outputs: Record<string, LoopOutput>): Record<string, Json> {
  const out: Record<string, Json> = {};
  for (const name of Object.keys(outputs).sort()) {
    switch (outputs[name]!.from) {
      case "product": out[name] = publishedProduct(state) as unknown as Json; break;
      case "findings": {
        const d = latestDraft(state as CaseState);
        out[name] = d === null ? null : { marking: d.product.marking, findings: d.product.key_findings as unknown as Json };
        break;
      }
      case "cards.kept": out[name] = keptCards(state) as unknown as Json; break;
    }
  }
  return out;
}

export const outputHash = (outputs: Record<string, Json>): string => sha256Hex(canonical(outputs));

/** A child's text with every card reference rewritten so it can never read as a citation of a card of the parent: `[c3]` becomes `(CASE-2 card 3)`. */
export function foreignText(text: string, child: string): string {
  const ref = (id: string): string => `${child} card ${id.slice(1)}`;
  return text
    .replace(/\[([^[\]\n]*)\]/g, (whole, inner: string) => (cardRefs(inner).length === 0 ? whole : `(${inner.replace(CARD_REF, ref)})`))
    .replace(CARD_REF, (id) => `(${ref(id)})`);
}

const isObjectJson = (x: Json): x is Record<string, Json> => typeof x === "object" && x !== null && !Array.isArray(x);
const isProduct = (x: Json): x is Record<string, Json> => isObjectJson(x) && Array.isArray(x.key_findings) && typeof x.marking === "string";
const isFindings = (x: Json): x is Record<string, Json> => isObjectJson(x) && Array.isArray(x.findings) && typeof x.marking === "string";
const isCardList = (x: Json): boolean => Array.isArray(x) && x.every((c) => isObjectJson(c) && typeof c.id === "string" && Array.isArray(c.columns));

/** The findings an output gives and the marking they carry; null when it gives none. */
function findingsOf(value: Json): { marking: Marking; findings: Finding[] } | null {
  if (isProduct(value)) return { marking: value.marking as Marking, findings: value.key_findings as unknown as Finding[] };
  if (isFindings(value)) return { marking: value.marking as Marking, findings: value.findings as unknown as Finding[] };
  return null;
}
const findingText = (f: Finding): string =>
  `${f.statement}\n\nLikelihood: ${f.likelihood}. Confidence: ${f.confidence}.${f.reasoning === "" ? "" : `\n\n${f.reasoning}`}`;
/** The sections a product holds as text: every section but the findings. */
const NARRATIVE_SECTIONS: readonly Section[] = SECTIONS.filter((x) => x !== "key_findings");

/**
 * The parent's entries for what came back, in order: card.created for each `as: cards`, proposal.created (narrative) for each `as: draft_section`. Card ids
 * come from `ids`. Every returned card is a note the workbench made, with no query, source or rows of the parent, and the marking of what it was made from.
 */
export function returnsOf(outputs: Record<string, Json>, spec: SubloopSpec, origin: { case: string; loop: string; run: string; head: string }, ids: IdAllocator): { entries: EntryInput[]; cards: string[] } {
  const entries: EntryInput[] = [];
  const cards: string[] = [];
  const why = `from sub-loop ${origin.loop} run ${origin.run} of ${origin.case}`;
  const note = (over: { title: string; body: string; marking: Marking; card: string | null; columns?: string[]; column_types?: (string | null)[]; rows?: Json[][]; row_count?: number }): void => {
    const id = ids.next("card");
    const card: Card = {
      id, title: foreignText(over.title, origin.case), body: foreignText(over.body, origin.case), kind: "note", made_by: "system", query: null,
      columns: over.columns ?? [], column_types: over.column_types ?? [], rows: over.rows ?? [], row_count: over.row_count ?? 0,
      coverage: null, empty: null, marking: over.marking, source: null, step: null, subgoal: null, why, event_time: null, quality_notes: [],
      from: { case: origin.case, loop: origin.loop, run: origin.run, card: over.card, head: origin.head },
    };
    entries.push({ type: "card.created", actor: ENGINE, payload: { card } });
    cards.push(id);
  };
  for (const name of Object.keys(spec.returns).sort()) {
    if (!Object.hasOwn(outputs, name)) continue;
    const r = spec.returns[name]!;
    const value = outputs[name]!;
    if (r.as === "cards") {
      if (isCardList(value)) {
        for (const c of value as unknown as Card[]) {
          note({ title: c.title, body: c.body, marking: c.marking, card: c.id, columns: [...c.columns], column_types: [...c.column_types], rows: c.rows.map((row) => [...row]), row_count: c.row_count });
        }
        continue;
      }
      const f = findingsOf(value);
      if (f === null) continue;
      for (const x of f.findings) note({ title: x.statement.slice(0, TITLE_CHARS), body: findingText(x), marking: f.marking, card: null });
      continue;
    }
    let text: string | null = null;
    if (isProduct(value) && (NARRATIVE_SECTIONS as readonly string[]).includes(r.section) && typeof value[r.section] === "string") text = value[r.section] as string;
    else {
      const f = findingsOf(value);
      if (f !== null) text = f.findings.map((x) => `- ${x.statement} (${x.likelihood}; confidence ${x.confidence})`).join("\n");
    }
    if (text === null || text.trim() === "") continue;
    entries.push({
      type: "proposal.created", actor: ENGINE,
      payload: { proposal: { id: ids.next("proposal"), kind: "narrative", title: `From sub-loop ${origin.loop} (${origin.case})`, by: `sub-loop:${origin.loop}`, section: r.section, text: foreignText(text, origin.case), cites: [] } },
    });
  }
  return { entries, cards };
}

/** Why a child that has not finished is not finished yet, in a few words: the tail of the parent's "waiting on child CASE-N: …". */
export function childWaitReason(state: Readonly<CaseState>): string {
  const { run } = state;
  switch (run.status) {
    case "none": return "its run has not started";
    case "waiting": return run.waiting === "plan" ? "it waits for a person at its plan gate" : run.waiting === "publish" ? "it waits for a person at its publish gate" : "it waits for a person";
    case "paused": return `it is paused: ${run.pause_reason ?? "no reason given"}`;
    case "interrupted": return "its run was interrupted; a person resumes it";
    case "running": return "it is still running";
    case "finished": return "it has finished";
  }
}

/**
 * Which case a parent's record names as its child: its id, the hash of its first entry (null when the record names none), and the link it was made
 * for. Ids repeat across workbenches, so a case with this id is the child only when its subloop.child names this parent, run, stage, attempt and
 * input hash, and its first entry is this one.
 */
export interface ChildRef { id: string; origin: string | null; parent: string; run: string; stage: string; attempt: number; input_hash: string }

/** The child a parent's record names, as a ChildRef. */
export const childRefOf = (parent: string, rec: Pick<SubloopState, "child" | "origin" | "run" | "stage" | "attempt" | "input_hash">): ChildRef =>
  ({ id: rec.child, origin: rec.origin, parent, run: rec.run, stage: rec.stage, attempt: rec.attempt, input_hash: rec.input_hash });

/** Whether a case (its state and the hash of its first entry) is the child `ref` names. */
export function isChildOf(state: Readonly<CaseState>, origin: string | null, ref: ChildRef): boolean {
  const p = state.loop.parent;
  if (p === null || p.case !== ref.parent || p.run !== ref.run || p.stage !== ref.stage || p.attempt !== ref.attempt || p.input_hash !== ref.input_hash) return false;
  return ref.origin === null || origin === ref.origin;
}

/** Why a host refuses to drive a case: it is not the child the parent's record names. */
export const notTheChild = (ref: ChildRef): string => `child ${ref.id} is not loaded; load it from the store`;

/** What a host's `read` gives of a child session: its state, head and why its run stopped; null when the session is not the child `ref` names. */
export function readChild(session: { readonly state: Readonly<CaseState>; head(): { seq: number; hash: string }; entries(from?: number, to?: number): readonly Entry[] }, ref: ChildRef): ChildView | null {
  if (!isChildOf(session.state, session.entries(0, 1)[0]?.hash ?? null, ref)) return null;
  const stopped = session.entries().findLast((e) => e.type === "run.finished");
  return { state: session.state, head: session.head(), stop_reason: stopped !== undefined && stopped.type === "run.finished" ? stopped.payload.reason ?? null : null };
}

export interface ChildView { state: Readonly<CaseState>; head: { seq: number; hash: string }; stop_reason?: string | null }

/** What the engine needs of the host to run a sub-loop. The host has the workbench; the engine has a session. */
export interface ChildCases {
  /** The case a stopped process made for this link, with the hash of its first entry; null when there is none. */
  find(link: ChildLink): { id: string; origin: string } | null;
  create(input: NewCase, link: ChildLink, cards: Card[]): { id: string; origin: string };
  /**
   * Starts the child's run when it has none, and carries it as far as it goes without a person. Never passes a gate. Throws Refused, doing
   * nothing, when the case with that id is not the child `ref` names.
   */
  drive(ref: ChildRef): Promise<RunSummary>;
  /** The child's state and head now; null when no case here is the child `ref` names. `stop_reason`: why its run was stopped, when the host knows it. */
  read(ref: ChildRef): ChildView | null;
}
