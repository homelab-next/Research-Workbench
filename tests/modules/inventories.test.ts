import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { belongsPlaybook } from "../../src/modules/inventories";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { copySample, sampleRoot } from "../helpers/sample-root";
import type { CaseSession } from "../../src/core/session";
import type { PlaybookLookup } from "../../src/core/types";
import { Workbench } from "../../src/core/workbench";
import { beginPlaybook, runPlaybook } from "../../src/modules/playbook-run";
import type { PlaybookStart } from "../../src/modules/playbook-run";
import type { RunnerDeps } from "../../src/modules/runner";
import { person, START, WINDOW } from "../helpers/tools-fixture";

let dir: string;
let root: string;
let registry: Registry;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inventories-"));
  root = join(dir, "sample");
  copySample(root);
  registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The pivot block for `id` in the sample's pivots.yaml, changed by `change`. */
const pivotBlock = (id: string, change: (block: string) => string) => (text: string): string =>
  text.replace(new RegExp(`(  - id: ${id}\\n(?:    .*\\n)*)`), (b) => change(b));

// ---------- a reused answer is only as good as the inventory it was read under ----------
async function belongsTwice(change: ((sampleRoot: string) => void) | null): Promise<{ first: PlaybookLookup; second: PlaybookLookup; body: string; s: CaseSession }> {
  const sample = sampleRoot(join(dir, "run"));
  const wb = Workbench.open(join(dir, "wb"), { onError: () => {} });
  try {
    const s = wb.createCase({ title: "t", asked: "a", why: "w", starting: [{ type: "address", value: START }], window: WINDOW, objective: null, marking: "TLP:GREEN" }, person);
    // the pivot states no empty_means, so the inventory alone decides it
    const pivots = join(sample.root, "pivots.yaml");
    writeFileSync(pivots, pivotBlock("address_to_asset", (b) => b.replace(/    empty_means: .*\n/, ""))(readFileSync(pivots, "utf8")));
    const once = async (deps: RunnerDeps): Promise<PlaybookLookup> => {
      const start: PlaybookStart = { playbook: belongsPlaybook(deps.registry, "address")!, inputs: [{ type: "address", value: START }], window: WINDOW, why: "is it ours", actor: person };
      const job = beginPlaybook(s, deps, start);
      await runPlaybook(s, deps, job, start);
      return s.state.playbooks[job]!.steps.i1!.lookups[0]!;
    };
    const load = () => loadRegistry([{ path: sample.root, trusted: true, credentials: [] }]);
    const firstRegistry = load();
    const first = await once({ ...sample.deps, registry: firstRegistry });
    change?.(sample.root);
    const second = await once({ ...sample.deps, registry: load() });
    const body = s.state.cards[second.card!]!.body;
    expect(s.state.skipped).toEqual([]);
    return { first, second, body, s };
  } finally {
    wb.close();
    sample.close();
  }
}

test("a proven negative is not reused once its inventory is no longer complete: the lookup runs again and reads not seen", async () => {
  const { first, second, body } = await belongsTwice((r) => {
    const f = join(r, "inventories", "assets.yaml");
    writeFileSync(f, readFileSync(f, "utf8").replace("complete: true", "complete: false"));
  });
  expect(first).toMatchObject({ outcome: "empty", reused: false, detail: "proven negative" });
  expect(second).toMatchObject({ outcome: "empty", reused: false, detail: "not seen" });
  expect(second.query).not.toBe(first.query);
  expect(body).toBe("No rows · not seen (not proof of absence) · Asset list is not declared complete");
});

test("a reused lookup says what the answer it reuses means", async () => {
  const { first, second } = await belongsTwice(null);
  expect(second.reused).toBe(true);
  expect(second.query).toBe(first.query);
  expect(second.detail).toEndWith("; same pivot, value and window · proven negative");
});
