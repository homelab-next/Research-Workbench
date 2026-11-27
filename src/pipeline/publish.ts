import { Refused } from "../core/refused";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Json } from "../core/canonical";
import { canonical, isPlainObject, parseJson } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CaseSession } from "../core/session";
import { activeOverrules, BASIS_TEXT, blockers, holdsOverrule, latestDraft, overruleSays, overruleText } from "../core/state";
import type { CaseState, Overrule, OverruleState } from "../core/state";
import type { Actor, Draft, Entry, EntryInput, Marking, Observable, PersonBasis } from "../core/types";
import { strictest } from "../core/types";
import { logToStderr } from "../core/deliver";
import { citedOf } from "../agents/draft";
import type { EngineDeps } from "./engine";
import type { Pipeline } from "./manifests";

export class PublishRefused extends Refused {
  constructor(reasons: string[]) {
    super(reasons.join(". "), reasons);
    this.name = "PublishRefused";
  }
}

export interface BundleManifest {
  case: string; n: number; draft: number; draft_hash: string; head: { seq: number; hash: string }; marking: Marking; title: string; note: string;
  files: { name: string; sha256: string; bytes: number }[];
}
export interface Bundle { manifest: BundleManifest; files: Record<string, string> }

const HUMAN_ONLY = "only a person may publish or send back a product";
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);
const who = (a: Actor): string => `${a.kind}:${a.id}`;
/** Text shown as plain text in Markdown: nothing in it can start a heading, a list, a link or emphasis. */
const plain = (text: string): string => text.replace(/\s+/g, " ").trim().replace(/([\\`*_{}[\]()#+\-.!|>~<&])/g, "\\$1");
const byId = (a: string, b: string): number => a.localeCompare(b, "en", { numeric: true });

/** Why a draft's hash is not the hash of its product; null when it is. */
export function draftProblem(draft: Draft): string | null {
  try {
    return sha256Hex(canonical(draft.product as unknown as Json)) === draft.hash ? null : "the draft's hash does not match its product";
  } catch (err) {
    return `the draft's product cannot be hashed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

interface Provenance {
  card: string; title: string | null; source: string | null; source_hash: string | null; query: string | null; text: string | null; bound: Json; window: Json;
  why: string | null; by: string | null; issued: string | null; marking: Marking | null; coverage: Json; empty: string | null; rows: number | null;
  rows_hash: string | null; result_sha256: string | null;
  /** Only on a statement by the person: how they know it, what it is about, and the question it answers with that question's text. */
  person?: { basis: PersonBasis; detail: string; about: Observable[]; answers: string | null; question: string | null };
}

function provenanceOf(session: CaseSession, draft: Draft): Provenance[] {
  const ids = citedOf(draft);
  const issued = new Map<string, Extract<Entry, { type: "query.issued" }>>();
  const result = new Map<string, Extract<Entry, { type: "query.result" }>>();
  /** Who wrote each card: the actor of its card.created entry. */
  const made = new Map<string, Actor>();
  for (const e of session.entries()) {
    if (e.type === "query.issued") issued.set(e.payload.query, e);
    else if (e.type === "query.result") result.set(e.payload.query, e);
    else if (e.type === "card.created" && isPlainObject(e.payload.card) && typeof e.payload.card.id === "string" && !made.has(e.payload.card.id)) made.set(e.payload.card.id, e.actor);
  }
  return ids.map((id): Provenance => {
    const c = Object.hasOwn(session.state.cards, id) ? session.state.cards[id]! : null;
    if (c === null) {
      return { card: id, title: null, source: null, source_hash: null, query: null, text: null, bound: null, window: null, why: null, by: null, issued: null, marking: null, coverage: null, empty: null, rows: null, rows_hash: null, result_sha256: null };
    }
    if (c.person !== undefined) {
      const p = c.person;
      const question = p.answers !== null && Object.hasOwn(session.state.questions, p.answers) ? session.state.questions[p.answers]!.text : null;
      return {
        card: id, title: c.title, source: null, source_hash: null, query: null, text: null, bound: null, window: null, why: c.why, by: made.has(id) ? who(made.get(id)!) : c.made_by,
        issued: null, marking: c.marking, coverage: null, empty: null, rows: c.row_count, rows_hash: null, result_sha256: null,
        person: { basis: p.basis, detail: p.detail, about: p.about.map((o) => ({ type: o.type, value: o.value })), answers: p.answers, question },
      };
    }
    const q = c.query === null ? undefined : issued.get(c.query);
    const r = c.query === null ? undefined : result.get(c.query);
    return {
      card: id, title: c.title, source: c.source, source_hash: q?.payload.source_hash ?? null, query: c.query, text: q?.payload.text ?? null,
      bound: (q?.payload.bound ?? null) as Json, window: (q?.payload.window ?? null) as unknown as Json, why: q?.payload.why ?? c.why, by: q === undefined ? c.made_by : who(q.actor),
      issued: q?.ts ?? null, marking: c.marking, coverage: (r?.payload.coverage ?? c.coverage ?? null) as unknown as Json, empty: c.empty,
      rows: r?.payload.rows ?? c.row_count, rows_hash: r?.payload.rows_hash ?? null, result_sha256: r?.payload.result.blob ?? null,
    };
  });
}

/** The line under a finding that cites the person's statements: "Rests on the person's statement: [c5] (did it myself). A statement, not data from a source." */
function restsOn(cites: readonly string[], statements: ReadonlyMap<string, PersonBasis>): string[] {
  const said = cites.filter((id) => statements.has(id));
  if (said.length === 0) return [];
  const list = said.map((id) => `[${id}] (${BASIS_TEXT[statements.get(id)!]})`).join(", ");
  return [said.length === 1
    ? `Rests on the person's statement: ${list}. A statement, not data from a source.`
    : `Rests on the person's statements: ${list}. Statements, not data from a source.`];
}

/** The person's overrules a draft holds and is to say so for: each active one whose finding is in the draft, or that dropped one. */
function heldOverrules(state: Readonly<CaseState>, draft: Draft): OverruleState[] {
  return activeOverrules(state).filter((o) => holdsOverrule(draft.product, o) === true);
}

/** The line under a finding whose value the person set: "Set by the person (likelihood almost certain): <note>". */
const setBy = (o: Overrule | undefined): string[] => (o === undefined || o.stays === false ? [] : [`Set by the person (${overruleSays(o)}): ${o.note.trim()}`]);

/** `statements`: the cited cards that are the person's statements, with how the person knows each; `overrules`: the person's, by finding. */
function productMarkdown(draft: Draft, title: string, statements: ReadonlyMap<string, PersonBasis>, overrules: ReadonlyMap<string, Overrule> = new Map()): string {
  const p = draft.product;
  const cites = (ids: string[]): string => (ids.length === 0 ? "none" : ids.map((c) => `[${c}]`).join(" "));
  const list = (items: string[]): string => (items.length === 0 ? "None." : items.map((x) => `- ${x}`).join("\n"));
  const findings = p.key_findings.map((f) => [
    `### ${f.id}. ${f.statement}`, "",
    `Likelihood: ${f.likelihood}. Confidence: ${f.confidence} (${f.confidence_basis}).`, `Citations: ${cites(f.cites)}.`, ...restsOn(f.cites, statements), ...setBy(overrules.get(f.id)),
    `Assumptions: ${f.assumptions.length === 0 ? "none" : f.assumptions.join("; ")}.`, `Reasoning: ${f.reasoning}`,
  ].join("\n"));
  return [
    p.marking, "", `# ${plain(title)}`, "",
    `Objective: ${p.objective}`, `Question: ${p.question}`, `Draft ${draft.n}, hash ${draft.hash}`, "",
    "## Summary", "", p.summary, "",
    "## Key findings", "", findings.length === 0 ? "None." : findings.join("\n\n"), "",
    "## Assessment", "", p.assessment, "",
    "## Alternatives considered", "", p.alternatives, "",
    "## Gaps and limits", "", p.gaps_and_limits, "",
    "## Sources and their quality", "", list(p.sources.map((s) => `${s.source}: ${s.quality}`)), "",
    "## Assumptions", "", list(p.assumptions), "",
    "## Change from earlier judgments", "", p.change, "",
    p.marking, "",
  ].join("\n");
}

function provenanceMarkdown(rows: Provenance[], marking: Marking, overrules: readonly Overrule[] = []): string {
  const text = (v: unknown): string => (v === null ? "none" : typeof v === "string" ? v : JSON.stringify(v));
  const cards = rows.map((r) => r.person !== undefined ? [
    // a statement has no query: how the person knows takes the query's lines
    `## [${r.card}] ${r.title ?? "(card not in the case)"}`, "",
    "- Source: the person (a statement, not data from a source)", `- How they know: ${text(r.why)}`,
    ...(r.person.about.length === 0 ? [] : [`- About: ${r.person.about.map((o) => `${o.type} ${o.value}`).join(", ")}`]),
    ...(r.person.answers === null ? [] : [`- Answers: ${r.person.answers}${r.person.question === null ? "" : ` (${r.person.question})`}`]),
    `- By: ${text(r.by)}`, `- Marking: ${text(r.marking)}`,
  ].join("\n") : [
    `## [${r.card}] ${r.title ?? "(card not in the case)"}`, "",
    `- Source: ${text(r.source)} (hash ${text(r.source_hash)})`, `- Query ${text(r.query)}: ${text(r.text)}`, `- Bound values: ${text(r.bound)}`, `- Window: ${text(r.window)}`,
    `- Why: ${text(r.why)}`, `- By: ${text(r.by)}`, `- Issued: ${text(r.issued)}`, `- Marking: ${text(r.marking)}`, `- Coverage: ${text(r.coverage)}`, `- If empty, it means: ${text(r.empty)}`,
    `- Rows: ${text(r.rows)} (hash ${text(r.rows_hash)})`, `- Result bytes SHA-256: ${text(r.result_sha256)}`,
  ].join("\n"));
  const set = overrules.length === 0 ? [] : ["# Overrules by the person", "", ...overrules.map((o) => `- ${overruleText(o)} (by ${o.by})`), ""];
  return [marking, "", "# Provenance of the cited cards", "", cards.length === 0 ? "No card is cited." : cards.join("\n\n"), "", ...set, marking, ""].join("\n");
}

/** The files of a bundle, and the manifest that lists them. Nothing here reads a clock. */
export function buildBundle(session: CaseSession, draft: Draft, cover: { title: string; note: string }, head: { seq: number; hash: string }, n: number): Bundle {
  const prov = provenanceOf(session, draft);
  // the values the person set: the product says so under each finding, and the provenance lists them (final review I4)
  const held = heldOverrules(session.state, draft);
  const files: Record<string, string> = {
    "product.json": canonical(draft.product as unknown as Json),
    "product.md": productMarkdown(draft, cover.title, new Map(prov.flatMap((r) => (r.person === undefined ? [] : [[r.card, r.person.basis] as const]))), new Map(held.map((o) => [o.finding, o]))),
    "provenance.json": canonical(prov as unknown as Json),
    "provenance.md": provenanceMarkdown(prov, draft.product.marking, held),
  };
  const manifest: BundleManifest = {
    case: session.id, n, draft: draft.n, draft_hash: draft.hash, head: { seq: head.seq, hash: head.hash }, marking: draft.product.marking, title: cover.title, note: cover.note,
    files: Object.entries(files).map(([name, text]) => ({ name, sha256: sha256Hex(bytesOf(text)), bytes: bytesOf(text).byteLength })),
  };
  return { manifest, files };
}

/** Why the product's marking is lower than a card it cites; null when it covers them all. Markings that are not known count as the most restrictive. */
export function markingProblem(session: CaseSession, draft: Draft): string | null {
  const low = citedOf(draft).filter((id) => Object.hasOwn(session.state.cards, id) && strictest(draft.product.marking, session.state.cards[id]!.marking) !== strictest(draft.product.marking));
  return low.length === 0 ? null : `the product is marked ${draft.product.marking}, which is less restrictive than ${low.map((id) => `${id} (${session.state.cards[id]!.marking})`).join(", ")}`;
}

/** The Publish stage's last output on this exact draft in the current run: the publisher's title and note, or why they cannot be used; null when there is none. */
function coverOf(session: CaseSession, stage: string, hash: string): { title: string; note: string } | string | null {
  const entries = session.entries();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type === "run.started") return null;
    if (e.type !== "stage.finished" || e.payload.stage !== stage || e.payload.outcome !== "pass" || e.payload.draft_hash !== hash || e.payload.output === null) continue;
    const parsed = parseJson(session.blobs.text(e.payload.output.blob));
    const out = parsed === null ? null : parsed.value;
    if (typeof out !== "object" || out === null || Array.isArray(out) || typeof out.title !== "string" || typeof out.note !== "string") return null;
    // a title is one plain line; neither it nor the note may carry control characters (a note may have line breaks and tabs)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(out.title) || out.title.trim() === "") return "the title must be one line of text with no control characters";
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(out.note)) return "the note must not contain control characters";
    return { title: out.title, note: out.note };
  }
  return null;
}

