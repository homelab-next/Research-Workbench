import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configFor, newRoot } from "../../scripts/new-root";
import { makeSampleData } from "../../scripts/make-sample-data";
import { preflight } from "../../src/cli/preflight";
import type { Check } from "../../src/cli/preflight";
import { cleanEnv } from "../helpers/clean-env";
import { startStandin } from "../helpers/http-standin";
import { startModelStandin } from "../helpers/model-standin";
import type { StandinReply } from "../helpers/model-standin";
import { copySample } from "../helpers/sample-root";
import { startTrino } from "../helpers/trino-standin";

const REPO = join(import.meta.dir, "..", "..");
const CLI = join(REPO, "src", "cli", "preflight.ts");
const dirs: string[] = [];
const stops: (() => void)[] = [];
afterEach(() => {
  while (stops.length > 0) stops.pop()!();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const call = (args: string, finish = "tool_calls"): StandinReply => ({
  json: {
    choices: [{ finish_reason: finish, message: { content: null, tool_calls: JSON.parse(`[${args}]`) } }],
    usage: { prompt_tokens: 40, completion_tokens: 8 },
  } as never,
});
const record = (args: string): string => `{"id":"c${Math.random().toString(36).slice(2)}","type":"function","function":{"name":"record","arguments":${JSON.stringify(args)}}}`;
const GOOD = (): StandinReply => call(record('{"why":"checking the call works"}'));

function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "preflight-"));
  dirs.push(d);
  return d;
}
function standin(replies: StandinReply[], models: { id: string; loaded_context_length?: number }[] = [{ id: "example/model-a", loaded_context_length: 65536 }]) {
  const m = startModelStandin({ models, replies });
  stops.push(m.stop);
  return m;
}
const BAD = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");
const by = (r: { checks: Check[] }, name: string): Check[] => r.checks.filter((c) => c.name === name);

