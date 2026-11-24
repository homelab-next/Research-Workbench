import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { LocalProvider } from "../src/agents/providers/local";
import { Secrets } from "../src/modules/secrets";
import { WHERES } from "../src/core/types";
import type { Where } from "../src/core/types";

const REPO = resolve(import.meta.dir, "..");

export interface NewRootOptions { base_url: string; model: string; provider?: string; where?: Where; sample?: string }

const USAGE = "usage: bun run new-root <dir> --base-url <url> --model <id> [--provider <id>] [--where machine|network|hosted]";

/** The real path of `p`, or of its nearest existing ancestor with the rest appended. */
function realish(p: string): string {
  const abs = resolve(p);
  let up = abs;
  const rest: string[] = [];
  while (!existsSync(up)) { rest.unshift(basename(up)); up = dirname(up); }
  return join(realpathSync(up), ...rest);
}

const inside = (child: string, parent: string): boolean => child === parent || child.startsWith(parent + sep);

function walk(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out.sort();
}

/** Rewrites the one `model:` line of a stage whose parsed model is not null, and checks nothing else changed. */
function pointStage(file: string, text: string, model: { provider: string; model: string }): string {
  const parsed = Bun.YAML.parse(text) as Record<string, unknown> | null;
  if (parsed === null || typeof parsed !== "object" || parsed.model === null || parsed.model === undefined) return text;
  const lines = text.split("\n");
  const at = lines.findIndex((l) => l.startsWith("model:"));
  if (at < 0) throw new Error(`${file}: the stage has a model but no line starting with "model:" to rewrite`);
  lines[at] = `model: { provider: ${model.provider}, model: ${JSON.stringify(model.model)}, effort: null }`;
  const out = lines.join("\n");
  let again: Record<string, unknown> | null;
  try { again = Bun.YAML.parse(out) as Record<string, unknown> | null; } catch { again = null; }
  const expected = { ...parsed, model: { provider: model.provider, model: model.model, effort: null } };
  if (JSON.stringify(again) !== JSON.stringify(expected)) throw new Error(`${file}: the model line cannot be rewritten in place (write it on the one line "model: ...")`);
  return out;
}

/** Throws naming the first symbolic link under `dir`. */
function refuseLinks(dir: string): void {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    if (st.isSymbolicLink()) throw new Error(`${p} is a symbolic link: the sample is copied, never linked`);
    if (st.isDirectory()) refuseLinks(p);
  }
}

