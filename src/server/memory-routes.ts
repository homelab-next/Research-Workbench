// The Memory page's routes (slice 13): the shared lessons store as a resource beside cases and loops, and what a case's run was given from it.
// They are routes of their own, each in app.ts's route table behind the same guard and role check as every other. Every write to the store is
// a person's, named by the server (no body may name an actor), and goes through one queue, so two proposals cannot take one id. A lesson is
// shared only by a person: accept, reject and retire are MemoryStore's, which refuses any other actor. A lesson's text reaches a case's view
// only when the case's marking allows it.
import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { isPlainObject } from "../core/canonical";
import { isTrigger, readMemoryLock, triggerWords } from "../core/lessons";
import { fold, runQuestions } from "../core/state";
import type { LessonDraft, LessonState, MemoryLock } from "../core/lessons";
import { checkMemoryFile, parseMemoryFileName } from "../core/memfile";
import { MemoryRefused } from "../core/memstore";
import { Refused } from "../core/refused";
import { isMarking, MARKINGS, strictest } from "../core/types";
import type { Actor, Entry, LessonOrigin, Marking, Trigger } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { CaseMemoryView, LessonView, MemoryView } from "../core/wire";
import { tooStrict } from "../agents/pack";
import type { Config } from "../modules/config";
import type { EngineDeps } from "../pipeline/engine";
import { memoryUses } from "../pipeline/loops";
import { isCaseTypeQuestion, TYPE_GAP } from "../pipeline/memory";
import type { CaseHub } from "./hub";
import type { Reading } from "./roles";

export interface MemoryRouteDeps {
  config: Config; wb: Workbench; hub: CaseHub; deps: EngineDeps; human: () => Extract<Actor, { kind: "human" }>;
  /** A text as the person may see it (app.ts's `shown`): scrubbed as a card is. */
  shown: (text: string) => string;
  /** The value of every secret the workbench holds: a proposal holding one is refused; one in a reason is written redacted. */
  secrets: () => readonly string[];
}
/** What a handler is given, as app.ts gives it. */
export interface MemoryCall { url: URL; params: string[]; body(): Promise<unknown> }
export interface MemoryRoute {
  method: "GET" | "POST"; path: RegExp; needs: { read: Reading } | { command: string }; kind: "api" | "download";
  handle(call: MemoryCall): Response | Promise<Response>;
}

/** The queue every write to the store runs in; no case id looks like it. */
export const MEMORY_LINE = "memory";

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const rank = (m: Marking): number => MARKINGS.indexOf(m);
const NOT_A_FILE = "file must be a memory file's name";

/** The body as an object with only the given fields, or why it is refused. */
function fieldsOf(body: unknown, allowed: string[]): Record<string, unknown> | string {
  if (!isPlainObject(body)) return "the body must be a JSON object";
  if (Object.hasOwn(body, "actor")) return "the server names the actor";
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra !== undefined) return `the body has a field it should not have: ${extra.slice(0, 40)}`;
  return body;
}

/** A path parameter, decoded; null when it does not decode. */
const decoded = (raw: string): string | null => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
};

/** A memory file's bare name, or null: no separator, no "..", the name exportMemory writes. */
const memoryFileOf = (x: unknown): string | null =>
  typeof x === "string" && !x.includes("/") && !x.includes("\\") && !x.includes("..") && parseMemoryFileName(x) !== null ? x : null;

// ---------- views ----------

/** Where a lesson came from, in words. */
export function fromWords(from: LessonOrigin): string {
  if (from.kind === "person") return "proposed by a person";
  if (from.kind === "seed") return `seed ${from.item} of ${from.manifest}`;
  const parts = [from.run === null ? null : `run ${from.run}`, from.product === null ? null : `product ${from.product.n}`].filter((p): p is string => p !== null);
  const by = from.model ? `, written by the model of its ${from.stage ?? "stage"} stage` : "";
  return `from ${from.case}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}${by}`;
}

const STATUS_RANK: Record<LessonState["status"], number> = { proposed: 0, accepted: 1, rejected: 2, retired: 2, superseded: 2 };

