import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import { sha256Hex } from "../../src/core/hash";
import { latestDraft } from "../../src/core/state";
import type { Marking, Product } from "../../src/core/types";
import { loadProfile } from "../../src/agents/context";
import { Registry, TRUSTED_ONLY_KINDS } from "../../src/modules/registry";
import type { StageEnv } from "../../src/pipeline/engine";
import type { CheckInput } from "../../src/pipeline/checks";
import { CHECK_MAX_OUTPUT, checkInput, runCheck } from "../../src/pipeline/checks";
import { loadChecks } from "../../src/pipeline/manifests";
import type { CheckManifest } from "../../src/pipeline/manifests";
import { checksRunner } from "../../src/pipeline/stages/checks";
import { copySample } from "../helpers/sample-root";
import { fixture, person } from "../helpers/tools-fixture";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "checks-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const PRODUCT: Product = {
  objective: "o", question: "q", marking: "TLP:GREEN", summary: "s", key_findings: [], gaps_and_limits: "g", alternatives: "a", assessment: "x", sources: [], assumptions: [], change: "First judgment.",
};
const INPUT: CheckInput = {
  check: "slow", draft: { n: 1, hash: sha256Hex(canonical(PRODUCT as never)), product: PRODUCT }, cards: {}, sources: {}, schema: {}, standard: {}, markings: [],
  objective: null, question: "q", earlier: [], cited: [],
};