interface Env { tmp: string; root: string; config: string }
/** A root from new-root against `url`, and a configuration beside it; `extra` lines are added to the configuration. */
function env(url: string, extra: string[] = [], over: { roots?: string } = {}): Env {
  const tmp = tmpDir();
  const root = join(tmp, "root");
  newRoot(root, { base_url: url, model: "example/model-a" });
  const config = join(tmp, "config.yaml");
  const base = configFor(root).split("\n").filter((l) => l !== "");
  const lines = over.roots === undefined ? base : base.filter((l) => !/^roots:|^  - \{ path/.test(l)).concat([`roots: ${over.roots}`]);
  writeFileSync(config, [...lines, ...extra, ""].join("\n"));
  return { tmp, root, config };
}
const run = (e: Env, args: string[] = []) => preflight(["--config", e.config, ...args], { env: {}, home: e.tmp, repoRoot: REPO });

const LAKE = (url = "https://lake.example.net:8443", extra = ""): string => `kind: source
id: lake
title: Lake
connector: trino
location: ${url}
user: workbench
marking: "TLP:AMBER"
where: network
confirmed: true
cost: { weight: 0, unit: rows }
${extra}tables:
  - { name: lake.archive.events, time_column: event_time, guarded: true, columns: [] }
`;
const PIVOTS = (list: string[]): string => `kind: pivots\npivots:\n${list.join("\n")}\n`;
const pivot = (id: string, query: string, needs = true): string =>
  `  - { id: ${id}, title: ${id}, from: address, to: address, source: lake, query: ${JSON.stringify(query)}, needs_window: ${needs}, empty_means: not-seen, yields: { peer: address } }`;
const GUARDED = "select peer from lake.archive.events where event_time >= {window.from} and event_time < {window.to} and addr in ({value})";

test("the sample is ready, with a note where a model is scripted", async () => {
  const tmp = tmpDir();
  const root = join(tmp, "sample");
  copySample(root);
  makeSampleData(join(root, "data"));
  const config = join(tmp, "config.yaml");
  writeFileSync(config, [`data_dir: ${join(tmp, "data")}`, "roots:", `  - { path: ${JSON.stringify(root)}, trusted: true, credentials: [] }`, ""].join("\n"));
  const r = await preflight(["--config", config], { env: {}, home: tmp, repoRoot: REPO });
  expect(r.checks.filter((c) => c.level === "fail")).toEqual([]);
  expect(r.ok).toBe(true);
  expect(by(r, "model answers")[0]).toMatchObject({ level: "note" });
});

test("preflight reports each loop: usable with its version and hash, or its problems", async () => {
  const tmp = tmpDir();
  const root = join(tmp, "sample");
  copySample(root);
  makeSampleData(join(root, "data"));
  writeFileSync(join(root, "loops", "broken.yaml"), JSON.stringify({ kind: "loop", id: "broken", title: "Broken", version: 3, profile: "investigation", entry: "frame", stages: ["frame", "nowhere"] }));
  const config = join(tmp, "config.yaml");
  writeFileSync(config, [`data_dir: ${join(tmp, "data")}`, "roots:", `  - { path: ${JSON.stringify(root)}, trusted: true, credentials: [] }`, ""].join("\n"));
  const r = await preflight(["--config", config, "--no-question"], { env: {}, home: tmp, repoRoot: REPO });
  const loops = by(r, "loops");
  expect(loops.map((c) => c.level)).toEqual(["fail", "ok", "ok", "ok"]);
  expect(loops[0]!.detail).toBe('broken: stage "nowhere" is no stage manifest and no inline stage');
  expect(loops[1]!.detail).toMatch(/^investigation: usable, version 1, hash [0-9a-f]{12}$/);
  expect(loops[2]!.detail).toMatch(/^triage: usable, version 1, hash [0-9a-f]{12}$/);
  expect(loops[3]!.detail).toMatch(/^unknown-device: usable, version 1, hash [0-9a-f]{12}$/);
  expect(r.ok).toBe(false);
  // preflight writes nothing: no data folder was made
  expect(existsSync(join(tmp, "data"))).toBe(false);
  // a root with no loop manifest has the implicit loop, which is usable
  const m = standin([]);
  const e = env(m.url);
  const plain = await run(e, ["--no-question"]);
  expect(by(plain, "loops").map((c) => c.level)).toEqual(["ok"]);
  expect(by(plain, "loops")[0]!.detail).toMatch(/^investigation: usable, version 1, hash [0-9a-f]{12} \(no loop manifest: every stage manifest is the investigation loop\)$/);
});

test("a root from new-root on a loaded model is ready", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const r = await run(e);
  expect(r.checks.filter((c) => c.level === "fail")).toEqual([]);
  expect(r.ok).toBe(true);
  expect(by(r, "context")[0]!.detail).toBe("65536 tokens; a turn's pack may use 98304 characters");
  expect(by(r, "model answers")[0]!.detail).toContain("is not in a ledger");
  expect(by(r, "model answers")[0]!.detail).toBe("one well-formed call (40 tokens in, 8 out); this question carries no case data and is not in a ledger");
  expect(m.requests.filter((q) => q.path.endsWith("/chat/completions"))).toHaveLength(1);
  expect(r.checks.map((c) => c.name)).toEqual(
    ["configuration", "outside the repository", "secrets", "manifests", "pipeline", "loops", "checks", "lake sources", "pivots", "model listed", "model loaded", "context", "context fit", "marking policy", "model answers"]
      .flatMap((n) => r.checks.filter((c) => c.name === n).map((c) => c.name)),
  );
});

test("--no-question leaves the question out and sends none", async () => {
  const m = standin([]);
  const r = await run(env(m.url), ["--no-question"]);
  expect(r.ok).toBe(true);
  expect(by(r, "model answers")).toEqual([]);
  expect(m.requests.some((q) => q.path.endsWith("/chat/completions"))).toBe(false);
});

test("a model that is not loaded fails", async () => {
  const m = standin([GOOD()], [{ id: "example/model-a" }]);
  const r = await run(env(m.url));
  expect(r.ok).toBe(false);
  expect(by(r, "model loaded")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "model loaded")[0]!.detail).toContain("load it with a context of at least 32768 tokens");
  expect(m.requests.some((q) => q.path.endsWith("/chat/completions"))).toBe(false);
});

