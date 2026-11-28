// bun run src/cli/loops.ts <command> ...   (see USAGE)
// Lists, shows, exports, imports and trusts loops. Only a person, here the configured user, runs it. Every form takes the workbench's lock,
// so the server must be stopped. `import` and `trust` do not need a usable loop (they never call compose), so a first import into an empty
// root works.
import { existsSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { ResolvedItem } from "../pipeline/components";
import { Refused } from "../core/refused";
import { Workbench, WorkbenchLockedError } from "../core/workbench";
import { ConfigError, loadConfig, rootsOf } from "../modules/config";
import type { Config } from "../modules/config";
import { saveTrustedRoot } from "../modules/config-write";
import { exportLoop, importLoop, trustProblems } from "../modules/loop-import";
import { loadRegistry } from "../modules/registry-record";
import type { Registry } from "../modules/registry";
import { Secrets } from "../modules/secrets";
import { loadLoops } from "../pipeline/loops";
import type { LoopCatalog, ResolvedLoop } from "../pipeline/loops";
import type { ResolveContext } from "../pipeline/components";
import { latestOutput, recordLoops } from "./compose";

export interface LoopsIO {
  log(line: string): void;
  error(line: string): void;
}

const USAGE = [
  "usage:",
  "  bun run src/cli/loops.ts list",
  "  bun run src/cli/loops.ts show <id>",
  "  bun run src/cli/loops.ts export <id> [--to <dir>]",
  "  bun run src/cli/loops.ts import <file>",
  "  bun run src/cli/loops.ts trust <imported-folder>",
  "options for every form: --config <file>",
  "every form needs the server stopped. import and trust need no usable loop.",
].join("\n");

class UsageError extends Error {}

type Form = "list" | "show" | "export" | "import" | "trust";
const FORMS: Record<Form, { arg: string | null; values: string[] }> = {
  list: { arg: null, values: [] },
  show: { arg: "a loop id", values: [] },
  export: { arg: "a loop id", values: ["to"] },
  import: { arg: "a loop file", values: [] },
  trust: { arg: "an imported folder", values: [] },
};
interface Parsed { form: Form; arg: string | null; config: string | null; opts: Record<string, string> }

function parse(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) throw new UsageError("no command given");
  if (!Object.hasOwn(FORMS, first)) throw new UsageError(`unknown command: ${first}`);
  const form = first as Form;
  const spec = FORMS[form];
  const out: Parsed = { form, arg: null, config: null, opts: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      if (spec.arg === null || out.arg !== null) throw new UsageError(`unexpected argument: ${a}`);
      out.arg = a;
      continue;
    }
    const flag = a.slice(2);
    if (flag !== "config" && !spec.values.includes(flag)) throw new UsageError(`unknown option for ${form}: ${a}`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${a} needs a value`);
    if (flag === "config") {
      if (out.config !== null) throw new UsageError("--config was given twice");
      out.config = value;
    } else {
      if (Object.hasOwn(out.opts, flag)) throw new UsageError(`--${flag} was given twice`);
      out.opts[flag] = value;
    }
  }
  if (spec.arg !== null && out.arg === null) throw new UsageError(`${form} needs ${spec.arg}`);
  return out;
}

const hex12 = (h: string): string => h.slice(0, 12);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a loop's pipeline hash and the value of every secret the configuration can name, for an export to search. */
function secretValues(config: Config, registry: Registry): string[] {
  const secrets = new Secrets(process.env, config.secrets_file);
  const names = new Set<string>();
  for (const r of config.roots) for (const c of r.credentials) names.add(c);
  for (const s of registry.sources()) if (s.credential !== null && s.credential !== undefined) names.add(s.credential);
  const out: string[] = [];
  for (const n of [...names].sort()) {
    try {
      const v = secrets.get(n);
      if (v !== null) out.push(v);
    } catch { /* a value too short to be a secret is not one the workbench holds */ }
  }
  return out;
}

/** The registry and every loop, loaded as compose loads them but never failing on an unusable default; what loaded is recorded on the chain. */
function catalogOf(config: Config, wb: Workbench): { registry: Registry; loops: LoopCatalog } {
  const roots = rootsOf(config);
  const registry = loadRegistry(roots, { chain: wb.chain, content: wb.chainBlobs });
  const ctx: ResolveContext = {
    registry, content: wb.chainBlobs, chain: wb.chain, trusted: roots.filter((r) => r.trusted).map((r) => r.path),
    output: (loop, output) => latestOutput(wb.chain, wb.chainBlobs, loop, output),
  };
  const loops = loadLoops(registry, ctx, { max_depth: config.loops.max_depth, max_children: config.loops.max_children });
  recordLoops(loops, wb.chain, wb.chainBlobs);
  return { registry, loops };
}

const CONTEXT = new Set(["persona", "rules", "goal", "procedure", "skill", "reference", "gate", "schema", "framework", "standard"]);
const MIDDLEWARE = new Set(["check", "check-script"]);
const itemLine = (i: ResolvedItem): string => `${i.kind} ${i.id}  ${i.source}  ${hex12(i.hash)}`;

function showLoop(loop: ResolvedLoop, log: (l: string) => void): void {
  const { manifest, lock, pipeline } = loop;
  log(manifest.title);
  if (manifest.about !== "") log(manifest.about);
  log(`version ${lock.version}`);
  log(`hash ${pipeline.hash}`);
  log(`legacy hash ${pipeline.legacy_hash ?? "none"}`);
  const groups = (items: ResolvedItem[], extra: string[]): void => {
    log("   context:");
    for (const i of items.filter((x) => CONTEXT.has(x.kind))) log(`     ${itemLine(i)}`);
    log("   middleware:");
    for (const i of items.filter((x) => MIDDLEWARE.has(x.kind))) log(`     ${itemLine(i)}`);
    log("   orchestration:");
    for (const i of items.filter((x) => !CONTEXT.has(x.kind) && !MIDDLEWARE.has(x.kind))) log(`     ${itemLine(i)}`);
    for (const l of extra) log(`     ${l}`);
  };
  pipeline.stages.forEach((s, n) => {
    const parts = [`${n + 1}. ${s.title} (${s.id}) runs ${s.runs}`];
    if (s.gate !== null && s.gate !== undefined) parts.push(`gate ${s.gate}`);
    if (s.on_fail !== null) parts.push(`on fail → ${s.on_fail}`);
    if (s.runs === "loop" && s.subloop !== null && s.subloop !== undefined) parts.push(`runs loop ${s.subloop.loop}`);
    log(parts.join(" "));
    const extra: string[] = [];
    if (s.tools.length > 0) extra.push(`tools ${s.tools.join(", ")}`);
    if (s.model !== null && s.model !== undefined) extra.push(`model ${s.model.provider}/${s.model.model}${s.model.effort === null ? "" : ` effort ${s.model.effort}`}`);
    if (s.fast_model !== null && s.fast_model !== undefined) extra.push(`fast model ${s.fast_model.provider}/${s.fast_model.model}`);
    if (s.max_turns !== null && s.max_turns !== undefined) extra.push(`turn cap ${s.max_turns}`);
    groups(lock.items.filter((i) => i.stage === s.id), extra);
  });
  const shared = lock.items.filter((i) => i.stage === "*");
  if (shared.length > 0) {
    log("all stages:");
    groups(shared, []);
  }
}

/** What a root, loaded as a trusted one, would supply: a count per kind. */
function supplyOf(folder: string): string {
  const registry = loadRegistry([{ path: folder, trusted: true, credentials: [] }]);
  const counts = new Map<string, number>();
  for (const m of registry.manifests()) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
  const parts = [...counts.keys()].sort().map((kind) => {
    const n = counts.get(kind)!;
    return kind === "check" ? `${n} ${n === 1 ? "check" : "checks"} with scripts` : plural(n, kind);
  });
  return parts.length === 0 ? "nothing" : parts.join(", ");
}

/** The imported folder `arg` names: a folder of loops.imports, given by its name or its path. */
function importedFolder(config: Config, arg: string): string {
  const imports = resolve(config.loops.imports);
  const path = isAbsolute(arg) || arg.includes("/") ? resolve(arg) : join(imports, arg);
  if (dirname(path) !== imports) throw new Refused(`${arg} is not a folder of ${imports}; only a folder an import made can be trusted here`);
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Refused(`${path} is not a folder`);
  return path;
}

/** Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function loops(argv: string[], io: LoopsIO): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  let config: Config;
  try {
    config = loadConfig(p.config === null ? {} : { path: p.config });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.error(err.message);
    return 2;
  }
  let wb: Workbench | null = null;
  try {
    wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${messageOf(e)}`) });
    if (p.form === "import" || p.form === "trust") {
      if (p.form === "import") {
        const registry = loadRegistry(rootsOf(config));
        const r = await importLoop(p.arg!, registry, config.loops.imports);
        const loop = basename(r.root).replace(/-[0-9a-f]{12}$/, "");
        io.log(`imported ${loop} into ${r.root} (not trusted): ${r.written.length} written, ${r.same.length} already here`);
        io.log(`to use it: bun run loops trust ${r.root}`);
        return 0;
      }
      const folder = importedFolder(config, p.arg!);
      const clash = trustProblems(folder, loadRegistry(rootsOf(config)));
      if (clash.length > 0) throw new Refused(`${folder} is not trusted: ${clash.join("; ")}`);
      io.log(`this root will supply: ${supplyOf(folder)}`);
      saveTrustedRoot(config, folder);
      io.log(`trusted ${folder}; it is now in ${config.write_path}`);
      return 0;
    }
    const { registry, loops: catalog } = catalogOf(config, wb);
    if (p.form === "list") {
      for (const x of catalog.list()) {
        if (x.loop === null) io.log(`${x.id}  not usable: ${x.problems[0] ?? "it did not load"}`);
        else io.log(`${x.id}  v${x.loop.lock.version}  ${hex12(x.loop.pipeline.hash)}  ${plural(x.loop.pipeline.stages.length, "stage")}  ${x.loop.manifest.title}`);
      }
      return 0;
    }
    const id = p.arg!;
    if (!catalog.list().some((x) => x.id === id)) {
      io.error(`no loop "${id}"; \`bun run loops list\` names the loops there are`);
      return 1;
    }
    const loop = catalog.current(id);
    if (loop === null) {
      io.error(`loop "${id}" is not usable:`);
      for (const problem of catalog.problems(id)) io.error(`  - ${problem}`);
      return 1;
    }
    if (p.form === "show") {
      showLoop(loop, (l) => io.log(l));
      return 0;
    }
    const to = p.opts.to ?? config.loops.store;
    const r = await exportLoop({ loops: catalog, registry, secrets: secretValues(config, registry) }, id, to);
    io.log(`exported ${id} v${r.manifest.version} to ${r.path}`);
    return 0;
  } catch (err) {
    if (err instanceof WorkbenchLockedError) {
      io.error(`${err.message}; stop the server or the command that holds it, then try again`);
      return 1;
    }
    if (err instanceof Refused || (err instanceof Error && (err.name === "ConfigWriteError" || err.name === "Refused"))) {
      io.error(messageOf(err));
      return 1;
    }
    io.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  } finally {
    try { wb?.close(); } catch (err) { io.error(`closing the workbench failed: ${messageOf(err)}`); }
  }
}

if (import.meta.main) {
  process.exitCode = await loops(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l) });
}