/** Writes a check (manifest and script) into `root` and returns what loadChecks makes of it. */
function write(root: string, id: string, script: string, extra: Record<string, string | number> = {}, file = `${id}.ts`): void {
  mkdirSync(root, { recursive: true });
  const fields = { kind: "check", id, title: id, order: 1, script: file, runner: "bun", timeout_ms: 10000, ...extra };
  writeFileSync(join(root, `${id}.yaml`), Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n") + "\n");
  if (!file.includes("/")) writeFileSync(join(root, file), script);
}
const load = (root: string): ReturnType<typeof loadChecks> => loadChecks(Registry.load([{ path: root, trusted: true, credentials: [] }]));
const one = (id: string, script: string, extra: Record<string, string | number> = {}): CheckManifest => {
  const root = join(dir, `root-${id}`);
  write(root, id, script, extra);
  const { checks, problems } = load(root);
  expect(problems).toEqual([]);
  return checks[0]!;
};
const PRINT = (obj: string): string => `await Bun.stdin.text(); console.log(JSON.stringify(${obj}));`;

test("check is a kind only a trusted root may supply", () => {
  expect(TRUSTED_ONLY_KINDS).toContain("check");
  const evil = join(dir, "evil");
  write(evil, "ghost", PRINT("{ pass: true, findings: [] }"));
  const good = join(dir, "good");
  write(good, "ghost", PRINT("{ pass: true, findings: [] }"));
  const r = Registry.load([{ path: good, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]);
  expect(r.problems.filter((p) => p.root === evil).map((p) => p.error)).toEqual(["a check manifest is accepted only from a trusted root"]);
  expect(r.get("check", "ghost")!.root).toBe(good);
});

test("a check gets the input on standard input and its findings come back with its id", async () => {
  const c = one("echo", `const i = JSON.parse(await Bun.stdin.text()); console.log(JSON.stringify({ pass: false, findings: [{ where: "f1", message: "saw " + i.question }] }));`);
  const o = await runCheck(c, INPUT);
  expect(o.pass).toBe(false);
  expect(o.findings).toEqual([{ check: "echo", where: "f1", message: "saw q" }]);
  expect((await runCheck(one("ok", PRINT("{ pass: true, findings: [] }")), INPUT)).pass).toBe(true);
});

test("the script's hash and the exact input and output bytes are returned", async () => {
  const script = PRINT("{ pass: true, findings: [] }");
  const c = one("bytes", script);
  const o = await runCheck(c, INPUT);
  expect(o.script_hash).toBe(sha256Hex(new TextEncoder().encode(script)));
  expect(new TextDecoder().decode(o.input)).toBe(canonical(INPUT as never));
  expect(new TextDecoder().decode(o.output).trim()).toBe('{"pass":true,"findings":[]}');
});

test("a check that hangs is killed at its timeout and fails", async () => {
  const c = one("slow", "for (;;) {}", { timeout_ms: 300 });
  const o = await runCheck(c, INPUT);
  expect(o).toMatchObject({ pass: false, findings: [{ check: "slow", where: "check", message: "timed out after 300 ms" }] });
});

test("a check that exits non-zero, prints rubbish or prints too much fails with the reason", async () => {
  const code = await runCheck(one("crash", `await Bun.stdin.text(); console.log('{"pass":true,"findings":[]}'); process.exit(3);`), INPUT);
  expect(code).toMatchObject({ pass: false, findings: [{ check: "crash", where: "check", message: "exited with code 3" }] });
  const thrown = await runCheck(one("thrown", `throw new Error("boom")`), INPUT);
  expect(thrown.pass).toBe(false);
  expect(thrown.findings[0]!.message).toMatch(/^exited with code /);
  for (const [id, body] of [["rubbish", `console.log("not json")`], ["shape", `console.log(JSON.stringify({ pass: "yes" }))`], ["badfinding", `console.log(JSON.stringify({ pass: false, findings: [{ where: 1 }] }))`], ["silent", ``]] as const) {
    const o = await runCheck(one(id, body), INPUT);
    expect(o).toMatchObject({ pass: false, findings: [{ check: id, where: "check", message: "did not return valid findings" }] });
  }
  const big = await runCheck(one("big", `await Bun.stdin.text(); process.stdout.write("x".repeat(${CHECK_MAX_OUTPUT + 10}));`), INPUT);
  expect(big).toMatchObject({ pass: false, findings: [{ check: "big", where: "check", message: "returned more than 1 MiB" }] });
  expect(big.output.length).toBeLessThanOrEqual(CHECK_MAX_OUTPUT);
});

test("a check that says pass but lists findings fails", async () => {
  const o = await runCheck(one("liar", PRINT(`{ pass: true, findings: [{ where: "f1", message: "m" }] }`)), INPUT);
  expect(o.pass).toBe(false);
  expect(o.findings).toEqual([{ check: "liar", where: "f1", message: "m" }]);
  const quiet = await runCheck(one("quiet", PRINT(`{ pass: false, findings: [] }`)), INPUT);
  expect(quiet.pass).toBe(false);
  expect(quiet.findings.length).toBe(1);
});

test("a check sees no credentials in its environment", async () => {
  process.env.RW_TEST_SECRET = "s3cr3t-value";
  try {
    const c = one("env", PRINT(`{ pass: Object.keys(process.env).sort().join() === "LANG,PATH", findings: [] }`));
    expect((await runCheck(c, INPUT)).pass).toBe(true);
  } finally {
    delete process.env.RW_TEST_SECRET;
  }
});

test("a check runs in a temporary folder that is gone afterwards, not in its own folder", async () => {
  const c = one("cwd", `await Bun.stdin.text(); await Bun.write("left-behind.txt", "x"); console.log(JSON.stringify({ pass: process.cwd() !== ${JSON.stringify(join(dir, "root-cwd"))}, findings: [] }));`);
  expect((await runCheck(c, INPUT)).pass).toBe(true);
  expect(existsSync(join(dir, "root-cwd", "left-behind.txt"))).toBe(false);
});

test("the exec runner runs the file itself", async () => {
  const root = join(dir, "root-exec");
  write(root, "exec", `#!/bin/sh\ncat > /dev/null\necho '{"pass":true,"findings":[]}'\n`, { runner: "exec" }, "exec.sh");
  chmodSync(join(root, "exec.sh"), 0o755);
  const { checks, problems } = load(root);
  expect(problems).toEqual([]);
  expect((await runCheck(checks[0]!, INPUT)).pass).toBe(true);
});

test("a script that cannot be read is a failed check, not a throw", async () => {
  const c = one("gone", PRINT("{ pass: true, findings: [] }"));
  rmSync(join(dir, "root-gone", "gone.ts"));
  const o = await runCheck(c, INPUT);
  expect(o).toMatchObject({ pass: false, findings: [{ check: "gone", where: "check" }] });
});

test("a check from an untrusted root is not loaded and never runs", () => {
  const marker = join(dir, "ran.txt");
  const root = join(dir, "root-evil");
  write(root, "evil", `await Bun.write(${JSON.stringify(marker)}, "x");`);
  const registry = Registry.load([{ path: root, trusted: false, credentials: [] }]);
  expect(registry.problems.map((p) => p.error)).toEqual(["a check manifest is accepted only from a trusted root"]);
  expect(loadChecks(registry).checks).toEqual([]);
  // the second lock: a registry that did hand one over is still refused by loadChecks
  const trusted = Registry.load([{ path: root, trusted: true, credentials: [] }]);
  const stub = Object.create(trusted) as Registry;
  stub.rootOf = () => ({ path: root, trusted: false, credentials: [] });
  const r = loadChecks(stub);
  expect(r.checks).toEqual([]);
  expect(r.problems).toEqual(["check evil is in a root that is not trusted for scripts; it will not run"]);
  expect(existsSync(marker)).toBe(false);
});

test("a script path that leaves its folder is refused", () => {
  const root = join(dir, "root-out");
  write(root, "out", "", { script: "../outside.ts" }, "../outside.ts");
  writeFileSync(join(dir, "outside.ts"), "console.log(1)");
  const r = load(root);
  expect(r.checks).toEqual([]);
  expect(r.problems.length).toBe(1);
  expect(r.problems[0]).toMatch(/check out.*script/);
});

test("a script that is missing is left out with a problem", () => {
  const root = join(dir, "root-missing");
  write(root, "missing", "", {}, "missing.ts");
  rmSync(join(root, "missing.ts"));
  const r = load(root);
  expect(r.checks).toEqual([]);
  expect(r.problems[0]).toMatch(/check missing.*missing/);
});

const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitGone = async (pid: number): Promise<boolean> => { for (let i = 0; i < 40; i++) { if (!alive(pid)) return true; await Bun.sleep(50); } return false; };

test("the program that runs is a copy of the bytes that were hashed, kept apart from the original folder", async () => {
  const root = join(dir, "root-copy");
  const A = `console.log(JSON.stringify({ pass: false, findings: [{ where: "w", message: "A" + (import.meta.dir === ${JSON.stringify(root)} ? "!" : "") }] }));\n`;
  const B = A.replace('"A"', '"B"');
  write(root, "copy", A);
  const c = load(root).checks[0]!;
  const f = join(root, "copy.ts");
  writeFileSync(join(dir, "flip.sh"), `while true; do printf '%s\\n' '${B.trim()}' > ${dir}/t1; mv ${dir}/t1 ${f}; printf '%s\\n' '${A.trim()}' > ${dir}/t2; mv ${dir}/t2 ${f}; done`);
  const flip = Bun.spawn(["bash", join(dir, "flip.sh")], { stdout: "ignore", stderr: "ignore" });
  try {
    for (let i = 0; i < 40; i++) {
      const o = await runCheck(c, INPUT);
      const ran = o.findings[0]!.message;
      const hashed = [A, B].find((x) => sha256Hex(new TextEncoder().encode(x)) === o.script_hash);
      expect(hashed).toBeDefined();
      expect(ran).toBe(hashed!.includes('"B"') ? "B" : "A");
    }
  } finally { flip.kill(); }
});

test("a child the check started does not outlive the timeout", async () => {
  const pidFile = join(dir, "child.pid");
  const c = one("kids", `Bun.spawn(["sleep", "30"], { stdout: "ignore" }).pid; await Bun.write(${JSON.stringify(pidFile)}, String(Bun.spawn(["sleep", "30"]).pid)); for (;;) { await Bun.sleep(50); }`, { timeout_ms: 600 });
  const o = await runCheck(c, INPUT);
  expect(o.findings[0]!.message).toBe("timed out after 600 ms");
  const pid = Number(await Bun.file(pidFile).text());
  expect(await waitGone(pid)).toBe(true);
});

test("a program that closes standard output and keeps running is a timeout and is killed", async () => {
  const pidFile = join(dir, "me.pid");
  const c = one("closer", `import { closeSync, writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); closeSync(1); for (;;) { await Bun.sleep(50); }`, { timeout_ms: 600 });
  const o = await runCheck(c, INPUT);
  expect(o).toMatchObject({ pass: false, findings: [{ check: "closer", where: "check", message: "timed out after 600 ms" }] });
  expect(await waitGone(Number(await Bun.file(pidFile).text()))).toBe(true);
});

test("a program whose standard output really is closed, and that carries on, is a timeout and is killed", async () => {
  const pidFile = join(dir, "sh.pid");
  const root = join(dir, "root-sh");
  write(root, "sh", `#!/bin/sh\necho $$ > ${pidFile}\nexec 1>&-\nsleep 30\n`, { runner: "exec", timeout_ms: 600 }, "sh.sh");
  chmodSync(join(root, "sh.sh"), 0o755);
  const o = await runCheck(load(root).checks[0]!, INPUT);
  expect(o.findings[0]!.message).toBe("timed out after 600 ms");
  expect(await waitGone(Number((await Bun.file(pidFile).text()).trim()))).toBe(true);
});

test("a child left running after an overflow is killed too", async () => {
  const pidFile = join(dir, "kid2.pid");
  const c = one("flood", `await Bun.write(${JSON.stringify(pidFile)}, String(Bun.spawn(["sleep", "30"]).pid)); process.stdout.write("x".repeat(${CHECK_MAX_OUTPUT + 10})); for (;;) { await Bun.sleep(50); }`);
  const o = await runCheck(c, INPUT);
  expect(o.findings[0]!.message).toBe("returned more than 1 MiB");
  expect(await waitGone(Number(await Bun.file(pidFile).text()))).toBe(true);
});

// ---- the stage ----

const DRAFT_PRODUCT: Product = { ...PRODUCT, key_findings: [{ id: "f1", statement: "s", likelihood: "likely", confidence: "high", confidence_basis: "b", cites: ["c1"], assumptions: [], reasoning: "r" }] };

/** A trusted root that is the sample's context with these checks in place of its own, and a session with a draft to check. */
function stageRig(checks: Record<string, [string, Record<string, string | number>?]>): { env: StageEnv; close(): void } {
  const f = fixture(false);
  const root = join(dir, "stage-root");
  copySample(root);
  rmSync(join(root, "checks"), { recursive: true, force: true });
  for (const [id, [script, extra]] of Object.entries(checks)) write(join(root, "checks"), id, script, extra ?? {});
  const registry = Registry.load([{ path: root, trusted: true, credentials: [] }]);
  f.s.commit((_s, ids) => [{ type: "card.created", actor: person, payload: { card: {
    id: ids.next("card"), title: "t", body: "b", kind: "result", made_by: "human", query: null, columns: [], column_types: [], rows: [], row_count: 0, coverage: null, empty: null,
    marking: "TLP:GREEN", source: "assets", step: null, subgoal: null, why: "w", event_time: null, quality_notes: [],
  } } }]);
  f.s.commit(() => [{ type: "draft.revised", actor: person, payload: { draft: { n: 1, hash: sha256Hex(canonical(DRAFT_PRODUCT as never)), author: person, product: DRAFT_PRODUCT, reason: "r" } } }]);
  const env = {
    session: f.s, attempt: 1, onNeedsBudget: async () => null,
    stage: { id: "checks", title: "Checks", role: "checks" },
    deps: { registry, profile: loadProfile(registry, "investigation") },
  } as unknown as StageEnv;
  return { env, close: () => f.close() };
}
const runs = (env: StageEnv) => env.session.entries().filter((e) => e.type === "check.run");

test("checkInput carries the exact draft, the cited cards that exist and their sources", () => {
  const { env, close } = stageRig({});
  try {
    const d = latestDraft(env.session.state)!;
    const i = checkInput("x", env.session.state, d, env.deps.registry, env.deps.profile);
    expect(i.draft).toEqual({ n: 1, hash: d.hash, product: d.product });
    expect(Object.keys(i.cards)).toEqual(["c1"]);
    expect(i.cards.c1).toMatchObject({ id: "c1", source: "assets", marking: "TLP:GREEN", row_count: 0 });
    expect(i.sources.assets!.marking).toBe("TLP:GREEN");
    expect(i.markings).toContain("TLP:RED");
    expect(i.earlier).toEqual([]);
    expect(Array.isArray((i.standard as { change_terms: unknown }).change_terms)).toBe(true);
  } finally { close(); }
});

test("the Checks stage records each run against the draft's hash with input and output blobs", async () => {
  const { env, close } = stageRig({ a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }], b: [PRINT("{ pass: true, findings: [] }"), { order: 2 }] });
  try {
    const d = latestDraft(env.session.state)!;
    const end = await checksRunner(env);
    expect(end).toEqual({ kind: "finished", outcome: "pass", draft_hash: d.hash, output: { checks: [{ check: "a", pass: true }, { check: "b", pass: true }] }, reason: null });
    const es = runs(env);
    expect(es.map((e) => e.type === "check.run" && e.payload.check)).toEqual(["a", "b"]);
    for (const e of es) {
      if (e.type !== "check.run") continue;
      expect(e.actor).toEqual({ kind: "system", id: "checks" });
      expect(e.payload.draft_hash).toBe(d.hash);
      expect(JSON.parse(env.session.blobs.text(e.payload.input.blob)).draft.hash).toBe(d.hash);
      expect(JSON.parse(env.session.blobs.text(e.payload.output.blob))).toEqual({ pass: true, findings: [] });
      expect(e.payload.script_hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(env.session.state.skipped).toEqual([]);
  } finally { close(); }
});

test("a failing check fails the stage and names itself in the reason", async () => {
  const { env, close } = stageRig({
    a: [PRINT(`{ pass: false, findings: [{ where: "f1", message: "first" }, { where: "f2", message: "second" }] }`), { order: 1 }],
    b: [PRINT("{ pass: true, findings: [] }"), { order: 2 }],
    c: ["for (;;) {}", { order: 3, timeout_ms: 200 }],
  });
  try {
    const end = await checksRunner(env);
    expect(end).toMatchObject({ kind: "finished", outcome: "fail", draft_hash: latestDraft(env.session.state)!.hash, reason: "a failed: first and 1 more" });
    expect(runs(env).length).toBe(3);
    expect((end as { output: unknown }).output).toEqual({ checks: [{ check: "a", pass: false }, { check: "b", pass: true }, { check: "c", pass: false }] });
    expect(env.session.state.skipped).toEqual([]);
  } finally { close(); }
});

test("a Checks stage with nothing to run pauses the run instead of passing", async () => {
  const { env, close } = stageRig({});
  try {
    const end = await checksRunner(env);
    expect(end.kind).toBe("stalled");
    expect((end as { reason: string }).reason).toMatch(/^Checks has nothing to run: /);
    expect(runs(env)).toEqual([]);
  } finally { close(); }
});

test("check 11 fails a product marked lower than a card only its narrative cites", async () => {
  const { checks, problems } = load(join(import.meta.dir, "..", "..", "sample", "checks"));
  expect(problems).toEqual([]);
  const c11 = checks.find((c) => c.id === "marking")!;
  const cardOf = (id: string, marking: Marking) => ({ id, title: id, source: null, marking, coverage: null, empty: null, row_count: 0, quality_notes: [] });
  const input: CheckInput = {
    ...INPUT, check: "marking", markings: ["TLP:CLEAR", "TLP:GREEN", "TLP:AMBER", "TLP:AMBER+STRICT", "TLP:RED"],
    draft: { n: 1, hash: "h", product: { ...PRODUCT, marking: "TLP:GREEN", summary: "see [c2]" } },
    cards: { c1: cardOf("c1", "TLP:GREEN"), c2: cardOf("c2", "TLP:RED") }, cited: ["c1", "c2"],
  };
  const o = await runCheck(c11, input);
  expect(o.pass).toBe(false);
  expect(o.findings.map((x) => x.message).join(" ")).toContain("c2");
  expect((await runCheck(c11, { ...input, draft: { ...input.draft, product: { ...input.draft.product, marking: "TLP:RED" } } })).pass).toBe(true);
});

test("checkInput carries the cards the narrative cites too", () => {
  const { env, close } = stageRig({});
  try {
    const d = latestDraft(env.session.state)!;
    const i = checkInput("x", env.session.state, { ...d, cited: ["c1"] }, env.deps.registry, env.deps.profile);
    expect(i.cited).toEqual(["c1"]);
    expect(Object.keys(i.cards)).toEqual(["c1"]);
  } finally { close(); }
});

test("a declared check that cannot be loaded fails the Checks stage, though every other check passed", async () => {
  const { env, close } = stageRig({ a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }], b: [PRINT("{ pass: true, findings: [] }"), { order: 2 }] });
  try {
    rmSync(join(dir, "stage-root", "checks", "b.ts"));
    const d = latestDraft(env.session.state)!;
    const end = await checksRunner(env);
    expect(end).toMatchObject({ kind: "finished", outcome: "fail", draft_hash: d.hash, reason: `check b could not be loaded: script "b.ts" is missing` });
    const es = runs(env);
    expect(es.map((e) => e.type === "check.run" && [e.payload.check, e.payload.pass])).toEqual([["b", false], ["a", true]]);
    expect(env.session.state.reviews[d.hash]!.checks.find((c) => c.check === "b")).toMatchObject({ pass: false });
    expect(env.session.state.skipped).toEqual([]);
  } finally { close(); }
});

