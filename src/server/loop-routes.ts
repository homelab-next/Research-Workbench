// The Loops page's routes (slice 12): loops as a resource beside cases. They read the loops the registry resolved, copy and save a loop into
// the trusted root, export a loop file into the loop store, import one from it, and trust an imported root. They are routes of their own, not
// case commands, each in app.ts's route table behind the same guard and role check as every other; the server names the actor, so no body may.
// Every path in an answer is root-relative or a bare file name.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { isPlainObject } from "../core/canonical";
import type { Json } from "../core/canonical";
import { checkLoopFile, parseLoopFileName } from "../core/loopfile";
import { Refused } from "../core/refused";
import type { Actor } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { ItemView, LoopFileView, LoopStageView, LoopSummaryView, LoopView } from "../core/wire";
import type { Config } from "../modules/config";
import { saveTrustedRoot } from "../modules/config-write";
import { exportLoop, importLoop, planImport, trustProblems } from "../modules/loop-import";
import { checkChange, copyLoop, draftOf, loopText, saveLoop, writeRoot } from "../modules/loop-write";
import type { LoopDraft, SaveDeps } from "../modules/loop-write";
import { parseManifestFile } from "../modules/manifests";
import type { Registry } from "../modules/registry";
import { CHECK_SCRIPT } from "../pipeline/components";
import type { ResolvedItem } from "../pipeline/components";
import type { EngineDeps } from "../pipeline/engine";
import { IMPLICIT_NOTE } from "../pipeline/loops";
import type { LoopCatalog, LoopManifest, ResolvedLoop } from "../pipeline/loops";
import type { StageManifest } from "../pipeline/manifests";
import { SEND_BACK_CAP } from "../pipeline/next";
import type { CaseHub } from "./hub";
import type { Reading } from "./roles";

export interface LoopRouteDeps {
  config: Config; wb: Workbench; hub: CaseHub; deps: EngineDeps; human: () => Extract<Actor, { kind: "human" }>;
  /** A reason as the person may see it (app.ts's `shown`). */
  shown: (text: string) => string;
  /** Loads the roots again in place (compose's reload); returns the new problems. */
  reload: () => string[];
  /** The value of every secret the workbench holds, for the search a save and an export make. */
  secrets: () => readonly string[];
}
/** What a handler is given, as app.ts gives it. */
export interface LoopCall { url: URL; params: string[]; body(): Promise<unknown> }
export interface LoopRoute {
  method: "GET" | "POST"; path: RegExp; needs: { read: Reading } | { command: string }; kind: "api" | "download";
  handle(call: LoopCall): Response | Promise<Response>;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });
const lt = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

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

// ---------- views ----------

const BUILT_IN = {
  query_guard: { kind: "built-in", id: "query-guard", title: "The query guard", source: "built-in", hash: null },
  marking_policy: { kind: "built-in", id: "marking-policy", title: "The marking policy", source: "built-in", hash: null },
  citation_check: { kind: "built-in", id: "citation-check", title: "The citation check", source: "built-in", hash: null },
} as const satisfies Record<string, ItemView>;
/** The tools whose queries go through runQuery, and so through the guard. */
const QUERY_TOOLS: readonly string[] = ["run_query", "run_pivot", "run_step", "verify_card"];
/** The order the Context list gives its kinds. */
const CONTEXT_ORDER = ["persona", "rules", "goal", "procedure", "skill", "reference", "gate", "schema", "framework", "standard"];
const MIDDLEWARE_KINDS: readonly string[] = ["check", CHECK_SCRIPT];

/** The folder name of the root a loop comes from. */
function rootName(d: LoopRouteDeps, registry: Registry, id: string, man: LoopManifest | null): string {
  if (man !== null && man.root !== null) return basename(man.root);
  if (man !== null) {
    try { return basename(writeRoot(d.config, man)); } catch { return ""; }
  }
  // a loop file the registry refused: the root of that file
  for (const p of registry.problems) {
    try {
      const parsed = parseManifestFile(p.path, readFileSync(p.path));
      if (parsed.kind === "loop" && parsed.body.id === id) return basename(p.root);
    } catch { /* not a manifest */ }
  }
  return "";
}

