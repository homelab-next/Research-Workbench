// bun run src/cli/improve.ts <command> ...   (see USAGE)
// Sets and withdraws the known answers of a task case, starts an improve run and shows one. Only a person, here the configuration's user, runs it.
// It decides nothing at Adopt: that gate is passed file by file in the browser, by the person who accepts. Every form takes the workbench's lock,
// so the server must be stopped.
import { readFileSync } from "node:fs";
import { scrub } from "../agents/tools/kit";
import { Refused } from "../core/refused";
import type { CaseSession } from "../core/session";
import { CANDIDATES_MAX, TASKS_MAX } from "../core/state/improve";
import { MARKINGS, isMarking, strictest } from "../core/types";
import type { Actor, Card, ExpectedFinding, Marking } from "../core/types";
import { CaseNotFoundError, Workbench, WorkbenchLockedError } from "../core/workbench";
import type { ChildLink } from "../core/workbench";
import { ConfigError, loadConfig, rootsOf } from "../modules/config";
import type { Config } from "../modules/config";
import { loadRegistry } from "../modules/registry-record";
import { Engine, RunRefused } from "../pipeline/engine";
import type { EngineDeps, StageRunner } from "../pipeline/engine";
import { setKnownAnswer, withdrawKnownAnswer } from "../pipeline/improve/answers";
import { targetProblem } from "../pipeline/improve/select";
import { improveHost } from "../pipeline/improve/workbench-host";
import type { ResolvedLoop } from "../pipeline/loops";
import { loopCaseType } from "../pipeline/memory";
import type { Role } from "../pipeline/manifests";
import { notTheChild, readChild } from "../pipeline/subloop";
import type { ChildCases, ChildRef } from "../pipeline/subloop";
import { compose, ComposeError, secretValues } from "./compose";

export interface ImproveIO {
  log(line: string): void;
  error(line: string): void;
}
/** What a test may add: a stage's runner in place of the engine's. Never reachable from the command line. */
export interface ImproveHooks { runners?: Partial<Record<Role, StageRunner>> }

const USAGE = [
  "usage:",
  "  bun run improve answer   CASE-N --product N --text T [--findings FILE.json] [--marking M]",
  "  bun run improve withdraw CASE-N --product N --reason R",
  "  bun run improve start    LOOP --type CASETYPE --marking M [--tasks N] [--candidates K]",
  "  bun run improve show     CASE-N",
  "options for every form: --config <file>",
  "every form needs the server stopped. At the adopt gate the files are decided in the browser: the case's Improve lens.",
].join("\n");

class UsageError extends Error {}

const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
const LOOP_ID = /^[a-z][a-z0-9_-]*$/;
const FINDINGS_SHAPE = "the findings file holds no list of findings: a JSON list of { claim, likelihood, confidence }";
export const WAITS_AT_ADOPT = "decide each file in the browser: the case's Improve lens";

type Form = "answer" | "withdraw" | "start" | "show";
interface Spec { arg: "case" | "loop"; values: string[]; required: string[] }
const SPECS: Record<Form, Spec> = {
  answer: { arg: "case", values: ["product", "text", "findings", "marking"], required: ["product", "text"] },
  withdraw: { arg: "case", values: ["product", "reason"], required: ["product", "reason"] },
  start: { arg: "loop", values: ["type", "marking", "tasks", "candidates"], required: ["type", "marking"] },
  show: { arg: "case", values: [], required: [] },
};
interface Parsed { form: Form; arg: string; config: string | null; one: Record<string, string> }

const whole = (name: string, v: string, min: number): number => {
  if (!/^[0-9]+$/.test(v) || Number(v) < min) throw new UsageError(`--${name} is a whole number, ${min} or more`);
  return Number(v);
};