const publishStage = (pipeline: Pipeline): string | null => pipeline.stages.find((s) => s.gate === "publish")?.id ?? null;

function atGate(session: CaseSession, actor: Actor): void {
  if (actor.kind !== "human") throw new PublishRefused([HUMAN_ONLY]);
  const { run } = session.state;
  if (run.status === "none" || run.status === "finished" || run.waiting !== "publish") throw new PublishRefused(["the run is not waiting at the publish gate"]);
}

class Stale extends Error {}
const ATTEMPTS = 3;
const report = (deps: EngineDeps, error: unknown): void => (deps.onError ?? logToStderr("publish"))(error);

/** Removes every temporary bundle folder a stopped process left in the case's published folder, reporting each. */
export function removeTempBundles(session: CaseSession, onError: (error: unknown) => void): void {
  const root = join(session.dir, "published");
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names.filter((x) => x.startsWith(".tmp-"))) {
    rmSync(join(root, name), { recursive: true, force: true });
    onError(new Error(`removed ${name}, a bundle a stopped publish left unfinished`));
  }
}

/**
 * The bundle `approve` would write now, or why there is none: no draft, a draft whose hash is not its product's, the publish rule's blockers, a product
 * marked below a card it cites, or no Publish stage output naming this draft. It writes nothing and reads no gate or person; `approve` builds its bundle
 * through this function after checking both, so what is previewed and what is written cannot differ.
 */
