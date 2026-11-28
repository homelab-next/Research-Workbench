// `synth seed-tasks` on tiny --scripted synthetic setups built under a fresh temporary folder: each storyline a case of the seed loop, its gates
// passed by the person of the configuration, its known answer set from the ground truth. Synthetic only.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
import { compose } from "../../src/cli/compose";
import { hostsFor } from "../../src/cli/improve";
import type { CaseSession } from "../../src/core/session";
import { strictest } from "../../src/core/types";
import type { Actor } from "../../src/core/types";
import { verifyCase } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { answeredProducts } from "../../src/pipeline/improve/answers";
import { buildSetup } from "../../src/synth/build";
import type { Built } from "../../src/synth/build";
import { SEED_FINDING } from "../../src/synth/seed-script";
import { synthSeed } from "../../src/synth/seed";
import { setupOf } from "../../src/synth/setup";
import type { SynthContext } from "../../src/synth/setup";
import { readIndex } from "../../src/synth/tasks";

let tmp: string;
let full: Built;
let broken: Built;
let truths: GroundTruth[];
const BROKEN = "backup-job";

const configOf = (b: Built): Config => loadConfig({ path: b.config, env: {}, home: join(tmp, "home") });

function ctxOf(b: Built): { ctx: SynthContext; out: string[]; err: string[] } {
  const config = configOf(b);
  const { dir, setup } = setupOf(config);
  const out: string[] = [], err: string[] = [];
  return { ctx: { config, dir, setup, human: { kind: "human", id: config.user }, io: { log: (l) => out.push(l), error: (l) => err.push(l) } }, out, err };
}

let first: { code: number; out: string[]; err: string[] };

beforeAll(async () => {
  tmp = mkdtempSync(join(tmpdir(), "synth-seed-"));
  mkdirSync(join(tmp, "home"));
  full = buildSetup(join(tmp, "full"), { params: TINY_PARAMS, model: "scripted" }, null);
  broken = buildSetup(join(tmp, "broken"), { params: TINY_PARAMS, model: "scripted" }, null);
  const dir = join(full.dir, "truth");
  truths = readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "mess.json").sort().map((f) => readGroundTruth(readFileSync(join(dir, f)))!);
  // the broken setup's script has no planner turn for one storyline
  const question = truths.find((t) => t.storyline === BROKEN)!.task.question;
  const file = join(broken.dir, "root", "scripts", "synth-seed.yaml");
  const lines = readFileSync(file, "utf8").split("\n");
  const kept = lines.filter((l) => !(l.startsWith("  - ") && (JSON.parse(l.slice(4)) as { actor: string; when: string[] }).actor === "planner" && l.includes(JSON.stringify(question))));
  expect(kept.length).toBe(lines.length - 1);
  writeFileSync(file, kept.join("\n"));
  const c = ctxOf(full);
  first = { code: await synthSeed(c.ctx, { only: null, marking: "TLP:GREEN" }), out: c.out, err: c.err };
}, 120_000);
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Opens the setup's workbench, gives `fn` each case the seed made by storyline, and closes it. */
function withCases<T>(b: Built, fn: (cases: { storyline: string; session: CaseSession }[], wb: Workbench, config: Config) => T): T {
  const config = configOf(b);
  const wb = Workbench.open(config.data_dir, { store: config.cases.store, memory: config.memory.store, onError: () => {} });
  try {
    const index = readIndex(config).cases.filter((c) => c.made_by === "seed-tasks");
    return fn(index.map((c) => ({ storyline: c.storyline, session: wb.session(c.case) })), wb, config);
  } finally {
    wb.close();
  }
}

/** Every regular file under a folder. */
function files(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...files(p));
    else out.push(p);
  }
  return out;
}

test("seed-tasks makes, for each storyline, a case of the loop synth-seed that is published and has a known answer, all by the person of the configuration", () => {
  // every gate.passed, plan.accepted, product.published and answer.known of each case is by { kind: "human", id: config.user }; state.skipped is []
  expect(first.err).toEqual([]);
  expect(first.code).toBe(0);
  expect(first.out.length).toBe(9);
  withCases(full, (cases, _wb, config) => {
    const human: Actor = { kind: "human", id: config.user };
    expect(cases.map((c) => c.storyline).sort()).toEqual(truths.map((t) => t.storyline).sort());
    for (const { storyline, session } of cases) {
      expect(first.out).toContain(`seeded ${session.id} for ${storyline}: product 1 published, known answer set (synthetic)`);
      const s = session.state;
      expect(s.skipped).toEqual([]);
      expect(session.entries().find((e) => e.type === "case.loop_set")?.payload).toEqual({ loop: "synth-seed" });
      expect(s.run.status).toBe("finished");
      expect(s.run.outcome).toBe("published");
      expect(s.published.map((p) => p.n)).toEqual([1]);
      expect(answeredProducts(s).map((a) => a.product)).toEqual([1]);
      expect(s.meta!.title.startsWith("[synthetic] ")).toBe(true);
      const byPerson = session.entries().filter((e) => ["gate.passed", "plan.accepted", "product.published", "answer.known"].includes(e.type));
      expect(byPerson.map((e) => e.type).sort()).toEqual(["answer.known", "gate.passed", "gate.passed", "plan.accepted", "product.published"]);
      for (const e of byPerson) expect({ type: e.type, actor: e.actor }).toEqual({ type: e.type, actor: human });
      // no budget was given at the plan gate
      expect(session.entries().filter((e) => e.type === "budget.set")).toEqual([]);
    }
  });
});