function historyOf(l: LessonState, bySeq: ReadonlyMap<number, Entry>): LessonView["history"] {
  return l.history.flatMap((seq) => {
    const e = bySeq.get(seq);
    if (e === undefined) return [];
    let what: string = String(e.type).replace(/^lesson\./, "");
    const lesson = (e.payload as unknown as Record<string, unknown>).lesson;
    if (e.type === "lesson.accepted" && lesson !== l.id) what = `superseded by ${String(lesson)}`;
    return [{ seq, ts: e.ts, what, by: e.actor.id }];
  });
}

function lessonView(d: MemoryRouteDeps, l: LessonState, bySeq: ReadonlyMap<number, Entry>): LessonView {
  const from = l.from;
  const caseId = from.kind === "case" && d.wb.loadedOrigin(from.case) === from.origin ? from.case : null;
  return {
    id: l.id, case_type: l.case_type, title: d.shown(l.title), text: d.shown(l.text), triggers: l.triggers.map(shownTrigger(d)),
    trigger_words: l.triggers.map((t) => d.shown(triggerWords(t))), marking: l.marking, proposed_marking: l.proposed_marking,
    status: l.status, hash: l.hash, supersedes: l.supersedes, superseded_by: l.superseded_by,
    from: { words: d.shown(fromWords(from)), case: caseId, kind: from.kind, model: from.kind === "case" && from.model },
    proposed: { by: l.proposed.by.id, ts: l.proposed.ts },
    decided: l.decided === null ? null : { by: l.decided.by, ts: l.decided.ts, reason: l.decided.reason === null ? null : d.shown(l.decided.reason) },
    history: historyOf(l, bySeq),
  };
}
const shownTrigger = (d: MemoryRouteDeps) => (t: Trigger): Trigger =>
  "observable" in t ? { observable: t.observable } : "source" in t ? { source: t.source } : { finding: d.shown(t.finding) };

async function filesOf(d: MemoryRouteDeps): Promise<MemoryView["files"]> {
  let names: string[];
  try {
    names = readdirSync(d.config.memory.files, { withFileTypes: true }).filter((e) => e.isFile() && memoryFileOf(e.name) !== null).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
  const out: MemoryView["files"] = [];
  for (const file of names.sort(lt)) {
    const at = join(d.config.memory.files, file);
    const named = parseMemoryFileName(file)!;
    let bytes = 0;
    try { bytes = statSync(at).size; } catch { /* gone since it was listed */ }
    try {
      const m = await checkMemoryFile(at);
      const lessons = Object.values(m.lessons).reduce((a, b) => a + b, 0);
      out.push({ file, bytes, marking: m.marking, lessons, head: m.head.hash.slice(0, 12), problem: null });
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      out.push({ file, bytes, marking: named.marking, lessons: 0, head: named.hash12, problem: d.shown(err.reasons[0] ?? err.message) });
    }
  }
  return out;
}

async function memoryView(d: MemoryRouteDeps): Promise<MemoryView> {
  const store = d.wb.memory;
  const state = store.state;
  const bySeq = new Map(store.entries().map((e) => [e.seq, e] as const));
  const lessons = state.order.map((id) => state.lessons[id]!);
  const newest = (l: LessonState): number => l.history.at(-1) ?? 0;
  const ordered = (ls: LessonState[]): LessonView[] =>
    [...ls].sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || newest(b) - newest(a) || lt(a.id, b.id)).map((l) => lessonView(d, l, bySeq));
  const types = [...(d.deps.case_types ?? [])].sort((a, b) => lt(a.id, b.id));
  const groups: MemoryView["groups"] = types.map((t) => ({
    type: { id: t.id, title: d.shown(t.title), about: d.shown(t.about) }, lessons: ordered(lessons.filter((l) => l.case_type === t.id)),
  }));
  const unloaded = lessons.filter((l) => !types.some((t) => t.id === l.case_type));
  if (unloaded.length > 0) groups.push({ type: null, lessons: ordered(unloaded) });
  return {
    store: { origin: store.origin(), head: store.head(), lessons: state.order.length, skipped: state.skipped.length },
    groups, files: await filesOf(d),
  };
}

