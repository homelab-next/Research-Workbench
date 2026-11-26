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
import { loadRegistry } from "../../src/modules/registry-record";
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
const load = (root: string): ReturnType<typeof loadChecks> => loadChecks(loadRegistry([{ path: root, trusted: true, credentials: [] }]));
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
  const r = loadRegistry([{ path: good, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]);
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
  const registry = loadRegistry([{ path: root, trusted: false, credentials: [] }]);
  expect(registry.problems.map((p) => p.error)).toEqual(["a check manifest is accepted only from a trusted root"]);
  expect(loadChecks(registry).checks).toEqual([]);
  // the second lock: a registry that did hand one over is still refused by loadChecks
  const trusted = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
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
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
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

test("a check that cannot be loaded stalls the stage and records no check run", async () => {
  const { env, close } = stageRig({ a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }], b: [PRINT("{ pass: true, findings: [] }"), { order: 2 }] });
  try {
    rmSync(join(dir, "stage-root", "checks", "b.ts"));
    const end = await checksRunner(env);
    expect(end).toEqual({ kind: "stalled", reason: `Checks cannot run: check b could not be loaded: script "b.ts" is missing` });
    expect(runs(env)).toEqual([]);
    expect(env.session.entries().some((e) => e.type === "check.run")).toBe(false);
    expect(env.session.state.skipped).toEqual([]);
  } finally { close(); }
});

test("two broken checks stall the stage naming the first and the count of the rest", async () => {
  const { env, close } = stageRig({ a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }], b: [PRINT("{ pass: true, findings: [] }"), { order: 2 }], c: [PRINT("{ pass: true, findings: [] }"), { order: 3 }] });
  try {
    rmSync(join(dir, "stage-root", "checks", "b.ts"));
    rmSync(join(dir, "stage-root", "checks", "c.ts"));
    const end = await checksRunner(env);
    expect(end).toEqual({ kind: "stalled", reason: `Checks cannot run: check b could not be loaded: script "b.ts" is missing and 1 more` });
    expect(runs(env)).toEqual([]);
  } finally { close(); }
});

test("a refused check manifest is recognised by its parsed kind", () => {
  const root = join(dir, "dup-root");
  mkdirSync(root, { recursive: true });
  const other = join(dir, "dup-other");
  mkdirSync(other, { recursive: true });
  // flow YAML on one line: a text match for `kind: check` on a line of its own does not see it; the id is taken by both roots, so both are refused
  writeFileSync(join(root, "first.yaml"), '{ kind: check, id: dup, title: first, order: 1, script: dup.ts, runner: bun, timeout_ms: 1000 }\n');
  writeFileSync(join(other, "again.yaml"), '{ kind: check, id: dup, title: again, order: 2, script: dup.ts, runner: bun, timeout_ms: 1000 }\n');
  const r = loadChecks(loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: other, trusted: true, credentials: [] }]));
  expect(r.broken.map((b) => b.id)).toContain("dup");
});

test("an unparseable file beside a check manifest counts as a broken check", () => {
  const root = join(dir, "unreadable-root");
  write(root, "fine", PRINT("{ pass: true, findings: [] }"));
  writeFileSync(join(root, "mangled.yaml"), "{ kind: check, id: [");
  const lone = join(dir, "lone-root");
  mkdirSync(lone, { recursive: true });
  writeFileSync(join(lone, "mangled.yaml"), "{ kind: check, id: [");
  const r = loadChecks(loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: lone, trusted: true, credentials: [] }]));
  expect(r.checks.map((c) => c.id)).toEqual(["fine"]);
  expect(r.broken).toHaveLength(1);
  expect(r.broken[0]!.problem).toContain("mangled.yaml");
});

test("a check manifest the registry refused, or one that is not valid, is broken; one from an untrusted root is not", () => {
  const root = join(dir, "broken-root");
  write(root, "fine", PRINT("{ pass: true, findings: [] }"));
  write(root, "nort", PRINT("{ pass: true, findings: [] }"), { runner: "perl" });
  writeFileSync(join(root, "garbled.yaml"), "kind: check\nid: garbled\norder: [1\n");
  const evil = join(dir, "evil-root");
  write(evil, "ghost", PRINT("{ pass: true, findings: [] }"));
  const r = loadChecks(loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: evil, trusted: false, credentials: [] }]));
  expect(r.checks.map((c) => c.id)).toEqual(["fine"]);
  expect(r.broken.map((b) => b.id).sort()).toEqual(["garbled", "nort"]);
  for (const b of r.broken) expect(b.problem).not.toContain(dir);
});

test("the sample with one check's script gone loads ten checks and names the eleventh as broken", () => {
  const root = join(dir, "sample-copy");
  copySample(root);
  rmSync(join(root, "checks", "08-gaps-and-negatives.ts"));
  const r = loadChecks(loadRegistry([{ path: root, trusted: true, credentials: [] }]));
  expect(r.checks).toHaveLength(10);
  expect(r.broken).toEqual([{ id: "gaps-and-negatives", problem: `script "08-gaps-and-negatives.ts" is missing` }]);
});

test("Checks writes no check run after the run was stopped while a check was running", async () => {
  const { env, close } = stageRig({ slow: [`await Bun.stdin.text(); await Bun.sleep(300); console.log(JSON.stringify({ pass: true, findings: [] }));`, { order: 1 }] });
  try {
    const s = env.session;
    s.commit((_st, ids) => [{ type: "run.started", actor: person, payload: { run: ids.next("run"), pipeline: "p", pipeline_hash: "h", stages: [] } }]);
    const going = checksRunner(env);
    await Bun.sleep(100);
    s.commit((st) => [{ type: "run.finished", actor: person, run: st.run.id, payload: { outcome: "stopped", reason: "enough" } }]);
    const stopSeq = s.head().seq;
    const end = await going;
    expect(end).toEqual({ kind: "stopped" });
    expect(s.entries().filter((e) => e.seq > stopSeq)).toEqual([]);
    expect(s.state.skipped).toEqual([]);
  } finally { close(); }
});