test("the published product's one finding is SEED_FINDING, and no entry or blob of the case but answer.known holds the truth's summary or a claim", () => {
  withCases(full, (cases) => {
    for (const { storyline, session } of cases) {
      const truth = truths.find((t) => t.storyline === storyline)!;
      const secrets = [truth.summary, ...truth.findings.map((f) => f.claim)];
      const s = session.state;
      const draft = s.drafts.find((d) => d.hash === s.published[0]!.draft_hash)!;
      // the one finding is SEED_FINDING, worded with its likelihood as the standard words a claim
      expect(draft.product.key_findings.length).toBe(1);
      expect(draft.product.key_findings[0]!.statement).toBe(`We assess it is roughly even chance that ${SEED_FINDING[0]!.toLowerCase()}${SEED_FINDING.slice(1)}`);
      expect(draft.product.key_findings[0]!.confidence).toBe("low");
      for (const e of session.entries()) {
        if (e.type === "answer.known") {
          expect((e.payload as { text: string }).text).toBe(truth.summary);
          continue;
        }
        const text = JSON.stringify(e.payload);
        for (const x of secrets) expect({ type: e.type, holds: text.includes(JSON.stringify(x).slice(1, -1)) }).toEqual({ type: e.type, holds: false });
      }
      for (const f of files(session.dir)) {
        if (/\.(sqlite|db)(-wal|-shm)?$/.test(f) || f.endsWith("ledger")) continue;
        const text = readFileSync(f, "latin1");
        for (const x of secrets) expect({ f, holds: text.includes(x) }).toEqual({ f, holds: false });
      }
    }
  });
});

test("each seeded case is a task of its case type for the improve loop's Select: published, answered, not stricter than TLP:GREEN", () => {
  withCases(full, (cases, wb, config) => {
    const composed = compose(config, wb);
    const deps = { ...composed.deps };
    const host = hostsFor(wb, deps, () => {});
    try {
      for (const { storyline, session } of cases) {
        const type = truths.find((t) => t.storyline === storyline)!.task.case_type;
        expect(session.state.memory.type).toBe(type);
        const view = deps.improve!.tasks(type).find((v) => v.ref.case === session.id);
        expect(view).toBeDefined();
        expect(view!.state.published.length).toBe(1);
        const answers = answeredProducts(view!.state);
        expect(answers.length).toBe(1);
        expect(strictest(answers[0]!.marking, "TLP:GREEN")).toBe("TLP:GREEN");
        expect(strictest(view!.state.meta!.marking, "TLP:GREEN")).toBe("TLP:GREEN");
      }
    } finally {
      host.close();
      composed.close();
    }
  });
});

test("a second seed-tasks seeds nothing; --only seeds the named ones", async () => {
  const again = ctxOf(full);
  expect(await synthSeed(again.ctx, { only: null, marking: "TLP:GREEN" })).toBe(0);
  expect(again.out).toEqual(["no case seeded: every storyline asked for already has a seeded case"]);
  expect(withCases(full, (cases) => cases.length)).toBe(9);

  const unknown = ctxOf(broken);
  expect(await synthSeed(unknown.ctx, { only: ["no-such-story"], marking: "TLP:GREEN" })).toBe(1);
  expect(unknown.err.join("\n")).toContain("no-such-story");
  expect(withCases(broken, (cases) => cases.length)).toBe(0);

  const only = ctxOf(broken);
  expect(await synthSeed(only.ctx, { only: ["cloud-key", "vpn-travel"], marking: "TLP:GREEN" })).toBe(0);
  expect(only.err).toEqual([]);
  expect(withCases(broken, (cases) => cases.map((c) => c.storyline).sort())).toEqual(["cloud-key", "vpn-travel"]);
}, 120_000);

test("a seed that stops elsewhere (the script's planner turn removed for one storyline) is named with where it stopped, gets no answer, and the others are still seeded; the exit code is 1", async () => {
  const c = ctxOf(broken);
  expect(await synthSeed(c.ctx, { only: null, marking: "TLP:GREEN" })).toBe(1);
  expect(c.err.length).toBe(1);
  expect(c.err[0]).toMatch(new RegExp(`^CASE-\\d+ for ${BROKEN} stopped at .+: .+`));
  expect(c.err[0]).toContain("planner");
  expect(c.out.length).toBe(6);
  withCases(broken, (cases) => {
    expect(cases.length).toBe(9);
    for (const { storyline, session } of cases) {
      const answered = answeredProducts(session.state).length;
      expect({ storyline, answered, published: session.state.published.length }).toEqual({ storyline, answered: storyline === BROKEN ? 0 : 1, published: storyline === BROKEN ? 0 : 1 });
    }
  });
}, 120_000);

test("verifyCase passes for every seeded case", () => {
  withCases(full, (cases) => {
    expect(cases.length).toBe(9);
    for (const { session } of cases) {
      const r = verifyCase(session.dir);
      expect({ case: session.id, ok: r.ok }).toEqual({ case: session.id, ok: true });
    }
  });
});
