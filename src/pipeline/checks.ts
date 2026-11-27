import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CaseState } from "../core/state";
import { openQuestions } from "../core/state";
import { MARKINGS } from "../core/types";
import type { CheckFinding, Coverage, Draft, EmptyMeans, Marking, PersonBasis } from "../core/types";
import { citedOf } from "../agents/draft";
import type { Profile } from "../agents/context";
import { schemaOf } from "../agents/context";
import type { Registry } from "../modules/registry";
import { CHECK_SCRIPT } from "./components";
import type { Components } from "./components";
import type { EngineDeps } from "./engine";
import { loadChecks } from "./manifests";
import type { CheckManifest } from "./manifests";

export interface CheckInput {
  check: string;
  draft: { n: number; hash: string; product: Draft["product"] };
  cards: Record<string, { id: string; title: string; source: string | null; marking: Marking; coverage: Coverage | null; empty: EmptyMeans | null; row_count: number; quality_notes: string[];
    /** Only on a statement by the person: how they know it and the question it answers. */
    person?: { basis: PersonBasis; answers: string | null };
  }>;
  sources: Record<string, { quality: string; quality_notes: { id: string; text: string }[]; marking: Marking }>;
  schema: Json; standard: Json; markings: Marking[];
  objective: { id: string; title: string } | null; question: string;
  earlier: { n: number; hash: string }[];
  /** Every card id the draft cites, in its findings or its narrative. */
  cited?: string[];
  /** The run's unanswered questions to the person; absent when there is none. */
  questions?: { id: string; text: string }[];
}
export interface CheckOutcome { pass: boolean; findings: CheckFinding[]; script_hash: string; input: Uint8Array; output: Uint8Array }
export const CHECK_MAX_OUTPUT = 1048576;

/**
 * What a check is told: the draft, the cards it cites that exist, their sources, the schema and the standard. Throws when the profile's standard
 * or the schema is missing. The standard and the schema are read from `from` (a bound run's components, for its checks `stage`); the sources
 * and the objective are the registry's.
 */
export function checkInput(check: string, state: Readonly<CaseState>, draft: Draft, registry: Registry, profile: Profile, from: Components | Registry = registry, stage = "*"): CheckInput {
  const cards: CheckInput["cards"] = {};
  const sources: CheckInput["sources"] = {};
  const cited = citedOf(draft);
  for (const id of cited) {
    if (!Object.hasOwn(state.cards, id)) continue;
    const c = state.cards[id]!;
    cards[id] = {
      id: c.id, title: c.title, source: c.source, marking: c.marking, coverage: c.coverage, empty: c.empty, row_count: c.row_count, quality_notes: [...c.quality_notes],
      // only a statement carries it, so an input that cites none is byte for byte what it was
      ...(c.person === undefined ? {} : { person: { basis: c.person.basis, answers: c.person.answers } }),
    };
    const s = c.source === null ? null : registry.source(c.source);
    if (c.source !== null && s !== null && !Object.hasOwn(sources, c.source)) {
      sources[c.source] = { quality: s.quality, quality_notes: s.quality_notes.map((n) => ({ id: n.id, text: n.text })), marking: s.marking };
    }
  }
  if (profile.standard === null) throw new Error("the profile names no standard");
  const standard = "rootOf" in from ? from.get("standard", profile.standard) : from.get(stage, "standard", profile.standard);
  if (standard === null) throw new Error(`standard "${profile.standard}" was not found`);
  const objective = state.meta?.objective ?? null;
  const objectiveManifest = objective === null ? null : registry.get("objective", objective);
  const open = openQuestions(state);
  return {
    check,
    draft: { n: draft.n, hash: draft.hash, product: draft.product },
    cards, sources,
    schema: schemaOf(from, "product", stage) as unknown as Json,
    standard: standard.body as Json,
    markings: [...MARKINGS],
    objective: objective === null ? null : { id: objective, title: objectiveManifest?.title ?? objective },
    question: state.meta?.asked ?? "",
    earlier: state.published.map((p) => ({ n: p.n, hash: p.draft_hash })),
    cited,
    // only when one is open, so an input with none is byte for byte what it was
    ...(open.length === 0 ? {} : { questions: open.map((q) => ({ id: q.id, text: q.text })) }),
  };
}

