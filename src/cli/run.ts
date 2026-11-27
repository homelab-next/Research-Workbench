// bun run src/cli/run.ts <command> ...   (see USAGE)
// Drives one investigation from the command line. Only the models the stage manifests name are used; the sample's is the scripted one,
// which contacts nothing. The command accepts a plan or approves publishing only when it is told to by its own command.
import { join } from "node:path";
import { latestDraft, blockers, unloadDue } from "../core/state";
import type { CaseSession } from "../core/session";
import { MARKINGS, isMarking } from "../core/types";
import type { Actor, Marking, Observable } from "../core/types";
import { CaseNotFoundError, Workbench, WorkbenchLockedError } from "../core/workbench";
import { ConfigError, loadConfig } from "../modules/config";
import { Engine, RunRefused } from "../pipeline/engine";
import { FeedbackRefused } from "../pipeline/feedback";
import { PlanRefused } from "../pipeline/plans";
import { PublishRefused } from "../pipeline/publish";
import { ReviseRefused } from "../pipeline/revise";
import { ensureSampleData } from "../../scripts/make-sample-data";
import { startReputationFixture } from "../../sample/fixture/reputation-server";
import { compose, ComposeError } from "./compose";

const USAGE = [
  "usage:",
  "  bun run src/cli/run.ts start  --title T --asked Q --why W --start type=value [--start ...] --from TS --to TS [--objective ID] [--marking M]",
  "  bun run src/cli/run.ts accept-plan <case> [--steps s1,s2] [--budget step=amount ...]",
  "  bun run src/cli/run.ts replan      <case> --note N",
  "  bun run src/cli/run.ts approve     <case> [--unload | --keep]",
  "  bun run src/cli/run.ts reject      <case> --reason R [--stop]",
  "  bun run src/cli/run.ts resume      <case>",
  "  bun run src/cli/run.ts stop        <case> --reason R",
  "  bun run src/cli/run.ts feedback    <case> --measure ID --value V [--note N]",
  "  bun run src/cli/run.ts status      <case>",
  "options for every form: --config <file>   --sample-fixture [port]",
].join("\n");

class UsageError extends Error {}

const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DEFAULT_PORT = 4801;

type Command = "start" | "accept-plan" | "replan" | "approve" | "reject" | "resume" | "stop" | "feedback" | "status";
interface Spec { values: string[]; repeated: string[]; flags: string[]; required: string[]; case: boolean }
const SPECS: Record<Command, Spec> = {
  start: { values: ["title", "asked", "why", "from", "to", "objective", "marking"], repeated: ["start"], flags: [], required: ["title", "asked", "why", "start", "from", "to"], case: false },
  "accept-plan": { values: ["steps"], repeated: ["budget"], flags: [], required: [], case: true },
  replan: { values: ["note"], repeated: [], flags: [], required: ["note"], case: true },
  approve: { values: [], repeated: [], flags: ["unload", "keep"], required: [], case: true },
  reject: { values: ["reason"], repeated: [], flags: ["stop"], required: ["reason"], case: true },
  resume: { values: [], repeated: [], flags: [], required: [], case: true },
  stop: { values: ["reason"], repeated: [], flags: [], required: ["reason"], case: true },
  feedback: { values: ["measure", "value", "note"], repeated: [], flags: [], required: ["measure", "value"], case: true },
  status: { values: [], repeated: [], flags: [], required: [], case: true },
};

interface Parsed {
  command: Command; case: string | null; config: string | null; fixture: number | null;
  one: Record<string, string>; many: Record<string, string[]>; flags: Set<string>;
}

function parseArgs(argv: string[]): Parsed {
  const [name, ...rest] = argv;
  if (name === undefined || !Object.hasOwn(SPECS, name)) throw new UsageError(name === undefined ? "no command given" : `unknown command: ${name}`);
  const command = name as Command;
  const spec = SPECS[command];
  const out: Parsed = { command, case: null, config: null, fixture: null, one: {}, many: {}, flags: new Set() };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      if (!spec.case || out.case !== null) throw new UsageError(`unexpected argument: ${a}`);
      if (!CASE_ID.test(a)) throw new UsageError(`${a} is not a case id (CASE-1, CASE-2, ...)`);
      out.case = a;
      continue;
    }
    const flag = a.slice(2);
    if (flag === "sample-fixture") {
      if (out.fixture !== null) throw new UsageError("--sample-fixture was given twice");
      const next = rest[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        const port = Number(next);
        if (port < 1 || port > 65535) throw new UsageError(`${next} is not a port`);
        out.fixture = port;
        i++;
      } else {
        out.fixture = DEFAULT_PORT;
      }
      continue;
    }
    if (spec.flags.includes(flag)) {
      out.flags.add(flag);
      continue;
    }
    const isConfig = flag === "config";
    if (!isConfig && !spec.values.includes(flag) && !spec.repeated.includes(flag)) throw new UsageError(`unknown option for ${command}: ${a}`);
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
  if (out.flags.has("unload") && out.flags.has("keep")) throw new UsageError("--unload and --keep cannot be given together");
  if (spec.case && out.case === null) throw new UsageError(`${command} needs a case id`);
  for (const r of spec.required) {
    if (!Object.hasOwn(out.one, r) && !Object.hasOwn(out.many, r)) throw new UsageError(`${command} needs --${r}`);
  }
  return out;
}

