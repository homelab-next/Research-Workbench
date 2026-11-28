// bun run synth <form> ...   (see USAGE)
// Builds a self-contained synthetic setup (a fake company's lake, a root over it, its ground truth beside them) and works in one. Every
// form but build needs --config naming the setup's own configuration; the environment's and the home's are never used for them.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { readLakeCatalog } from "pivot/synth/format";
import type { SynthParams } from "pivot/synth/params";
import { MARKINGS, WHERES, isMarking } from "../core/types";
import type { Actor, Marking, Where } from "../core/types";
import { ConfigError, loadConfig } from "../modules/config";
import type { Config } from "../modules/config";
import { synthAnswer } from "../synth/answer";
import { ambientConfig, buildSetup, SYNTH_RUN } from "../synth/build";
import type { BuildOptions } from "../synth/build";
import { synthSeed } from "../synth/seed";
import { setupOf, SynthRefused } from "../synth/setup";
import type { SynthContext, SynthSetup } from "../synth/setup";
import { readIndex, synthTasks } from "../synth/tasks";

const USAGE = [
  "usage:",
  "  bun run synth build <dir> (--scripted | --base-url URL --model ID [--provider ID] [--where machine|network|hosted])",
  "                            [--seed N] [--start YYYY-MM-DD] [--days N] [--users N] [--hosts N] [--sites N] [--volume X] [--scale N] [--only id,id] [--port N]",
  "  bun run synth show        --config <dir>/config.yaml",
  "  bun run synth tasks       --config <dir>/config.yaml [--only id,id] [--marking M]",
  "  bun run synth answer CASE-N --config <dir>/config.yaml [--product N]",
  "  bun run synth seed-tasks  --config <dir>/config.yaml [--only id,id] [--marking M]",
  "build writes only inside <dir>. Every other form needs --config and a synth.json beside it, and (but show) the server stopped.",
].join("\n");

class UsageError extends Error {}

type Form = "build" | "show" | "tasks" | "answer" | "seed-tasks";
const INTS = ["seed", "days", "users", "hosts", "sites", "scale"] as const;
interface Spec { values: string[]; flags: string[]; positional: "dir" | "case" | null }
const SPECS: Record<Form, Spec> = {
  build: { values: ["base-url", "model", "provider", "where", ...INTS, "start", "volume", "only", "port"], flags: ["scripted"], positional: "dir" },
  show: { values: ["config"], flags: [], positional: null },
  tasks: { values: ["config", "only", "marking"], flags: [], positional: null },
  answer: { values: ["config", "product"], flags: [], positional: "case" },
  "seed-tasks": { values: ["config", "only", "marking"], flags: [], positional: null },
};
const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
const WHOLE = /^(0|[1-9][0-9]*)$/;

interface Parsed { form: Form; positional: string | null; one: Record<string, string>; flags: Set<string> }

function parseArgs(argv: string[]): Parsed {
  if (argv.includes("--help") || argv.includes("-h")) throw new UsageError("");
  const [name, ...rest] = argv;
  if (name === undefined) throw new UsageError("no form given");
  if (!Object.hasOwn(SPECS, name)) throw new UsageError(`unknown form: ${name}`);
  const form = name as Form;
  const spec = SPECS[form];
  const out: Parsed = { form, positional: null, one: {}, flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (spec.flags.includes(key)) { out.flags.add(key); continue; }
      if (!spec.values.includes(key)) throw new UsageError(`${form} takes no ${a}`);
      const v = rest[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      if (Object.hasOwn(out.one, key)) throw new UsageError(`${a} is given twice`);
      out.one[key] = v;
      continue;
    }
    if (spec.positional === null || out.positional !== null) throw new UsageError(`unexpected argument: ${a}`);
    if (spec.positional === "case" && !CASE_ID.test(a)) throw new UsageError(`${a} is not a case id (CASE-1, CASE-2, ...)`);
    out.positional = a;
  }
  if (spec.positional === "dir" && out.positional === null) throw new UsageError("build needs the folder to build in");
  if (spec.positional === "case" && out.positional === null) throw new UsageError("answer needs the case");
  if (form !== "build" && out.one.config === undefined) throw new UsageError(`${form} needs --config <dir>/config.yaml (the setup's own; no other configuration is used)`);
  return out;
}

