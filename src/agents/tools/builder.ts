// The loop builder's seven tools (slice 12, part B): read the catalogue, check a manifest, propose a checked change, ask for a probe.
// None is a stage's. Each refuses outside a builder session. None writes into a root, reads a credential's value or contacts a source: a
// proposal is only an entry and a blob of the session, which a person accepts file by file; a probe is only a question, which a person
// approves and the server runs at the one custody point. Every view is shown to the model as data: text from a root that is not trusted is withheld,
// and every string passes through scrub and the search for each secret value the workbench holds.
import { catalogueOf } from "pivot/catalogue/views";
import type { Json } from "../../core/canonical";
import type { Schema } from "../../core/schema";
import { canonical, isPlainObject } from "../../core/canonical";
import { builderOpen } from "../../core/state";
import type { CaseState } from "../../core/state";
import type { Observable, TimeWindow } from "../../core/types";
import { parseManifestFile } from "../../modules/manifests";
import { MIN_SECRET_LENGTH } from "../../modules/secrets";
import type { BuilderTools, ManifestFile, ToolContext, ToolDef, ToolResult } from "./index";
import { idArg, MAX_ID, MAX_TEXT, params, scrub, str, ToolError } from "./kit";

/** The refusal of a file, a question or a probe that holds a credential: it never repeats the value. */
export const CREDENTIAL_REFUSAL = "a credential is named by reference; set its value outside the workbench";
const NOT_HERE = "this tool is the loop builder's";
const ONE_PROBE = "one probe at a time; the person has not decided the last";
const WAITING = "waiting for the person's approval";
const IMPROVE_PROBES = "a probe is the improve loop's own";
const HIDDEN = "[hidden]";
/** The marks that stand for text kept from the model: scrub's and the redaction of a secret a person or a model wrote. */
const MARKS = [HIDDEN, "[redacted secret]"] as const;
/** The refusal of a file that holds one of the marks: written into a root, it would replace the real value with the mark. */
export const MARK_REFUSAL = "it holds the mark of text kept from you; propose the file without it and leave that value to the person";
const BUILD_ID = /^BUILD-[1-9][0-9]{0,8}$/;
/** The keys whose value is a credential, wherever they are in a manifest. */
const CREDENTIAL_KEYS: ReadonlySet<string> = new Set(["password", "token", "secret", "api_key", "apikey"]);
const KEY_LINE = /^(\s*(?:-\s+)?["']?(?:password|token|secret|api_key|apikey)["']?\s*:\s*)(\S.*)$/gim;
/** The most files one proposal holds, and the longest text of one. */
const MAX_FILES = 12;
const MAX_FILE_TEXT = 65536;
const MAX_PATH = 512;

/**
 * The builder's context, or the refusal every builder tool gives elsewhere: in a case, or in a builder session the server did not set up. An
 * improve run's proposer (`improve` set) is taken only in a case that has an improve request, and never in a builder session.
 */
function need(ctx: ToolContext): BuilderTools {
  const b = ctx.builder;
  if (b === undefined) throw new ToolError(NOT_HERE);
  if (b.improve !== undefined) {
    if (ctx.session.state.improve.request === null) throw new ToolError(NOT_HERE);
    return b;
  }
  if (!BUILD_ID.test(ctx.session.state.meta?.id ?? "")) throw new ToolError(NOT_HERE);
  return b;
}

/** The changes proposed in this improve run: those after its selection (every one, before a selection). */
const proposedInRun = (s: Readonly<CaseState>): number => {
  const after = s.improve.selected?.seq ?? 0;
  return Object.values(s.builder.changes).filter((c) => c.seq > after).length;
};
const atMost = (n: number): string => `this improve run takes at most ${n} candidates`;

const holdsSecret = (text: string, secrets: readonly string[]): boolean => secrets.some((s) => s.length >= MIN_SECRET_LENGTH && text.includes(s));

/** Every secret value replaced, and the value of any credential-named key: the text as the model may read it. */
export function hideCredentials(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of [...secrets].filter((x) => x.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length)) out = out.split(s).join(HIDDEN);
  return out.replace(KEY_LINE, (_m, key: string) => `${key}${HIDDEN}`);
}

function hasCredentialKey(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(hasCredentialKey);
  if (!isPlainObject(x)) return false;
  return Object.entries(x).some(([k, v]) => CREDENTIAL_KEYS.has(k.toLowerCase()) || hasCredentialKey(v));
}

/** Whether a file holds a credential: a secret value anywhere in it, or a credential-named key at any depth (by line when it does not parse). */
function holdsCredential(file: ManifestFile, secrets: readonly string[]): boolean {
  if (holdsSecret(file.text, secrets) || holdsSecret(file.path, secrets)) return true;
  let body: unknown;
  try {
    body = parseManifestFile(file.path, new TextEncoder().encode(file.text)).body;
  } catch {
    KEY_LINE.lastIndex = 0;
    const hit = KEY_LINE.test(file.text);
    KEY_LINE.lastIndex = 0;
    return hit;
  }
  return hasCredentialKey(body);
}

/** Every string of a view with each secret value hidden and, unless `registry` is false, every source's location, host, user and path too. */
function shown(ctx: ToolContext, b: BuilderTools, x: unknown, opts: { registry: boolean } = { registry: true }): Json {
  const text = (t: string): string => {
    const hidden = hideCredentials(t, b.secrets);
    return opts.registry ? scrub(ctx.deps.registry, hidden) : hidden;
  };
  const walk = (v: unknown): Json => {
    if (typeof v === "string") return text(v);
    if (Array.isArray(v)) return v.map(walk);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, w]) => [k, walk(w)]));
    return v as Json;
  };
  return walk(x);
}