const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const failed = (check: CheckManifest, message: string, script_hash: string, input: Uint8Array, output: Uint8Array): CheckOutcome =>
  ({ pass: false, findings: [{ check: check.id, where: "check", message }], script_hash, input, output });

/** What a program printed, as findings; null when it is not the agreed shape. */
function parseFindings(text: string): { pass: boolean; findings: { where: string; message: string }[] } | null {
  let x: unknown;
  try { x = JSON.parse(text); } catch { return null; }
  if (typeof x !== "object" || x === null || Array.isArray(x)) return null;
  const { pass, findings } = x as { pass?: unknown; findings?: unknown };
  if (typeof pass !== "boolean" || !Array.isArray(findings)) return null;
  const out: { where: string; message: string }[] = [];
  for (const f of findings) {
    if (typeof f !== "object" || f === null) return null;
    const { where, message } = f as { where?: unknown; message?: unknown };
    if (typeof where !== "string" || typeof message !== "string") return null;
    out.push({ where, message });
  }
  return { pass, findings: out };
}

/**
 * Runs one check as a separate program: JSON in on standard input, one JSON object out. It gets a stripped environment and a temporary
 * working folder, and is killed at its timeout. Every way of not answering is a failed check with the reason; this never throws.
 */
export async function runCheck(check: CheckManifest, input: CheckInput): Promise<CheckOutcome> {
  const empty = new Uint8Array(0);
  const script = join(dirname(check.path), check.script);
  let scriptBytes: Uint8Array;
  try {
    scriptBytes = readFileSync(script);
  } catch (err) {
    return failed(check, `could not read the script: ${(err as Error).message.split("\n")[0]}`, "", empty, empty);
  }
  const script_hash = sha256Hex(scriptBytes);
  let inputBytes: Uint8Array;
  try {
    inputBytes = bytesOf(canonical(input as unknown as Json));
  } catch (err) {
    return failed(check, `could not encode the input: ${(err as Error).message.split("\n")[0]}`, script_hash, empty, empty);
  }
  let cwd: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killGroup = (): void => {};
  try {
    cwd = mkdtempSync(join(tmpdir(), "rw-check-"));
    // what runs is a copy of the bytes that were hashed, alone in the working folder: the original may change, and its siblings are out of reach
    const copy = join(cwd, basename(script));
    writeFileSync(copy, scriptBytes, { mode: check.runner === "exec" ? 0o700 : 0o600 });
    const cmd = check.runner === "bun" ? [process.execPath, copy] : [copy];
    // its own process group, so that the whole group can be killed, not only the program
    const proc = Bun.spawn(cmd, { cwd, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true });
    killGroup = (): void => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* the group is gone */ } try { proc.kill("SIGKILL"); } catch { /* so is the program */ } };
    let timedOut = false;
    let tooBig = false;
    const stop = new Promise<"stop">((resolve) => {
      timer = setTimeout(() => { timedOut = true; killGroup(); resolve("stop"); }, check.timeout_ms);
    });
    try {
      proc.stdin.write(inputBytes);
      void Promise.resolve(proc.stdin.end()).catch(() => {});
    } catch { /* a program that does not read its input may have exited already */ }

    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
    const readAll = async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        const room = CHECK_MAX_OUTPUT - total;
        if (value.length > room) {
          if (room > 0) chunks.push(value.subarray(0, room));
          total = CHECK_MAX_OUTPUT;
          tooBig = true;
          killGroup();
          return;
        }
        chunks.push(value);
        total += value.length;
      }
    };
    await Promise.race([readAll().catch(() => {}), stop]);
    if (timedOut || tooBig) void reader.cancel().catch(() => {});
    // a program that closed its output and carries on has not finished: it runs until the timeout, which kills it
    let code = -1;
    if (!timedOut && !tooBig) {
      const ended = await Promise.race([proc.exited, stop]);
      if (ended === "stop") timedOut = true;
      else code = ended;
    }
    killGroup();
    const output = Buffer.concat(chunks);
    if (timedOut) return failed(check, `timed out after ${check.timeout_ms} ms`, script_hash, inputBytes, output);
    if (tooBig) return failed(check, "returned more than 1 MiB", script_hash, inputBytes, output);
    if (code !== 0) return failed(check, `exited with code ${code}`, script_hash, inputBytes, output);
    const parsed = parseFindings(new TextDecoder().decode(output));
    if (parsed === null) return failed(check, "did not return valid findings", script_hash, inputBytes, output);
    const findings = parsed.findings.map((f): CheckFinding => ({ check: check.id, where: f.where, message: f.message }));
    if (parsed.pass && findings.length === 0) return { pass: true, findings, script_hash, input: inputBytes, output };
    if (findings.length === 0) findings.push({ check: check.id, where: "check", message: "failed without saying why" });
    return { pass: false, findings, script_hash, input: inputBytes, output };
  } catch (err) {
    return failed(check, `could not run: ${(err as Error).message.split("\n")[0]}`, script_hash, inputBytes, empty);
  } finally {
    clearTimeout(timer);
    killGroup();
    if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
  }
}