/** The marking a case's views compare a lesson with: the case's; with no record, the least that may be shown. */
const caseMarking = (marking: Marking | undefined): Marking => marking ?? MARKINGS[0]!;

/**
 * A case's memory as it stands, or, with `at`, as it stood after entry `at` (Replay): the type and the binding in force then, folded from the
 * case's own entries, so the lessons listed are the ones that binding locked. The lessons proposed from the case are the store's now.
 */
function caseMemoryView(d: MemoryRouteDeps, id: string, at: number | null = null): CaseMemoryView {
  const session = d.hub.read(id);
  const st = at === null || at >= session.state.seq ? session.state : fold(session.entries(0, at), at);
  const m = st.memory;
  const marking = caseMarking(st.meta?.marking);
  const types = d.deps.case_types ?? [];
  const titleOf = (t: string): string | null => {
    const found = types.find((x) => x.id === t);
    return found === undefined ? null : d.shown(found.title);
  };
  const lock = d.hub.depsFor(id).lock;
  const uses = lock === undefined ? [] : memoryUses(lock);
  let bound: CaseMemoryView["bound"] = null;
  if (m.bound !== null) {
    let read: MemoryLock | null = null;
    try { read = readMemoryLock(session.blobs.get(m.bound.lock.blob)); } catch { read = null; }
    const now = d.wb.memory.state;
    const count = (why: "marking" | "trigger" | "cap"): number => read?.left_out.filter((x) => x.why === why).length ?? 0;
    bound = {
      seq: m.bound.seq, store_head: m.bound.store.head.seq,
      // selection left out every lesson stricter than the case; one that is is not shown here either
      lessons: (read?.lessons ?? []).filter((l) => !tooStrict(l.marking, marking)).map((l) => ({
        id: l.lesson, title: d.shown(l.title), text: d.shown(l.text), marking: l.marking, matched: l.matched.map(d.shown), stages: [...l.stages],
        from: d.shown(fromWords(l.from)), still_shared: Object.hasOwn(now.lessons, l.lesson) && now.lessons[l.lesson]!.status === "accepted" && now.lessons[l.lesson]!.hash === l.hash,
      })),
      left_out: { marking: count("marking"), trigger: count("trigger"), cap: count("cap") },
    };
  }
  const origin = session.entries(0, 1)[0]?.hash ?? null;
  const store = d.wb.memory.state;
  const proposed = store.order.map((x) => store.lessons[x]!)
    .filter((l) => l.from.kind === "case" && l.from.case === id && l.from.origin === origin)
    .map((l) => ({ id: l.id, title: tooStrict(l.marking, marking) ? `a lesson marked ${l.marking}, stricter than this case` : d.shown(l.title), status: l.status }));
  return {
    type: m.type, type_title: m.type === null ? null : titleOf(m.type),
    proposed_type: m.proposed_type === null ? null : { type: m.proposed_type.type, title: titleOf(m.proposed_type.type) ?? m.proposed_type.type, why: d.shown(m.proposed_type.why) },
    reads: { shared: uses.some((u) => u.store === "shared"), notes: uses.some((u) => u.store === "case") },
    bound, proposed,
    gap: m.type === null && runQuestions(st).some((q) => isCaseTypeQuestion(q) && q.answer === null && q.waived !== null) ? TYPE_GAP : null,
  };
}

// ---------- the bodies a person sends ----------

const PROPOSAL_FIELDS = ["case_type", "title", "text", "triggers", "marking", "supersedes", "case"];