test("a check manifest the registry refused, or one that is not valid, is broken; one from an untrusted root is not", () => {
  const root = join(dir, "broken-root");
  write(root, "fine", PRINT("{ pass: true, findings: [] }"));
  write(root, "nort", PRINT("{ pass: true, findings: [] }"), { runner: "perl" });
  writeFileSync(join(root, "garbled.yaml"), "kind: check\nid: garbled\norder: [1\n");
  const evil = join(dir, "evil-root");
  write(evil, "ghost", PRINT("{ pass: true, findings: [] }"));
  const r = loadChecks(Registry.load([{ path: root, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]));
  expect(r.checks.map((c) => c.id)).toEqual(["fine"]);
  expect(r.broken.map((b) => b.id).sort()).toEqual(["garbled", "nort"]);
  for (const b of r.broken) expect(b.problem).not.toContain(dir);
});

test("the sample with one check's script gone loads ten checks and names the eleventh as broken", () => {
  const root = join(dir, "sample-copy");
  copySample(root);
  rmSync(join(root, "checks", "08-gaps-and-negatives.ts"));
  const r = loadChecks(Registry.load([{ path: root, trusted: true, credentials: [] }]));
  expect(r.checks).toHaveLength(10);
  expect(r.broken).toEqual([{ id: "gaps-and-negatives", problem: `script "08-gaps-and-negatives.ts" is missing` }]);
});