export function previewBundle(session: CaseSession, deps: EngineDeps): Bundle | { reasons: string[] } {
  const state = session.state;
  const d = latestDraft(state);
  if (d === null) return { reasons: ["there is no draft to publish"] };
  const problem = draftProblem(d);
  if (problem !== null) return { reasons: [problem] };
  const why = blockers(state, d.hash);
  if (why.length > 0) return { reasons: why };
  const low = markingProblem(session, d);
  if (low !== null) return { reasons: [low] };
  const stage = publishStage(deps.pipeline);
  const cover = stage === null ? null : coverOf(session, stage, d.hash);
  if (cover === null) return { reasons: ["the Publish stage has not named this draft"] };
  if (typeof cover === "string") return { reasons: [cover] };
  return buildBundle(session, d, cover, session.head(), state.published.length + 1);
}

/**
 * A person approves the draft the run waits on. Everything is checked again at this moment, from the ledger: the person, the gate, the hash against
 * the product, the product's marking against the cards it cites, and the publish rule. The bundle is written to a temporary folder and stored as a blob;
 * one commit records it, and only then is the folder moved to `published/<n>`, so a folder there always has its entry.
 */
export function approve(session: CaseSession, deps: EngineDeps, input: { actor: Actor }): { n: number; dir: string; draft_hash: string } {
  const { actor } = input;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    atGate(session, actor);
    const made = previewBundle(session, deps);
    if ("reasons" in made) throw new PublishRefused(made.reasons);
    const bundle = made;
    const { n, head } = { n: bundle.manifest.n, head: bundle.manifest.head };
    const d = latestDraft(session.state)!;
    const rel = `published/${n}`;
    const tmp = join(session.dir, "published", `.tmp-${n}-${randomBytes(6).toString("hex")}`);
    try {
      mkdirSync(tmp, { recursive: true });
      for (const [name, text] of Object.entries(bundle.files)) writeFileSync(join(tmp, name), text);
      writeFileSync(join(tmp, "manifest.json"), canonical(bundle.manifest as unknown as Json));
      const blob = session.blobs.put(canonical({ manifest: bundle.manifest, files: bundle.files } as unknown as Json));
      session.commit((s, ids) => {
        if (s.seq !== head.seq) throw new Stale();
        const link = { run: s.run.id };
        const entries: EntryInput[] = [{ type: "gate.passed", actor, ...link, payload: { gate: "publish" } }];
        const loose = citedOf(d).filter((id) => Object.hasOwn(s.cards, id) && s.cards[id]!.place === "incoming");
        let lanes = s.lanes.map((l) => ({ id: l.id, subgoal: l.subgoal }));
        if (loose.length > 0 && lanes.length === 0) {
          const lane = ids.next("lane");
          entries.push({ type: "lane.created", actor, ...link, payload: { lane, title: "Cited evidence", subgoal: null } });
          lanes = [{ id: lane, subgoal: null }];
        }
        for (const id of loose) {
          const sub = s.cards[id]!.subgoal;
          const lane = (sub === null ? undefined : lanes.find((l) => l.subgoal === sub)) ?? lanes[0]!;
          entries.push({ type: "card.kept", actor, ...link, payload: { card: id, lane: lane.id, index: null } });
        }
        entries.push({ type: "product.published", actor, ...link, payload: { n, draft_hash: d.hash, head_hash: head.hash, dir: rel, bundle: blob } });
        return entries;
      });
    } catch (err) {
      rmSync(tmp, { recursive: true, force: true });
      if (err instanceof Stale) continue;
      throw err;
    }
    // recorded: the folder takes its place. A folder under this number with no entry is a leftover.
    try {
      rmSync(join(session.dir, rel), { recursive: true, force: true });
      renameSync(tmp, join(session.dir, rel));
    } catch (err) {
      report(deps, new Error(`the product was published, but its folder could not be put in place (${err instanceof Error ? err.message : String(err)}); the bundle is in the ledger's blob`));
    }
    try {
      const now = session.head();
      deps.anchor?.({ case: session.id, seq: now.seq, hash: now.hash, why: "published" });
    } catch (err) {
      report(deps, new Error(`the product was published, but anchoring it failed: ${err instanceof Error ? err.message : String(err)}`));
    }
    return { n, dir: rel, draft_hash: d.hash };
  }
  throw new PublishRefused(["the case kept changing while the product was being published; try again"]);
}