/** A proposal's draft and the case it is from, or why the body is not one. */
function proposalOf(fields: Record<string, unknown>): { draft: LessonDraft; case: string | null } | string {
  for (const f of ["case_type", "title", "text"] as const) if (typeof fields[f] !== "string") return `${f} must be text`;
  if (!Array.isArray(fields.triggers)) return "triggers must be a list";
  if (!fields.triggers.every((t) => isTrigger(t))) return "a trigger is { observable: <type> }, { source: <id> } or { finding: <words> }";
  if (!isMarking(fields.marking)) return "marking must be a marking";
  const supersedes = fields.supersedes ?? null;
  if (supersedes !== null && typeof supersedes !== "string") return "supersedes must be a lesson's id or null";
  const from = fields.case ?? null;
  if (from !== null && typeof from !== "string") return "case must be a case's id";
  return {
    draft: {
      case_type: fields.case_type as string, title: fields.title as string, text: fields.text as string,
      triggers: (fields.triggers as Trigger[]).map((t) => ({ ...t }) as Trigger), marking: fields.marking, supersedes: supersedes as string | null,
    },
    case: from,
  };
}

/** The origin of a person's proposal from a case, and the marking it must have at least: the case's and its latest published product's. */
function caseOrigin(d: MemoryRouteDeps, id: string): { from: LessonOrigin; floor: Marking } {
  const session = d.hub.read(id); // an unknown case is 404
  const st = session.state;
  const marks: Marking[] = [];
  if (st.meta !== null) marks.push(st.meta.marking);
  const latest = st.published.at(-1);
  const product = latest === undefined ? undefined : st.drafts.find((x) => x.hash === latest.draft_hash)?.product.marking;
  if (isMarking(product)) marks.push(product);
  const head = session.head();
  return {
    from: {
      kind: "case", case: id, origin: session.entries(0, 1)[0]!.hash, run: st.run.id, head: { seq: head.seq, hash: head.hash },
      product: latest === undefined ? null : { n: latest.n, draft_hash: latest.draft_hash }, stage: null, model: false,
    },
    floor: marks.length === 0 ? strictest(null) : strictest(...marks),
  };
}

// ---------- the routes ----------

