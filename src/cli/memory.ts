// bun run src/cli/memory.ts <command> ...   (see USAGE)
// Lists, shows, proposes, accepts, rejects and retires the shared lessons, exports and loads the store, and verifies it. Only a person, here the
// configuration's user, runs it: that is what makes an acceptance a person's. Every form but verify takes the workbench's lock, so the server must
// be stopped. `accept` takes the proposal it printed; no person types a hash.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { scrub } from "../agents/tools/kit";
import { draftProblem, triggerWords } from "../core/lessons";
import type { LessonState, LessonStatus } from "../core/lessons";
import { MemoryRefused } from "../core/memstore";
import { Refused } from "../core/refused";
import { MARKINGS, isMarking } from "../core/types";
import type { Actor, Marking, Trigger } from "../core/types";
import { formatReport, UnreadableLedgerError, verifyMemory, verifyMemoryLinks } from "../core/verify";
import { Workbench, WorkbenchLockedError } from "../core/workbench";
import { loadCaseTypes } from "../modules/case-types";
import { ConfigError, loadConfig, rootsOf } from "../modules/config";
import type { Config } from "../modules/config";
import { loadRegistry } from "../modules/registry-record";
import type { Registry } from "../modules/registry";
import { secretValues } from "./compose";

export interface MemoryIO {
  log(line: string): void;
  error(line: string): void;
}

const USAGE = [
  "usage:",
  "  bun run memory list    [--type ID] [--status proposed|accepted|rejected|retired|superseded] [--config F]",
  "  bun run memory show    LESSON-N",
  "  bun run memory propose --type ID --title T --text X --marking M [--when observable=TYPE | source=ID | finding=WORDS]... [--supersedes LESSON-N]",
  "  bun run memory accept  LESSON-N [--marking M]",
  "  bun run memory reject  LESSON-N --reason R",
  "  bun run memory retire  LESSON-N --reason R",
  "  bun run memory export  [--to DIR]",
  "  bun run memory load    FILE",
  "  bun run memory verify  [--case CASE-N]",
  "options for every form: --config <file>",
  "every form but verify needs the server stopped.",
].join("\n");

class UsageError extends Error {}

const LESSON_ID = /^LESSON-[1-9][0-9]{0,8}$/;
const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
const STATUSES: readonly LessonStatus[] = ["proposed", "accepted", "rejected", "retired", "superseded"];

type Form = "list" | "show" | "propose" | "accept" | "reject" | "retire" | "export" | "load" | "verify";
interface Spec { arg: "lesson" | "file" | null; values: string[]; repeated: string[]; required: string[] }
const SPECS: Record<Form, Spec> = {
  list: { arg: null, values: ["type", "status"], repeated: [], required: [] },
  show: { arg: "lesson", values: [], repeated: [], required: [] },
  propose: { arg: null, values: ["type", "title", "text", "marking", "supersedes"], repeated: ["when"], required: ["type", "title", "text", "marking"] },
  accept: { arg: "lesson", values: ["marking"], repeated: [], required: [] },
  reject: { arg: "lesson", values: ["reason"], repeated: [], required: ["reason"] },
  retire: { arg: "lesson", values: ["reason"], repeated: [], required: ["reason"] },
  export: { arg: null, values: ["to"], repeated: [], required: [] },
  load: { arg: "file", values: [], repeated: [], required: [] },
  verify: { arg: null, values: ["case"], repeated: [], required: [] },
};
interface Parsed { form: Form; arg: string | null; config: string | null; one: Record<string, string>; many: Record<string, string[]> }