const ok = (summary: string, view: Json): ToolResult => ({ ok: true, summary, view, marking: null });

/** The files of a tool call, as given. */
function filesOf(args: Record<string, Json>): ManifestFile[] {
  return (args.files as { path: string; text: string }[]).map((f) => ({ path: f.path, text: f.text }));
}

/** The credential check, then the save's own check; the problems as the model may read them. */
function checked(ctx: ToolContext, b: BuilderTools, files: ManifestFile[]): { ok: boolean; problems: string[]; files: { path: string; kind: string; id: string; hash: string; before: string | null }[] } {
  const leaked = files.filter((f) => holdsCredential(f, b.secrets));
  if (leaked.length > 0) {
    // a path that itself holds a value is not repeated either
    return { ok: false, problems: leaked.map((f) => `${holdsSecret(f.path, b.secrets) ? "a file" : f.path}: ${CREDENTIAL_REFUSAL}`), files: [] };
  }
  // a file copied from a scrubbed view holds the mark where the real text was: it is never proposed
  const marked = files.filter((f) => MARKS.some((m) => f.text.includes(m) || f.path.includes(m)));
  if (marked.length > 0) return { ok: false, problems: marked.map((f) => `${f.path}: ${MARK_REFUSAL}`), files: [] };
  const check = b.check(files);
  const problems = shown(ctx, b, check.problems) as string[];
  // the files a save would write besides these (the implicit loop made explicit) are the save's, not the proposal's
  const given = new Set(files.map((f) => f.path));
  return { ok: check.ok && problems.length === 0, problems, files: check.ok ? check.files.filter((f) => given.has(f.path)) : [] };
}

// ---------- read ----------

async function loopCatalogue(ctx: ToolContext): Promise<ToolResult> {
  const b = need(ctx);
  const loops = b.loops();
  return ok(`${loops.length} loops`, shown(ctx, b, { loops }));
}