const onlyOf = (v: string | undefined): string[] | null => {
  if (v === undefined) return null;
  const ids = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  if (ids.length === 0) throw new UsageError("--only names no storyline");
  return ids;
};

function markingOf(v: string | undefined): Marking {
  const m = v ?? "TLP:GREEN";
  if (!isMarking(m)) throw new UsageError(`unknown marking ${m}; one of ${MARKINGS.join(", ")}`);
  return m;
}

function buildOptions(p: Parsed): BuildOptions {
  const scripted = p.flags.has("scripted");
  const url = p.one["base-url"], model = p.one.model;
  if (scripted && (url !== undefined || model !== undefined || p.one.provider !== undefined || p.one.where !== undefined)) throw new UsageError("--scripted takes no --base-url, --model, --provider or --where");
  if (!scripted && (url === undefined || model === undefined)) throw new UsageError("build needs --scripted, or --base-url and --model");
  if (p.one.where !== undefined && !(WHERES as readonly string[]).includes(p.one.where)) throw new UsageError("--where is machine, network or hosted");
  const params: Partial<SynthParams> = {};
  for (const k of INTS) {
    const v = p.one[k];
    if (v === undefined) continue;
    if (!WHOLE.test(v)) throw new UsageError(`--${k} wants a whole number, not ${v}`);
    params[k] = Number(v);
  }
  if (p.one.start !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p.one.start)) throw new UsageError(`--start wants YYYY-MM-DD, not ${p.one.start}`);
    params.start = p.one.start;
  }
  if (p.one.volume !== undefined) {
    if (!/^[0-9]+(\.[0-9]+)?$/.test(p.one.volume)) throw new UsageError(`--volume wants a number, not ${p.one.volume}`);
    params.volume = Number(p.one.volume);
  }
  let port: number | undefined;
  if (p.one.port !== undefined) {
    if (!WHOLE.test(p.one.port)) throw new UsageError(`--port wants a whole number, not ${p.one.port}`);
    port = Number(p.one.port);
  }
  const only = onlyOf(p.one.only);
  return {
    params,
    model: scripted ? "scripted" : {
      base_url: url!, model: model!,
      ...(p.one.provider === undefined ? {} : { provider: p.one.provider }),
      ...(p.one.where === undefined ? {} : { where: p.one.where as Where }),
    },
    ...(port === undefined ? {} : { port }),
    ...(only === null ? {} : { only }),
  };
}

/** A simulated size in decimal units. */
function size(bytes: number): string {
  const units = ["B", "kB", "MB", "GB", "TB"];
  let n = bytes, u = 0;
  while (n >= 1000 && u < units.length - 1) { n /= 1000; u++; }
  return u === 0 ? `${n} B` : `${n.toFixed(2)} ${units[u]}`;
}

const modelLine = (m: SynthSetup["model"]): string => (m === "scripted" ? `scripted (${SYNTH_RUN})` : `${m.provider} ${m.model}`);
const paramsLine = (p: SynthParams): string => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(" ");

function tableLines(tables: { name: string; rows: number; bytes: number }[]): string[] {
  const w = Math.max(...tables.map((t) => t.name.length));
  const r = Math.max(...tables.map((t) => String(t.rows).length));
  return tables.map((t) => `  ${t.name.padEnd(w)}  ${`${t.rows} rows`.padStart(r + 5)}  ${size(t.bytes)}`);
}

function storylineLines(setup: SynthSetup): string[] {
  return [
    `storylines placed: ${setup.storylines.length}`,
    ...setup.storylines.map((s) => `  ${s.id} (${s.case_type}, ${s.malicious ? "malicious" : "benign"}): ${s.title}`),
    setup.left_out.length === 0 ? "left out: none" : `left out: ${setup.left_out.length}`,
    ...setup.left_out.map((s) => `  ${s.id}: ${s.why}`),
  ];
}

