# Observed-activity Timeline and Graph (6b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pivot declares its time columns, each card carries what its result observed, and two lenses read that from the record: the Timeline (per value, first and last seen and counts, on the data's own axis) and the Graph (values linked by the pivots that found them). The items 6a's review and dev CASE-2 left open are closed first.

**Architecture:** The runner reads a pivot's declared time columns from every row of a result and writes a bounded summary, `observed`, on the card it already makes. Three pure, browser-safe functions over the folded case state (`cardObserved`, `timelineOf`, `graphOf`) build the models; nothing is added to `CaseState`. A pure layered layout places the graph; both lenses draw SVG through a second fixed-list builder (`src/web/svg.ts`), since the page's policy forbids inline style.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun test`, happy-dom for interface tests. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-11-26-slice-6b-timeline-graph-design.md`](../specs/2026-11-26-slice-6b-timeline-graph-design.md) ("the design"; §n means its section n). It builds on the 6a design and the slice design in the same folder. Branch `slice-6b-timeline-graph`, from `slice-6a-playbooks` `683a49a` (2270 tests). Evidence for Task 0: `.superpowers/sdd/2026-11-26-slice-6a-playbooks/final-review.md` (items M3, M5, M10 to M13 and its "seven questions" table) and `progress.md` lines 31 and 37 to 38.

## Global Constraints

- **The record decides.** A time, a link, a count or a verdict a lens shows comes from the folded entries. `ui.ref` supplies titles and scope words only.
- **Nothing in this plan reaches a source.** No code calls a connector; `observed` is built from the result `runQuery` already holds, in the commit that makes the card.
- **The fold never throws and never mutates its input.** A field added to a payload is optional, and an entry without it folds as it did. A malformed payload is recorded in `skipped`.
- **Browser-safe core.** `src/core/state/**` imports nothing outside `src/core/`; no `Bun`, `process`, `Buffer`, `node:*`. `src/web/**` imports only `src/web`, `src/core/state`, `src/core/wire.ts`, `src/core/types.ts`, `src/core/canonical.ts` (`tests/web/lint.test.ts`, `tests/core/browser-safety.test.ts`). New state modules are imported by path (`../../core/state/observed`); `src/core/state/index.ts` is edited by Task 1 only.
- **No HTML sink, no inline style.** Elements are made only by `h` (`src/web/dom.ts`) and `s` (`src/web/svg.ts`). Text from the record is a text node or the value of a fixed attribute. Colour is a class in `src/web/style.css`.
- **Deterministic.** No `Math.random`, no `Date.now` in a model or a layout, no locale-dependent compare (`<` on strings, not `localeCompare`), no engine date parsing of anything but a normalised `YYYY-MM-DDTHH:MM:SS.mmmZ` string.
- **Exact values from the design:** at most 100 sightings a card and 24 points a sighting; Timeline draws 200 rows, strip `viewBox` `0 0 1000 20`, a mark never narrower than 4; Graph places at most 12 neighbours per node and 60 nodes; node 180 × 26, column gap 70, row gap 8, tall indent 24, margin 12; labels cut at 22 characters; SVG numbers rounded to two decimals.
- **The real environment stays out of the repository.** No host, address, account, schema, table or column name of the owner's in any file, test, commit message or task report. Tests use the sample's names, loopback and RFC 5737 addresses, and `example.*` domains. Task 7 uses placeholders in angle brackets.
- **No test, script or `preflight` contacts a real source.**
- **Tests:** `timeout 120 bun test <file>` while iterating; `timeout 900 bun test && timeout 300 bun run typecheck` before each commit, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. No test asserts an absolute duration. Every test makes its files under a fresh `mkdtempSync` directory and removes it, closes what it opens, and asserts `state.skipped` is `[]` when it drives a session. Report real RED: the failing run of the new tests, made before the implementation.
- **Commits:** on `slice-6b-timeline-graph`, never pushed; `git add` by explicit path (other tasks may have uncommitted work in the tree). End every commit message with the attribution lines your own harness reminder gives you.
- **A test outside your task's Files that your change breaks:** fix it if no task running beside yours lists that file; otherwise report it and leave it.

## What can run in parallel

Tasks in one wave touch disjoint files. A wave starts when the one before it is committed.