async function adapterCatalogue(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const b = need(ctx);
  const cat = catalogueOf(ctx.deps.registry);
  const id = str(args.source);
  if (id === "") return ok(`${cat.adapters.length} adapters, ${cat.pivots.length} pivots, ${cat.playbooks.length} playbooks`, shown(ctx, b, cat));
  const adapter = cat.adapters.find((a) => a.id === id);
  if (adapter === undefined) throw new ToolError(`unknown source: ${id}`);
  const one = { types: cat.types, adapters: [adapter], pivots: cat.pivots.filter((p) => p.source === id), playbooks: [], inventories: cat.inventories.filter((i) => adapter.inventories.includes(i.id)), problems: [] };
  return ok(`${id}: ${one.pivots.length} pivots`, shown(ctx, b, one));
}

/** The connector kinds a source manifest may name: what each needs, whether only a trusted root may supply one, and how its credential is named. */
const CONNECTORS = [
  {
    kind: "sql", about: "a SQLite database file", trusted_only: false,
    needs: ["location", "tables"], location: "the database file, relative to the manifest and inside the root",
    credential: "none: a SQLite file has no sign-in. A credential: <name> is accepted only from a trusted root",
    list_tables: "SELECT name FROM sqlite_master WHERE type = 'table'",
  },
  {
    kind: "files", about: "a folder of CSV or JSON-lines files", trusted_only: false,
    needs: ["location", "tables"], location: "the folder, relative to the manifest and inside the root; each table names its file and format (csv or jsonl)",
    credential: "none: files have no sign-in. A credential: <name> is accepted only from a trusted root",
    list_tables: null,
  },
  {
    kind: "http", about: "a JSON service over HTTP, such as an MCP server's or a lookup API", trusted_only: true,
    needs: ["location", "endpoints"], location: "the service's base URL; each endpoint names its method, path ({value} is the bound value) and the field its rows are in",
    credential: "credential: <name>, sent as a bearer token; the person grants <name> to the root in the configuration and sets its value in the secrets file or the environment",
    list_tables: null,
  },
  {
    kind: "trino", about: "a Trino (or Starburst) SQL engine over a lake", trusted_only: true,
    needs: ["location", "user", "tables"], location: "the engine's URL; cost.unit must be rows",
    credential: "credential: <name>, the password sent with user; the person grants <name> to the root in the configuration and sets its value in the secrets file or the environment",
    list_tables: "SHOW TABLES FROM <catalog>.<schema>",
  },
  {
    kind: "fakeathena", about: "a synthetic lake file made by pivot's generator, billed as a lake would be", trusted_only: true,
    needs: ["location", "tables"], location: "the lake file, relative to the manifest; cost.unit must be USD",
    credential: "none: the file has no sign-in",
    list_tables: null,
  },
] as const;

async function listConnectors(ctx: ToolContext): Promise<ToolResult> {
  const b = need(ctx);
  return ok(`${CONNECTORS.length} connector kinds`, shown(ctx, b, { connectors: CONNECTORS }, { registry: false }));
}

async function listRoots(ctx: ToolContext): Promise<ToolResult> {
  const b = need(ctx);
  const roots = b.roots().map((r) => ({ name: r.name, trusted: r.trusted, writable: r.writable, credentials: [...r.credentials], imported: r.imported }));
  // credential names are shown here, so the registry's scrub (which hides them elsewhere) is not run; no value is ever in this view
  return ok(`${roots.length} roots`, shown(ctx, b, { write_root: b.root, roots }, { registry: false }));
}

async function validateManifest(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const b = need(ctx);
  const r = checked(ctx, b, [{ path: str(args.path), text: str(args.text) }]);
  const files = r.files.map((f) => ({ path: f.path, kind: f.kind, id: f.id, new_file: f.before === null }));
  return ok(r.ok ? "ok" : `${r.problems.length} problems: ${r.problems.join("; ")}`, shown(ctx, b, { ok: r.ok, problems: r.problems, files }));
}

// ---------- propose ----------