test("an endpoint without a loaded listing is a note, not a failure", async () => {
  const m = startModelStandin({ models: [{ id: "example/model-a" }], details: false, replies: [GOOD()] });
  stops.push(m.stop);
  const e = env(m.url);
  writeFileSync(join(e.root, "models", "local.yaml"), (await Bun.file(join(e.root, "models", "local.yaml")).text()) + "context: 65536\n");
  const r = await run(e);
  expect(by(r, "model loaded")[0]).toMatchObject({ level: "note" });
  expect(by(r, "context")[0]).toMatchObject({ level: "ok" });
  expect(r.ok).toBe(true);
});

test("a context below the floor fails", async () => {
  const m = standin([GOOD()], [{ id: "example/model-a", loaded_context_length: 4096 }]);
  const r = await run(env(m.url));
  expect(by(r, "context")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "context")[0]!.detail).toContain("4096");
  expect(by(r, "context")[0]!.detail).toContain("32768");
  expect(r.ok).toBe(false);
  const lower = await run(env(standin([GOOD()]).url), ["--min-context", "100000"]);
  expect(by(lower, "context")[0]).toMatchObject({ level: "fail" });
});

test("an endpoint that does not answer fails model listed, and nothing after it is asked", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  m.stop();
  const r = await run(e);
  expect(by(r, "model listed")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "model loaded")).toEqual([]);
  expect(by(r, "context")).toEqual([]);
  expect(by(r, "model answers")).toEqual([]);
  expect(r.ok).toBe(false);
});

test("a malformed tool call fails the question", async () => {
  const m = standin([
    call(record("{why: no quotes}")),
    call(record("{}")),
    call(`${record('{"why":"a"}')},${record('{"why":"b"}')}`),
    { json: { choices: [{ finish_reason: "stop", message: { content: "I will not call it" } }] } as never },
  ]);
  const e = env(m.url);
  const answers: string[] = [];
  for (let i = 0; i < 4; i++) {
    const r = await run(e);
    expect(r.ok).toBe(false);
    expect(by(r, "model answers")[0]!.level).toBe("fail");
    answers.push(by(r, "model answers")[0]!.detail);
  }
  expect(answers[0]).toContain("arguments are not JSON");
  expect(answers[1]).toContain("why is missing");
  expect(answers[2]).toContain("2 tool calls");
  expect(answers[3]).toContain("no tool call");
});

test("a question the endpoint answers with an error fails with the provider's error", async () => {
  const m = standin([{ status: 500, text: "boom" }]);
  const r = await run(env(m.url));
  expect(by(r, "model answers")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "model answers")[0]!.detail).toContain("500");
});

function lakeEnv(pivots: string[], extra = "", url?: string): Env {
  const m = standin([GOOD()]);
  const e = env(m.url);
  writeFileSync(join(e.root, "sources", "lake.yaml"), LAKE(url, extra));
  writeFileSync(join(e.root, "pivots.yaml"), PIVOTS(pivots));
  return e;
}

test("a pivot the guard refuses is reported by id", async () => {
  const e = lakeEnv([
    pivot("good", GUARDED),
    pivot("bad_or", `${GUARDED} or 1 = 1`),
    pivot("bad_window", "select peer from lake.archive.events where addr in ({value})", false),
  ]);
  const r = await run(e);
  expect(by(r, "pivots").filter((c) => c.level === "fail").map((c) => c.detail.split(":")[0])).toEqual(["bad_or", "bad_window"]);
  expect(by(r, "pivots").find((c) => c.detail.startsWith("bad_or"))!.detail).toContain("or are not allowed");
  expect(r.ok).toBe(false);
});

test("pivots that render are one ok line", async () => {
  const r = await run(lakeEnv([pivot("good", GUARDED)]));
  expect(by(r, "pivots")).toEqual([{ name: "pivots", level: "ok", detail: "1 pivot renders against the guard" }]);
});