/**
 * A person sends the draft back, or stops the run. Without `stop` the run goes to the Publish stage's on_fail stage like an engine send-back,
 * except that the cap does not apply to a person.
 */
export function reject(session: CaseSession, pipeline: Pipeline, input: { reason: string; stop: boolean; actor: Actor }): void {
  const { actor, stop } = input;
  atGate(session, actor);
  if (input.reason.trim() === "") throw new PublishRefused(["a rejection needs a reason"]);
  const id = publishStage(pipeline);
  const manifest = pipeline.stages.find((s) => s.id === id);
  if (manifest === undefined) throw new PublishRefused(["the pipeline has no publish stage"]);
  if (!stop && manifest.on_fail === null) throw new PublishRefused(["the Publish stage has nowhere to send work back to; stop the run instead"]);
  const engine: Actor = { kind: "system", id: "engine" };
  session.commit((s) => {
    const d = latestDraft(s);
    if (d === null) throw new PublishRefused(["there is no draft to reject"]);
    const link = { run: s.run.id };
    const out: EntryInput[] = [{ type: "publish.rejected", actor, ...link, payload: { draft_hash: d.hash, reason: input.reason, stop } }];
    if (stop) {
      out.push({ type: "run.finished", actor, ...link, payload: { outcome: "stopped" } });
      return out;
    }
    const to = manifest.on_fail!;
    const target = pipeline.stages.find((x) => x.id === to);
    const edge = `${manifest.id}>${to}`;
    const count = (Object.hasOwn(s.run.sendbacks, edge) ? s.run.sendbacks[edge]! : 0) + 1;
    const attempt = (s.run.stages.find((x) => x.id === manifest.id)?.attempts ?? 1);
    out.push({ type: "stage.finished", actor: engine, ...link, stage: manifest.id, payload: { stage: manifest.id, attempt, outcome: "fail", draft_hash: d.hash, output: null, reason: input.reason } });
    out.push({ type: "stage.sent_back", actor: engine, ...link, stage: to, payload: { from: manifest.id, to, reason: input.reason, count } });
    if (target?.phase != null && target.phase !== s.phase) out.push({ type: "case.phase_changed", actor: engine, ...link, stage: to, payload: { phase: target.phase } });
    out.push({ type: "stage.started", actor: engine, ...link, stage: to, payload: { stage: to, attempt: (s.run.stages.find((x) => x.id === to)?.attempts ?? 0) + 1 } });
    return out;
  });
}