function build(p: Parsed): number {
  const opts = buildOptions(p);
  const typed = p.positional!.replace(/\/+$/, "") || "/";
  const b = buildSetup(p.positional!, opts, ambientConfig());
  const cfg = `${typed}/config.yaml`;
  const lines = [
    `built a synthetic setup in ${typed}: lake.sqlite, root/ (${b.files} files), truth/, data/, config.yaml, synth.json`,
    `parameters: ${paramsLine(b.setup.params)}`,
    `digest: ${b.setup.digest}`,
    "tables (simulated sizes):",
    ...tableLines(b.tables),
    ...storylineLines(b.setup),
    `model: ${modelLine(b.setup.model)}`,
    ...(b.setup.model === "scripted" ? [`  every stage names the scripted model ${SYNTH_RUN}; put a script at ${typed}/root/scripts/${SYNTH_RUN}.yaml before a run`] : []),
    "",
    "next:",
    `  bun run synth show --config ${cfg}`,
    `  bun run synth tasks --config ${cfg}`,
    `  bun run synth seed-tasks --config ${cfg}`,
    `  bun run serve --config ${cfg}`,
  ];
  console.log(lines.join("\n"));
  return 0;
}

function show(config: Config): number {
  const { dir, setup } = setupOf(config);
  const lake = join(dir, "lake.sqlite");
  const db = new Database(lake, { readonly: true });
  let catalog;
  try {
    catalog = readLakeCatalog(db);
  } finally {
    db.close();
  }
  if (catalog === null) throw new SynthRefused(`${lake} is not a synthetic lake of this format`);
  const tables = catalog.tables.map((t) => {
    const parts = catalog.partitions.filter((x) => x.table === t.name);
    return { name: t.name, rows: parts.reduce((s, x) => s + x.rows, 0), bytes: parts.reduce((s, x) => s + x.bytes, 0) };
  });
  const index = readIndex(config);
  const lines = [
    `synthetic setup ${dir} (pivot ${setup.pivot}, workbench ${setup.workbench})`,
    `parameters: ${paramsLine(setup.params)}`,
    `digest: ${setup.digest}`,
    "tables (simulated sizes):",
    ...tableLines(tables),
    ...storylineLines(setup),
    `model: ${modelLine(setup.model)}`,
    `port: ${config.server.port}`,
    `cases: ${index.cases.filter((c) => c.made_by === "tasks").length} task, ${index.cases.filter((c) => c.made_by === "seed-tasks").length} seeded`,
  ];
  console.log(lines.join("\n"));
  return 0;
}

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
    if (p.form === "build") buildOptions(p);
    else { onlyOf(p.one.only); markingOf(p.one.marking); }
    if (p.one.product !== undefined && !/^[1-9][0-9]*$/.test(p.one.product)) throw new UsageError(`--product wants a product number, not ${p.one.product}`);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(err.message === "" ? USAGE : `${err.message}\n${USAGE}`);
    return 2;
  }
  try {
    if (p.form === "build") return build(p);
    // the setup's own configuration only: --config is required, and nothing of the environment's or the home's is used in its place
    const config = loadConfig({ path: p.one.config! });
    if (p.form === "show") return show(config);
    const { dir, setup } = setupOf(config);
    const ctx: SynthContext = {
      config, dir, setup, human: { kind: "human", id: config.user } satisfies Actor,
      io: { log: (l) => console.log(l), error: (l) => console.error(l) },
    };
    if (p.form === "tasks") return await synthTasks(ctx, { only: onlyOf(p.one.only), marking: markingOf(p.one.marking) });
    if (p.form === "seed-tasks") return await synthSeed(ctx, { only: onlyOf(p.one.only), marking: markingOf(p.one.marking) });
    return await synthAnswer(ctx, { case: p.positional!, product: p.one.product === undefined ? null : Number(p.one.product) });
  } catch (err) {
    if (err instanceof SynthRefused || err instanceof ConfigError) {
      console.error(err.message);
      return 1;
    }
    console.error(`synth ${p.form} failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