| Wave | Tasks |
|---|---|
| 1 | **Task 0** (carried items) ∥ **Task 4** (SVG builder) |
| 2 | **Task 1** (times → cards → `cardObserved`; the sample) |
| 3 | **Task 2** (Timeline model and lens) ∥ **Task 3** (Graph model and layout) |
| 4 | **Task 5** (Graph lens) |
| 5 | **Task 6** (acceptance and documents) |
| after | **Task 7** (the owner's root; the controller, outside the repository) |

`src/core/types.ts` and `src/core/state/{run,types,shapes,index}.ts` are changed by Task 0 (plan-step fields) and then by Task 1 (card and query fields); they are never in the tree of two running tasks. Task 1 changes the sample's pivots, which many tests read, so it runs alone. Tasks 2 and 3 add new files only, except Task 2's lens registration.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/pipeline/stages/agent.ts`, `evaluate.ts`, `challenge.ts` | Reviewers' packs hold every cited card (A); fast-model fit (H) | 0 |
| `tests/agents/loop.test.ts` | The `extractJson` test asserts shape, not the clock (B) | 0 |
| `src/modules/pins.ts` (new) | `stepPins`: one hash over what a plan step's acceptance covers (D) | 0 |
| `src/core/types.ts`, `src/core/state/run.ts`, `state/types.ts`, `src/pipeline/plans.ts`, `stages/research.ts`, `src/agents/tools/research.ts`, `tools/index.ts` | `PlanStep.pins` (D), several end steps (E), `step.started.by` (F) | 0 |
| `src/core/workbench.ts`, `src/server/app.ts` | Recovery at start for a running job (G) | 0 |
| `src/web/panels/playbook.ts`, `src/web/lenses/jobs.ts`, `lenses/steps.ts` | The run's trail in Jobs (I); the "workbench" tag (F) | 0 |
| `src/modules/playbook-run.ts` | A halted run's outcome; steps not reached (J) | 0 |
| `src/modules/observe.ts` (new) | `readTime`, `observe`: a result's rows → `Observed` | 1 |
| `src/modules/manifests.ts`, `registry.ts`, `runner.ts` | `PivotManifest.times`, its load checks; the card's `observed` and `event_time` | 1 |
| `src/core/types.ts`, `src/core/state/shapes.ts`, `state/run.ts`, `state/types.ts`, `state/index.ts` | `Span`, `Sighting`, `Observed`, `Card.observed`; `QueryState.pivot`, `.value` | 1 |
| `src/core/state/observed.ts` (new) | `valueKey`, `cardObserved` (and the legacy reading) | 1 |
| `sample/pivots.yaml`, `sample/README.md` | `times` on the five windowed pivots | 1 |
| `src/core/state/timeline.ts` (new) | `timelineOf` | 2 |
| `src/web/lenses/timeline.ts` (new), `lenses/index.ts`, `style.css` | The Timeline lens | 2 |
| `src/core/state/graph.ts` (new) | `graphOf` | 3 |
| `src/web/graphlayout.ts` (new) | `layoutGraph` | 3 |
| `src/web/svg.ts` (new), `tests/web/lint.test.ts` | The SVG builder and its lint rules | 4 |
| `src/web/lenses/graph.ts` (new), `src/web/belongs.ts`, `app.ts`, `keys.ts`, `commands.ts`, `views/workarea.ts`, `lenses/index.ts`, `style.css` | The Graph lens, its key and command word, the verdict per value | 5 |
| `tests/sample/observed-acceptance.test.ts` (new), `README.md`, `docs/gui-guide.md`, `docs/security-notes.md` | Acceptance and documents | 6 |

## Review Focus

Inputs the design implies and a person will meet, most likely first. Each has its test in the task named.

1. **A source returns a time in a form the table of §5.2 does not hold** (an epoch number, a local zone name, an empty string). The card is still made, the row counts in `unread`, the value is still found, nothing throws. *Task 1, Step 1 (`observe` tests).*
2. **A value that looks like markup or is very long** (`<img src=x onerror=1>`, 512 characters). It is drawn as text in both lenses, its label is cut and its tooltip whole, and no element or attribute comes from it. *Task 2 Step 3 and Task 5 Step 1.*
3. **Replay moved to before the first card, or to entry 0.** Both lenses show their "nothing yet" line and throw nothing; moving forward fills them. *Task 2 Step 3 and Task 5 Step 1.*
4. **Links that loop** (A found B, B found A; a value found from itself; two cards saying the same link). The layout ends, there is one edge per direction with both cards on it, and no self-edge. *Task 3 Step 1.*
5. **Everything observed at one instant, or a case window with an open end.** The axis has a width, the mark is 4 wide, nothing divides by zero. *Task 2 Step 1 and Step 3.*

---

### Task 0: The carried items

Ten small parts, one commit each, in this order. Parts D and F change core types; do them before G to J so the type errors of one part are not mixed with another's.

**Files:**
- Create: `src/modules/pins.ts`
- Modify: `src/pipeline/stages/agent.ts`, `src/pipeline/stages/evaluate.ts`, `src/pipeline/stages/challenge.ts`, `src/pipeline/plans.ts`, `src/pipeline/stages/research.ts`, `src/agents/tools/research.ts`, `src/agents/tools/index.ts`, `src/core/types.ts`, `src/core/state/run.ts`, `src/core/state/types.ts`, `src/core/workbench.ts`, `src/server/app.ts`, `src/modules/playbook-run.ts`, `src/web/panels/playbook.ts`, `src/web/lenses/jobs.ts`, `src/web/lenses/steps.ts`
- Test: `tests/modules/pins.test.ts` (new), `tests/pipeline/stages-analysis.test.ts`, `tests/agents/loop.test.ts`, `tests/pipeline/plans.test.ts`, `tests/pipeline/stages-front.test.ts`, `tests/agents/tools-research.test.ts`, `tests/core/state-run.test.ts`, `tests/server/commands.test.ts`, `tests/pipeline/stage-agent.test.ts`, `tests/modules/playbook-run.test.ts`, `tests/web/lenses-simple.test.ts`, `tests/web/steps.test.ts`

**Interfaces (Produces):**
```ts
// src/pipeline/stages/agent.ts
/** Every card the draft cites, as pack parts: the findings' cards in finding order, then the rest of citedOf(draft). A card no longer in the case is left out. */
export function citedCardParts(session: CaseSession, registry: Registry, draft: Draft): PackPart[];
/** The ids citedOf(draft) names that are not in the case, sorted as citedOf sorts. */
export function citedGone(session: CaseSession, draft: Draft): string[];
// src/core/types.ts
PlanStep.pins?: string;                                   // what the person accepted, as one hash
Payloads["step.started"]: { step: string; by?: "workbench" };
// src/core/state/types.ts
PlanState.steps[id]: { status; cards; note; by?: "workbench" };
// src/modules/pins.ts (in modules, so both src/pipeline and src/agents/tools may import it)
/** sha256Hex(canonical(x)). Playbook step: x = [playbook hash, ...steps.map(s => [s.pivot, pivot hash, inventory id | null, inventory hash | null])].
 *  Route step: x = [pivot id, pivot hash, inventory id | null, inventory hash | null]. Null when the playbook or a pivot is not loaded. */
export function stepPins(registry: Registry, step: Pick<PlanStep, "pivot" | "playbook">): string | null;
// src/agents/tools/index.ts
ToolContext.in_code?: boolean;                             // set by Research when the workbench runs a step itself
// src/core/workbench.ts
CaseSummary.jobs_running: number;
// src/web/panels/playbook.ts
/** The trail of one run, from the fold: the verdict for a does-it-belong run, the status line, each step and lookup with its card chip, the caveats. */
export function playbookTrail(ui: Ui, run: PlaybookRunState, cards: CaseState["cards"], onCard: (card: string) => void): HTMLElement;
```

- [ ] **Part A, Step 1: failing tests** in `tests/pipeline/stages-analysis.test.ts` (use the file's own rig for a draft and a scripted reviewer):

```ts
test("Evaluate's pack holds a card the draft cites only in Gaps and limits", async () => {
  // a draft whose one finding cites c1 and whose gaps_and_limits reads "c2 and c3 were empty [c2, c3]"
  // run evaluateRunner; read the model.request entry of stage "evaluate"
  expect(request.payload.pack.filter((i) => i.kind === "card").map((i) => i.id)).toEqual(["c1", "c2", "c3"]);
});
test("Challenge's pack holds the same cards, the findings' cards first", async () => { /* same draft; stage "challenge"; ["c1", "c2", "c3"] */ });
test("a cited card that is no longer in the case is named in the reviewer's task", async () => {
  // the draft's assessment names c9, which the case does not hold
  expect(messagesText).toContain("Cited by the draft but no longer in the case: c9. Say so; do not judge what they held.");
});
```
- [ ] **Step 2: run, expect FAIL** (`pack` holds `c1` only). **Step 3: implement.** `citedCardParts` takes its ids from the findings, then `citedOf(draft)` (`src/agents/draft.ts`) minus those. `evaluateRunner` and `challengeRunner` append the "Cited by the draft…" line to `task` only when `citedGone` is not empty. **Step 4: PASS; commit** `fix(pipeline): the reviewers' packs hold every card the draft cites, not only the findings' cards`.

- [ ] **Part B: replace the test** at `tests/agents/loop.test.ts:446` with:

```ts
test("extractJson on open braces grows with the input, not with its square", () => {
  const best = (n: number): number => {
    let ms = Infinity;
    for (let i = 0; i < 3; i++) { const t0 = performance.now(); expect(extractJson("{".repeat(n))).toBeNull(); ms = Math.min(ms, performance.now() - t0); }
    return Math.max(ms, 0.25);
  };
  expect(best(1024 * 1024) / best(128 * 1024)).toBeLessThan(24);   // linear is about 8; quadratic is about 64
  expect(extractJson("```\n".repeat(200_000))).toBeNull();
});
```
Run it five times in a row (`for i in 1 2 3 4 5; do timeout 120 bun test tests/agents/loop.test.ts -t "grows with the input" || break; done`); commit `test(agents): the extractJson linearity test compares two sizes instead of a clock`.

- [ ] **Part C: verify, change nothing.** `grep -rn '"does-it-belong"' src` prints one line, `src/core/wire.ts`. If it prints more, replace the literal with `BELONGS_ID` and commit; otherwise note "already done in 683a49a" in the report.

- [ ] **Part D, Step 1: failing tests.**

```ts
// tests/modules/pins.test.ts — sampleRoot(dir)
test("stepPins is a hash of the pivot and its inventory for a route step, of the playbook and every step's pivot for a playbook step, and null for what is not loaded", () => {
  expect(stepPins(registry, { pivot: "address_to_asset" })).toBe(sha256Hex(canonical(["address_to_asset", pivot.hash, "assets", inventory.hash])));
  expect(stepPins(registry, { pivot: "address_to_domains" })).toBe(sha256Hex(canonical(["address_to_domains", domains.hash, null, null])));
  expect(stepPins(registry, { pivot: "", playbook: { id: "address-triage", hash: "x", inputs: [] } })).toMatch(/^[0-9a-f]{64}$/);
  expect(stepPins(registry, { pivot: "no_such_pivot" })).toBeNull();
});
// tests/pipeline/plans.test.ts
test("every step of a built plan carries pins, and a playbook step's pins change when one of its pivots changes", () => {
  // build a plan with one route sub-goal and one playbook sub-goal on the sample
  for (const st of plan.steps) expect(st.pins).toMatch(/^[0-9a-f]{64}$/);
  // reload the registry from a copy of the root with one line appended to pivots.yaml ("# changed")
  expect(stepPins(changed, plan.steps.find((s) => s.playbook !== undefined)!)).not.toBe(plan.steps.find((s) => s.playbook !== undefined)!.pins);
});
// tests/pipeline/stages-front.test.ts
test("a playbook step whose pivot changed since acceptance is not run: it finishes blocked", async () => {
  // accept the plan, swap deps.registry for the changed one (playbook file untouched), run Research
  expect(step("s1")).toMatchObject({ status: "blocked", note: "a pivot of the playbook address-triage changed since the plan was accepted; re-plan to use it" });
  expect(ofType("query.issued")).toEqual([]);
});
// tests/agents/tools-research.test.ts
test("run_step on a route step whose pivot changed since acceptance finishes it blocked and sends nothing", async () => {
  expect(result).toMatchObject({ ok: true, view: { status: "blocked", step: "s1" } });
  expect(f.session.state.plan.steps.s1).toMatchObject({ status: "blocked", note: "the pivot address_to_domains changed since the plan was accepted; re-plan to use it" });
});
test("a step recorded without pins runs as before", async () => { /* PLAN() from the fixture has no pins: the lookup is sent */ });
```
- [ ] **Step 2: FAIL. Step 3: implement.** `buildPlan` and `playbookStep` set `pins: stepPins(...)!`. `isPlanStep` (`src/core/state/run.ts:18`) accepts `pins` absent or a string. `runPlaybookUnit` (`research.ts`, beside the `p.hash !== ref.hash` test) and `runStepTool` (before the reuse check) compare `step.pins` with `stepPins(registry, step)` when `step.pins !== undefined`; on a mismatch each commits `step.started` and `step.finished { outcome: "blocked", cards: [], note }` with the note above. `runStepTool` then returns `{ ok: true, summary: note, view: { status: "blocked", step: id, note }, marking: null }`. A pin that cannot be computed now (`stepPins` null) is a mismatch. **Step 4: PASS; commit** `fix(pipeline): a plan step pins its pivots and inventories; a changed one blocks the step`.

- [ ] **Part E:** in `playbookStep` every `p.end` step's pivot must have `to === sg.want`; otherwise return `` `${name}: the playbook ${id} ends on steps that find ${types.join(" and ")}; a plan step needs every end step to find ${sg.want}` ``. `empty_means` is `"proven-negative"` only when every end step's pivot says so. Test in `plans.test.ts`: a copy of the sample playbook with `end: [asset, names]` is refused with that sentence; with `end: [asset, lease]` it builds and its `empty_means` is `"not-seen"`. Commit `fix(pipeline): a playbook plan step checks every end step`.

- [ ] **Part F, Step 1: failing tests.**

```ts
// tests/core/state-run.test.ts
test("step.started by the workbench is kept on the step; without it the step folds as before", () => {
  // plan.proposed, plan.accepted, step.started { step: "s1", by: "workbench" }, step.started { step: "s2" }
  expect(s.plan.steps.s1!.by).toBe("workbench"); expect("by" in s.plan.steps.s2!).toBe(false);
  // step.started { step: "s1", by: "someone" } is malformed: skipped, state unchanged
});
// tests/pipeline/stages-front.test.ts
test("a step Research runs in code is recorded as started by the workbench; one the researcher runs is not", async () => {
  expect(ofType("step.started").map((e) => [e.payload.step, e.payload.by])).toEqual([["s1", "workbench"], ["s2", undefined]]);
});
// tests/web/steps.test.ts
test("a step the workbench ran reads so", async () => { expect(p.q('[data-step="s1"] .tag-system').textContent).toBe("workbench"); });
```
- [ ] **Step 2: FAIL. Step 3: implement.** `runStepsInCode` sets `in_code: true` on its `ctx`; `runStepTool` writes `by: "workbench"` on both of its `step.started` entries when `ctx.in_code === true`; every `step.started` in `runPlaybookUnit` carries it. The Steps lens adds `tag(ui, "system", "workbench", "Run in code by the workbench; no model chose this lookup")`. **Step 4: PASS; commit** `feat(core): step.started says when the workbench ran the step`.

- [ ] **Part G:** `summaryOf`'s caller fills `jobs_running` (jobs with status `running`). `createApp` recovers a case when `c.run_status === "running" || c.jobs_running > 0`. Test in `tests/server/commands.test.ts`, beside the test at line 231: a ledger with `job.started` (kind `playbook`) and `playbook.started` and no run; after `createApp`, with no command sent, `hub.read(id).state.jobs.j1.status` is `"failed"` and `state.playbooks.j1.status` is `"interrupted"`. Commit `fix(server): a job left running by a stopped process is recovered at start`.

- [ ] **Part H:** in `stageAgent`, after `fast` resolves: when `fast.provider.kind === "local"` and `fitProblem(fast.context, cap) !== null` (the same `cap` as the check above it), set `fast = null`. Test in `tests/pipeline/stage-agent.test.ts`, beside "a fast model the provider does not list": a fast model listed with a context of 8192 and a stage cap of 16384; every `model.request` names the stage's own model and the stage ends with its output. Commit `fix(pipeline): a fast model that cannot take the stage's reply cap is not used`.

- [ ] **Part I:** move the body of `trail` in `panels/playbook.ts` to the exported `playbookTrail` (same DOM, same classes); the panel calls it. In `lenses/jobs.ts` a job of kind `playbook` whose run is in `store.shown.playbooks` is a `details.job-row` whose `summary` is today's row and whose body is `playbookTrail(...)`, rebuilt when the run object changes. Test in `tests/web/lenses-simple.test.ts`: after a `run playbook address-triage on 198.51.100.77` on the page, the Jobs lens has `details[data-job] .playbook-trail` with one `.step` per step of the run, and a click on its first `.card-chip` records `["focusCard", <id>]` in `p.navCalls`. Commit `feat(web): a playbook job opens to its run in the Jobs lens`.

- [ ] **Part J, Step 1: failing tests** in `tests/modules/playbook-run.test.ts`:

```ts
test("a run stopped in its end step ends blocked, not answered", async () => {
  // end: [clients]; stop() turns true after the first clients lookup has returned rows
  expect(end).toMatchObject({ outcome: "blocked", end_step: "clients" });
});
test("steps a stopped run never reached are recorded skipped with the reason", async () => {
  // stop() true before the second step's first lookup
  expect(steps.map((s) => [s.step, s.status, s.reason])).toEqual([["asset", "ran", ""], ["lease", "skipped", STOPPED], ["names", "skipped", STOPPED], ["clients", "skipped", STOPPED]]);
});
test("a run that hits the lookup ceiling after its end step finished keeps that step's outcome", async () => { /* end: [asset]; outcome "empty"; later steps skipped with CAPPED */ });
```
- [ ] **Step 2: FAIL. Step 3: implement** in `walk`: remember the id of the step the halt happened in; after the loop, write a `playbook.step` `{ status: "skipped", reason: STOPPED | CAPPED, lookups: [], found: [], left: 0 }` for the halted step if it recorded nothing and for every step after it; the outcome is `"blocked"` when there is no end step that ran or the end step is the halted one. Export `STOPPED` and `CAPPED` if they are not. **Step 4: PASS; full suite with the browser; typecheck; commit** `fix(modules): a halted playbook run ends blocked and records the steps it did not reach`.

---

### Task 1: Times from results, onto the card, into the fold

**Files:**
- Create: `src/modules/observe.ts`, `src/core/state/observed.ts`
- Modify: `src/modules/manifests.ts`, `src/modules/registry.ts`, `src/modules/runner.ts`, `src/core/types.ts`, `src/core/state/shapes.ts`, `src/core/state/run.ts`, `src/core/state/types.ts`, `src/core/state/index.ts`, `sample/pivots.yaml`, `sample/README.md`
- Test: `tests/modules/observe.test.ts` (new), `tests/modules/registry.test.ts`, `tests/modules/runner.test.ts`, `tests/core/state-cards.test.ts`, `tests/core/state-observed.test.ts` (new), `tests/sample/sample.test.ts`; and any test the sample's new columns break

**Interfaces:**
- Consumes: `Observables.matches`, `PivotManifest.yields` (as `yielded` in `src/modules/pivots.ts` reads them).
- Produces:
```ts
// src/core/types.ts
export interface Span { first: string | null; last: string | null; count: number | null }
export interface Sighting extends Span { type: string; value: string; points: [string, number][] }
export interface Observed { pivot: string; from: Observable; span: Span; found: Sighting[]; more: number; unread: number }
Card.observed?: Observed;
// src/core/state/shapes.ts
export const isObserved: (x: unknown) => x is Observed;      // times null or /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/; counts null or a count; points [time, count][]
// isCard accepts observed absent or isObserved; cardFields copies it only when present
// src/core/state/types.ts
QueryState.pivot: string | null; QueryState.value: string | null;   // from query.issued: payload.pivot, and payload.bound.value when it is a string
// src/modules/manifests.ts
export type PivotTimes = { kind: "span"; first: string; last: string; count: string | null } | { kind: "points"; at: string; count: string | null };
PivotManifest.times: PivotTimes | null;
// src/modules/observe.ts
export const MAX_SIGHTINGS = 100;
export const MAX_POINTS = 24;
/** A cell as a UTC timestamp with milliseconds, by the three forms of design §5.2; null for anything else. */
export function readTime(v: Json): string | null;
/** What a pivot's result observed, from every row (design §5.3, §5.4). */
export function observe(pivot: PivotManifest, value: string, columns: string[], rows: Json[][], observables: Observables): Observed;
// src/core/state/observed.ts
export const valueKey: (type: string, value: string) => string;         // `${type}|${value}`
export type CardObserved = Observed & { card: string; legacy: boolean };
/** What the card observed: its own `observed`, or the legacy reading (design §5.5). Null for a card with neither, and for a discarded card. */
export function cardObserved(state: CaseState, card: CardState): CardObserved | null;
/** cardObserved of every card that has one, in the order the cards were made (created_seq, then id). */
export function allObserved(state: CaseState): CardObserved[];
```

- [ ] **Step 1: failing tests for `readTime` and `observe`** (`tests/modules/observe.test.ts`). Pivots are plain objects; `observables` is `new Observables([{ id: "address", … }, { id: "domain", … }])` with the sample's patterns.

```ts
test("readTime reads the three forms into UTC with milliseconds", () => {
  for (const [given, want] of [
    ["2026-11-20T03:04:05.123Z", "2026-11-20T03:04:05.123Z"], ["2026-11-20T03:04:05Z", "2026-11-20T03:04:05.000Z"],
    ["2026-11-20T03:04:05+01:00", "2026-11-20T02:04:05.000Z"], ["2026-11-20 03:04:05.123 UTC", "2026-11-20T03:04:05.123Z"],
    ["2026-11-20 03:04:05", "2026-11-20T03:04:05.000Z"], ["2026-11-20 03:04:05.123456 +00:00", "2026-11-20T03:04:05.123Z"],
    ["2026-11-19", "2026-11-19T00:00:00.000Z"],
  ] as const) expect(readTime(given)).toBe(want);
});
test("readTime refuses what it cannot be sure of", () => {
  for (const v of [1763607845, "1763607845", "", "yesterday", "2026-02-30", "2026-11-20 03:04:05 America/Chicago", "2026-11-20T25:00:00Z", null, true, ["2026-11-19"]]) expect(readTime(v as never)).toBeNull();
});
test("a span pivot: rows for one value merge to the earliest first, the latest last and the summed count", () => {
  // columns [name, status, first_seen, last_seen, events]; two rows for a.example.com, one for b.example.com
  expect(o.found).toEqual([
    { type: "domain", value: "a.example.com", first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 7, points: [] },
    { type: "domain", value: "b.example.com", first: "2026-11-18T00:00:00.000Z", last: "2026-11-18T00:00:00.000Z", count: 1, points: [] },
  ]);
  expect(o).toMatchObject({ pivot: "address_to_domains", from: { type: "address", value: "198.51.100.77" }, span: { first: "2026-11-17T01:00:00.000Z", last: "2026-11-19T05:00:00.000Z", count: 8 }, more: 0, unread: 0 });
});
test("a span pivot without a count column has null counts", () => { /* found[0].count === null; span.count === null */ });
test("a points pivot: one point per distinct time, in time order; a row without a count column counts once", () => {
  // three rows for 192.0.2.17 at two times
  expect(o.found[0]).toMatchObject({ first: "2026-11-17T08:00:00.000Z", last: "2026-11-17T09:00:00.000Z", count: 3, points: [["2026-11-17T08:00:00.000Z", 2], ["2026-11-17T09:00:00.000Z", 1]] });
});
test("more than 24 distinct times are merged into 24 slices of the value's own span, counts kept", () => {
  // 48 rows, one a minute from 08:00:00
  expect(o.found[0]!.points.length).toBe(24);
  expect(o.found[0]!.points.reduce((n, p) => n + p[1], 0)).toBe(48);
  expect(o.found[0]!.points[0]).toEqual(["2026-11-17T08:00:00.000Z", 2]);
});
test("values past 100 are counted, not listed; the span still covers every row", () => { /* 130 values: found.length 100, more 30, span.count 130 */ });
test("a time that cannot be read counts the row in unread, keeps the value, adds no time, and throws nothing", () => {
  // first_seen cells: 1763607845, "", "2026-11-20 03:04:05 America/Chicago", and a row whose first is after its last
  expect(o.unread).toBe(4); expect(o.found.map((f) => f.first)).toEqual([null, null, null, null]);
});
test("a declared time column the result does not have makes every row unread", () => { /* unread === rows.length */ });
test("a pivot without times, and an empty result", () => {
  expect(observe(noTimes, "198.51.100.77", ["name"], [["a.example.com"]], observables)).toEqual({ pivot: "p", from: { type: "address", value: "198.51.100.77" }, span: { first: null, last: null, count: null }, found: [{ type: "domain", value: "a.example.com", first: null, last: null, count: null, points: [] }], more: 0, unread: 0 });
  expect(observe(spanPivot, "198.51.100.77", ["name", "first_seen", "last_seen", "events"], [], observables).found).toEqual([]);
});
test("a value that fails its type's pattern, a null and a non-string are not found", () => { /* found is [] */ });
```
- [ ] **Step 2: run, expect FAIL** (`observe.ts` does not exist).
- [ ] **Step 3: implement `src/modules/observe.ts`.** `readTime`: three anchored patterns, the instant from `Date.UTC` with the offset applied, refused unless the fields round-trip (so 30 February is refused), written with `new Date(ms).toISOString()`. `observe`: found values are those of every column `pivot.yields` names, typed by that mapping and kept only when `observables.matches`. A count cell is a non-negative finite number or a string of digits. The 24-slice merge, on whole milliseconds:

```ts
const width = last - first + 1;                                   // ms, first and last as epoch ms of the sighting
const slice = (t: number): number => Math.min(MAX_POINTS - 1, Math.floor(((t - first) * MAX_POINTS) / width));
const startOf = (i: number): number => first + Math.floor((i * width) / MAX_POINTS);
```
- [ ] **Step 4: run, expect PASS.**

- [ ] **Step 5: failing tests for the declaration** (`tests/modules/registry.test.ts`, with the file's `GOOD` root and one pivot line changed each time):

```ts
test("a pivot may declare a span or points, with an optional count", () => {
  expect(load('times: { first: first_seen, last: last_seen, count: events }').pivot("p")!.times).toEqual({ kind: "span", first: "first_seen", last: "last_seen", count: "events" });
  expect(load("times: { at: ts }").pivot("p")!.times).toEqual({ kind: "points", at: "ts", count: null });
  expect(load("").pivot("p")!.times).toBeNull();
});
test("each wrong times declaration is rejected with its reason", () => {
  for (const [times, reason] of [
    ["{ first: a }", 'pivot "p": times needs first and last together, or at alone'],
    ["{ first: a, last: b, at: c }", 'pivot "p": times needs first and last together, or at alone'],
    ["{ first: a, last: a }", 'pivot "p": times names the column "a" twice'],
    ["{ at: name }", 'pivot "p": times column "name" is a yielded value'],
    ["{ at: when }", 'pivot "p": times column "when" is not in its query'],
  ] as const) { /* the pivot is not loaded and the registry's problems hold the reason */ }
});
test("on an http source a times column must be one of the endpoint's columns", () => { /* 'pivot "p": times column "when" is not a column of the endpoint lookup' */ });
```
- [ ] **Step 6: FAIL. Step 7: implement.** `PIVOTS_SCHEMA` gains `times: { type: "object", additionalProperties: false, properties: { first: name, last: name, at: name, count: name } }`. `toPivot` builds `times` and throws the first two errors; the registry's pivot cross-check (beside the `yields` checks, `registry.ts:338-348`) makes the other three. "In its query" is a word match: `new RegExp(`(?<![\\w])${escaped}(?![\\w])`).test(p.query)`. **Step 8: PASS.**

- [ ] **Step 9: failing tests for the card and the fold.**

```ts
// tests/modules/runner.test.ts — add `times: { first: first_seen, last: last_seen }` to a pivot of the file's own root whose stub result has those columns
test("a pivot's card carries what the result observed, from every row, and its event time", async () => {
  // stub outcome: 60 rows
  const c = cardOf(r);
  expect(c.observed!.found.length).toBe(60); expect(c.rows.length).toBe(50);
  expect(c.event_time).toBe(c.observed!.span.first);
});
test("a card from an ad-hoc query has no observed and no event time", async () => { expect("observed" in cardOf(r)).toBe(false); expect(cardOf(r).event_time).toBeNull(); });
// tests/core/state-cards.test.ts
test("a card's observed is kept by the fold; a card without it folds as before; a malformed one is skipped", () => {
  // card("c1", { observed: OBSERVED }), card("c2"), card("c3", { observed: { ...OBSERVED, found: [{ type: "domain", value: "a.example.com", first: "17 Nov", last: null, count: null, points: [] }] } })
  expect(s.cards.c1!.observed).toEqual(OBSERVED); expect("observed" in s.cards.c2!).toBe(false);
  expect(s.cards.c3).toBeUndefined(); expect(s.skipped.map((x) => x.type)).toEqual(["card.created"]);
});
// tests/core/state-observed.test.ts
test("cardObserved is the card's own observed, with its card id", () => { expect(cardObserved(s, s.cards.c1!)).toEqual({ ...OBSERVED, card: "c1", legacy: false }); });
test("a discarded card observes nothing; restored, it does again", () => { /* card.discarded -> null; card.restored -> not null */ });
test("a card recorded before observed is read from its query and its typed preview cells, marked legacy", () => {
  // case.created starting [address 198.51.100.77]; query.issued { pivot: "address_to_domains", bound: { value: "198.51.100.77" }, … }; query.result;
  // card.created card("c1", { query: "q1", columns: ["name", "n"], column_types: ["domain", null], rows: [["a.example.com", 3], ["a.example.com", 1], ["b.example.com", 2]], row_count: 3 })
  expect(cardObserved(s, s.cards.c1!)).toEqual({
    card: "c1", legacy: true, pivot: "address_to_domains", from: { type: "address", value: "198.51.100.77" }, span: { first: null, last: null, count: null },
    found: [{ type: "domain", value: "a.example.com", first: null, last: null, count: null, points: [] }, { type: "domain", value: "b.example.com", first: null, last: null, count: null, points: [] }],
    more: 0, unread: 0,
  });
});
test("the legacy reading types its value from a typed cell of an earlier card, else unknown", () => { /* from.type "domain" when c1 holds it in a domain column; "unknown" otherwise */ });
test("an assessment, a note and a card whose query named no pivot have none", () => { /* null */ });
test("allObserved is in the order the cards were made, and the same for the same state", () => { expect(allObserved(s)).toEqual(allObserved(s)); });
```
- [ ] **Step 10: FAIL. Step 11: implement.** In `issueAndRun` (`runner.ts`, where the card is built): when `pivot !== null`, `const observed = observe(pivot, String(req.bound.value), out.columns, out.rows, deps.observables)`, the card gets `observed` and `event_time: observed.span.first`. The `query.issued` reducer keeps `pivot` (a string or null, else null) and `value`. `cardObserved` uses own-property lookups for `state.queries` and never throws on a malformed legacy card. Add `export * from "./observed"` to `src/core/state/index.ts`. **Step 12: PASS.**

- [ ] **Step 13: the sample.** In `sample/pivots.yaml` change these five (ids, titles, `from`, `to`, `source`, `needs_window`, `empty_means`, `yields` unchanged):

```yaml
  # address_to_internal_peers
    query: "select src as peer, ts from flows where dst = {value} and ts >= {window.from} and ts < {window.to}"
    times: { at: ts }
  # address_to_domains
    query: "select name, min(ts) as first_seen, max(ts) as last_seen, count(*) as events from dns where answer = {value} and ts >= {window.from} and ts < {window.to} group by name order by first_seen, name"
    times: { first: first_seen, last: last_seen, count: events }
  # domain_to_clients
    query: "select client, min(ts) as first_seen, max(ts) as last_seen, count(*) as events from dns where name = {value} and ts >= {window.from} and ts < {window.to} group by client order by first_seen, client"
    times: { first: first_seen, last: last_seen, count: events }
  # asset_to_accounts
    query: "select account, min(ts) as first_seen, max(ts) as last_seen, count(*) as events from signins where host = {value} and ts >= {window.from} and ts < {window.to} group by account order by first_seen, account"
    times: { first: first_seen, last: last_seen, count: events }
  # account_to_signin_addresses
    query: "select from_address, min(ts) as first_seen, max(ts) as last_seen, count(*) as events from signins where account = {value} and ts >= {window.from} and ts < {window.to} group by from_address order by first_seen, from_address"
    times: { first: first_seen, last: last_seen, count: events }
```
Add to `tests/sample/sample.test.ts`:

```ts
test("the sample's windowed pivots give observed times", async () => {
  // runPivot address_to_domains on 198.51.100.77 over the sample window
  expect(c.columns).toEqual(["name", "first_seen", "last_seen", "events"]);
  expect(c.observed!.found.every((f) => f.first !== null && f.last !== null && f.count !== null && f.first <= f.last)).toBe(true);
  expect(c.observed!.unread).toBe(0);
  // runPivot address_to_internal_peers: every sighting has at least one point
});
```
`sample/README.md` gains two sentences on `times` under its pivots heading.
- [ ] **Step 14: the full suite.** `WORKBENCH_REQUIRE_BROWSER=1 timeout 900 bun test`. Tests that assert the exact columns or cells of those five pivots' results get the new columns; a row count, a value found or an order found that changed is a finding to report, not an assertion to edit (the queries keep the same values in the same order). `timeout 300 bun run typecheck`.
- [ ] **Step 15: commit**

```bash
git add src/modules/observe.ts src/modules/manifests.ts src/modules/registry.ts src/modules/runner.ts src/core/types.ts src/core/state/shapes.ts src/core/state/run.ts src/core/state/types.ts src/core/state/index.ts src/core/state/observed.ts sample/pivots.yaml sample/README.md tests/modules/observe.test.ts tests/modules/registry.test.ts tests/modules/runner.test.ts tests/core/state-cards.test.ts tests/core/state-observed.test.ts tests/sample/sample.test.ts
git add <each other test file the sample's new columns changed>
git commit -m "feat: a pivot declares its time columns and the card carries what its result observed"
```

---

### Task 2: The Timeline model and lens

**Files:**
- Create: `src/core/state/timeline.ts`, `src/web/lenses/timeline.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/style.css`, `docs/gui-guide.md` (§5.3, the Timeline line), `tests/web/lenses-simple.test.ts` (the "marked soon" test goes; the shelf text is `Timeline T`)
- Test: `tests/core/state-timeline.test.ts` (new), `tests/web/timeline.test.ts` (new)

**Interfaces:**
- Consumes: `allObserved`, `valueKey`, `CardObserved` (Task 1); `makeS`, `S` (Task 4); `cardChip` (`src/web/chips.ts`); `Open`, `Nav.focusCard`.
- Produces:
```ts
// src/core/state/timeline.ts
export interface TimelineMark { card: string; pivot: string; role: "subject" | "found"; first: string; last: string; count: number | null; points: [string, number][] }
export interface TimelineRow { key: string; type: string; value: string; first: string; last: string; marks: TimelineMark[] }
export interface TimelineModel {
  rows: TimelineRow[];
  /** The axis: the case window widened to what was observed; both null when there is no row. */
  from: string | null; to: string | null;
  window: TimeWindow;
  untimed: number;      // values observed with no time at all
  unread: number;       // rows whose time could not be read, over every card
  legacy: boolean;      // some card was read the legacy way
}
export function timelineOf(state: CaseState): TimelineModel;
// src/web/lenses/timeline.ts
export const TIMELINE_ROWS = 200;
/** x in 0..1000 for a time on the model's axis. An axis of no width is widened by 30 minutes each side. */
export function timelineScale(model: Pick<TimelineModel, "from" | "to">): (ts: string) => number;
export function makeTimeline(ui: Ui, open: Open): View;
```

- [ ] **Step 1: failing model tests** (`tests/core/state-timeline.test.ts`; states built with `EntryBuilder` and `card(id, { observed })`):

```ts
test("one row per value with a time; a mark per card and role; the row spans its marks and adds nothing up", () => {
  // c1: address_to_domains on 198.51.100.77 found a.example.com 17th 01:00 to 19th 05:00, 7 events
  // c2: domain_to_clients on a.example.com, span 18th 00:00 to 20th 00:00, 5 events, found 192.0.2.17
  const row = m.rows.find((r) => r.key === "domain|a.example.com")!;
  expect(row).toMatchObject({ first: "2026-11-17T01:00:00.000Z", last: "2026-11-20T00:00:00.000Z" });
  expect(row.marks.map((k) => [k.card, k.role, k.count])).toEqual([["c1", "found", 7], ["c2", "subject", 5]]);
  expect("count" in row).toBe(false);
});
test("a card with no rows makes no subject mark", () => { /* an empty result's `from` has no row */ });
test("rows are in order of first seen, then type, then value", () => { /* three values, two sharing a first time */ });
test("the axis is the case window widened to what was observed; an open end is ignored", () => {
  // window 2026-11-18T00:00:00.000Z to null; observed 17th 01:00 to 20th 00:00
  expect([m.from, m.to]).toEqual(["2026-11-17T01:00:00.000Z", "2026-11-20T00:00:00.000Z"]);
});
test("values with no time are counted, not listed; unread rows and legacy cards are reported", () => { expect(m).toMatchObject({ untimed: 2, unread: 3, legacy: true }); });
test("a discarded card's marks are gone", () => {});
test("a case with no card, and a state with no case, give an empty model", () => { expect(timelineOf(initial())).toEqual({ rows: [], from: null, to: null, window: { from: null, to: null }, untimed: 0, unread: 0, legacy: false }); });
test("everything at one instant gives an axis of that instant", () => { /* from === to */ });
```
- [ ] **Step 2: FAIL; implement `timelineOf`; PASS.**

- [ ] **Step 3: failing lens tests** (`tests/web/timeline.test.ts`). Unit tests mount the lens alone: `const store = new CaseStore("CASE-1")`, entries from `new EntryBuilder("CASE-1")` pushed with `store.push`, `ui = testUi(win, { ref })`, `nav` an object that records its calls, `v = makeTimeline(ui, { store, nav }); v.update()`.

```ts
test("a row per value: a button with the type and value, and a strip with a mark per card", () => {
  expect(rows().map((r) => r.querySelector(".tl-label")!.textContent)).toEqual(["Address 198.51.100.77", "Domain a.example.com", "Address 192.0.2.17"]);
  const strip = rows()[1]!.querySelector("svg.tl-strip")!;
  expect(strip.namespaceURI).toBe("http://www.w3.org/2000/svg"); expect(strip.getAttribute("viewBox")).toBe("0 0 1000 20");
  expect([...strip.querySelectorAll("g.tl-mark")].map((g) => g.getAttribute("data-card"))).toEqual(["c1", "c2"]);
});
test("a span is a bar from first to last, never narrower than 4; points are bars as tall as their share of the row's largest count", () => {
  expect(Number(bar.getAttribute("x"))).toBeCloseTo(scale("2026-11-17T01:00:00.000Z"), 1);
  expect(Number(instant.getAttribute("width"))).toBe(4);
  expect(pointBars.map((b) => Number(b.getAttribute("height")))).toEqual([18, 9]);     // counts 2 and 1 of a largest 2: 18 × count ÷ largest, at least 2
});
test("the case window is shaded on every strip", () => { /* rect.tl-window x and width from the window's ends on the scale */ });
test("a click on a mark opens its card", () => { click(mark("c2")); expect(calls).toEqual([["focusCard", "c2"]]); });
test("Enter on the row's button opens its detail: a line per mark with the card's chip, its role, the pivot's title, its times and its count", () => {
  expect(detail().map((li) => li.textContent)).toEqual([
    "c1 · found by Names that resolved to the address · 2026-11-17T01:00:00.000Z → 2026-11-19T05:00:00.000Z · 7 events",
    "c2 · subject of Clients that looked the name up · 2026-11-18T00:00:00.000Z → 2026-11-20T00:00:00.000Z · 5 events",
  ]);
  click(detail()[0]!.querySelector(".card-chip")!); expect(calls).toEqual([["focusCard", "c1"]]);
  expect(button.getAttribute("aria-expanded")).toBe("true");
});
test("a pivot the reference no longer names reads by its id", () => { /* "found by address_to_domains" */ });
test("unticking a type hides its rows", () => {});
test("the header shows the two ends of the axis in UTC", () => {});
test("the first 200 rows are drawn and a line says how many more", () => { expect(q(".tl-more").textContent).toBe("37 more values: narrow by type."); });
test("the honest lines appear only when true", () => {
  expect(q(".tl-untimed").textContent).toBe("2 values have no observed time (their pivots declare none); they are in the Graph.");
  expect(q(".tl-unread").textContent).toBe("3 rows had a time that could not be read.");
  expect(q(".tl-legacy").textContent).toBe("Some cards were recorded before times were; their values are in the Graph only.");
});
test("with nothing observed it says so, at entry 0 and in a replay to before the first card", () => {
  expect(q(".empty").textContent).toBe("No card carries an observed time yet. A pivot gives one when its manifest declares times.");
  // store.goTo(1): the same line; store.goTo(null): the rows are back
});
test("a value that looks like markup is text, and a long one is cut in the label and whole in its title", () => {
  // found value "<img src=x onerror=1>" under a type whose pattern admits it; a second value of 300 characters
  expect(v.el.querySelector("img")).toBeNull();
  expect(label.textContent).toContain("<img src=x onerror=1>");
  expect(long.textContent!.length).toBeLessThan(80); expect(long.getAttribute("title")!.length).toBeGreaterThan(300);
});
test("everything at one instant, with an open-ended window, still draws a mark 4 wide", () => { expect(Number(bar.getAttribute("width"))).toBe(4); });
```
And one test on a real page (the `published()` helper of `tests/web/lenses-simple.test.ts`, copied): `p.press("t")` opens a lens with at least one `.tl-row`, and the shelf button reads `Timeline T`.
- [ ] **Step 4: FAIL. Step 5: implement.** Exact copy: the label is `<type title> <value>` (the type's title from `ui.ref.types`, else its id), the value cut at 60 characters with `…`; singulars `1 value has no observed time (its pivot declares none); it is in the Graph.`, `1 row had a time that could not be read.`, `1 more value: narrow by type.`, `1 event`. A mark's `<title>` is its detail line. The marks carry `hidden: true` (they are reached through the detail). The lens repaints when `store.shown` is another object or the filter changes. `LENSES`' entry becomes `{ id: "timeline", key: "t", title: "Timeline", make: (ui, open) => makeTimeline(ui, open) }`; `soon.ts` and the `soon` flag stay for the lenses still to come. `docs/gui-guide.md` §5.3: "**Timeline:** what was observed, on the data's own time axis: a row per value, a mark per card that saw it."
- [ ] **Step 6: PASS; full suite with the browser; typecheck; commit**

```bash
git add src/core/state/timeline.ts src/web/lenses/timeline.ts src/web/lenses/index.ts src/web/style.css docs/gui-guide.md tests/core/state-timeline.test.ts tests/web/timeline.test.ts tests/web/lenses-simple.test.ts
git commit -m "feat(web): the Timeline lens shows what was observed, per value, on the data's own axis"
```

---

### Task 3: The Graph model and its layout

**Files:**
- Create: `src/core/state/graph.ts`, `src/web/graphlayout.ts`
- Test: `tests/core/state-graph.test.ts` (new), `tests/web/graphlayout.test.ts` (new)

**Interfaces:**
- Consumes: `allObserved`, `valueKey` (Task 1).
- Produces:
```ts
// src/core/state/graph.ts
export interface GraphNode { key: string; type: string; value: string; cards: string[]; starting: boolean; more: number }
export interface GraphEdge { key: string; from: string; to: string; via: { pivot: string; card: string }[] }      // key `${from}>${to}`
export interface GraphModel { nodes: GraphNode[]; edges: GraphEdge[]; legacy: boolean }
export function graphOf(state: CaseState): GraphModel;
// src/web/graphlayout.ts
export const GRAPH = { nodes: 60, children: 12, w: 180, h: 26, gapX: 70, gapY: 8, indent: 24, pad: 12, label: 22 } as const;
export interface PlacedNode { key: string; x: number; y: number; layer: number; label: string; more: number }
export interface PlacedEdge { key: string; from: string; to: string; points: [number, number][] }
export interface GraphLayout { nodes: PlacedNode[]; edges: PlacedEdge[]; width: number; height: number; shown: number; of: number }
export function layoutGraph(model: GraphModel, opts: { dir: "wide" | "tall"; types: ReadonlySet<string> | null; focus: string | null }): GraphLayout;
```
`nodes` is in walk order (the order the keyboard moves in). `more` on a placed node is the number of its visible neighbours not placed. `of` is the number of visible nodes.

- [ ] **Step 1: failing tests.**

```ts
// tests/core/state-graph.test.ts
test("the starting values come first, then values in the order cards were made: the value a pivot ran on, then what it found", () => {
  expect(g.nodes.map((n) => n.key)).toEqual(["address|198.51.100.77", "domain|a.example.com", "domain|b.example.com", "address|192.0.2.17"]);
  expect(g.nodes[0]).toMatchObject({ starting: true, cards: ["c1"] });
});
test("an edge from the value a pivot ran on to each value it found, with the pivot and the card", () => {
  expect(g.edges[0]).toEqual({ key: "address|198.51.100.77>domain|a.example.com", from: "address|198.51.100.77", to: "domain|a.example.com", via: [{ pivot: "address_to_domains", card: "c1" }] });
});
test("two cards saying the same link make one edge with both; the two directions are two edges; a value found from itself makes none", () => {
  expect(g.edges.map((e) => [e.key, e.via.map((v) => v.card)])).toEqual([["address|A>address|B", ["c1", "c3"]], ["address|B>address|A", ["c2"]]]);
});
test("a node counts the values its cards could not list", () => { /* observed.more 30 on c1: the node of c1's `from` has more 30 */ });
test("a discarded card's values and links are gone; a starting value stays", () => {});
test("a value holding the key's separator is still one node", () => { /* type "note", value "a|b": one node, key "note|a|b", and an edge to it resolves */ });
test("no case gives no nodes; the same state gives the same model", () => { expect(graphOf(initial())).toEqual({ nodes: [], edges: [], legacy: false }); expect(graphOf(s)).toEqual(graphOf(s)); });
// tests/web/graphlayout.test.ts — models built by hand
test("wide: layers are columns by distance from the starting values; a layer stacks in walk order", () => {
  expect(l.nodes.map((n) => [n.key, n.layer, n.x, n.y])).toEqual([["address|S", 0, 12, 12], ["domain|a", 1, 262, 12], ["domain|b", 1, 262, 46], ["address|c", 2, 512, 12]]);
  expect([l.width, l.height]).toEqual([704, 84]);
});
test("tall: one node a line in the walk tree's depth-first order, indented by layer", () => {
  expect(l.nodes.map((n) => [n.key, n.x, n.y])).toEqual([["address|S", 12, 12], ["domain|a", 36, 46], ["address|c", 60, 80], ["domain|b", 36, 114]]);
});
test("an edge is walked in either direction: a value that found a starting value sits one layer from it", () => {});
test("values no starting value reaches start again at layer 0, first in model order", () => {});
test("a loop ends: A found B and B found A place both once", () => { expect(l.nodes.map((n) => n.key)).toEqual(["address|A", "address|B"]); expect(l.edges.length).toBe(2); });
test("a node places 12 neighbours and counts the rest; they are not made roots", () => { /* a hub with 30 found values: 13 nodes, hub.more 18, shown 13, of 31 */ });
test("at most 60 nodes are placed", () => { /* a chain of hubs: nodes.length 60 */ });
test("focus roots the walk at one node; a filter hides a type and its edges", () => {});
test("an edge is drawn only between placed nodes; its points are whole numbers of at most two decimals", () => {});
test("a label is cut at 22 characters with an ellipsis", () => { expect(l.nodes[0]!.label).toBe("aaaaaaaaaaaaaaaaaaaaaa…"); });
test("a new card adds nodes without moving the nodes of earlier layers", () => { /* layout before and after one more card: every earlier node of layers 0 and 1 has the same x and y */ });
test("the same model and options give the same layout", () => { expect(layoutGraph(m, o)).toEqual(layoutGraph(m, o)); });
```
- [ ] **Step 2: FAIL. Step 3: implement.** `graphOf` keeps nodes and edges in `Map`s keyed by `valueKey` so a value holding `|` cannot collide with a split. The walk (design §8.1), which the tests alone do not fix:

```ts
// queue = roots (starting values that are visible, in model order; or [focus]); placed = [...roots]
// take the first of the queue; its neighbours are the other ends of its visible edges, in model node order;
//   for each neighbour not yet seen: if this node has placed fewer than 12 children and fewer than 60 nodes are placed,
//   place it (layer + 1, parent = this node) and queue it; otherwise mark it passed-over.
// when the queue is empty: the first visible node in model order that is neither placed nor passed-over becomes a root (layer 0); repeat.
```
Coordinates: wide `x = pad + layer × (w + gapX)`, `y = pad + indexInLayer × (h + gapY)`; tall `x = pad + layer × indent`, `y = pad + line × (h + gapY)`. Width and height reach the furthest node plus `pad`. Edge points, wide: from the right-middle of the node in the lower layer to the left-middle of the other; two nodes of one layer join right-middle to right-middle through `x + 16`. Tall: `(from.x + 8, from.y + h)`, `(from.x + 8, to.y + h / 2)`, `(to.x, to.y + h / 2)`. **Step 4: PASS; typecheck; commit**

```bash
git add src/core/state/graph.ts src/web/graphlayout.ts tests/core/state-graph.test.ts tests/web/graphlayout.test.ts
git commit -m "feat: the graph of observed values from the fold, and a layered layout that is the same every time"
```

---

### Task 4: The SVG builder

**Files:**
- Create: `src/web/svg.ts`
- Modify: `tests/web/lint.test.ts`
- Test: `tests/web/svg.test.ts` (new)

**Interfaces (Produces):**
```ts
export type SChild = Node | string | number | null | undefined | false | SChild[];
export interface SProps {
  class?: string; id?: string; role?: string; name?: string; tabindex?: number; hidden?: boolean;      // name → aria-label; hidden → aria-hidden="true"
  x?: number; y?: number; width?: number; height?: number; cx?: number; cy?: number; r?: number; rx?: number; x1?: number; y1?: number; x2?: number; y2?: number;
  viewBox?: [number, number, number, number]; points?: [number, number][]; translate?: [number, number];
  anchor?: "start" | "middle" | "end"; stretch?: boolean;                                            // text-anchor; preserveAspectRatio="none"
  data?: Record<string, string>; aria?: Record<string, string>; on?: Record<string, (event: Event) => void>;
}
export type S = (tag: string, props?: SProps | null, ...children: SChild[]) => SVGElement;
export const SVG_TAGS: readonly string[];      // svg, g, line, rect, circle, path, text, title
export function makeS(doc: Document): S;
```

- [ ] **Step 1: failing tests** (`tests/web/svg.test.ts`, a happy-dom `Window`):

```ts
test("elements are in the SVG namespace and text goes in as text nodes", () => {
  const el = s("text", { x: 1, y: 2 }, "<b>x</b>", 3);
  expect(el.namespaceURI).toBe("http://www.w3.org/2000/svg"); expect(el.childNodes.length).toBe(2); expect(el.querySelector("b")).toBeNull(); expect(el.textContent).toBe("<b>x</b>3");
});
test("a tag outside the list throws", () => { for (const t of ["script", "foreignObject", "a", "use", "image", "style", "div"]) expect(() => s(t)).toThrow(`s: tag not allowed: ${t}`); });
test("a prop outside the list throws", () => { for (const k of ["style", "href", "d", "fill", "stroke", "onclick", "xlink:href"]) expect(() => s("g", { [k]: "x" } as never)).toThrow(`s: prop not allowed: ${k}`); });
test("a number attribute must be a finite number and is written with at most two decimals", () => {
  expect(s("rect", { x: 1.23456, width: 10 }).getAttribute("x")).toBe("1.23");
  for (const v of [Number.NaN, Infinity, "5" as never, null as never]) expect(() => s("rect", { x: v })).toThrow("s: x must be a finite number");
});
test("viewBox, translate, anchor and stretch are built from their parts", () => {
  const el = s("svg", { viewBox: [0, 0, 1000, 20], stretch: true });
  expect(el.getAttribute("viewBox")).toBe("0 0 1000 20"); expect(el.getAttribute("preserveAspectRatio")).toBe("none");
  expect(s("g", { translate: [1.5, 2] }).getAttribute("transform")).toBe("translate(1.5 2)");
  expect(s("text", { anchor: "middle" }).getAttribute("text-anchor")).toBe("middle"); expect(() => s("text", { anchor: "left" as never })).toThrow();
});
test("points become a path's d and are refused on any other tag", () => {
  expect(s("path", { points: [[0, 0], [10, 5.555]] }).getAttribute("d")).toBe("M 0 0 L 10 5.56"); expect(() => s("line", { points: [[0, 0]] })).toThrow("s: points is for path only");
});
test("name, hidden, role, tabindex, data and aria are written as on the HTML helper; a name starting on is refused", () => {
  const el = s("g", { name: "Address 198.51.100.77", hidden: true, role: "button", tabindex: -1, data: { key: "a|b" }, aria: { expanded: "false" } });
  expect([el.getAttribute("aria-label"), el.getAttribute("aria-hidden"), el.getAttribute("tabindex"), el.getAttribute("data-key")]).toEqual(["Address 198.51.100.77", "true", "-1", "a|b"]);
  expect(() => s("g", { data: { onclick: "x" } })).toThrow(); expect(() => s("g", { aria: { "bad name": "x" } })).toThrow();
});
test("a listener must be a function and is called", () => {});
test("an attribute value that looks like markup stays an attribute value", () => { expect(s("g", { name: '"><script>' }).outerHTML).not.toContain("<script>"); });
```
In `tests/web/lint.test.ts`: `svg.ts` joins `dom.ts` for `setAttribute` and `createElement` only (not `href or src`), and a new test:

```ts
test("the svg helper writes attribute names from a fixed list, none starting with on", () => {
  const text = code(readFileSync(join(WEB, "svg.ts"), "utf8"));
  const names = [...text.matchAll(/setAttribute\(\s*"([^"]+)"/g)].map((m) => m[1]!);
  expect(names.length).toBeGreaterThan(0);
  expect(names.filter((n) => /^on/i.test(n))).toEqual([]);
  expect(text).not.toMatch(/\bstyle\b|href/);
});
```
- [ ] **Step 2: FAIL. Step 3: implement** `makeS` with `doc.createElementNS("http://www.w3.org/2000/svg", tag)`. Number attributes are written by one helper that takes the attribute name from a constant list, so every `setAttribute` either has a literal name or goes through that list; `data-` and `aria-` names use `dom.ts`'s rule (`/^[a-z][a-z0-9-]*$/`, not starting `on`). **Step 4: PASS (`svg.test.ts`, `lint.test.ts`, `tests/core/browser-safety.test.ts`); typecheck; commit**

```bash
git add src/web/svg.ts tests/web/svg.test.ts tests/web/lint.test.ts
git commit -m "feat(web): an SVG builder with fixed tags and attributes, held to the page's injection rules"
```

---

### Task 5: The Graph lens

**Files:**
- Create: `src/web/lenses/graph.ts`
- Modify: `src/web/belongs.ts`, `src/web/app.ts` (`LensId` gains `"graph"`), `src/web/keys.ts` (`LENS_KEYS` gains `["g", "graph", "Graph"]` after Timeline), `src/web/commands.ts` (its `LENSES` list), `src/web/views/workarea.ts` (the lens-key list at line 302), `src/web/lenses/index.ts` (after Timeline), `src/web/style.css`, `docs/gui-guide.md` (§5.3, the Graph line)
- Test: `tests/web/graph.test.ts` (new), `tests/web/playbook.test.ts`, `tests/web/keys.test.ts`, `tests/web/commands.test.ts`

**Interfaces:**
- Consumes: `graphOf`, `GraphModel` (Task 3); `layoutGraph`, `GRAPH` (Task 3); `makeS` (Task 4); `belongsVerdict` (`src/web/belongs.ts`); `BELONGS_ID`; `Nav.focusCard`, `Nav.pivot`; `ui.prefs.get("dock", "bottom")`.
- Produces:
```ts
// src/web/belongs.ts
/** For each value "does it belong?" has finished on: the verdict of its newest run (by started_seq), keyed by valueKey. A running run gives none. */
export function belongsByValue(state: Pick<CaseState, "playbooks" | "cards">, ref: Pick<Reference, "pivots" | "inventories">): Map<string, { verdict: Verdict; text: string }>;
// src/web/lenses/graph.ts
export function makeGraph(ui: Ui, open: Open): View;
```

- [ ] **Step 1: failing tests.** `belongsByValue` in `tests/web/playbook.test.ts`: two finished runs on one address give the newer one's verdict; a running run and a run of another playbook give nothing. The lens in `tests/web/graph.test.ts`, mounted alone as in Task 2 Step 3:

```ts
test("a node per value with its type's title and its value, placed where the layout says", () => {
  const n = node("domain|a.example.com");
  expect(n.getAttribute("role")).toBe("button"); expect(n.getAttribute("transform")).toBe("translate(262 12)");
  expect([...n.querySelectorAll("text")].map((t) => t.textContent)).toEqual(["Domain", "a.example.com"]);
  expect(n.getAttribute("aria-label")).toBe("Domain a.example.com, 2 cards");
});
test("an edge is a path between its two nodes with a tooltip naming the pivot and the cards", () => { expect(edge.querySelector("title")!.textContent).toBe("Names that resolved to the address · c1"); });
test("selecting a node fills the detail: its cards, its links both ways, Pivot… and Focus", () => {
  click(node("domain|a.example.com"));
  expect(detail.querySelector("h3")!.textContent).toBe("Domain a.example.com");
  expect([...detail.querySelectorAll(".node-cards .card-chip")].map((b) => b.textContent)).toEqual(["c1", "c2"]);
  expect([...detail.querySelectorAll(".node-links li")].map((li) => li.textContent)).toEqual([
    "← Address 198.51.100.77 · Names that resolved to the address · c1", "→ Address 192.0.2.17 · Clients that looked the name up · c2",
  ]);
  click(detail.querySelector('[data-action="pivot"]')!); expect(calls).toEqual([["pivot", "c2", [{ type: "domain", value: "a.example.com" }]]]);
});
test("the selected node's edges carry the pivot's title as a label; no other edge does", () => {});
test("a card chip opens the card; a linked value's button focuses the graph on it", () => { /* header reads "Showing 3 of 4 values" and has a "Whole graph" button, which restores "Showing 4 of 4 values" */ });
test("the drawing is one tab stop; arrows move between nodes in layout order; Enter selects", () => {
  expect(all("g.node").filter((n) => n.getAttribute("tabindex") === "0").length).toBe(1);
  key(node("address|198.51.100.77"), "ArrowRight"); expect(doc.activeElement).toBe(node("domain|a.example.com"));
  key(doc.activeElement!, "End"); key(doc.activeElement!, "Enter"); expect(detail.querySelector("h3")!.textContent).toBe("Address 192.0.2.17");
});
test("a value 'does it belong?' has finished on carries its verdict, in a glyph and in words", () => {
  expect(n.querySelector("text.belongs")!.textContent).toBe("✗"); expect(n.classList.contains("belongs-proven")).toBe(true);
  expect(n.getAttribute("aria-label")).toBe("Address 198.51.100.77, 1 card, Not a known asset: proven for internal hosts");
  // selected: the detail's .belongs-verdict has the same words
});
test("the four verdicts have four glyph-and-class pairs", () => { /* known ✓ belongs-known; proven ✗ belongs-proven; not seen ? belongs-not-seen; could not tell ? belongs-unknown */ });
test("a type's checkbox hides its nodes and their edges", () => {});
test("a hub shows 12 of its neighbours and a +N badge; its detail lists every link", () => {
  expect(node("address|hub").querySelector("text.more")!.textContent).toBe("+18"); expect(header.textContent).toContain("Showing 13 of 31 values");
  click(node("address|hub")); expect(detail.querySelectorAll(".node-links li").length).toBe(30);
});
test("a node whose cards hold more values than they list says so", () => { expect(detail.querySelector(".node-more")!.textContent).toBe("Its cards hold 30 more values than they list."); });
test("docked right the layout is tall; docked at the bottom it is wide; a change of dock lays it out again", () => { /* ui.prefs.set("dock", "right"); v.update(): node x is 36, not 262 */ });
test("in replay Pivot… is disabled and says why; so it is for a starting value no card holds", () => {
  expect(pivot.disabled).toBe(true); expect(pivot.title).toBe("Return to live to pivot");      // store.goTo(n)
  expect(pivot.title).toBe("No card holds this value yet");
});
test("with no card the starting values are drawn and a line says nothing links them; at entry 0 there is only the line", () => { expect(q(".empty").textContent).toBe("No lookup has linked these yet."); });
test("a case read the legacy way says so", () => { expect(q(".graph-legacy").textContent).toBe("Some cards were recorded before links were; their links are read from the first 50 rows."); });
test("a value that looks like markup is text; a long one is cut in the node and whole in its name", () => { expect(v.el.querySelector("img")).toBeNull(); });
test("the selection survives a new entry and is dropped when its node is gone", () => {});
```
`tests/web/keys.test.ts` and `tests/web/commands.test.ts`: `g` and `open graph` open the lens; the shelf button reads `Graph G`.
- [ ] **Step 2: FAIL. Step 3: implement.** Structure: `div.lens.lens-graph[name=Graph]` holding a header (type checkboxes, `span.graph-count` "Showing X of Y values", the `Whole graph` button in focus mode), `div.graph-scroll` with one `svg` (its `width`, `height` and `viewBox` from the layout), and `aside.graph-detail`. A node is `g.node` with `translate`, a `rect` (`rx: 6`), `text.node-type`, `text.node-value`, optional `text.belongs` and `text.more`, and a `title` holding the whole value; its classes are `node`, `t0`…`t7` (the type's index in the sorted types present, modulo 8), `selected`, `starting`, and the verdict class. An edge is `g.edge` with a `path` (the layout's `points`), a `circle.edge-end` (`r: 3`) at its last point, a `title`, and for the selected node's edges a `text.edge-label` at the middle point. The verdict's glyph and class: `known` ✓ `belongs-known`; `not known: proven` ✗ `belongs-proven`; `not seen` ? `belongs-not-seen`; `could not tell` ? `belongs-unknown`. Accessible name: `<type title> <value>, <n> card(s)`, then `, <verdict text>`, then `, <more> more linked values not drawn`. A link line is `<arrow> <type title> <value> · <pivot title> · <card ids joined by ", ">`, the value being a button with `data-action="focus"`. Pivot… calls `nav.pivot(<the node's last card>, [{ type, value }])`. The model and layout are recomputed when `store.shown`, the dock, the filter or the focus changes. `docs/gui-guide.md` §5.3: "**Graph:** observed values as nodes, the pivots that found one from another as edges, each with its cards; a node shows its cards, its links, its "does it belong?" verdict and Pivot…; nodes are clickable and keyboard-reachable. A tall layout when docked right."
- [ ] **Step 4: PASS; full suite with the browser; typecheck; commit**

```bash
git add src/web/lenses/graph.ts src/web/belongs.ts src/web/app.ts src/web/keys.ts src/web/commands.ts src/web/views/workarea.ts src/web/lenses/index.ts src/web/style.css docs/gui-guide.md tests/web/graph.test.ts tests/web/playbook.test.ts tests/web/keys.test.ts tests/web/commands.test.ts
git commit -m "feat(web): the Graph lens: observed values linked by the pivots that found them"
```

---

### Task 6: Acceptance and the documents

**Files:**
- Create: `tests/sample/observed-acceptance.test.ts`
- Modify: `README.md`, `docs/gui-guide.md` (§4's shelf line and §5.2's lens keys, if either no longer matches the shelf), `docs/security-notes.md`

- [ ] **Step 1: the acceptance test** (passes on the finished branch; if it fails, the failure is a finding for the task that owns the code):

```ts
test("after a playbook on the sample every pivot card says what it observed, the models replay exactly, and the record verifies", async () => {
  // sampleRoot(dir); a case on 203.0.113.30; run playbook address-triage; wait for the job
  const entries = session.entries();
  for (const c of Object.values(session.state.cards).filter((c) => c.kind === "result")) expect(c.observed).toBeDefined();
  // live is the state as each entry arrived; replay is the browser store's fold to that entry from its nearest snapshot
  const store = new CaseStore(session.id);
  let live = initial();
  for (const e of entries) {
    live = apply(live, e); store.push(e);
    expect(timelineOf(store.stateAt(e.seq))).toEqual(timelineOf(live));
    expect(graphOf(store.stateAt(e.seq))).toEqual(graphOf(live));
  }
  for (const n of [0, 1, Math.floor(entries.length / 2)]) expect(graphOf(store.stateAt(n))).toEqual(graphOf(fold(entries, n)));
  const g = graphOf(session.state);
  expect(g.nodes[0]).toMatchObject({ key: "address|203.0.113.30", starting: true });
  expect(g.edges.every((e) => e.via.every((v) => Object.hasOwn(session.state.cards, v.card)))).toBe(true);
  expect(timelineOf(session.state).rows.length).toBeGreaterThan(0);
  expect(session.state.skipped).toEqual([]);
  // verify(case) reports ok
});
test("a time on the Timeline is a cell of the card that says it", async () => {
  // the sample's results are under 50 rows, so the card's preview holds every row:
  // for each row's `found` marks, the card's row for that value has the mark's `first` in its first_seen (or ts) column
});
```
- [ ] **Step 2: documents.** `README.md`: a short section "What was observed" (the `times` line with both shapes, what a card carries, the two lenses, the two caps, and that editing a pivots file changes the hash of every pivot in it). `docs/security-notes.md`: one paragraph on `svg.ts` (fixed tags and attributes, no style, no caller-written path data, covered by the lint test) and one on `observed` (derived from a result already in custody, bounded, as strict as its card). Check `docs/gui-guide.md` §4 and §5.2 against the shelf: Graph is `G`.
- [ ] **Step 3: hygiene.** Run the repository's hygiene test (`timeout 120 bun test tests/repo/hygiene.test.ts`). The controller runs it again with the owner's private terms before the branch is called done.
- [ ] **Step 4: full suite with the browser; typecheck; commit**

```bash
git add tests/sample/observed-acceptance.test.ts README.md docs/gui-guide.md docs/security-notes.md
git commit -m "test: observed times and links on the sample replay exactly and verify; docs for the Timeline and the Graph"
```

---

### Task 7: The owner's root (the controller's checklist; nothing here is committed)

Done by the controller in `~/workbench-lake/root/pivots.yaml` and again in `~/workbench-lake/root-dev/pivots.yaml`, between cases: editing the file changes the hash of every pivot in it, so earlier answers are not reused and a plan accepted earlier is blocked. No name from those files goes into the repository, a commit message or a report.

The file holds nine pivots today, all windowed aggregates capped at 50 rows.

- [ ] **The two that already return a first time, a last time and a count** (the two that read the Wi-Fi controller's events): add one line to each, naming the three columns its `select` already aliases:

```yaml
    times: { first: <first-time alias>, last: <last-time alias>, count: <count alias> }
```
- [ ] **The seven that return a count only:** in each, add to the `select`, after the count, the earliest and latest of the time column its own `where` already filters on, and add the `times` line:

```yaml
    query: "select <value column>, count(*) as <count alias>, min(<time column>) as first_seen, max(<time column>) as last_seen from <table> where <time column> >= {window.from} and <time column> < {window.to} and … group by <value column> order by <count alias> desc limit 50"
    times: { first: first_seen, last: last_seen, count: <count alias> }
```
Leave `yields`, `order by` and `limit` as they are. The one that also returns a highest level, and the one that also returns a distinct count, keep those columns.
- [ ] **Check each edited file loads:** `bun run preflight --config ~/workbench-lake/config.yaml` (and `config-dev.yaml`): no pivot is rejected; a rejection names the pivot and the `times` column at fault. The guard checks the new text as it checks any pivot.
- [ ] **One lookup by hand in the dev case folder** (`config-dev.yaml`, port 4748): run one edited pivot from the Pivot panel on a known address; open the card and check its rows show `first_seen` and `last_seen`; press `T` and check the value has a row whose ends match those cells; press `G` and check the address links to what the card found. If the Timeline line reads "N rows had a time that could not be read", copy one such cell's *shape* (not its value) into the 6b ledger: `readTime` needs that form.
- [ ] **Later, when a value is worth watching:** a second pivot on the same table in the points shape, grouped by the value and `date_trunc('hour', <time column>)`, with `times: { at: <hour alias>, count: <count alias> }`. Not needed for the first case.
- [ ] **Record in the 6b ledger** which files were edited and that both preflights pass. No names.

---

## Hand-back

When Task 6 is committed: the full suite with the browser and the typecheck pass on a quiet machine; the whole-branch review reads the range from `683a49a`; the controller runs the hygiene scan with the private terms, then Task 7, then one dev case to the publish gate with both lenses open. What to look for in that case: the Timeline's rows for the starting address agree with the cards' cells, the Graph's first layer is what the triage playbook found, and Evaluate no longer says a cited card was not provided.