// ---- check strictness (task 11 item 3) ----

test("a check manifest may say blocking: false; a check is blocking unless it says so", () => {
  const root = join(dir, "root-blocking");
  write(root, "strict", PRINT("{ pass: true, findings: [] }"), { order: 1 });
  write(root, "lenient", PRINT("{ pass: true, findings: [] }"), { order: 2, blocking: "false" });
  write(root, "plain", PRINT("{ pass: true, findings: [] }"), { order: 3, blocking: "true" });
  const r = load(root);
  expect(r.problems).toEqual([]);
  expect(r.checks.map((c) => [c.id, c.blocking])).toEqual([["strict", true], ["lenient", false], ["plain", true]]);
  write(root, "bad", PRINT("{ pass: true, findings: [] }"), { order: 4, blocking: "maybe" });
  expect(load(root).broken.map((b) => b.id)).toEqual(["bad"]);
});

const GAPS = "g";

test("a failed non-blocking check does not send the draft back: Checks notes it in gaps_and_limits in a new revision, checks that one and passes it", async () => {
  const { env, close } = stageRig({
    a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }],
    soft: [PRINT(`{ pass: false, findings: [{ where: "f1", message: "f1 cites c1, which has no rows" }] }`), { order: 2, blocking: "false" }],
  });
  try {
    const d1 = latestDraft(env.session.state)!;
    const end = await checksRunner(env);
    const d2 = latestDraft(env.session.state)!;
    expect(d2.n).toBe(2);
    expect(d2.author).toEqual({ kind: "system", id: "checks" });
    expect(d2.reason).toBe("Checks noted form exceptions: soft");
    // card ids in the note are written so that the note cites no card
    expect(d2.product.gaps_and_limits).toBe(`${GAPS}\n\nForm exceptions noted:\n- soft (f1): f1 cites card 1, which has no rows`);
    expect({ ...d2.product, gaps_and_limits: GAPS }).toEqual(d1.product);
    expect(d2.hash).toBe(sha256Hex(canonical(d2.product as never)));
    expect(end).toEqual({ kind: "finished", outcome: "pass", draft_hash: d2.hash, output: { checks: [{ check: "a", pass: true }, { check: "soft", pass: false, blocking: false }] }, reason: null });
    const es = runs(env).map((e) => (e.type === "check.run" ? [e.payload.check, e.payload.draft_hash, e.payload.pass, e.payload.blocking ?? true] : []));
    expect(es).toEqual([["a", d1.hash, true, true], ["soft", d1.hash, false, false], ["a", d2.hash, true, true], ["soft", d2.hash, false, false]]);
    const s = env.session.state;
    expect(s.reviews[d2.hash]!.checks.map((c) => [c.check, c.pass])).toEqual([["a", true], ["soft", false]]);
    expect(s.skipped).toEqual([]);
  } finally { close(); }
});

test("a revision that already holds the same note is not written again; one whose exceptions are gone loses its note", async () => {
  const { env, close } = stageRig({ soft: [PRINT(`{ pass: false, findings: [{ where: "change", message: "empty" }] }`), { order: 1, blocking: "false" }] });
  try {
    await checksRunner(env);
    expect(env.session.state.drafts).toHaveLength(2);
    const end = await checksRunner(env);
    expect(env.session.state.drafts).toHaveLength(2);
    expect(end).toMatchObject({ outcome: "pass", draft_hash: latestDraft(env.session.state)!.hash });
  } finally { close(); }
  const r2 = stageRig({ a: [PRINT("{ pass: true, findings: [] }"), { order: 1 }] });
  try {
    const d = latestDraft(r2.env.session.state)!;
    const noted = { ...d.product, gaps_and_limits: `${GAPS}\n\nForm exceptions noted:\n- old (x): stale` };
    r2.env.session.commit(() => [{ type: "draft.revised", actor: person, payload: { draft: { n: 2, hash: sha256Hex(canonical(noted as never)), author: person, product: noted, reason: "r" } } }]);
    const end = await checksRunner(r2.env);
    const last = latestDraft(r2.env.session.state)!;
    expect(last.n).toBe(3);
    expect(last.product.gaps_and_limits).toBe(GAPS);
    expect(last.reason).toBe("Checks removed form exceptions that no longer apply");
    expect(end).toMatchObject({ outcome: "pass", draft_hash: last.hash });
  } finally { r2.close(); }
});

test("a blocking failure fails the stage as before, and no note is written even when a non-blocking check failed too", async () => {
  const { env, close } = stageRig({
    hard: [PRINT(`{ pass: false, findings: [{ where: "f1", message: "bad" }] }`), { order: 1 }],
    soft: [PRINT(`{ pass: false, findings: [{ where: "f1", message: "meh" }] }`), { order: 2, blocking: "false" }],
  });
  try {
    const d = latestDraft(env.session.state)!;
    const end = await checksRunner(env);
    expect(env.session.state.drafts).toHaveLength(1);
    expect(end).toMatchObject({ kind: "finished", outcome: "fail", draft_hash: d.hash, reason: "hard failed: bad" });
  } finally { close(); }
});