/** What `start` needs, checked before anything is written. */
function newCase(p: Parsed, knows: (type: string, value: string) => boolean, objectives: (id: string) => boolean): {
  title: string; asked: string; why: string; starting: Observable[]; window: { from: string; to: string }; objective: string | null; marking: Marking;
} {
  const starting = (p.many.start ?? []).map((s): Observable => {
    const at = s.indexOf("=");
    const type = s.slice(0, at), value = s.slice(at + 1);
    if (at < 1 || value === "") throw new UsageError(`--start wants type=value, not ${s}`);
    if (!knows(type, value)) throw new UsageError(`${value} is not a ${type}`);
    return { type, value };
  });
  const from = p.one.from!, to = p.one.to!;
  if (!UTC.test(from) || !UTC.test(to)) throw new UsageError("--from and --to must be UTC timestamps like 2026-11-17T00:00:00.000Z");
  if (from > to) throw new UsageError("--from is after --to");
  const marking = p.one.marking ?? "TLP:AMBER";
  if (!isMarking(marking)) throw new UsageError(`unknown marking ${marking}; one of ${MARKINGS.join(", ")}`);
  const objective = p.one.objective ?? null;
  if (objective !== null && !objectives(objective)) throw new UsageError(`unknown objective ${objective}`);
  return { title: p.one.title!, asked: p.one.asked!, why: p.one.why!, starting, window: { from, to }, objective, marking };
}

function budgetsOf(items: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of items) {
    const at = b.indexOf("=");
    const amount = Number(b.slice(at + 1));
    if (at < 1 || b.slice(at + 1).trim() === "" || !Number.isFinite(amount)) throw new UsageError(`--budget wants step=amount, not ${b}`);
    out[b.slice(0, at)] = amount;
  }
  return out;
}