/** Whether a loop comes from a root the configuration trusts. A loop file the registry refused (an imported one, say) is not trusted. */
function trustedOf(man: LoopManifest | null, config: Config): boolean {
  if (man === null) return false;
  if (man.root === null) return man.implicit;
  return config.roots.some((r) => r.trusted && resolve(r.path) === resolve(man.root!));
}

function summaryOf(d: LoopRouteDeps, x: ReturnType<LoopCatalog["list"]>[number]): LoopSummaryView {
  const { registry } = d.deps;
  const man = x.manifest;
  const stages = x.loop !== null ? x.loop.pipeline.stages.map((s) => s.id) : (man?.stages ?? []).map((s) => (typeof s === "string" ? s : String(s.id)));
  const root = rootName(d, registry, x.id, man);
  return {
    id: x.id, title: d.shown(man?.title ?? x.id), about: d.shown(man?.about ?? ""), version: man?.version ?? null, hash: x.loop?.pipeline.hash ?? null, stages,
    usable: x.loop !== null, problems: x.problems.filter((p) => p !== IMPLICIT_NOTE).map(d.shown), implicit: man?.implicit === true,
    trusted: trustedOf(man, d.config), root,
  };
}

const item = (d: LoopRouteDeps, i: ResolvedItem): ItemView => ({ kind: i.kind, id: i.id, title: d.shown(i.title), source: i.source, hash: i.hash });
const returnText = (r: NonNullable<StageManifest["subloop"]>["returns"][string]): string => (r.as === "cards" ? "cards" : `draft_section:${r.section}`);

function stageView(d: LoopRouteDeps, loop: ResolvedLoop, stage: StageManifest): LoopStageView {
  const items = loop.lock.items;
  const own = items.filter((i) => i.stage === stage.id && i.kind !== "stage");
  const shared = items.filter((i) => i.stage === "*" && ["rules", "framework", "standard"].includes(i.kind));
  const context: ItemView[] = [...own.filter((i) => !MIDDLEWARE_KINDS.includes(i.kind)), ...shared].map((i) => item(d, i));
  const entry = stage.runs === "loop" || !Object.hasOwn(loop.profile.stages, stage.id) ? null : loop.profile.stages[stage.id]!;
  if (entry !== null) {
    const profile = items.find((i) => i.stage === "*" && i.kind === "profile");
    context.push({ kind: "goal", id: stage.id, title: d.shown(entry.goal), source: profile?.source ?? "root", hash: profile?.hash ?? null });
  }
  context.sort((a, b) => CONTEXT_ORDER.indexOf(a.kind) - CONTEXT_ORDER.indexOf(b.kind));
  const middleware: ItemView[] = own.filter((i) => MIDDLEWARE_KINDS.includes(i.kind)).map((i) => item(d, i));
  if (stage.tools.some((t) => QUERY_TOOLS.includes(t))) middleware.push({ ...BUILT_IN.query_guard });
  if (stage.runs === "agent") middleware.push({ ...BUILT_IN.marking_policy });
  if (stage.reviews) middleware.push({ ...BUILT_IN.citation_check });
  const sub = stage.subloop ?? null;
  const self = items.find((i) => i.stage === stage.id && i.kind === "stage");
  return {
    id: stage.id, title: d.shown(stage.title), runs: stage.runs, role: stage.role, gate: stage.gate, reviews: stage.reviews, on_pass: stage.on_pass, on_fail: stage.on_fail,
    hash: stage.hash, inline: self?.source === "inline", context, middleware,
    orchestration: {
      tools: [...stage.tools], model: stage.model, fast_model: stage.fast_model ?? null, max_turns: stage.max_turns ?? null, send_back_cap: SEND_BACK_CAP,
      subloop: sub === null ? null : {
        loop: sub.loop, hash: loop.lock.subloops.find((x) => x.stage === stage.id)?.hash ?? null, inputs: { ...sub.inputs },
        returns: Object.fromEntries(Object.entries(sub.returns).map(([k, r]) => [k, returnText(r)])),
      },
    },
  };
}