test("a lake source open to agent-written queries fails; an unguarded table and unverified TLS are notes", async () => {
  const adhoc = await run(lakeEnv([], "adhoc: true\n"));
  expect(by(adhoc, "lake sources").some((c) => c.level === "fail")).toBe(true);
  const e = lakeEnv([], "tls_verify: false\n");
  writeFileSync(join(e.root, "sources", "lake.yaml"), LAKE(undefined, "tls_verify: false\n").replace("guarded: true", "guarded: false"));
  const r = await run(e);
  const notes = by(r, "lake sources").filter((c) => c.level === "note").map((c) => c.detail).join("\n");
  expect(notes).toContain("lake.archive.events");
  expect(notes).toMatch(/tls/i);
  expect(by(r, "lake sources").some((c) => c.level === "fail")).toBe(false);
});

test("a marking the policy keeps from the model fails, naming the stage and the source", async () => {
  const e = lakeEnv([pivot("good", GUARDED)]);
  writeFileSync(e.config, (await Bun.file(e.config).text()) + 'marking_policy: { "TLP:AMBER": [] }\n');
  const r = await run(e);
  const fails = by(r, "marking policy").filter((c) => c.level === "fail");
  expect(fails.length).toBeGreaterThan(1);
  expect(fails.map((c) => c.detail.split(":")[0])).toContain("frame");
  expect(fails.map((c) => c.detail.split(":")[0])).toContain("publish");
  for (const f of fails) expect(f.detail).toContain("lake (TLP:AMBER)");
  expect(r.ok).toBe(false);
});

test("a root inside the repository fails", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url, [], { roots: `[{ path: ${JSON.stringify(join(REPO, "tests"))}, trusted: false }]` });
  const r = await run(e);
  expect(by(r, "outside the repository")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "outside the repository")[0]!.detail).toContain(join(REPO, "tests"));
  expect(r.ok).toBe(false);
});

test("a credential with no value fails without printing anything secret", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const secrets = join(e.tmp, "secrets.yaml");
  writeFileSync(secrets, "OTHER: do-not-print-me\n", { mode: 0o600 });
  writeFileSync(e.config, [`data_dir: ./data`, `secrets_file: ${secrets}`, "roots:", `  - { path: ${JSON.stringify(e.root)}, trusted: true, credentials: [LAKE_PW] }`, ""].join("\n"));
  writeFileSync(join(e.root, "sources", "lake.yaml"), LAKE(undefined, "credential: LAKE_PW\n"));
  const r = await run(e);
  const s = by(r, "secrets");
  expect(s.some((c) => c.level === "fail" && c.detail.includes("LAKE_PW"))).toBe(true);
  expect(r.checks.map((c) => c.detail).join("\n")).not.toContain("do-not-print-me");
  expect(r.ok).toBe(false);
});

test("a secrets file readable by others fails", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const secrets = join(e.tmp, "secrets.yaml");
  writeFileSync(secrets, "OTHER: do-not-print-me\n", { mode: 0o644 });
  writeFileSync(e.config, (await Bun.file(e.config).text()) + `secrets_file: ${secrets}\n`);
  const r = await run(e);
  expect(by(r, "secrets")[0]).toMatchObject({ level: "fail" });
  expect(by(r, "secrets")[0]!.detail).toContain("readable by others");
  expect(r.checks.map((c) => c.detail).join("\n")).not.toContain("do-not-print-me");
});

test("a manifest problem is one fail with a path relative to its root", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  writeFileSync(join(e.root, "sources", "broken.yaml"), "kind: source\nid: broken\n");
  const r = await run(e);
  const f = by(r, "manifests").filter((c) => c.level === "fail");
  expect(f).toHaveLength(1);
  expect(f[0]!.detail).toContain("sources/broken.yaml");
  expect(f[0]!.detail).not.toContain(e.tmp);
});