async function proposeChange(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const b = need(ctx);
  const limit = b.improve?.max ?? null;
  if (limit !== null && proposedInRun(ctx.session.state) >= limit) throw new ToolError(atMost(limit));
  const files = filesOf(args);
  const title = str(args.title);
  if (holdsSecret(title, b.secrets) || holdsSecret(str(args.why), b.secrets)) throw new ToolError(CREDENTIAL_REFUSAL);
  const r = checked(ctx, b, files);
  if (!r.ok) throw new ToolError(r.problems.join("; "));
  const byPath = new Map(r.files.map((f) => [f.path, f]));
  const proposed = files.map((f) => {
    const c = byPath.get(f.path);
    if (c === undefined) throw new ToolError(`${f.path}: the save's check did not name this file`);
    return { path: f.path, kind: c.kind, id: c.id, before: c.before, after: c.hash };
  });
  const bundle = ctx.session.blobs.put(canonical({ files: files.map((f) => ({ path: f.path, text: f.text })) } as Json), "application/json");
  let change = "";
  ctx.session.commit((s, ids) => {
    // checked again in the commit: two calls of one reply cannot both take the last candidate
    if (limit !== null && proposedInRun(s) >= limit) throw new ToolError(atMost(limit));
    change = ids.next("change");
    return [{ type: "builder.proposed", actor: ctx.actor, payload: { change, title, why: str(args.why), root: b.root, files: proposed, bundle } }];
  });
  const view = { change, status: "the person accepts or rejects each file; nothing is written until then", files: proposed.map((f) => ({ path: f.path, kind: f.kind, id: f.id, new_file: f.before === null })) };
  return ok(`proposed ${change}: ${proposed.length === 1 ? "1 file" : `${proposed.length} files`}; waiting for the person`, shown(ctx, b, view));
}

// ---------- probe ----------

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

function windowOf(ctx: ToolContext, raw: Json | undefined): TimeWindow {
  if (raw === undefined) return { from: ctx.window.from, to: ctx.window.to };
  const w = raw as { from: string | null; to: string | null };
  for (const v of [w.from, w.to]) if (v !== null && !(ISO.test(v) && !Number.isNaN(Date.parse(v)))) throw new ToolError("a window's ends are UTC times like 2026-11-17T00:00:00.000Z, or null");
  if (w.from !== null && w.to !== null && !(w.from < w.to)) throw new ToolError("a window ends after it begins");
  return { from: w.from, to: w.to };
}

