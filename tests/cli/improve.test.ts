// Slice 14, Task 18: bun run improve sets known answers and starts and shows an improve run. The workbench is a copy of the sample with an improve
// loop written beside it; the task case is published by the investigate command, as a person would.
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { improve } from "../../src/cli/improve";
import { IMPROVE_ROLES } from "../../src/pipeline/manifests";
import { cleanEnv } from "../helpers/clean-env";
import { copySample } from "../helpers/sample-root";

const REPO = join(import.meta.dir, "..", "..");
const RUN = join(REPO, "src", "cli", "run.ts");
const ASK = "context/skills/ask-the-person.md";
const TARGET = "investigation";

interface Env { dir: string; config: string; data: string; root: string; port: number }
const dirs: string[] = [];
let base: Env;

const freePort = (): number => {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  void s.stop(true);
  return port;
};

const TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };
const improveLoop = (): string => {
  const stages = IMPROVE_ROLES.map((role, i) => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: role === "propose" ? ["propose_change", "loop_catalogue", "adapter_catalogue", "validate_manifest"] : [],
      schema: role === "compose"
        ? "compose-cli-test"
        : role === "reflect" ? "lessons-output" : null,
      model: agent ? { provider: "scripted", model: "improve-cli-test", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  return JSON.stringify({ kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-cli-test", entry: "select", stages }, null, 2);
};
const improveProfile = (): string => JSON.stringify({
  kind: "profile", id: "improve-cli-test", title: "Improve (cli test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
  stages: Object.fromEntries([["propose", "proposer"], ["compose", "composer"], ["reflect", "reflector"]].map(([id, agent]) => [id, { agent, persona: "analyst", goal: `The ${id} stage of the test.` }])),
});
const improveScript = (root: string): string => {
  const text = readFileSync(join(root, ASK), "utf8");
  const files = [{ path: ASK, text: text.replace("Ask one thing at a time, and ask early.", "Ask one thing at a time.") }];
  return JSON.stringify({
    kind: "script", id: "improve-cli-test", title: "Scripted improve run",
    turns: [
      { actor: "proposer", reply: { tool_calls: [{ tool: "propose_change", args: { why: "shorter", title: "Shorter ask", files } }] } },
      { actor: "proposer", reply: { content: "Proposed what is above." } },
      { actor: "composer", reply: { content: JSON.stringify({ choice: "K1", why: "K1 reads shorter" }) } },
      { actor: "reflector", reply: { content: JSON.stringify({ lessons: [] }) } },
    ],
  });
};

const runCli = (e: Env, script: string, args: string[]): { code: number; out: string; err: string } => {
  const r = Bun.spawnSync(["bun", "run", script, ...args, "--config", e.config], { cwd: REPO, timeout: 120_000, env: cleanEnv(e.dir), stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
};
const configOf = (dir: string, data: string, root: string): string => {
  const config = join(dir, "config.yaml");
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  return config;
};

/** A workbench holding one published case of the case type, as the investigate command leaves it. */
function prepare(): Env {
  const dir = mkdtempSync(join(tmpdir(), "cli-improve-"));
  dirs.push(dir);
  const root = join(dir, "sample");
  copySample(root);
  const port = freePort();
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", `http://127.0.0.1:${port}`));
  writeFileSync(join(root, "loops", "improve.yaml"), improveLoop());
  writeFileSync(join(root, "context", "improve-cli-test-profile.yaml"), improveProfile());
  writeFileSync(join(root, "context", "schemas", "compose-cli-test.yaml"), JSON.stringify({
    kind: "schema", id: "compose-cli-test", title: "Compose output",
    schema: { type: "object", additionalProperties: false, required: ["choice", "why"], properties: { choice: { type: "string" }, why: { type: "string" } } },
  }));
  writeFileSync(join(root, "scripts", "improve-cli-test.yaml"), improveScript(root));
  const data = join(dir, "data");
  const e: Env = { dir, config: configOf(dir, data, root), data, root, port };
  const fx = ["--sample-fixture", String(port)];
  const start = runCli(e, RUN, ["start", "--title", "Sample", "--asked", "Which device is 198.51.100.77?", "--why", "demo", "--start", "address=198.51.100.77",
    "--from", "2026-11-17T00:00:00.000Z", "--to", "2026-11-24T00:00:00.000Z", "--objective", "sample-objective", "--marking", "TLP:GREEN", "--type", "unknown-device", ...fx]);
  if (start.code !== 0) throw new Error(`start: ${start.err}${start.out}`);
  const plan = runCli(e, RUN, ["accept-plan", "CASE-1", "--budget", "s3=1", ...fx]);
  if (plan.code !== 0) throw new Error(`accept-plan: ${plan.err}${plan.out}`);
  const approve = runCli(e, RUN, ["approve", "CASE-1", "--keep"]);
  if (approve.code !== 0) throw new Error(`approve: ${approve.err}${approve.out}`);
  return e;
}
/** A private copy of the prepared workbench, so a test's writes are its own. */
function fresh(): Env {
  const dir = mkdtempSync(join(tmpdir(), "cli-improve-"));
  dirs.push(dir);
  const data = join(dir, "data");
  cpSync(base.data, data, { recursive: true });
  return { ...base, dir, data, config: configOf(dir, data, base.root) };
}

beforeAll(() => { base = prepare(); });
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

let out: string[], err: string[];
const io = { log: (l: string) => void out.push(l), error: (l: string) => void err.push(l) };
const run = (e: Env, argv: string[], hooks?: Parameters<typeof improve>[2]): Promise<number> => {
  out = []; err = [];
  return improve([...argv, "--config", e.config], io, hooks);
};
const rows = (e: Env, id: string, type: string): { payload: Record<string, unknown>; actor: Record<string, unknown> }[] => {
  const db = new Database(join(e.data, "cases", id, "ledger.sqlite"), { readonly: true });
  try {
    return (db.query("select payload, actor from entries where type = ? order by seq").all(type) as { payload: string; actor: string }[])
      .map((r) => ({ payload: JSON.parse(r.payload), actor: JSON.parse(r.actor) }));
  } finally { db.close(); }
};
const headOf = (e: Env, id: string): number => {
  const db = new Database(join(e.data, "cases", id, "ledger.sqlite"), { readonly: true });
  try { return (db.query("select max(seq) as n from entries").get() as { n: number }).n; } finally { db.close(); }
};
const casesOf = (e: Env): string[] => [...new Bun.Glob("CASE-*").scanSync({ cwd: join(e.data, "cases"), onlyFiles: false })].sort();

const FINDINGS = [{ claim: "The device is the lobby printer", likelihood: "likely", confidence: "moderate" }];
const answerArgs = (e: Env, extra: string[] = []): string[] => {
  const file = join(e.dir, "findings.json");
  writeFileSync(file, JSON.stringify(FINDINGS));
  return ["answer", "CASE-1", "--product", "1", "--text", "It is the lobby printer.", "--findings", file, ...extra];
};

test("answer writes a known answer by the person of the configuration, and prints the product it is for", async () => {
  const e = fresh();
  expect(await run(e, answerArgs(e))).toBe(0);
  expect(err).toEqual([]);
  expect(out.join("\n")).toContain("product 1 of CASE-1");
  const [row] = rows(e, "CASE-1", "answer.known");
  expect(row!.actor).toEqual({ kind: "human", id: "analyst" });
  expect(row!.payload.product).toBe(1);
  expect(row!.payload.text).toBe("It is the lobby printer.");
  expect(row!.payload.findings).toEqual(FINDINGS);
  // the marking is the case's and its product's strictest, unless the person raises it
  expect(row!.payload.marking).toBe("TLP:GREEN");
  expect(await run(e, answerArgs(e, ["--marking", "TLP:AMBER"]))).toBe(0);
  expect(rows(e, "CASE-1", "answer.known").at(-1)!.payload.marking).toBe("TLP:AMBER");
  // withdrawing it says why
  expect(await run(e, ["withdraw", "CASE-1", "--product", "1", "--reason", "the printer was replaced"])).toBe(0);
  expect(rows(e, "CASE-1", "answer.withdrawn")[0]!.payload).toEqual({ product: 1, reason: "the printer was replaced" });
  expect(rows(e, "CASE-1", "answer.withdrawn")[0]!.actor).toEqual({ kind: "human", id: "analyst" });
});

test("answer with findings from a file that is not a list of findings is refused with the sentence", async () => {
  const e = fresh();
  const before = headOf(e, "CASE-1");
  const file = join(e.dir, "findings.json");
  writeFileSync(file, JSON.stringify({ claim: "not a list" }));
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text", "x", "--findings", file])).toBe(1);
  expect(err.join("\n")).toBe("the findings file holds no list of findings: a JSON list of { claim, likelihood, confidence }, each with asks: true when the claim is the person's to say");
  writeFileSync(file, JSON.stringify([{ claim: "c", likelihood: "likely" }]));
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text", "x", "--findings", file])).toBe(1);
  expect(err.join("\n")).toContain("confidence");
  writeFileSync(file, "{ not json");
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text", "x", "--findings", file])).toBe(1);
  expect(err.join("\n")).toContain("is not JSON");
  expect(headOf(e, "CASE-1")).toBe(before);
});

test("answer checks each likelihood term against the case's own standard, as the server does", async () => {
  const e = fresh();
  const before = headOf(e, "CASE-1");
  const file = join(e.dir, "findings.json");
  writeFileSync(file, JSON.stringify([{ claim: "The device is the lobby printer", likelihood: "somewhat", confidence: "moderate" }]));
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text", "x", "--findings", file])).toBe(1);
  expect(err.join("\n")).toContain("somewhat");
  expect(headOf(e, "CASE-1")).toBe(before);
});

test("answer takes its text from a file with --text-file, so it is not in the shell's history; one of --text and --text-file is needed", async () => {
  const e = fresh();
  const textFile = join(e.dir, "answer.txt");
  writeFileSync(textFile, "It is the lobby printer, from a file.\n");
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text-file", textFile])).toBe(0);
  expect(rows(e, "CASE-1", "answer.known").at(-1)!.payload.text).toBe("It is the lobby printer, from a file.");
  const before = headOf(e, "CASE-1");
  expect(await run(e, ["answer", "CASE-1", "--product", "1"])).toBe(2);
  expect(await run(e, ["answer", "CASE-1", "--product", "1", "--text", "x", "--text-file", textFile])).toBe(2);
  expect(err.join("\n")).toContain("answer needs one of --text and --text-file");
  expect(headOf(e, "CASE-1")).toBe(before);
});

test("start makes the improve case, runs it to the adopt gate on the sample, and prints the scores and where it waits", async () => {
  const e = fresh();
  expect(await run(e, answerArgs(e))).toBe(0);
  const code = await run(e, ["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--tasks", "1", "--candidates", "1"]);
  expect(err).toEqual([]);
  expect(code).toBe(0);
  const text = out.join("\n");
  expect(text).toContain("CASE-2 waiting waiting=adopt");
  expect(text).toContain("decide the whole candidate in the browser: the case's Improve lens");
  expect(text).toMatch(/score base \d+/);
  expect(text).toMatch(/score K1 \d+/);
  expect(text).toContain("chose K1: K1 reads shorter");
  // the person of the configuration asked; the command line passed no gate
  expect(rows(e, "CASE-2", "improve.requested")[0]).toEqual({ payload: { target: TARGET, case_type: "unknown-device", tasks: 1, candidates: 1 }, actor: { kind: "human", id: "analyst" } });
  expect(rows(e, "CASE-2", "gate.passed")).toEqual([]);
  expect(rows(e, "CASE-2", "builder.decided")).toEqual([]);
  // nothing reached a root
  expect(readFileSync(join(e.root, ASK), "utf8")).toContain("ask early");
  // the same account, later
  expect(await run(e, ["show", "CASE-2"])).toBe(0);
  expect(out.join("\n")).toContain("waiting at adopt");
  expect(out.join("\n")).toMatch(/score K1 \d+/);
}, 180_000);

test("show before the Judge prints no score", async () => {
  const e = fresh();
  expect(await run(e, answerArgs(e))).toBe(0);
  // Probe stalls, as a stopped process would leave it
  const code = await run(e, ["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--tasks", "1", "--candidates", "1"],
    { runners: { probe: async () => ({ kind: "stalled", reason: "probe stopped in the test" }) } });
  expect(code).toBe(1);
  expect(out.join("\n")).toContain("CASE-2 paused");
  expect(await run(e, ["show", "CASE-2"])).toBe(0);
  const text = out.join("\n");
  expect(text).toContain("improve TARGET".replace("TARGET", TARGET));
  expect(text).toContain("T1 CASE-1 product 1");
  expect(text).toContain("K1 staged");
  expect(text).not.toMatch(/score/);
  expect(text).not.toContain("chose");
  expect(text).toContain('paused stage=probe reason="probe stopped in the test"');
  // no answer's text or claim is shown
  expect(text).not.toContain("lobby printer");
});

test("investigate resume on an improve case paused mid-probe carries it on", async () => {
  const e = fresh();
  expect(await run(e, answerArgs(e))).toBe(0);
  await run(e, ["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--tasks", "1", "--candidates", "1"],
    { runners: { probe: async () => ({ kind: "stalled", reason: "probe stopped in the test" }) } });
  const r = runCli(e, RUN, ["resume", "CASE-2"]);
  expect(r.err).toBe("");
  expect(r.code).toBe(0);
  expect(r.out.split("\n")[0]).toBe("CASE-2 waiting waiting=adopt stage=adopt");
  expect(rows(e, "CASE-2", "gate.passed")).toEqual([]);
  expect(rows(e, "CASE-2", "probe.finished").length).toBe(2);
  // stop works on it too
  const stop = runCli(e, RUN, ["stop", "CASE-2", "--reason", "not now"]);
  expect(stop.err).toBe("");
  expect(stop.code).toBe(0);
  const done = runCli(e, RUN, ["status", "CASE-2"]);
  expect(done.out.split("\n")[0]).toContain("CASE-2 finished");
}, 240_000);

test("each refusal exits 1 and writes nothing", async () => {
  const e = fresh();
  const before = headOf(e, "CASE-1");
  const cases = casesOf(e);
  const refused = async (argv: string[], sentence: string): Promise<void> => {
    expect(await run(e, argv), argv.join(" ")).toBe(1);
    expect(err.join("\n"), argv.join(" ")).toContain(sentence);
    expect(out).toEqual([]);
    expect(headOf(e, "CASE-1")).toBe(before);
    expect(casesOf(e)).toEqual(cases);
  };
  await refused(["answer", "CASE-1", "--product", "7", "--text", "x"], "there is no published product 7 in this case");
  await refused(["answer", "CASE-1", "--product", "1", "--text", "x", "--marking", "TLP:CLEAR"], "marked at least");
  await refused(["answer", "CASE-1", "--product", "1", "--text", "x", "--findings", join(e.dir, "missing.json")], "cannot be read");
  await refused(["answer", "CASE-9", "--product", "1", "--text", "x"], "CASE-9");
  await refused(["withdraw", "CASE-1", "--product", "1", "--reason", "gone"], "there is no known answer for product 1");
  await refused(["start", "no-such-loop", "--type", "unknown-device", "--marking", "TLP:GREEN"], 'no loop "no-such-loop"');
  await refused(["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--tasks", "9"], "tasks");
  await refused(["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--candidates", "4"], "candidates");
  await refused(["start", "improve", "--type", "unknown-device", "--marking", "TLP:GREEN"], "improve loop");
  await refused(["show", "CASE-1"], "is no improve case");
  await refused(["show", "CASE-9"], "CASE-9");
});

test("a wrong command line is a usage error, exit 2, with the usage on stderr", async () => {
  const e = fresh();
  for (const argv of [[], ["nope"], ["--help"], ["answer", "CASE-1"], ["answer", "CASE-1", "--product", "x", "--text", "t"], ["start", TARGET, "--type", "unknown-device"],
    ["start", TARGET, "--type", "unknown-device", "--marking", "TLP:GREEN", "--tasks", "0"], ["show"], ["withdraw", "CASE-1", "--product", "1"]]) {
    expect(await run(e, argv), argv.join(" ")).toBe(2);
    expect(err.join("\n")).toContain("usage:");
  }
  expect(existsSync(join(e.data, "cases", "CASE-2"))).toBe(false);
});

test("the command is spawned with a clean environment and releases the lock", () => {
  const e = fresh();
  const r = runCli(e, join(REPO, "src", "cli", "improve.ts"), ["show", "CASE-1"]);
  expect(r.code).toBe(1);
  expect(r.err).toContain("is no improve case");
  expect(runCli(e, join(REPO, "src", "cli", "improve.ts"), ["--help"]).code).toBe(2);
  expect(JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")).scripts.improve).toBe("bun run src/cli/improve.ts");
});