test("preflight never contacts a source", async () => {
  const tmp = tmpDir();
  const root = join(tmp, "sample");
  copySample(root);
  makeSampleData(join(root, "data"));
  const t = startTrino();
  stops.push(() => t.stop());
  const http = startStandin({});
  stops.push(http.stop);
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, (await Bun.file(rep).text()).replace("http://127.0.0.1:4801", http.url));
  writeFileSync(join(root, "sources", "lake.yaml"), LAKE(t.url));
  writeFileSync(join(root, "pivots.yaml"), (await Bun.file(join(root, "pivots.yaml")).text()) + pivot("lake_peers", GUARDED) + "\n");
  const config = join(tmp, "config.yaml");
  writeFileSync(config, [`data_dir: ${join(tmp, "data")}`, "roots:", `  - { path: ${JSON.stringify(root)}, trusted: true, credentials: [] }`, ""].join("\n"));
  const r = await preflight(["--config", config], { env: {}, home: tmp, repoRoot: REPO });
  expect(r.checks.filter((c) => c.level === "fail")).toEqual([]);
  expect(by(r, "pivots")[0]!.detail).toMatch(/renders|render/);
  expect(t.statements).toEqual([]);
  expect(http.requests).toEqual([]);
});

test("the command exits 0 when ready, 1 when not, 2 on a bad line", async () => {
  const m = standin([GOOD(), GOOD()]);
  const e = env(m.url);
  const go = async (args: string[]) => {
    const p = Bun.spawn(["bun", "run", CLI, ...args], { cwd: REPO, env: cleanEnv(e.tmp), stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { out, err, code };
  };
  const ready = await go(["--config", e.config]);
  expect(ready.code).toBe(0);
  expect(ready.out).toMatch(/^ok {4}configuration: /m);
  expect(ready.out).toContain("is not in a ledger");
  expect(ready.out.trimEnd().split("\n").at(-1)).toBe("ready");
  const notReady = await go(["--config", e.config, "--no-question", "--min-context", "999999"]);
  expect(notReady.code).toBe(1);
  expect(notReady.out).toMatch(/^FAIL {2}context: /m);
  expect(notReady.out.trimEnd().split("\n").at(-1)).toBe("not ready: 1 to fix");
  expect((await go(["--bogus"])).code).toBe(2);
  expect((await go(["--config", join(e.tmp, "missing.yaml")])).code).toBe(2);
  expect((await go(["--min-context", "lots"])).code).toBe(2);
});

test("text from the model is one bounded line with no control characters", async () => {
  const m = standin([
    { json: { choices: [{ finish_reason: "stop", message: { content: null, refusal: `no\u001b[31m ${"x".repeat(200_000)}` } }] } as never },
    call(`{"id":"c1","type":"function","function":{"name":"rec\\u001b[2Jord\\u0085\\u2028","arguments":"{}"}}`),
  ]);
  const e = env(m.url);
  for (let i = 0; i < 2; i++) {
    const r = await run(e);
    const d = by(r, "model answers")[0]!.detail;
    expect(d.length).toBeLessThanOrEqual(300);
    expect(d).not.toMatch(BAD);
    if (i === 0) expect(d.endsWith("\u2026")).toBe(true);
    expect(r.checks.every((c) => c.detail.length <= 300 && !BAD.test(c.detail))).toBe(true);
  }
});

test("a path other than the configuration's prints relative to the configuration's folder", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const inRepo = join(REPO, "tests");
  writeFileSync(e.config, `roots: [{ path: ${JSON.stringify(inRepo)}, trusted: false }]\ndata_dir: ./data\n`);
  const r = await run(e);
  const d = by(r, "outside the repository")[0]!.detail;
  expect(d).toContain("a root ..");
  expect(d.startsWith(REPO)).toBe(false);
});

test("the usage text documents the exit codes", async () => {
  const e = env(standin([]).url);
  const p = Bun.spawn(["bun", "run", CLI, "--bogus"], { cwd: REPO, env: cleanEnv(e.tmp), stdout: "pipe", stderr: "pipe" });
  const err = await new Response(p.stderr).text();
  await p.exited;
  expect(err).toContain("exit 0 ready, 1 not ready, 2 bad command line or configuration, 3 unexpected error");
});

test("the model line prints the sampling and output limit the model manifest gives", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const r = await run(e);
  expect(by(r, "model listed")[0]!.detail).toBe("example/model-a at local; sampling temperature 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 1.5; up to 16384 output tokens");
});

