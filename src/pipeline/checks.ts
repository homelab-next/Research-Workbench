import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Json } from "../core/canonical";
import { canonical } from "../core/canonical";
import { sha256Hex } from "../core/hash";
import type { CaseState } from "../core/state";
import { MARKINGS } from "../core/types";
import type { CheckFinding, Coverage, Draft, EmptyMeans, Marking } from "../core/types";
import type { Profile } from "../agents/context";
import { schemaOf } from "../agents/context";
import type { Registry } from "../modules/registry";
import type { CheckManifest } from "./manifests";

export interface CheckInput {
  check: string;
  draft: { n: number; hash: string; product: Draft["product"] };
  cards: Record<string, { id: string; title: string; source: string | null; marking: Marking; coverage: Coverage | null; empty: EmptyMeans | null; row_count: number; quality_notes: string[] }>;
  sources: Record<string, { quality: string; quality_notes: { id: string; text: string }[]; marking: Marking }>;
  schema: Json; standard: Json; markings: Marking[];
  objective: { id: string; title: string } | null; question: string;
  earlier: { n: number; hash: string }[];
}
export interface CheckOutcome { pass: boolean; findings: CheckFinding[]; script_hash: string; input: Uint8Array; output: Uint8Array }
export const CHECK_MAX_OUTPUT = 1048576;

/** What a check is told: the draft, the cards it cites that exist, their sources, the schema and the standard. Throws when the profile's standard or the schema is missing. */
export function checkInput(check: string, state: Readonly<CaseState>, draft: Draft, registry: Registry, profile: Profile): CheckInput {
  const cards: CheckInput["cards"] = {};
  const sources: CheckInput["sources"] = {};
  for (const id of new Set(draft.product.key_findings.flatMap((f) => f.cites))) {
    if (!Object.hasOwn(state.cards, id)) continue;
    const c = state.cards[id]!;
    cards[id] = { id: c.id, title: c.title, source: c.source, marking: c.marking, coverage: c.coverage, empty: c.empty, row_count: c.row_count, quality_notes: [...c.quality_notes] };
    const s = c.source === null ? null : registry.source(c.source);
    if (c.source !== null && s !== null && !Object.hasOwn(sources, c.source)) {
      sources[c.source] = { quality: s.quality, quality_notes: s.quality_notes.map((n) => ({ id: n.id, text: n.text })), marking: s.marking };
    }
  }
  if (profile.standard === null) throw new Error("the profile names no standard");
  const standard = registry.get("standard", profile.standard);
  if (standard === null) throw new Error(`standard "${profile.standard}" was not found`);
  const objective = state.meta?.objective ?? null;
  const objectiveManifest = objective === null ? null : registry.get("objective", objective);
  return {
    check,
    draft: { n: draft.n, hash: draft.hash, product: draft.product },
    cards, sources,
    schema: schemaOf(registry, "product") as unknown as Json,
    standard: standard.body as Json,
    markings: [...MARKINGS],
    objective: objective === null ? null : { id: objective, title: objectiveManifest?.title ?? objective },
    question: state.meta?.asked ?? "",
    earlier: state.published.map((p) => ({ n: p.n, hash: p.draft_hash })),
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
  try {
    cwd = mkdtempSync(join(tmpdir(), "rw-check-"));
    const cmd = check.runner === "bun" ? [process.execPath, script] : [script];
    const proc = Bun.spawn(cmd, { cwd, env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    let tooBig = false;
    const stop = new Promise<"stop">((resolve) => {
      timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); resolve("stop"); }, check.timeout_ms);
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
          proc.kill("SIGKILL");
          return;
        }
        chunks.push(value);
        total += value.length;
      }
    };
    await Promise.race([readAll().catch(() => {}), stop]);
    if (timedOut || tooBig) void reader.cancel().catch(() => {});
    const code = await Promise.race([proc.exited, new Promise<number>((r) => setTimeout(() => r(-1), 2000))]);
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
    if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
  }
}