/** Makes a module root of your own at `dir` from the generic half of the sample. Returns the files written, sorted. */
export function newRoot(dir: string, opts: NewRootOptions): string[] {
  const provider = opts.provider ?? "local";
  const where: Where = opts.where ?? "machine";
  const sample = resolve(opts.sample ?? join(REPO, "sample"));
  if (!/^[a-z][a-z0-9_-]*$/.test(provider)) throw new Error(`the provider id "${provider}" must be lower-case letters, digits, - and _`);
  if (!(WHERES as readonly string[]).includes(where)) throw new Error(`where must be machine, network or hosted, not "${where}"`);
  if (opts.model.trim() === "" || /[\r\n]/.test(opts.model)) throw new Error("the model id must be one non-empty line");
  if (inside(realish(dir), realpathSync(REPO))) throw new Error(`${dir} is inside the repository: make the root outside it`);
  if (existsSync(dir) && (!statSync(dir).isDirectory() || readdirSync(dir).length > 0)) throw new Error(`${dir} already exists and is not empty`);
  // The same check the workbench makes when it loads the model, so a refusal comes now and nothing is written.
  new LocalProvider({ id: provider, base_url: opts.base_url, where, credential: null, secrets: new Secrets({}, null), context: null, efforts: [], timeout_ms: 300000 });

  for (const need of ["context", "checks", "stages"]) {
    if (!existsSync(join(sample, need)) || !statSync(join(sample, need)).isDirectory()) throw new Error(`${join(sample, need)}: the sample has no ${need} folder`);
  }
  if (!existsSync(join(sample, "types.yaml"))) throw new Error(`${join(sample, "types.yaml")}: the sample has no types.yaml`);
  for (const need of ["context", "checks", "stages"]) refuseLinks(join(sample, need));
  if (lstatSync(join(sample, "types.yaml")).isSymbolicLink()) throw new Error(`${join(sample, "types.yaml")} is a symbolic link: the sample is copied, never linked`);

  const stages = new Map<string, string>();
  for (const f of readdirSync(join(sample, "stages")).sort()) {
    const p = join(sample, "stages", f);
    stages.set(f, pointStage(p, readFileSync(p, "utf8"), { provider, model: opts.model }));
  }
  const types = (Bun.YAML.parse(readFileSync(join(sample, "types.yaml"), "utf8")) as { types: { id: string; title: string; pattern: string }[] }).types;
  const keep = types.filter((t) => t.id === "address" || t.id === "domain");
  if (keep.length !== 2) throw new Error("the sample's types.yaml must define address and domain");

  const made = !existsSync(dir);
  try {
    mkdirSync(dir, { recursive: true });
    cpSync(join(sample, "context"), join(dir, "context"), { recursive: true });
    cpSync(join(sample, "checks"), join(dir, "checks"), { recursive: true });
    mkdirSync(join(dir, "stages"));
    for (const [f, text] of stages) writeFileSync(join(dir, "stages", f), text);
    mkdirSync(join(dir, "models"));
    writeFileSync(join(dir, "models", `${provider}.yaml`), [
      "kind: model", `id: ${provider}`, "title: Local model", "provider: local", `where: ${where}`,
      `base_url: ${JSON.stringify(opts.base_url)}`, "efforts: []", "timeout_ms: 300000", "",
    ].join("\n"));
    writeFileSync(join(dir, "types.yaml"), ["kind: types", "types:", ...keep.map((t) => `  - { id: ${t.id}, title: ${t.title}, pattern: '${t.pattern.replace(/'/g, "''")}' }`), ""].join("\n"));
    writeFileSync(join(dir, "pivots.yaml"), "kind: pivots\npivots: []\n");
    mkdirSync(join(dir, "sources"));
  } catch (err) {
    // Remove what this run made: the folder itself if it was new, else (an empty folder) its contents.
    if (made) rmSync(dir, { recursive: true, force: true });
    else for (const n of readdirSync(dir)) rmSync(join(dir, n), { recursive: true, force: true });
    throw err;
  }
  return walk(dir);
}

/** The configuration to save beside the root; paths in it are relative to the file it is saved in. */
export function configFor(dir: string): string {
  return ["data_dir: ./data", "roots:", `  - { path: ${JSON.stringify("./" + basename(resolve(dir)))}, trusted: true, credentials: [] }`, "research: { parallel: 1 }", ""].join("\n");
}

function main(argv: string[]): number {
  const args = argv.slice();
  const flags: Record<string, string> = {};
  const rest: string[] = [];
  while (args.length > 0) {
    const a = args.shift()!;
    if (a.startsWith("--")) {
      const v = args.shift();
      if (!["--base-url", "--model", "--provider", "--where"].includes(a) || v === undefined) { console.error(USAGE); return 2; }
      flags[a.slice(2)] = v;
    } else rest.push(a);
  }
  if (rest.length !== 1 || flags["base-url"] === undefined || flags.model === undefined) { console.error(USAGE); return 2; }
  if (flags.where !== undefined && !(WHERES as readonly string[]).includes(flags.where)) { console.error(USAGE); return 2; }
  const dir = rest[0]!;
  try {
    const files = newRoot(dir, {
      base_url: flags["base-url"], model: flags.model,
      ...(flags.provider === undefined ? {} : { provider: flags.provider }),
      ...(flags.where === undefined ? {} : { where: flags.where as Where }),
    });
    console.log(`wrote ${files.length} files into ${resolve(dir)}:`);
    for (const f of files) console.log(`  ${f}`);
    console.log("\nSave this configuration beside the root:\n");
    process.stdout.write(configFor(dir));
    return 0;
  } catch (err) {
    console.error((err as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));