function parse(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) throw new UsageError("no command given");
  if (!Object.hasOwn(SPECS, first)) throw new UsageError(`unknown command: ${first}`);
  const form = first as Form;
  const spec = SPECS[form];
  const out: Parsed = { form, arg: null, config: null, one: {}, many: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      if (spec.arg === null || out.arg !== null) throw new UsageError(`unexpected argument: ${a}`);
      if (spec.arg === "lesson" && !LESSON_ID.test(a)) throw new UsageError(`${a} is not a lesson id (LESSON-1, LESSON-2, ...)`);
      out.arg = a;
      continue;
    }
    const flag = a.slice(2);
    const isConfig = flag === "config";
    if (!isConfig && !spec.values.includes(flag) && !spec.repeated.includes(flag)) throw new UsageError(`unknown option for ${form}: ${a}`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${a} needs a value`);
    if (isConfig) {
      if (out.config !== null) throw new UsageError("--config was given twice");
      out.config = value;
    } else if (spec.repeated.includes(flag)) {
      (out.many[flag] ??= []).push(value);
    } else {
      if (Object.hasOwn(out.one, flag)) throw new UsageError(`--${flag} was given twice`);
      out.one[flag] = value;
    }
  }
  if (spec.arg !== null && out.arg === null) throw new UsageError(`${form} needs ${spec.arg === "lesson" ? "a lesson id" : "a memory file"}`);
  for (const r of spec.required) if (!Object.hasOwn(out.one, r)) throw new UsageError(`${form} needs --${r}`);
  if (out.one.status !== undefined && !(STATUSES as readonly string[]).includes(out.one.status)) throw new UsageError(`unknown status ${out.one.status}; one of ${STATUSES.join(", ")}`);
  if (out.one.marking !== undefined && !isMarking(out.one.marking)) throw new UsageError(`unknown marking ${out.one.marking}; one of ${MARKINGS.join(", ")}`);
  if (out.one.supersedes !== undefined && !LESSON_ID.test(out.one.supersedes)) throw new UsageError(`${out.one.supersedes} is not a lesson id (LESSON-1, LESSON-2, ...)`);
  if (out.one.case !== undefined && !CASE_ID.test(out.one.case)) throw new UsageError(`${out.one.case} is not a case id (CASE-1, CASE-2, ...)`);
  return out;
}

/** `observable=TYPE`, `source=ID` or `finding=WORDS`. */
function triggerOf(s: string): Trigger {
  const at = s.indexOf("=");
  const key = s.slice(0, at), value = s.slice(at + 1);
  if (at < 1 || value === "" || (key !== "observable" && key !== "source" && key !== "finding")) {
    throw new UsageError(`--when wants observable=TYPE, source=ID or finding=WORDS, not ${s}`);
  }
  return key === "observable" ? { observable: value } : key === "source" ? { source: value } : { finding: value };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const plural = (n: number, one: string): string => `${n} ${n === 1 ? one : `${one}s`}`;
const hex12 = (h: string): string => h.slice(0, 12);

function provenance(l: LessonState): string {
  const f = l.from;
  if (f.kind === "person") return `proposed by a person (${l.proposed.by.id ?? "unnamed"})`;
  if (f.kind === "seed") return `proposed from the seed ${f.manifest}, item ${f.item}`;
  const where = [`case ${f.case}`, f.run === null ? null : `run ${f.run}`, f.stage === null ? null : `stage ${f.stage}`, f.product === null ? null : `product ${f.product.n}`];
  return `proposed from ${where.filter((x) => x !== null).join(", ")}${f.model ? " (a model wrote the text)" : ""}`;
}

/** The line every list prints for a lesson. */
const lineOf = (l: LessonState, registry: Registry): string => `${l.id}  ${l.status}  ${l.case_type}  ${l.marking}  ${scrub(registry, l.title)}`;

function showLines(l: LessonState, entries: { seq: number; type: string; ts: string; actor: Actor }[], registry: Registry): string[] {
  const lines = [lineOf(l, registry), `text: ${scrub(registry, l.text)}`, `hash ${l.hash}`];
  if (l.marking !== l.proposed_marking) lines.push(`proposed at ${l.proposed_marking}, now ${l.marking}`);
  lines.push(l.triggers.length === 0 ? `applies to: every ${l.case_type} case` : "applies when:");
  for (const t of l.triggers) lines.push(`  ${triggerWords(t)}`);
  lines.push(provenance(l));
  if (l.supersedes !== null) lines.push(`supersedes ${l.supersedes}`);
  if (l.superseded_by !== null) lines.push(`superseded by ${l.superseded_by}`);
  if (l.decided !== null && l.decided.reason !== null) lines.push(`${l.status} by ${l.decided.by}: ${scrub(registry, l.decided.reason)}`);
  lines.push("history:");
  for (const seq of l.history) {
    const e = entries.find((x) => x.seq === seq);
    if (e !== undefined) lines.push(`  ${e.seq}  ${e.ts}  ${e.type}  ${e.actor.kind === "human" || e.actor.kind === "agent" || e.actor.kind === "system" ? (e.actor as { id?: string }).id ?? e.actor.kind : "?"}`);
  }
  return lines;
}

/** What the store verifies as: the chain, each proposal's hash, and with a case, each lock against the store. Needs no workbench lock. */
function verifyCommand(config: Config, caseId: string | null, io: MemoryIO): number {
  const storeDir = config.memory.store;
  let ok = true;
  if (!existsSync(join(storeDir, "ledger.sqlite"))) {
    io.log("memory store: empty, nothing to verify");
  } else {
    try {
      const r = verifyMemory(storeDir);
      io.log(formatReport(r));
      if (r.lessons.ok && r.lessons.skipped === 0) io.log("lessons: each proposal's hash is the hash of what it says");
      else {
        io.log(`lessons: ${plural(r.lessons.bad.length, "bad proposal")}, ${r.lessons.skipped} skipped entries`);
        for (const b of r.lessons.bad) io.log(`  ${b.lesson}: ${b.reason}`);
      }
      ok = r.ok && r.lessons.ok;
    } catch (err) {
      if (!(err instanceof UnreadableLedgerError)) throw err;
      io.log(`memory store: UNREADABLE (${err.message})`);
      ok = false;
    }
  }
  if (caseId !== null) {
    const caseDir = join(config.data_dir, "cases", caseId);
    if (!existsSync(join(caseDir, "ledger.sqlite"))) {
      io.error(`${caseId} is not a case loaded here`);
      return 1;
    }
    const links = verifyMemoryLinks(caseDir, storeDir);
    if (links.links.length === 0) io.log(`${caseId}: no lesson was locked into its runs`);
    for (const l of links.links) io.log(`${caseId} entry ${l.seq}: ${l.lesson} ${l.status.replace(/_/g, " ")}`);
    ok = ok && links.ok;
  }
  return ok ? 0 : 1;
}

/** Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function memory(argv: string[], io: MemoryIO): Promise<number> {
  let p: Parsed;
  let triggers: Trigger[] = [];
  try {
    p = parse(argv);
    triggers = (p.many.when ?? []).map(triggerOf);
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
  if (p.form === "verify") {
    try {
      return verifyCommand(config, p.one.case ?? null, io);
    } catch (err) {
      io.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      return 1;
    }
  }
  const human: Actor = { kind: "human", id: config.user };
  let wb: Workbench | null = null;
  try {
    wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${messageOf(e)}`) });
    if (p.form === "export") {
      const to = resolve(p.one.to ?? config.memory.files);
      const r = await wb.exportMemory(to, { actor: human });
      io.log(`exported ${r.file} (${plural(r.manifest.lessons.accepted, "shared lesson")}, ${plural(r.manifest.entries, "entry").replace("entrys", "entries")}) to ${r.path}`);
      return 0;
    }
    if (p.form === "load") {
      const r = await wb.loadMemory(resolve(p.arg!), { actor: human });
      io.log(`loaded ${plural(r.lessons, "lesson")}, head ${r.head.seq} ${hex12(r.head.hash)}, from ${p.arg!}`);
      return 0;
    }
    const registry = loadRegistry(rootsOf(config));
    const store = wb.memory;
    const find = (id: string): LessonState => {
      const l = Object.hasOwn(store.state.lessons, id) ? store.state.lessons[id]! : null;
      if (l === null) throw new Refused(`no lesson ${id}; \`bun run memory list\` names the lessons there are`);
      return l;
    };
    switch (p.form) {
      case "list": {
        for (const id of store.state.order) {
          const l = store.state.lessons[id]!;
          if ((p.one.type !== undefined && l.case_type !== p.one.type) || (p.one.status !== undefined && l.status !== p.one.status)) continue;
          io.log(lineOf(l, registry));
        }
        return 0;
      }
      case "show":
        for (const line of showLines(find(p.arg!), store.entries(), registry)) io.log(line);
        return 0;
      case "propose": {
        const draft = {
          case_type: p.one.type!, title: p.one.title!, text: p.one.text!, triggers, marking: p.one.marking as Marking, supersedes: p.one.supersedes ?? null,
        };
        const problem = draftProblem(draft);
        if (problem !== null) throw new MemoryRefused(problem);
        const r = store.propose(draft, { kind: "person" }, human, {
          secrets: secretValues(config, registry),
          case_types: loadCaseTypes(registry).types.map((t) => t.id),
          observables: registry.types().map((t: { id: string }) => t.id),
        });
        io.log(`proposed ${r.lesson.id} (${r.lesson.status}); \`bun run memory accept ${r.lesson.id}\` shares it`);
        return 0;
      }
      case "accept": {
        // what the person sees is what they accept: the hash is the one of the lesson as printed here
        const seen = find(p.arg!);
        for (const line of showLines(seen, store.entries(), registry)) io.log(line);
        const l = store.accept(seen.id, { actor: human, hash: seen.hash, ...(p.one.marking === undefined ? {} : { marking: p.one.marking as Marking }) });
        io.log(`accepted ${l.id} at ${l.marking}`);
        return 0;
      }
      case "reject": {
        const l = store.reject(p.arg!, { actor: human, reason: p.one.reason! });
        io.log(`rejected ${l.id}`);
        return 0;
      }
      case "retire": {
        const l = store.retire(p.arg!, { actor: human, reason: p.one.reason! });
        io.log(`retired ${l.id}`);
        return 0;
      }
    }
    return 0;
  } catch (err) {
    if (err instanceof WorkbenchLockedError) {
      io.error(`${err.message}; stop the server or the command that holds it, then try again`);
      return 1;
    }
    if (err instanceof Refused) {
      io.error(err.message);
      return 1;
    }
    io.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  } finally {
    try { wb?.close(); } catch (err) { io.error(`closing the workbench failed: ${messageOf(err)}`); }
  }
}

if (import.meta.main) {
  process.exitCode = await memory(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l) });
}