function viewOf(d: LoopRouteDeps, x: ReturnType<LoopCatalog["list"]>[number]): LoopView {
  const summary = summaryOf(d, x);
  const man = x.manifest;
  const loop = x.loop;
  return {
    ...summary,
    entry: loop?.pipeline.stages[0]?.id ?? (man?.entry || null), profile: man?.profile ?? null,
    inputs: man === null ? {} : Object.fromEntries(Object.entries(man.inputs).map(([k, v]) => [k, { type: v.type, required: v.required }])),
    outputs: man === null ? {} : Object.fromEntries(Object.entries(man.outputs).map(([k, v]) => [k, { from: v.from }])),
    stage_views: loop === null ? [] : loop.pipeline.stages.map((s) => stageView(d, loop, s)),
    caps: { max_depth: d.config.loops.max_depth, max_children: d.config.loops.max_children },
    draft: loop === null ? null : (draftOf(loop) as unknown as Json),
  };
}

// ---------- the loop store ----------

function fileView(d: LoopRouteDeps, file: string, plan: { write: number; same: number; conflicts: string[] } | null, problem: string | null, m: Awaited<ReturnType<typeof checkLoopFile>> | null): LoopFileView {
  const parsed = parseLoopFileName(file)!;
  let bytes = 0;
  try { bytes = statSync(join(d.config.loops.store, file)).size; } catch { /* gone since it was listed */ }
  return {
    file, loop: m?.loop ?? parsed.loop, version: m?.version ?? parsed.version, title: d.shown(m?.title ?? parsed.loop), hash: m?.hash ?? parsed.hash12,
    files: m?.files.length ?? 0, bytes, plan, problem: problem === null ? null : d.shown(problem),
  };
}

async function listFiles(d: LoopRouteDeps): Promise<LoopFileView[]> {
  let names: string[];
  try {
    names = readdirSync(d.config.loops.store, { withFileTypes: true }).filter((e) => e.isFile() && parseLoopFileName(e.name) !== null).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: unknown }).code === "ENOENT") return [];
    throw err;
  }
  const out: LoopFileView[] = [];
  for (const file of names.sort(lt)) {
    const at = join(d.config.loops.store, file);
    let m: Awaited<ReturnType<typeof checkLoopFile>> | null = null;
    try {
      m = await checkLoopFile(at);
      const plan = await planImport(at, d.deps.registry, d.config.loops.imports);
      out.push(fileView(d, file, { write: plan.write.length, same: plan.same.length, conflicts: plan.conflicts.map((c) => `${c.kind} "${c.id}" (${c.file}) is already loaded with other content`) }, null, m));
    } catch (err) {
      if (!(err instanceof Refused)) throw err;
      out.push(fileView(d, file, null, err.reasons[0] ?? err.message, m));
    }
  }
  return out;
}

/** The loop file a route names, or the refusal: a name outside parseLoopFileName (a separator, a leading dot, another ending) is refused. */
const loopFileOf = (raw: string): string | Response => {
  const file = decoded(raw);
  if (file === null || parseLoopFileName(file) === null) return refused(400, "that is not a loop file's name");
  return file;
};

// ---------- the drafts a person sends ----------

const DRAFT_STRINGS = ["id", "title", "about", "profile", "entry"] as const;
const DRAFT_FIELDS = [...DRAFT_STRINGS, "stages", "inputs", "outputs", "components", "uses", "case_type"];
/** A draft from a body, or why it is not one. */
function draftFrom(x: unknown, id: string): LoopDraft | string {
  if (!isPlainObject(x)) return "the draft must be a JSON object";
  const extra = Object.keys(x).find((k) => !DRAFT_FIELDS.includes(k));
  if (extra !== undefined) return `the draft has a field a loop does not: ${extra.slice(0, 40)}`;
  for (const f of DRAFT_STRINGS) if (typeof x[f] !== "string") return `the draft's ${f} must be text`;
  if (!Array.isArray(x.stages) || !x.stages.every((s) => isPlainObject(s))) return "the draft's stages must be a list of stages";
  if (x.id !== id) return `the draft is of loop "${String(x.id).slice(0, 64)}", not "${id}"`;
  if (x.case_type !== undefined && x.case_type !== null && typeof x.case_type !== "string") return "the draft's case_type must be text or null";
  const at = (k: string): Json => (Object.hasOwn(x, k) ? (x[k] as Json) : {});
  return {
    id: x.id as string, title: x.title as string, about: x.about as string, profile: x.profile as string, entry: x.entry as string,
    stages: x.stages as Record<string, Json>[], inputs: at("inputs"), outputs: at("outputs"), components: at("components"), uses: at("uses"),
    case_type: typeof x.case_type === "string" ? x.case_type : null,
  };
}