/** Rewrites the model manifest of a new root: its context, slots and reply cap. */
function sizeModel(e: Env, context: number, parallel: number, cap: number): void {
  const file = join(e.root, "models", "local.yaml");
  const kept = readFileSync(file, "utf8").split("\n").filter((l) => !/^(max_output_tokens|context|parallel):/.test(l));
  writeFileSync(file, [...kept.filter((l) => l !== ""), `context: ${context}`, `parallel: ${parallel}`, `max_output_tokens: ${cap}`, ""].join("\n"));
}

test("preflight fails a stage whose reply cap does not fit, and names the cap that does", async () => {
  const m = startModelStandin({ models: [{ id: "example/model-a" }], details: false, replies: [GOOD()] });
  stops.push(m.stop);
  const e = env(m.url);
  sizeModel(e, 65536, 2, 32768);
  const r = await run(e);
  const fit = by(r, "context fit").filter((c) => c.level === "fail");
  expect(fit.length).toBeGreaterThan(0);
  expect(fit[0]!.detail).toMatch(/^[a-z]+: /);
  expect(fit[0]!.detail).toContain("16384 or less");
  expect(r.ok).toBe(false);
});

test("preflight's question is sized to the per-request context the manifest claims", async () => {
  const m = startModelStandin({ models: [{ id: "example/model-a" }], details: false, replies: [GOOD()] });
  stops.push(m.stop);
  const e = env(m.url);
  sizeModel(e, 65536, 1, 8192);
  const r = await run(e);
  expect(by(r, "context fit")).toEqual([expect.objectContaining({ level: "ok", detail: "every stage's reply cap fits 65536 tokens a request (1 slot)" })]);
  const body = JSON.parse(m.requests.find((q) => q.path.endsWith("/chat/completions"))!.body) as { max_tokens: number };
  expect(body.max_tokens).toBe(65536 - 2048);
});

test("a fast_model is one more model for the checks, named with its stage", async () => {
  const m = standin([GOOD(), GOOD()], [{ id: "example/model-a", loaded_context_length: 65536 }, { id: "example/small", loaded_context_length: 65536 }]);
  const e = env(m.url);
  const file = join(e.root, "stages", "research.yaml");
  const text = readFileSync(file, "utf8");
  // a fast model the provider lists and one it does not
  writeFileSync(file, text.replace(/^on_pass:/m, "fast_model: { provider: local, model: example/small }\non_pass:"));
  const good = await run(e);
  expect(by(good, "model listed").map((c) => c.detail)).toContain("example/small at local; sampling temperature 0.6, top_p 0.95, top_k 20, min_p 0, presence_penalty 1.5; up to 16384 output tokens");
  expect(by(good, "model answers").filter((c) => c.level === "ok").length).toBe(2);
  expect(good.ok).toBe(true);
  writeFileSync(file, text.replace(/^on_pass:/m, "fast_model: { provider: nowhere, model: example/small }\non_pass:"));
  const bad = await run(e);
  const listed = by(bad, "model listed").filter((c) => c.level === "fail");
  expect(listed).toHaveLength(1);
  expect(listed[0]!.detail).toContain("research (fast)");
  expect(bad.ok).toBe(false);
});

test("a fast model's marking is checked against the policy, named with its stage", async () => {
  const m = standin([GOOD()]);
  const e = env(m.url);
  const file = join(e.root, "stages", "research.yaml");
  writeFileSync(file, readFileSync(file, "utf8").replace(/^on_pass:/m, "fast_model: { provider: local, model: example/model-a }\non_pass:"));
  const r = await run(e);
  expect(by(r, "context fit").some((c) => c.detail.includes("fast"))).toBe(false);
  expect(r.ok).toBe(true);
});