function parse(argv: string[]): Parsed {
  const [first, ...rest] = argv;
  if (first === undefined) throw new UsageError("no command given");
  if (!Object.hasOwn(SPECS, first)) throw new UsageError(first === "--help" ? "help" : `unknown command: ${first}`);
  const form = first as Form;
  const spec = SPECS[form];
  let arg: string | null = null;
  let config: string | null = null;
  const one: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      if (arg !== null) throw new UsageError(`unexpected argument: ${a}`);
      if (spec.arg === "case" && !CASE_ID.test(a)) throw new UsageError(`${a} is not a case id (CASE-1, CASE-2, ...)`);
      if (spec.arg === "loop" && !LOOP_ID.test(a)) throw new UsageError(`${a} is not a loop id`);
      arg = a;
      continue;
    }
    const flag = a.slice(2);
    if (flag !== "config" && !spec.values.includes(flag)) throw new UsageError(`unknown option for ${form}: ${a}`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${a} needs a value`);
    if (flag === "config") {
      if (config !== null) throw new UsageError("--config was given twice");
      config = value;
    } else {
      if (Object.hasOwn(one, flag)) throw new UsageError(`--${flag} was given twice`);
      one[flag] = value;
    }
  }
  if (arg === null) throw new UsageError(`${form} needs ${spec.arg === "case" ? "a case id" : "a loop id"}`);
  for (const r of spec.required) if (!Object.hasOwn(one, r)) throw new UsageError(`${form} needs --${r}`);
  if (one.product !== undefined) whole("product", one.product, 1);
  if (one.tasks !== undefined) whole("tasks", one.tasks, 1);
  if (one.candidates !== undefined) whole("candidates", one.candidates, 1);
  if (one.marking !== undefined && !isMarking(one.marking)) throw new UsageError(`unknown marking ${one.marking}; one of ${MARKINGS.join(", ")}`);
  return { form, arg, config, one };
}

/** The findings of a file: a JSON list. Throws Refused, naming what is wrong, before anything is written. */
function findingsOf(path: string): ExpectedFinding[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new Refused(`the findings file ${path} cannot be read`);
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Refused(`the findings file ${path} is not JSON`);
  }
  if (!Array.isArray(data)) throw new Refused(FINDINGS_SHAPE);
  return data as ExpectedFinding[];
}

const oneLine = (t: string): string => t.replace(/\s+/g, " ").replace(/"/g, "'").trim();
const hex12 = (h: string): string => h.slice(0, 12);

/** The status line investigate prints: the case, where its run is, what it waits for and why it stopped. */
function statusLine(session: CaseSession): string {
  const { run } = session.state;
  const parts: string[] = [session.id, run.status];
  if (run.waiting !== null) parts.push(`waiting=${run.waiting}`);
  if (run.status !== "finished" && run.waiting !== "plan" && run.current !== null) parts.push(`stage=${run.current}`);
  if (run.status === "paused" && run.pause_reason !== null) parts.push(`reason="${oneLine(run.pause_reason)}"`);
  return parts.join(" ");
}

/** What a person reads of an improve case: the request, the tasks, the candidates, each probe, the choice, the scores once there are any, and where it waits. */
function showLines(session: CaseSession, text: (t: string) => string): string[] {
  const { state } = session;
  const im = state.improve;
  const lines = [statusLine(session)];
  const r = im.request!;
  lines.push(`improve ${r.target} for ${r.case_type} cases: ${r.tasks} ${r.tasks === 1 ? "task" : "tasks"}, ${r.candidates} ${r.candidates === 1 ? "candidate" : "candidates"}, asked by ${r.by}`);
  if (im.selected !== null) lines.push(`target ${im.selected.target} version ${im.selected.version} (${hex12(im.selected.loop_hash)})`);
  for (const t of im.task_order) {
    const k = im.tasks[t]!;
    lines.push(`${t} ${k.case} product ${k.product.n} ${k.marking}`);
  }
  for (const l of im.selected?.left_out ?? []) lines.push(`left out ${l.case}: ${l.why}`);
  for (const c of im.candidate_order) {
    const k = im.candidates[c]!;
    lines.push(k.status === "staged" ? `${c} staged ${k.change} (${hex12(k.loop_hash!)})` : `${c} dropped ${k.change}: ${text(k.reason)}`);
  }
  for (const p of im.probe_order) {
    const k = im.probes[p]!;
    const f = k.finished;
    lines.push(f === null ? `probe ${p} child ${k.child} running` : `probe ${p} child ${k.child} ${f.outcome}${f.reason === "" ? "" : `: ${text(f.reason)}`} (lookups ${f.lookups}, tokens ${f.tokens})`);
  }
  if (im.chosen !== null) lines.push(`chose ${im.chosen.candidate ?? "none"}: ${text(im.chosen.why)}`);
  if (im.scored !== null) for (const s of im.scored.summary) lines.push(`score ${s.candidate} ${s.score} (${s.drafted} of ${s.tasks} drafted)`);
  if (state.run.waiting === "adopt") lines.push(`waiting at adopt: ${WAITS_AT_ADOPT}`);
  return lines;
}

/** The host's ChildCases, and (through improveHost) the improve loop's host: children are cases of this workbench, driven by an engine of this process. Never passes a gate. */
export class Host implements ChildCases {
  private readonly engines = new Map<string, Engine>();
  constructor(private readonly wb: Workbench, private readonly deps: () => EngineDeps, private readonly runners: Partial<Record<Role, StageRunner>> = {}) {}
  engine(id: string): Engine {
    let e = this.engines.get(id);
    if (e === undefined) {
      // an engine on a session this process did not create closes what a stopped process left half done
      e = Engine.open(this.wb.session(id), this.deps(), { runners: this.runners });
      this.engines.set(id, e);
    }
    return e;
  }
  find(link: ChildLink): ReturnType<ChildCases["find"]> {
    const id = this.wb.findChild(link);
    const origin = id === null ? null : this.wb.loadedOrigin(id);
    return id === null || origin === null ? null : { id, origin };
  }
  create(input: Parameters<ChildCases["create"]>[0], link: ChildLink, cards: Card[]): ReturnType<ChildCases["create"]> {
    // a child's type is its own loop's default, else its parent's
    let parentType: string | null = null;
    try { parentType = this.wb.session(link.parent).state.memory.type; } catch { /* the parent is not loaded: the child has none */ }
    const own = loopCaseType(this.deps().loops, link.loop);
    const type = own ?? parentType;
    const type_by: Actor = { kind: "system", id: own === null ? "parent" : "loop-default" };
    const made = this.wb.createCase(input, { kind: "system", id: "engine" }, { loop: link.loop, link, cards, ...(type === null ? {} : { type, type_by }) });
    return { id: made.id, origin: made.entries(0, 1)[0]!.hash };
  }
  async drive(ref: ChildRef, opts: { loop: ResolvedLoop }): Promise<ReturnType<Engine["summary"]>> {
    // never a run on a case that is not this child: ids repeat across workbenches
    if (this.read(ref) === null) throw new RunRefused(notTheChild(ref));
    const e = this.engine(ref.id);
    if (this.wb.session(ref.id).state.run.status === "none") e.start({ kind: "system", id: "engine" }, { loop: opts.loop });
    return e.advance();
  }
  read(ref: ChildRef): ReturnType<ChildCases["read"]> {
    let s: CaseSession;
    try { s = this.wb.session(ref.id); } catch { return null; }
    return readChild(s, ref);
  }
  close(): void {
    for (const e of this.engines.values()) { try { e.close(); } catch { /* closed */ } }
    this.engines.clear();
  }
}

/** Gives the deps the way a stage reaches child cases and the way an improve run reaches its tasks, staging stores and probe children. */
export function hostsFor(wb: Workbench, deps: EngineDeps, onError: (e: unknown) => void, runners: Partial<Record<Role, StageRunner>> = {}): Host {
  const host = new Host(wb, () => deps, runners);
  deps.children = host;
  deps.improve = improveHost({ wb, deps: () => deps, engine: (id) => host.engine(id), secrets: () => deps.runner.secrets?.() ?? [], onError });
  return host;
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage. */
export async function improve(argv: string[], io: ImproveIO, hooks: ImproveHooks = {}): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.error(err.message === "help" ? USAGE : `${err.message}\n${USAGE}`);
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
  const human: Actor = { kind: "human", id: config.user };
  let wb: Workbench | null = null;
  let composed: ReturnType<typeof compose> | null = null;
  let host: Host | null = null;
  try {
    wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: (e) => io.error(`workbench: ${messageOf(e)}`) });
    const registry = loadRegistry(rootsOf(config));
    const secrets = secretValues(config, registry);
    const text = (t: string): string => scrub(registry, t);
    if (p.form === "show") {
      const session = wb.session(p.arg);
      if (session.state.improve.request === null) throw new Refused(`${p.arg} is no improve case`);
      for (const l of showLines(session, text)) io.log(l);
      return 0;
    }
    if (p.form === "answer" || p.form === "withdraw") {
      const session = wb.session(p.arg);
      const deps = { runner: { secrets: () => secrets } } as unknown as Pick<EngineDeps, "runner">;
      const product = Number(p.one.product);
      if (p.form === "withdraw") {
        withdrawKnownAnswer(session, deps, { product, reason: p.one.reason!, actor: human });
        io.log(`withdrew the known answer for product ${product} of ${session.id}`);
        return 0;
      }
      const findings = p.one.findings === undefined ? [] : findingsOf(p.one.findings);
      // the floor is the case's and its product's; the person may raise it
      const state = session.state;
      const published = state.published.find((x) => x.n === product);
      const draft = published === undefined ? undefined : state.drafts.find((d) => d.hash === published.draft_hash);
      const floor = strictest(state.meta?.marking ?? "TLP:RED", draft?.product.marking);
      const marking: Marking = p.one.marking === undefined ? floor : (p.one.marking as Marking);
      setKnownAnswer(session, { runner: deps.runner }, { product, text: p.one.text!, findings, marking, actor: human });
      io.log(`known answer set for product ${product} of ${session.id} (${marking})`);
      return 0;
    }
    // start
    composed = compose(config, wb);
    for (const problem of composed.problems) io.error(`problem: ${problem}`);
    const deps: EngineDeps = { ...composed.deps };
    const anchoredAt = new Map<string, number>();
    const base = composed.deps;
    deps.anchor = (a: Parameters<NonNullable<typeof base.anchor>>[0]) => { base.anchor?.(a); anchoredAt.set(a.case, a.seq); };
    host = hostsFor(wb, deps, (e) => io.error(`improve: ${messageOf(e)}`), hooks.runners);
    const target = p.arg;
    const catalog = deps.loops;
    if (catalog === undefined || !catalog.list().some((x) => x.id === target)) throw new Refused(`no loop "${target}"; \`bun run loops list\` names the loops there are`);
    const problem = targetProblem(catalog, target);
    if (problem !== null) throw new Refused(`loop "${target}" cannot be improved: ${problem}`);
    if (catalog.current("improve") === null) throw new Refused(`there is no usable improve loop: ${catalog.problems("improve").join("; ") || "none is loaded"}`);
    const type = p.one.type!;
    if (!(deps.case_types ?? []).some((t) => t.id === type)) throw new Refused(`"${type}" is not a case type`);
    const max = config.improve;
    const tasks = p.one.tasks === undefined ? Math.min(max.max_tasks, TASKS_MAX) : Number(p.one.tasks);
    const candidates = p.one.candidates === undefined ? Math.min(max.max_candidates, CANDIDATES_MAX) : Number(p.one.candidates);
    if (tasks > Math.min(max.max_tasks, TASKS_MAX)) throw new Refused(`a request asks for at most ${Math.min(max.max_tasks, TASKS_MAX)} tasks`);
    if (candidates > Math.min(max.max_candidates, CANDIDATES_MAX)) throw new Refused(`a request asks for at most ${Math.min(max.max_candidates, CANDIDATES_MAX)} candidates`);
    const session = wb.createCase(
      { title: `Improve ${target}`, asked: `Make ${type} cases of loop ${target} more correct`, why: "improve", starting: [], window: { from: "", to: "" }, objective: null, marking: p.one.marking as Marking },
      human, { loop: "improve", type, improve: { target, case_type: type, tasks, candidates } },
    );
    const engine = host.engine(session.id);
    engine.start(human);
    await engine.advance();
    const { run } = session.state;
    if (run.status === "finished") {
      const head = session.head();
      if (anchoredAt.get(session.id) !== head.seq) {
        try { deps.anchor?.({ case: session.id, seq: head.seq, hash: head.hash, why: "closed" }); } catch (err) { io.error(`the case head could not be anchored: ${messageOf(err)}`); }
      }
    }
    for (const l of showLines(session, text)) io.log(l);
    return run.status === "paused" || run.status === "interrupted" ? 1 : 0;
  } catch (err) {
    if (err instanceof WorkbenchLockedError) {
      io.error(`${err.message}; stop the server or the command that holds it, then try again`);
      return 1;
    }
    if (err instanceof Refused || err instanceof CaseNotFoundError || err instanceof RunRefused || err instanceof ComposeError || err instanceof TypeError) {
      io.error(messageOf(err));
      return 1;
    }
    io.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  } finally {
    try { host?.close(); } catch { /* closed */ }
    try { composed?.close(); } catch { /* the pool is already closed */ }
    try { wb?.close(); } catch (err) { io.error(`closing the workbench failed: ${messageOf(err)}`); }
  }
}

if (import.meta.main) {
  process.exitCode = await improve(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l) });
}