async function requestProbe(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> {
  const b = need(ctx);
  if (b.improve !== undefined) throw new ToolError(IMPROVE_PROBES);
  if (builderOpen(ctx.session.state).probes.length > 0) throw new ToolError(ONE_PROBE);
  const kind = str(args.kind) as "pivot" | "query";
  const sourceId = str(args.source);
  const given = (k: string): boolean => Object.hasOwn(args, k);
  for (const k of ["source", "pivot", "value", "text", "why"]) if (holdsSecret(str(args[k]), b.secrets)) throw new ToolError(CREDENTIAL_REFUSAL);
  const source = ctx.deps.registry.source(sourceId);
  if (source === null) throw new ToolError(`unknown source: ${sourceId}`);
  const window = windowOf(ctx, args.window);
  let pivot: string | null = null;
  let value: Observable | null = null;
  let text: string | null = null;
  if (kind === "pivot") {
    if (!given("pivot") || !given("value") || given("text")) throw new ToolError("a pivot probe names a pivot and a value, and no text");
    const p = ctx.deps.registry.pivot(str(args.pivot));
    if (p === null) throw new ToolError(`unknown pivot: ${str(args.pivot)}`);
    if (p.source !== source.id) throw new ToolError(`pivot ${p.id} reads source ${p.source}, not ${source.id}`);
    const v = str(args.value);
    if (!ctx.deps.observables.matches(p.from, v)) throw new ToolError(`${JSON.stringify(v)} is not a value of type ${p.from}`);
    if (p.needs_window && (window.from === null || window.to === null)) throw new ToolError(`pivot ${p.id} needs a window`);
    pivot = p.id;
    value = { type: p.from, value: v };
  } else {
    if (!given("text") || given("pivot") || given("value")) throw new ToolError("a query probe names its text, and no pivot or value");
    text = str(args.text);
  }
  let probe = "";
  ctx.session.commit((s, ids) => {
    // checked again in the commit: two calls of one reply cannot both open a probe
    if (builderOpen(s).probes.length > 0) throw new ToolError(ONE_PROBE);
    probe = ids.next("probe");
    return [{ type: "builder.probe_asked", actor: ctx.actor, payload: { probe, kind, source: source.id, pivot, value, text, window, why: str(args.why) } }];
  });
  return ok(WAITING, shown(ctx, b, { probe, status: WAITING, note: "the person approves or rejects it; its answer comes back as a card of this session" }));
}

const fileProps: Record<string, Schema> = {
  path: { type: "string", minLength: 1, maxLength: MAX_PATH, description: "the file's path in the write root, relative and / separated, as loops/<id>.yaml" },
  text: { type: "string", minLength: 1, maxLength: MAX_FILE_TEXT, description: "the whole text of the file" },
};
const fileArg: Schema = { type: "object", additionalProperties: false, required: ["path", "text"], properties: fileProps };
const nullableTime: Schema = { type: ["string", "null"], maxLength: 40 };

export const BUILDER_TOOLS: ToolDef[] = [
  {
    name: "loop_catalogue", description: "List every loop: its id, title, about text, version and hash, whether it is usable and why not, and its stages with their gates, edges and the loop a stage runs.",
    parameters: params(), call: loopCatalogue,
  },
  {
    name: "adapter_catalogue",
    description: "The adapter catalogue: each source's purpose, each field's meaning, what it reveals and its extract rules with the pivots an extracted value leads to, the pivots in and out, the types, the playbooks and the inventories. Optionally one source.",
    parameters: params({ source: idArg }), call: adapterCatalogue,
  },
  {
    name: "list_connectors", description: "The connector kinds a source manifest may name (sql, files, http, trino): what each needs, whether only a trusted root may supply one, how its credential is named, and how to list its tables.",
    parameters: params(), call: listConnectors,
  },
  {
    name: "list_roots", description: "The roots by name: whether each is trusted, whether a save may write there, the credential names the configuration grants it (names only) and whether it was imported.",
    parameters: params(), call: listRoots,
  },
  {
    name: "validate_manifest", description: "Check one manifest file exactly as a save would, against the roots as they are now. Writes nothing. Answers ok, or the problems.",
    parameters: params(fileProps, ["path", "text"]), call: validateManifest,
  },
  {
    name: "propose_change",
    description: "Propose a change as whole files under the write root. It is checked exactly as a save would be; a change that does not pass is refused with its problems and the person never sees it. The person accepts or rejects each file; nothing is written until then.",
    parameters: params({
      title: { type: "string", minLength: 1, maxLength: MAX_ID, description: "the change in a few words" },
      files: { type: "array", minItems: 1, maxItems: MAX_FILES, items: fileArg },
    }, ["title", "files"]),
    call: proposeChange,
  },
  {
    name: "request_probe",
    description: "Ask the person to run one probe: one loaded pivot on one value (kind pivot), or one read-only query on one loaded source (kind query). It waits for the person's approval; one probe waits at a time. The answer comes back as a card.",
    parameters: params({
      kind: { type: "string", enum: ["pivot", "query"] },
      source: idArg, pivot: idArg, value: { type: "string", minLength: 1, maxLength: MAX_ID },
      text: { type: "string", minLength: 1, maxLength: MAX_TEXT, description: "the read-only statement, for kind query" },
      window: { type: "object", additionalProperties: false, required: ["from", "to"], properties: { from: nullableTime, to: nullableTime } },
    }, ["kind", "source"]),
    call: requestProbe,
  },
];