/** The routes of the Memory page and a case's Memory lens, for app.ts's table. */
export function memoryRoutes(d: MemoryRouteDeps): MemoryRoute[] {
  /** A refusal of the store or a memory file is 409 with its reasons as the person may see them; anything else is the caller's to answer. */
  const refusing = async (work: () => Promise<Response> | Response): Promise<Response> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Refused) return refused(409, ...error.reasons.map(d.shown));
      throw error;
    }
  };
  /** One write to the store at a time. */
  const inLine = <T>(work: () => Promise<T> | T): Promise<T> => d.hub.serial(MEMORY_LINE, work);
  const lessonOf = (raw: string): string => decoded(raw) ?? raw;
  const deciding = (path: RegExp, command: string, allowed: string[], decide: (id: string, fields: Record<string, unknown>) => Response | Promise<Response>): MemoryRoute => ({
    method: "POST", path, needs: { command }, kind: "api",
    handle: async ({ params, body }) => {
      const fields = fieldsOf(await body(), allowed);
      if (typeof fields === "string") return refused(400, fields);
      return decide(lessonOf(params[0]!), fields);
    },
  });
  const reasoned = (verb: "reject" | "retire") => (id: string, fields: Record<string, unknown>): Promise<Response> | Response => {
    if (typeof fields.reason !== "string") return refused(400, "reason must be text");
    const reason = fields.reason;
    return refusing(() => inLine(() => {
      const by = { actor: d.human(), reason, secrets: d.secrets() };
      const l = verb === "reject" ? d.wb.memory.reject(id, by) : d.wb.memory.retire(id, by);
      return json(200, { id: l.id, status: l.status });
    }));
  };

  return [
    { method: "GET", path: /^\/api\/memory$/, needs: { read: "memory" }, kind: "api", handle: () => refusing(async () => json(200, await memoryView(d))) },
    {
      method: "GET", path: /^\/api\/cases\/([^/]+)\/memory$/, needs: { read: "memory" }, kind: "api",
      handle: ({ params, url }) => {
        const given = url.searchParams.get("at");
        if (given !== null && !/^[1-9]\d{0,9}$/.test(given)) return refused(400, "at must be an entry's number");
        return refusing(() => json(200, caseMemoryView(d, params[0]!, given === null ? null : Number(given))));
      },
    },
    {
      method: "POST", path: /^\/api\/memory\/lessons$/, needs: { command: "propose_lesson" }, kind: "api",
      handle: async ({ body }) => {
        const fields = fieldsOf(await body(), PROPOSAL_FIELDS);
        if (typeof fields === "string") return refused(400, fields);
        const made = proposalOf(fields);
        if (typeof made === "string") return refused(400, made);
        const { draft } = made;
        const origin = made.case === null ? null : caseOrigin(d, made.case);
        return refusing(() => inLine(() => {
          if (origin !== null && rank(draft.marking) < rank(origin.floor)) throw new MemoryRefused(`a lesson from ${made.case} is marked at least ${origin.floor}`);
          const { lesson } = d.wb.memory.propose(draft, origin?.from ?? { kind: "person" }, d.human(), {
            secrets: d.secrets(), case_types: (d.deps.case_types ?? []).map((t) => t.id), observables: d.deps.registry.types().map((t) => t.id),
          });
          return json(200, { id: lesson.id });
        }));
      },
    },
    deciding(/^\/api\/memory\/lessons\/([^/]+)\/accept$/, "accept_lesson", ["hash", "marking"], (id, fields) => {
      if (typeof fields.hash !== "string") return refused(400, "hash must be the hash of the proposal you saw");
      if (fields.marking !== undefined && !isMarking(fields.marking)) return refused(400, "marking must be a marking");
      const hash = fields.hash;
      const marking = fields.marking as Marking | undefined;
      return refusing(() => inLine(() => {
        const l = d.wb.memory.accept(id, { actor: d.human(), hash, ...(marking === undefined ? {} : { marking }) });
        return json(200, { id: l.id, status: l.status });
      }));
    }),
    deciding(/^\/api\/memory\/lessons\/([^/]+)\/reject$/, "reject_lesson", ["reason"], reasoned("reject")),
    deciding(/^\/api\/memory\/lessons\/([^/]+)\/retire$/, "retire_lesson", ["reason"], reasoned("retire")),
    {
      method: "POST", path: /^\/api\/memory\/export$/, needs: { command: "export_memory" }, kind: "api",
      handle: async ({ body }) => {
        const fields = fieldsOf(await body(), []);
        if (typeof fields === "string") return refused(400, fields);
        return refusing(() => inLine(async () => {
          mkdirSync(d.config.memory.files, { recursive: true });
          const made = await d.wb.exportMemory(d.config.memory.files, { actor: d.human() });
          return json(200, { file: made.file });
        }));
      },
    },
    {
      method: "POST", path: /^\/api\/memory\/load$/, needs: { command: "load_memory" }, kind: "api",
      handle: async ({ body }) => {
        const fields = fieldsOf(await body(), ["file", "typed"]);
        if (typeof fields === "string") return refused(400, fields);
        const file = memoryFileOf(fields.file);
        if (file === null) return refused(400, NOT_A_FILE);
        if (typeof fields.typed !== "string") return refused(400, "typed must be text");
        const typed = fields.typed;
        return refusing(() => inLine(async () => {
          // a run reads the store when it binds: none may be running while the store is replaced
          const running = d.wb.listCases().filter((c) => c.run_status === "running").map((c) => c.id);
          if (running.length > 0) throw new MemoryRefused(`a memory store is not loaded while a run is running (${running.join(", ")}); pause or stop it first`);
          const at = join(d.config.memory.files, file);
          const m = await checkMemoryFile(at);
          if (typed.trim().toLowerCase() !== m.head.hash.slice(0, 12)) throw new MemoryRefused("the characters typed are not the first 12 of the file's head; nothing was loaded");
          const done = await d.wb.loadMemory(at, { actor: d.human() });
          return json(200, { lessons: done.lessons });
        }));
      },
    },
    {
      method: "GET", path: /^\/api\/memory\/files\/([^/]+)$/, needs: { read: "memory" }, kind: "download",
      handle: ({ params }) => {
        const file = memoryFileOf(decoded(params[0]!));
        if (file === null) return refused(400, NOT_A_FILE);
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(join(d.config.memory.files, file));
        } catch {
          return refused(404, "there is no such memory file");
        }
        return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${file}"` } });
      },
    },
  ];
}
