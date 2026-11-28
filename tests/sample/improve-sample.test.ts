// Slice 14, Task 21: the sample's improve story. A case type device-check ("Which device held this address?"), its loop on the script
// sample-check, three addresses of the sample's data as its tasks, and the improve loop on the script sample-improve. The known answers
// are the person's, so they live here and in the sample's README, never in a script, a loop, a skill or a schema.
import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { compose } from "../../src/cli/compose";
import { claimSimilarity, scoreOutput } from "../../src/core/score";
import { probeOutputOf } from "../../src/core/state";
import type { AnswerCopy, ProbeOutput } from "../../src/core/state";
import { Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import type { ExpectedFinding } from "../../src/core/types";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import { copySample } from "../helpers/sample-root";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const REPO_SAMPLE = join(import.meta.dir, "..", "..", "sample");

/** The hashes the sample's loops had before this slice: the three literals the sample tests hold, and the unknown-device loop's. */
const SAMPLE_LEGACY_HASH = "19f7829f3f9c97faf5c149c0eddc4b047471ca3b2119f168abe2cbef93761329";
const SAMPLE_INVESTIGATION_HASH = "ec2e79367acfc215dbbc23642eb0039c9d2f67971ab12618618fd04f68b35c1c";
const SAMPLE_TRIAGE_HASH = "a355a2cb8ccf568944042d0db18e5bd8e775bbdd196a8ab9c4f62519b3b642b2";
const SAMPLE_UNKNOWN_DEVICE_HASH = "bb36a4611091e5d236ba41e1c0075e8c0eef49a9f2074ecd76c42b4ba983f709";

/** What this task adds to the sample root. */
const NEW_FILES = [
  "case-types-device-check.yaml", "loops/improve.yaml", "loops/device-check.yaml", "context/improve-profile.yaml", "context/device-check-profile.yaml",
  "context/personas/proposer.md", "context/personas/composer.md", "context/personas/reflector.md", "context/skills/find-the-device.md",
  "context/schemas/propose-output.yaml", "context/schemas/compose-output.yaml", "context/schemas/judge-output.yaml",
  "scripts/sample-check.yaml", "scripts/sample-improve.yaml",
];

/** The sentence the candidate K1 adds to the skill find-the-device; the device-check script's `when` turns carry its words. */
const K1_SENTENCE = "For an address that is not in the asset list, plan the lookup in the WiFi log in place of the lease records: a device that took no lease is named by the connection message it sent when it joined.";

/** The three tasks: an address of the sample's data each, and the person's known answer for the case's published product. */
const SAMPLE_TASKS: { address: string; device: string; text: string; findings: ExpectedFinding[] }[] = [
  {
    address: "192.0.2.14", device: "ws-14.example.net",
    text: "answer-key-1: the workstation ws-14.example.net holds this address under its lease.",
    findings: [{ claim: "ws-14.example.net was the device holding 192.0.2.14 by lease", likelihood: "very likely", confidence: "moderate" }],
  },
  {
    address: "192.0.2.61", device: "ws-17.example.net",
    text: "answer-key-2: the workstation ws-17.example.net joined the WiFi at this address without a lease.",
    findings: [{ claim: "ws-17.example.net was the device at 192.0.2.61, as its WiFi connection message shows", likelihood: "very likely", confidence: "moderate" }],
  },
  {
    address: "192.0.2.62", device: "pr-2.example.net",
    text: "answer-key-3: the printer pr-2.example.net joined the WiFi at this address without a lease.",
    findings: [{ claim: "pr-2.example.net was the device at 192.0.2.62, as its WiFi connection message shows", likelihood: "very likely", confidence: "moderate" }],
  },
];
const CANARIES = ["answer-key-1", "answer-key-2", "answer-key-3"];

const caseOf = (address: string): Partial<NewCase> & { loop: string } => ({
  loop: "device-check", title: `Device at ${address}`, asked: `Which device held ${address}?`, why: "sample",
  starting: [{ type: "address", value: address }], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN",
});

/** Every file under the folder, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? filesUnder(p).map((x) => join(f, x)) : [f];
  });
}

/** A workbench composed over a fresh copy of the sample, for a test that only reads what it loaded. */
function composedSample(): { config: Config; composed: ReturnType<typeof compose>; wb: Workbench; root: string; close(): void } {
  const d = mkdtempSync(join(tmpdir(), "improve-sample-"));
  const root = join(d, "sample");
  copySample(root);
  const config: Config = { ...loadConfig({ env: {}, home: d, repoRoot: d }), data_dir: join(d, "wb"), roots: [{ path: root, trusted: true, credentials: [] }] };
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  const composed = compose(config, wb);
  return { config, composed, wb, root, close: () => { composed.close(); wb.close(); rmSync(d, { recursive: true, force: true }); } };
}

test("the sample root loads with no problems, with the loops improve and device-check usable and the case type device-check", () => {
  for (const f of NEW_FILES) expect(`${f}: ${filesUnder(REPO_SAMPLE).includes(f)}`).toBe(`${f}: true`);
  const s = composedSample();
  try {
    const { composed } = s;
    expect(composed.problems).toEqual([]);
    const loops = composed.deps.loops!;
    const check = loops.current("device-check")!;
    expect(check).not.toBeNull();
    expect(check.manifest.case_type).toBe("device-check");
    expect(check.pipeline.stages.map((st) => [st.id, st.role, st.gate, st.reviews])).toEqual([
      ["frame", "frame", null, false], ["plan", "plan", "plan", false], ["research", "research", null, false],
      ["assemble", "assemble", null, false], ["checks", "checks", null, true], ["publish", "publish", "publish", false],
    ]);
    for (const st of check.pipeline.stages) if (st.model !== null) expect(st.model).toEqual({ provider: "scripted", model: "sample-check", effort: null });
    const improve = loops.current("improve")!;
    expect(improve).not.toBeNull();
    expect(improve.pipeline.stages.map((st) => st.role)).toEqual([...IMPROVE_ROLES]);
    expect(improve.pipeline.stages.map((st) => [st.id, st.runs, st.gate])).toEqual([
      ["select", "script", null], ["propose", "agent", null], ["probe", "script", null], ["compose", "agent", null],
      ["judge", "script", null], ["reflect", "agent", null], ["adopt", "human", "adopt"],
    ]);
    const byRole = Object.fromEntries(improve.pipeline.stages.map((st) => [st.role, st]));
    expect(byRole.propose!.tools).toEqual(["propose_change", "loop_catalogue", "adapter_catalogue", "validate_manifest"]);
    expect([byRole.propose!.schema, byRole.compose!.schema, byRole.judge!.schema, byRole.reflect!.schema]).toEqual(["propose-output", "compose-output", "judge-output", "lessons-output"]);
    expect(byRole.probe!.probe).toEqual({ plan_gate: "accept" });
    const registry = composed.deps.registry;
    expect((registry.get("loop", "improve")!.body as { components: unknown }).components).toEqual({ propose: { "reference:shared-lessons": { memory: "shared/*" } } });
    // the case type is a manifest of its own, so a root that replaces case-types.yaml keeps it
    expect(registry.get("case-types", "sample-device-check")!.body.types).toEqual([{ id: "device-check", title: "Device check", about: "Which device held this address?" }]);
    expect(composed.deps.case_types!.map((t) => t.id)).toEqual(["device-check", "unknown-device"]);
    // Research's profile entry lists the skill, whose text says to look the address up in the lease records
    const profile = registry.get("profile", "device-check")!.body.stages as Record<string, { skills?: string[] }>;
    expect(profile.research!.skills).toEqual(["find-the-device"]);
    const skill = readFileSync(join(REPO_SAMPLE, "context", "skills", "find-the-device.md"), "utf8");
    expect(skill).toContain("look the address up in the lease records");
    expect(skill).not.toContain(K1_SENTENCE);
    // the improve script: three proposals (the skill with the sentence added, Research's turns, a check), a choice of K1, one lesson
    const script = Bun.YAML.parse(readFileSync(join(REPO_SAMPLE, "scripts", "sample-improve.yaml"), "utf8")) as { turns: { actor: string; reply: { content?: string; tool_calls?: { tool: string; args: { files: { path: string; text: string }[] } }[] } }[] };
    const calls = script.turns.flatMap((t) => t.reply.tool_calls ?? []);
    expect(calls.map((c) => [c.tool, c.args.files.map((f) => f.path)])).toEqual([
      ["propose_change", ["context/skills/find-the-device.md"]], ["propose_change", ["loops/device-check.yaml"]], ["propose_change", ["checks/07-alternatives.yaml"]],
    ]);
    expect(calls[0]!.args.files[0]!.text).toBe(skill.replace("which is complete for internal hosts.\n", `which is complete for internal hosts.\n\n${K1_SENTENCE}\n`));
    const loopText = readFileSync(join(REPO_SAMPLE, "loops", "device-check.yaml"), "utf8");
    expect(calls[1]!.args.files[0]!.text).toBe(loopText.replace("version: 1\n", "version: 2\n")
      .replace("    tools: [find_routes, run_step, run_pivot, list_cards, read_card]\n", "    tools: [find_routes, run_step, run_pivot, list_cards, read_card]\n    max_turns: 12\n"));
    const answer = (actor: string): Record<string, unknown> => JSON.parse(script.turns.find((t) => t.actor === actor)!.reply.content!) as Record<string, unknown>;
    expect(answer("composer").choice).toBe("K1");
    expect(String(answer("composer").why)).toMatch(/T2 and T3/);
    expect((answer("reflector").lessons as unknown[]).length).toBe(1);
  } finally {
    s.close();
  }
});

test("the investigation, triage and unknown-device loops have the hashes they had", () => {
  // the three literals the existing sample tests hold
  const s = composedSample();
  try {
    const loops = s.composed.deps.loops!;
    expect(loops.current("investigation")!.pipeline.hash).toBe(SAMPLE_INVESTIGATION_HASH);
    expect(loops.current("investigation")!.pipeline.legacy_hash).toBe(SAMPLE_LEGACY_HASH);
    expect(loops.current("triage")!.pipeline.hash).toBe(SAMPLE_TRIAGE_HASH);
    expect(loops.current("unknown-device")!.pipeline.hash).toBe(SAMPLE_UNKNOWN_DEVICE_HASH);
    expect(s.composed.deps.pipeline.hash).toBe(SAMPLE_INVESTIGATION_HASH);
  } finally {
    s.close();
  }
});

/** Each address's case run to its publish gate on the scripted model, the person accepting the plan; the probe output of each. */
async function runTasks(s: Served): Promise<ProbeOutput[]> {
  const outputs: ProbeOutput[] = [];
  for (const t of SAMPLE_TASKS) {
    const id = await s.newCase(caseOf(t.address));
    await s.toPlanGate(id);
    const accepted = await s.command(id, "accept_plan");
    expect(accepted.status).toBe(200);
    await s.app.hub.idle();
    const session = s.app.hub.read(id);
    expect(session.state.skipped).toEqual([]);
    expect([t.address, session.state.run.status, session.state.run.waiting]).toEqual([t.address, "waiting", "publish"]);
    expect(session.state.memory.type).toBe("device-check");
    outputs.push(probeOutputOf(session.state));
  }
  return outputs;
}

/** The score code gives each output against its task's known answer, on the sample standard's likelihood scale. */
function scores(outputs: ProbeOutput[], candidate: string): number[] {
  const scale = ["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"];
  return outputs.map((o, i) => {
    const t = SAMPLE_TASKS[i]!;
    const answer: AnswerCopy = { task: `T${i + 1}`, seq: 1, hash: "0".repeat(64), text: t.text, findings: t.findings, marking: "TLP:GREEN" };
    return scoreOutput({ probe: `${candidate}/T${i + 1}`, candidate, task: `T${i + 1}` }, o, answer, scale).score!;
  });
}

test("a device-check case runs to its publish gate on the scripted model for each of the three addresses", async () => {
  const base = await served();
  let candidate: Served | null = null;
  let baseOutputs: ProbeOutput[];
  let candidateOutputs: ProbeOutput[];
  try {
    baseOutputs = await runTasks(base);
    // the skill as candidate K1 changes it
    candidate = await served({
      before: (root) => {
        const path = join(root, "context", "skills", "find-the-device.md");
        writeFileSync(path, readFileSync(path, "utf8").replace("which is complete for internal hosts.\n", `which is complete for internal hosts.\n\n${K1_SENTENCE}\n`));
      },
    });
    candidateOutputs = await runTasks(candidate);
  } finally {
    await base.close();
    await candidate?.close();
  }
  expect(baseOutputs.map((o) => o.outcome)).toEqual(["drafted", "drafted", "drafted"]);
  const statements = baseOutputs.map((o) => o.product!.key_findings.map((f) => f.statement));
  // the lease answers the first; for the other two only the asset list's proven negative is a finding, and the device is not named
  expect(statements[0]!.join(" ")).toContain("ws-14.example.net");
  expect(statements[1]).toEqual(["We assess it is almost certain that 192.0.2.61 is not an internal host."]);
  expect(statements[2]).toEqual(["We assess it is almost certain that 192.0.2.62 is not an internal host."]);
  for (const o of baseOutputs) expect(o.product!.gaps_and_limits).toContain("lease");
  // with the sentence K1 adds, the WiFi log is asked too and the device is named on the second and third
  expect(candidateOutputs.map((o) => o.outcome)).toEqual(["drafted", "drafted", "drafted"]);
  expect(candidateOutputs[0]!.product!.key_findings.map((f) => f.statement)).toEqual(baseOutputs[0]!.product!.key_findings.map((f) => f.statement));
  for (const i of [1, 2]) expect(candidateOutputs[i]!.product!.key_findings.map((f) => f.statement).join(" ")).toContain(SAMPLE_TASKS[i]!.device);
  expect(baseOutputs.map((o) => o.stats.lookups)).toEqual([2, 2, 2]);
  expect(candidateOutputs.map((o) => o.stats.lookups)).toEqual([2, 2, 2]);
  // scored in code against the known answers: the base 1000, 0, 0 (333) and K1 1000 on each (1000); each expected finding matched at full agreement or not at all
  expect(scores(baseOutputs, "base")).toEqual([1000, 0, 0]);
  expect(scores(candidateOutputs, "K1")).toEqual([1000, 1000, 1000]);
  for (const [i, t] of SAMPLE_TASKS.entries()) {
    const best = (o: ProbeOutput): number => Math.max(...o.product!.key_findings.map((f) => claimSimilarity(t.findings[0]!.claim, f.statement)));
    expect(best(candidateOutputs[i]!)).toBeGreaterThanOrEqual(500);
    if (i > 0) expect(best(baseOutputs[i]!)).toBeLessThan(500);
  }
}, 180_000);

test("no script, loop, skill or schema of the sample holds a known answer's canary or claim", () => {
  const read = ["scripts", "loops", "context/skills", "context/schemas", "context/procedures", "context/personas", "stages", "memory"]
    .flatMap((d) => filesUnder(join(REPO_SAMPLE, d)).map((f) => join(d, f)));
  expect(read).toContain("scripts/sample-check.yaml");
  expect(read).toContain("scripts/sample-improve.yaml");
  for (const f of read) {
    const text = readFileSync(join(REPO_SAMPLE, f), "utf8");
    for (const c of CANARIES) expect(`${f}: ${text.includes(c)}`).toBe(`${f}: false`);
    for (const t of SAMPLE_TASKS) {
      expect(`${f}: ${text.includes(t.text)}`).toBe(`${f}: false`);
      for (const e of t.findings) expect(`${f}: ${text.toLowerCase().includes(e.claim.toLowerCase())}`).toBe(`${f}: false`);
    }
  }
  // the claims are worded unlike any scripted finding: no claim the script proposes is an expected claim
  const script = Bun.YAML.parse(readFileSync(join(REPO_SAMPLE, "scripts", "sample-check.yaml"), "utf8")) as { turns: { reply: { tool_calls?: { tool: string; args: { claim?: string } }[] } }[] };
  const claims = script.turns.flatMap((t) => (t.reply.tool_calls ?? []).filter((c) => c.tool === "propose_assessment").map((c) => c.args.claim!));
  expect(claims.length).toBeGreaterThan(0);
  for (const t of SAMPLE_TASKS) for (const e of t.findings) expect(claims).not.toContain(e.claim);
});

test("every name in the new files is the sample's: loopback and RFC 5737 addresses, example domains", () => {
  const reserved = /^(?:127\.0\.0\.1|192\.0\.2\.\d{1,3}|198\.51\.100\.\d{1,3}|203\.0\.113\.\d{1,3})$/;
  // generic shapes only: private ranges, a MAC address, a home folder (the owner's own words are read from the private-terms file, below)
  const forbidden = [/\b192\.168\./, /\b10\.\d+\.\d+\.\d+\b/, /\b172\.(?:1[6-9]|2\d|3[01])\./, /(?:[0-9a-f]{2}:){5}[0-9a-f]{2}/i, /\/home\//, /\/Users\//];
  for (const f of [...NEW_FILES, "README.md"]) {
    const text = readFileSync(join(REPO_SAMPLE, f), "utf8");
    for (const a of text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? []) expect(`${f}: ${a} ${reserved.test(a)}`).toBe(`${f}: ${a} true`);
    for (const n of text.match(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|lan|local|home|internal|corp|arpa)\b/gi) ?? []) {
      expect(`${f}: ${n} ${/(?:^|\.)example\.(?:com|net|org)$/.test(n)}`).toBe(`${f}: ${n} true`);
    }
    for (const re of forbidden) expect(`${f}: ${re} ${re.test(text)}`).toBe(`${f}: ${re} false`);
  }
  // the task addresses are in the sample's data, and none of them is a prefix of another
  for (const t of SAMPLE_TASKS) for (const u of SAMPLE_TASKS) if (t !== u) expect(u.address.startsWith(t.address)).toBe(false);
});

// the owner's words are never written in the repository: they are read from the file WORKBENCH_PRIVATE_TERMS names, as the hygiene test reads them
test.skipIf(!process.env.WORKBENCH_PRIVATE_TERMS)("no private term is in the new sample files", () => {
  const terms = readFileSync(process.env.WORKBENCH_PRIVATE_TERMS!, "utf8").split("\n").map((l) => l.trim().toLowerCase()).filter((l) => l !== "" && !l.startsWith("#"));
  const hits: string[] = [];
  for (const f of [...NEW_FILES, "README.md"]) {
    const text = readFileSync(join(REPO_SAMPLE, f), "utf8").toLowerCase();
    terms.forEach((t, n) => { if (text.includes(t)) hits.push(`${f} (term #${n + 1})`); });
  }
  expect(hits).toEqual([]);
});