const oneLine = (t: string): string => t.replace(/\s+/g, " ").replace(/"/g, "'").trim();

/** The lines that say where the case stopped and what it waits for. */
/** `asked` is a status request: it reports a paused run and still succeeds. */
function report(session: CaseSession, asked: boolean): { lines: string[]; code: number } {
  const state = session.state;
  const { run } = state;
  const parts = [session.id, run.status];
  const { waiting } = run;
  if (waiting !== null) parts.push(`waiting=${waiting}`);
  if (run.status !== "finished" && waiting !== "plan" && run.current !== null) parts.push(`stage=${run.current}`);
  const draft = latestDraft(state);
  if (run.status !== "finished" && draft !== null) parts.push(`draft=${draft.n}`);
  const published = state.published.at(-1);
  if (run.status === "finished" && run.outcome === "published" && published !== undefined) parts.push(`published=${published.dir}`);
  if (run.status === "paused" && run.pause_reason !== null) parts.push(`reason="${oneLine(run.pause_reason)}"`);
  const lines = [parts.join(" ")];
  if (waiting === "plan" && state.plan.current !== null) {
    for (const s of state.plan.current.steps) lines.push(`${s.id} ${s.free ? "free" : "costly"} ${s.source} ${s.pivot} ${s.from.value === "" ? "(from an earlier step)" : s.from.value}`);
  }
  if (waiting === "publish" && draft !== null) for (const b of blockers(state, draft.hash)) lines.push(`blocker: ${oneLine(b)}`);
  return { lines, code: asked || (run.status !== "paused" && run.status !== "interrupted") ? 0 : 1 };
}

const REFUSALS = [PlanRefused, ReviseRefused, PublishRefused, FeedbackRefused, RunRefused, CaseNotFoundError, WorkbenchLockedError, ComposeError];

async function main(argv: string[]): Promise<number> {
  let p: Parsed;
  try {
    p = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    console.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  let config;
  try {
    config = loadConfig(p.config === null ? {} : { path: p.config });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    console.error(err.message);
    return 2;
  }
  const human: Actor = { kind: "human", id: config.user };

  let fixture: { stop(): void } | null = null;
  let wb: Workbench | null = null;
  let composed: ReturnType<typeof compose> | null = null;
  let session: CaseSession | null = null;
  try {
    if (p.fixture !== null) {
      const root = config.roots[0];
      if (root === undefined) {
        console.error("--sample-fixture needs a root in the configuration");
        return 2;
      }
      ensureSampleData(root.path);
      fixture = startReputationFixture(join(root.path, "data"), p.fixture);
    }
    wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, onError: (e) => console.error(`workbench: ${e instanceof Error ? e.message : String(e)}`) });
    // status only reads: no registry is loaded (that records on the workbench chain), no engine, no recovery, no anchor
    if (p.command === "status") {
      const r = report(wb.session(p.case!), true);
      console.log(r.lines.join("\n"));
      return r.code;
    }
    composed = compose(config, wb);
    for (const problem of composed.problems) console.error(`problem: ${problem}`);
    const base = composed.deps;
    // what the engine anchored, so a run this command finished is anchored at its last entry once and only once
    let anchoredAt: number | null = null;
    const deps = { ...base, anchor: (a: Parameters<NonNullable<typeof base.anchor>>[0]) => { base.anchor?.(a); anchoredAt = a.seq; } };

    if (p.command === "start") {
      let input;
      try {
        input = newCase(p, (type, value) => deps.runner.observables.matches(type, value), (id) => deps.registry.get("objective", id) !== null);
      } catch (err) {
        if (!(err instanceof UsageError)) throw err;
        console.error(`${err.message}\n${USAGE}`);
        return 2;
      }
      session = wb.createCase({ ...input }, human);
    } else {
      session = wb.session(p.case!);
    }
    // an engine on a session this process did not create closes what a stopped process left half done
    const engine = Engine.open(session, deps);
    const wasFinished = session.state.run.status === "finished";
    const finishedHere = (): void => {
      const { run } = session!.state;
      const head = session!.head();
      if (wasFinished || run.status !== "finished" || anchoredAt === head.seq) return;
      try {
        deps.anchor({ case: session!.id, seq: head.seq, hash: head.hash, why: run.outcome === "published" ? "published" : "closed" });
      } catch (err) {
        console.error(`the case head could not be anchored: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    switch (p.command) {
      case "start":
        engine.start(human);
        await engine.advance();
        break;
      case "accept-plan":
        engine.acceptPlan({ ...(p.one.steps === undefined ? {} : { steps: p.one.steps.split(",").map((s) => s.trim()).filter((s) => s !== "") }), budgets: budgetsOf(p.many.budget ?? []), actor: human });
        await engine.advance();
        break;
      case "replan":
        engine.replan({ note: p.one.note!, actor: human });
        await engine.advance();
        break;
      case "approve":
        // the box's value travels with the approval; neither flag follows cases.on_complete
        engine.approve({ actor: human, unload_after: p.flags.has("unload") || (!p.flags.has("keep") && config.cases.on_complete === "unload") });
        await engine.advance();
        break;
      case "reject":
        engine.reject({ reason: p.one.reason!, stop: p.flags.has("stop"), actor: human });
        await engine.advance();
        break;
      case "resume":
        await engine.resume(human);
        break;
      case "stop":
        engine.stop(human, p.one.reason!);
        break;
      case "feedback": {
        const raw = p.one.value!;
        engine.feedback({ measure: p.one.measure!, value: raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw, note: p.one.note ?? "", actor: human });
        break;
      }
    }
    finishedHere();
    const r = report(session, false);
    let failed = false;
    // the host unloads once the drive has settled; what the report says was read before the case left
    if (unloadDue(session.state)) {
      try {
        const u = await wb.unloadCase(session.id, { actor: { kind: "system", id: "workbench" } });
        if (u.ok) r.lines[0] += ` unloaded=${u.file}`;
        else { failed = true; console.error(`published, but the case could not be unloaded: ${u.reason}`); }
      } catch (err) {
        failed = true;
        console.error(`published, but the case could not be unloaded: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(r.lines.join("\n"));
    return failed ? 1 : r.code;
  } catch (err) {
    if (err instanceof CaseNotFoundError && p.case !== null && wb !== null) {
      // a case in the store is not an unknown case
      try {
        const held = await wb.store.find(p.case);
        console.error(`${p.case} is not loaded; the store holds ${held.file}`);
        return 1;
      } catch { /* the store holds nothing for it: the plain message follows */ }
    }
    if (err instanceof UsageError) {
      console.error(`${err.message}\n${USAGE}`);
      return 2;
    }
    if (REFUSALS.some((c) => err instanceof c)) {
      console.error(err instanceof Error ? err.message : String(err));
      return 1;
    }
    console.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  } finally {
    try { composed?.close(); } catch { /* the pool is already closed */ }
    try { wb?.close(); } catch (err) { console.error(`closing the workbench failed: ${err instanceof Error ? err.message : String(err)}`); }
    fixture?.stop();
  }
}

process.exitCode = await main(process.argv.slice(2));