// ---------- the routes ----------

/** The routes of the Loops page, for app.ts's table. */
export function loopRoutes(d: LoopRouteDeps): LoopRoute[] {
  const loops = (): LoopCatalog => {
    const have = d.deps.loops;
    if (have === undefined) throw new Refused("this workbench has no loops");
    return have;
  };
  const entryOf = (id: string): ReturnType<LoopCatalog["list"]>[number] | null => loops().list().find((x) => x.id === id) ?? null;
  const saveDeps = (): SaveDeps & { loops: LoopCatalog } => ({ config: d.config, chain: d.wb.chain, content: d.wb.chainBlobs, secrets: d.secrets(), loops: loops() });
  /** A refusal of a loop, a save, a loop file or the configuration is 409; anything else is the caller's to answer. */
  const refusing = async (work: () => Promise<Response> | Response): Promise<Response> => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof Refused) return refused(409, ...error.reasons.map(d.shown));
      throw error;
    }
  };
  const idOf = (raw: string): string | null => decoded(raw);
  const known = (raw: string): string | Response => {
    const id = idOf(raw);
    if (id === null || entryOf(id) === null) return refused(404, `there is no loop "${(id ?? raw).slice(0, 64)}"`);
    return id;
  };
  const ok = (...why: string[]): Response => refused(409, ...why.map(d.shown));

  return [
    { method: "GET", path: /^\/api\/loops$/, needs: { read: "loops" }, kind: "api", handle: () => json(200, loops().list().map((x) => summaryOf(d, x))) },
    {
      method: "GET", path: /^\/api\/loops\/([^/]+)$/, needs: { read: "loops" }, kind: "api",
      handle: ({ params }) => {
        const id = known(params[0]!);
        return typeof id === "string" ? json(200, viewOf(d, entryOf(id)!)) : id;
      },
    },
    {
      method: "POST", path: /^\/api\/loops\/([^/]+)\/copy$/, needs: { command: "copy_loop" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["id", "title"]);
        if (typeof fields === "string") return refused(400, fields);
        if (typeof fields.id !== "string" || typeof fields.title !== "string") return refused(400, "a copy needs an id and a title, both text");
        const from = known(params[0]!);
        if (typeof from !== "string") return from;
        const to = fields.id;
        const title = fields.title;
        return refusing(() => {
          const check = copyLoop(saveDeps(), from, to, title, { actor: d.human() });
          if (!check.ok) return ok(...check.problems);
          d.reload();
          return json(200, { id: to });
        });
      },
    },
    {
      method: "POST", path: /^\/api\/loops\/([^/]+)\/save$/, needs: { command: "save_loop" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["draft", "version"]);
        if (typeof fields === "string") return refused(400, fields);
        const id = idOf(params[0]!);
        if (id === null) return refused(404, "there is no such loop");
        const version = fields.version;
        if (!(version === null || (typeof version === "number" && Number.isInteger(version) && version >= 1))) return refused(400, "version is the version the screen loaded, a whole number, or null for a new loop");
        const draft = draftFrom(fields.draft, id);
        if (typeof draft === "string") return refused(400, draft);
        return refusing(() => {
          const check = saveLoop(saveDeps(), draft, version, { actor: d.human() });
          if (!check.ok) return ok(...check.problems);
          d.reload();
          const now = loops().current(id);
          return json(200, { id, version: (version ?? 0) + 1, hash: now?.pipeline.hash ?? null });
        });
      },
    },
    {
      method: "POST", path: /^\/api\/loops\/([^/]+)\/check$/, needs: { command: "save_loop" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), ["draft"]);
        if (typeof fields === "string") return refused(400, fields);
        const id = idOf(params[0]!);
        if (id === null) return refused(404, "there is no such loop");
        const draft = draftFrom(fields.draft, id);
        if (typeof draft === "string") return refused(400, draft);
        return refusing(() => {
          // the check a save makes, on the same root and path, with the version a save would write; nothing is written
          const man = entryOf(id)?.manifest ?? null;
          const root = writeRoot(d.config, man);
          const path = man !== null && !man.implicit && man.root !== null && man.path !== null && resolve(man.root) === resolve(root) ? man.path : `loops/${id}.yaml`;
          const check = checkChange(saveDeps(), root, [{ path, text: loopText(draft, (man?.version ?? 0) + 1, entryOf(id)?.loop ?? null) }]);
          return json(200, { ok: check.ok, problems: check.problems.map(d.shown) });
        });
      },
    },
    {
      method: "POST", path: /^\/api\/loops\/([^/]+)\/export$/, needs: { command: "export_loop" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), []);
        if (typeof fields === "string") return refused(400, fields);
        const id = known(params[0]!);
        if (typeof id !== "string") return id;
        return refusing(async () => {
          const made = await exportLoop({ loops: loops(), registry: d.deps.registry, secrets: d.secrets() }, id, d.config.loops.store);
          return json(200, { file: made.file });
        });
      },
    },
    { method: "GET", path: /^\/api\/loop-files$/, needs: { read: "loop_files" }, kind: "api", handle: async () => json(200, await listFiles(d)) },
    {
      method: "GET", path: /^\/api\/loop-files\/([^/]+)$/, needs: { read: "loop_files" }, kind: "download",
      handle: ({ params }) => {
        const file = loopFileOf(params[0]!);
        if (typeof file !== "string") return file;
        let bytes: Uint8Array;
        try {
          bytes = readFileSync(join(d.config.loops.store, file));
        } catch {
          return refused(404, "there is no such loop file in the loop store");
        }
        return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${file}"` } });
      },
    },
    {
      method: "POST", path: /^\/api\/loop-files\/([^/]+)\/import$/, needs: { command: "import_loop" }, kind: "api",
      handle: async ({ params, body }) => {
        const fields = fieldsOf(await body(), []);
        if (typeof fields === "string") return refused(400, fields);
        const file = loopFileOf(params[0]!);
        if (typeof file !== "string") return file;
        return refusing(async () => {
          const done = await importLoop(join(d.config.loops.store, file), d.deps.registry, d.config.loops.imports);
          d.reload();
          return json(200, { root: basename(done.root), written: done.written.length, same: done.same.length });
        });
      },
    },
    {
      method: "POST", path: /^\/api\/roots\/trust$/, needs: { command: "trust_root" }, kind: "api",
      handle: async ({ body }) => {
        const fields = fieldsOf(await body(), ["root", "typed"]);
        if (typeof fields === "string") return refused(400, fields);
        if (typeof fields.root !== "string" || typeof fields.typed !== "string") return refused(400, "trust needs the root's folder name and the name typed, both text");
        const name = fields.root;
        if (fields.typed !== name) return ok("the name typed is not the folder's name; nothing was changed");
        if (parseLoopFolder(name) === null) return ok("that is not the name of an imported folder");
        const at = join(d.config.loops.imports, name);
        let isDir = false;
        try { isDir = statSync(at).isDirectory(); } catch { isDir = false; }
        if (!isDir) return ok(`there is no imported folder "${name}"`);
        if (d.config.roots.some((r) => resolve(r.path) === resolve(at))) return ok(`the root "${name}" is already in the configuration`);
        const clash = trustProblems(resolve(at), d.deps.registry);
        if (clash.length > 0) return ok(`the folder is not trusted: ${clash.join("; ")}`);
        return refusing(() => {
          saveTrustedRoot(d.config, resolve(at));
          d.reload();
          return json(200, { ok: true });
        });
      },
    },
  ];
}

/** A bare folder name as an import makes them: no separator, no leading dot. Null when it is not one. */
function parseLoopFolder(name: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(name) && !name.includes("..") ? name : null;
}