type Found = ReturnType<typeof loadChecks>;
const HASH12 = 12;

/** A bound check's manifest body as a CheckManifest, or why it cannot run. */
function boundCheck(id: string, title: string, hash: string, body: Record<string, unknown>): Omit<CheckManifest, "path"> | string {
  const { script, order, runner, timeout_ms, blocking } = body;
  if (typeof script !== "string" || script === "" || script !== basename(script) || script === "." || script === ".." || isAbsolute(script) || /[\\/]/.test(script)) return "its script is not a plain file name";
  if (typeof order !== "number") return "order must be a number";
  if (runner !== "bun" && runner !== "exec") return "runner must be bun or exec";
  if (typeof timeout_ms !== "number" || !(timeout_ms > 0) || !Number.isFinite(timeout_ms)) return "timeout_ms must be a positive number";
  return { id, title: typeof body.title === "string" && body.title !== "" ? body.title : title, order, hash, script, runner, timeout_ms, blocking: blocking !== false };
}

/** The checks of a checks stage: the lock's check items and their scripts when the run is bound; loadChecks(registry) otherwise. A bound check runs from a file written from the content store under <case>/checks-<hash12>/. */
export function checksFor(deps: EngineDeps, stage: string, caseDir: string): { checks: CheckManifest[]; problems: string[]; broken: { id: string; problem: string }[] } {
  const from = deps.components;
  if (from === undefined) return loadChecks(deps.registry);
  const found: Found = { checks: [], problems: [], broken: [] };
  const items = from.items().filter((i) => i.stage === stage);
  for (const item of items.filter((i) => i.kind === "check")) {
    const bad = (problem: string): void => { found.problems.push(`check ${item.id}: ${problem}`); found.broken.push({ id: item.id, problem }); };
    const scriptItem = items.find((i) => i.kind === CHECK_SCRIPT && i.id === item.id);
    const manifest = from.get(stage, "check", item.id);
    if (scriptItem === undefined || manifest === null) { bad("the loop holds no script for it"); continue; }
    const content = deps.content;
    if (content === undefined) { bad("there is no content store to read it from"); continue; }
    if (content.check(item.hash) !== "ok") { bad(`its manifest (${item.hash.slice(0, HASH12)}) is not in the content store`); continue; }
    if (content.check(scriptItem.hash) !== "ok") { bad(`its script (${scriptItem.hash.slice(0, HASH12)}) is not in the content store`); continue; }
    const made = boundCheck(item.id, item.title, item.hash, manifest.body);
    if (typeof made === "string") { bad(made); continue; }
    // the script is written once per hash, from the content store's bytes, into the case's own folder
    const folder = join(caseDir, `checks-${scriptItem.hash.slice(0, HASH12)}`);
    const file = join(folder, made.script);
    const bytes = content.get(scriptItem.hash);
    if (sha256Hex(bytes) !== scriptItem.hash) { bad(`its script (${scriptItem.hash.slice(0, HASH12)}) is not in the content store`); continue; }
    let held: Uint8Array | null = null;
    try { held = existsSync(file) ? new Uint8Array(readFileSync(file)) : null; } catch { held = null; }
    if (held === null || sha256Hex(held) !== scriptItem.hash) {
      mkdirSync(folder, { recursive: true });
      writeFileSync(file, bytes, { mode: 0o600 });
    }
    found.checks.push({ ...made, path: join(folder, basename(item.path ?? `${item.id}.yaml`)) });
  }
  found.checks.sort((a, b) => a.order - b.order);
  return found;
}
