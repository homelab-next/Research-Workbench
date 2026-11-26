# Playbooks and "Does it belong?" (6a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lookups run from a written playbook in the background with no model call and full custody; an inventory answers "does it belong?" and says what the answer proves; the run stops for reasons a person can read; the Timeline lens becomes the Worklog.

**Architecture:** A playbook is a new manifest kind whose steps name existing pivots. A small runner (`src/modules/playbook-run.ts`) walks it, sending every lookup through `runQuery` with purpose `playbook` and reusing an identical answered query first. The person starts one with a command that returns at once and runs the lookups under `hub.background`; the planner may offer one as a single plan step, which Research runs in code with no researcher. An inventory is a second new manifest kind that pivots point at; it decides what an empty answer means. Task 0 fixes what CASE-1 showed.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun test`, happy-dom for interface tests. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-11-26-slice-6a-playbooks-design.md`](../specs/2026-11-26-slice-6a-playbooks-design.md) ("the design"; §n means its section n). It builds on [`2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md) ("the slice design"). Branch `slice-6a-playbooks`, from `77750e4` (about 2100 tests). Evidence for Task 0: `.superpowers/sdd/2026-11-23-slice-5-real-run/progress.md` and its `task-7` to `task-17` files.

## Global Constraints

- **One custody point.** No code in this plan calls a connector. Every lookup goes through `runPivot` / `runQuery` (`src/modules/pivots.ts`, `src/modules/runner.ts`).
- **Nothing slow in the case queue.** A command's `perform` checks, writes the job's first entries and returns; lookups run under `hub.background`.
- **A playbook never spends a budget, passes a gate, keeps a card or accepts a proposal.** Its actor is the person who started it or `{ kind: "system", id: "playbook" }`; never an agent.
- **Honest negatives.** Partial, failed, refused and waiting-for-budget are never "empty". An inventory's empty answer is `proven-negative` only when the inventory is `complete`.
- **Trusted roots only** for `playbook` and `inventory` manifests.
- **The real environment stays out of the repository.** No host, address, account, schema or table name of the owner's in any file, test, commit message or task report. Tests use the sample's names, loopback and RFC 5737 addresses, and `example.*` domains. Task 10 uses placeholders in angle brackets.
- **No test, script or `preflight` contacts a real source.** Model and source stand-ins only (`tests/helpers/model-standin.ts`, `trino-standin.ts`, `http-standin.ts`).
- **The fold never throws and never mutates its input.** A new entry type gets a reducer branch that validates shape and records a malformed payload in `skipped`. A field added to an existing payload is optional, and an entry without it folds as it did.
- **Exact values from the design:** at most 12 steps a playbook; `max_values` default 5, at most 20; at most 50 lookups a run; `new-root` stage defaults as in the design §9 row 1; fit rule `max_output_tokens + floor(slot × 0.5) ≤ slot` where `slot = floor(context ÷ parallel)`.
- **Tests:** `timeout 120 bun test <file>` while iterating; `timeout 900 bun test && timeout 300 bun run typecheck` before each commit, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. Every test makes its files under a fresh `mkdtempSync` directory and removes it, closes what it opens, and asserts `session.state.skipped` is `[]` when it drives a session. Report real RED: the failing run of the new tests, made before the implementation.
- **Commits:** on `slice-6a-playbooks`, never pushed; `git add` by explicit path (other tasks may have uncommitted work in the tree). End every commit message with the attribution lines your own harness reminder gives you.
- **A test outside your task's Files that your change breaks:** fix it if no task running beside yours lists that file; otherwise report it and leave it.

## What can run in parallel

Tasks in one wave touch disjoint files. A wave starts when the one before it is committed.

| Wave | Tasks |
|---|---|
| 1 | **Task 0** (hardening) ∥ **Task 1** (playbook manifest) ∥ **Task 7** (Worklog) |
| 2 | **Task 2** (the record and the runner) |
| 3 | **Task 3** (person start) |
| 4 | **Task 4** (planner step) ∥ **Task 5** (inventory) ∥ **Task 9** (fast model; may be left for 6b) |
| 5 | **Task 6** (interface) |
| 6 | **Task 8** (acceptance and documents) |
| after | **Task 10** (the owner's root; the controller, outside the repository) |

`src/core/types.ts` and `src/core/state/` are changed only by Task 0 (part G) and Task 2. Task 2 adds every core type the later tasks need, so waves 4 and 5 never touch them.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/modules/playbooks.ts` (new) | The playbook manifest: types, schema, parsing `from`/`when`, cost, lookup ceiling | 1 |
| `src/modules/manifests.ts`, `registry.ts` | Load and cross-check `playbook` (1) and `inventory` (5); `PivotManifest.inventory` (5) | 1, 5 |
| `sample/playbooks/address-triage.yaml` (new) | The sample playbook | 1 |
| `src/core/types.ts`, `src/core/state/playbooks.ts` (new), `state/run.ts`, `state/types.ts`, `state/index.ts`, `state/apply.ts` | Purpose `playbook`, job kind, three entry types and their fold, `PlanStep.playbook`, `query.issued.inventory` | 2 |
| `src/modules/playbook-run.ts` (new) | `beginPlaybook`, `runPlaybook`: the walk, reuse, limits, outcome | 2 |
| `src/modules/runner.ts`, `pivots.ts`, `reuse.ts` | `purpose` on the input; reuse counts answer purposes (2); inventory wording and record (5) | 2, 5 |
| `src/server/playbook-commands.ts` (new) | `run_playbook` (3), `check_belongs` (5) | 3, 5 |
| `src/core/wire.ts`, `src/server/views.ts` | `Reference.playbooks` (3), `Reference.inventories`, `PivotView.inventory` (5) | 3, 5 |
| `src/pipeline/plans.ts`, `stages/plan.ts`, `stages/research.ts`, `src/agents/tools/` | A playbook sub-goal, `list_playbooks`, Research runs it in code | 4 |
| `src/modules/inventories.ts` (new), `sample/inventories/*.yaml` (new) | The inventory manifest; the on-the-spot `does-it-belong` playbook | 5 |
| `src/web/panels/playbook.ts` (new), `src/web/belongs.ts` (new), `panels/pivot.ts`, `commands.ts`, `describe.ts`, `lenses/steps.ts`, `trail.ts` | Start and follow a playbook; the verdict; the command-bar verb | 6 |
| `src/web/lenses/worklog.ts`, `lenses/soon.ts` (new), `lenses/index.ts`; `lenses/timeline.ts` deleted | The merged Worklog; the Timeline placeholder | 7 |
| `src/agents/pack.ts`, `providers/`, `pipeline/stages/agent.ts`, `cli/preflight.ts`, `scripts/new-root.ts`, `modules/connectors/http.ts`, `trino.ts`, `web/derive.ts`, `web/views/brief.ts`, `agents/draft.ts`, `pipeline/stages/assemble.ts`, `stages/research.ts` | Hardening | 0 |
| `src/agents/loop.ts`, `pipeline/manifests.ts`, `stages/agent.ts`, `cli/preflight.ts` | `fast_model` | 9 |
| `README.md`, `docs/gui-guide.md`, `docs/security-notes.md`, `tests/sample/playbook-custody.test.ts` (new) | Documents and the custody acceptance test | 7, 8 |

## Review Focus

Failure modes the design implies and a person is likely to meet. Each has its test in the task named.

1. **The server stops while a playbook is running.** Expected: after restart the job reads failed and the playbook reads interrupted, not running; starting it again sends only the lookups that had no full answer. (Task 2, test "an interrupted playbook…")
2. **The person presses "Run playbook" twice.** Expected: the second press is refused in words while the first is running; no lookup is sent twice. (Task 3, test "a second start…")
3. **The owner edits a playbook file between accepting a plan and Research.** Expected: the step is not run under the old acceptance; it finishes `blocked` saying the playbook changed. (Task 4, test "a playbook changed since the plan…")
4. **A step finds more values than `max_values`, or the run reaches 50 lookups.** Expected: it stops there, and the step's entry, the run's caveats and the panel all say how many values were not followed. (Task 2 test "the fan-out cap…"; Task 6 test "the trail says…")
5. **An inventory that is not declared complete returns nothing.** Expected: nowhere does the screen, the card, the sub-goal rule or the verdict call it a proven negative. (Task 5 test "an incomplete inventory…"; Task 6 test "the verdict…")

---

### Task 0: Hardening from CASE-1

Eight parts, one commit each, in this order. Parts A to D are the model and connectors; E is the interface; F to H are small.

**Files:**
- Modify: `src/agents/pack.ts`, `src/agents/providers/types.ts`, `providers/local.ts`, `providers/index.ts`, `providers/scripted.ts`, `src/agents/loop.ts` (pass `cause` through only), `src/pipeline/stages/agent.ts`, `src/cli/preflight.ts`, `scripts/new-root.ts`, `src/modules/connectors/http.ts`, `src/modules/connectors/trino.ts`, `src/web/derive.ts`, `src/web/views/brief.ts`, `src/agents/draft.ts`, `src/pipeline/stages/assemble.ts`, `src/pipeline/stages/research.ts`, `src/core/types.ts`, `src/core/state/run.ts`, `src/core/state/types.ts`, `sample/context/schemas/assemble-output.yaml`, `sample/context/standards/icd203.yaml`, `README.md` ("Before a run")
- Test: `tests/agents/pack.test.ts`, `tests/agents/local.test.ts`, `tests/pipeline/stage-agent.test.ts`, `tests/cli/preflight.test.ts`, `tests/cli/new-root.test.ts`, `tests/modules/connector-http.test.ts`, `tests/modules/connector-trino.test.ts`, `tests/web/derive.test.ts`, `tests/web/workarea.test.ts`, `tests/agents/draft.test.ts`, `tests/pipeline/stages-analysis.test.ts`, `tests/pipeline/stages-front.test.ts`, `tests/core/state-run.test.ts`, `tests/server/commands.test.ts`

**Interfaces (Produces):**
- `src/agents/pack.ts`: `slotContext(context: number, parallel: number | null): number` (`floor(context / max(1, parallel ?? 1))`); `maxReply(slot: number): number` (`slot - floor(slot * PACK_SHARE)`); `fitProblem(slot: number, cap: number): string | null`, null when `cap <= maxReply(slot)`, else exactly `` `a reply of up to ${cap} tokens does not fit beside this stage's context in the ${slot} tokens each request has; set max_output_tokens to ${maxReply(slot)} or less, or load the model with a larger context in one slot` ``.
- `ModelInfo` gains `parallel: number | null`. A local model manifest gains `parallel` (integer, 1 to 64); `LocalOptions.parallel?: number`. `LocalProvider.models()` reports the manifest's value, or null when it gives none; the scripted provider reports null.
- `TurnResult` error and `AgentEnd` error gain `cause?: "context"`.
- `resolveAgent(...)` returns `context` as the per-request context: `slotContext(info.context ?? DEFAULT_CONTEXT, info.parallel)`.
- `src/web/derive.ts`: `StageMark` gains `"sent back"`; `sentBack(state: CaseState, stage: StageState): { draft: number; by: string } | null`; `briefButtons(state: CaseState): { run: ReturnType<typeof runButton> | null; next: NextThing | null }`.
- `StandardTerms` gains `first_change: string` (`change_terms[0]`; `termsOf` returns null for an empty list). `composeChange(kind: string, detail: string, first: string): string`. `firstJudgmentOnly(schema: Schema, first: string): Schema`. New `changeKinds(schema: Schema, terms: readonly string[]): Schema` in `assemble.ts`, which sets `properties.change_kind.enum` to `terms`. `FIRST_JUDGMENT` is removed.
- `Payloads["job.started"]` gains `subgoal?: string | null` and `request?: number | null`; `JobState` gains `subgoal: string | null` and `request: number | null` (absent in an entry: null).

#### Part A: the per-request context and the fit rule

- [ ] **Step 1: Write the failing tests**

`tests/agents/pack.test.ts`:
```ts
test("the per-request context is the loaded context shared between the slots", () => {
  expect(slotContext(131072, null)).toBe(131072);
  expect(slotContext(131072, 2)).toBe(65536);
  expect(maxReply(65536)).toBe(32768);
});
test("a reply cap fits only while it leaves the pack its half", () => {
  expect(fitProblem(131072, 65536)).toBeNull();
  expect(fitProblem(65536, 65536)).toBe("a reply of up to 65536 tokens does not fit beside this stage's context in the 65536 tokens each request has; set max_output_tokens to 32768 or less, or load the model with a larger context in one slot");
});
```
`tests/pipeline/stage-agent.test.ts`: `test("a stage whose reply cap does not fit the per-request context stalls before any model call", ...)`: a local provider (model stand-in) whose manifest has `context: 65536`, `parallel: 2`, `max_output_tokens: 32768`; `stageAgent` returns `{ kind: "stalled" }` whose reason contains `"in the 32768 tokens each request has"`; the stand-in received no chat request; no `model.request` entry.
`tests/cli/preflight.test.ts`: `test("preflight fails a stage whose reply cap does not fit, and names the cap that does", ...)`: same manifest; a check named `"context fit"` at level `fail` whose detail starts with the stage id and contains `"16384 or less"`. `test("preflight's question is sized to the per-request context the manifest claims", ...)`: `context: 65536`, `parallel: 1`; the stand-in's received body has `max_tokens === 65536 - 2048`.

- [ ] **Step 2: Run them; expect FAIL** (`slotContext` is not exported; no check named "context fit")
- [ ] **Step 3: Implement.** In `stageAgent`, after `resolveAgent` and only for `provider.kind === "local"`: `cap = stage.max_output_tokens ?? provider.max_output_tokens`; a non-null `fitProblem(who.context, cap)` returns `{ kind: "stalled", reason: `${title}: ${problem}` }`. In `preflight`: add `"context fit"` to `NAMES` after `"context"`; for each agent stage compute the same and add `fail` with `` `${stage.id}: ${problem}` `` or one `ok` line `` `every stage's reply cap fits ${slot} tokens a request (${parallel ?? 1} slot${…})` ``; the existing `"context"` line reports the per-request context; the question's request carries `max_output_tokens: Math.max(1, slot - 2048)` (constant `QUESTION_ROOM = 2048`).
- [ ] **Step 4: Run the tests (PASS), the full suite, typecheck; commit**

```bash
git add src/agents/pack.ts src/agents/providers/types.ts src/agents/providers/local.ts src/agents/providers/index.ts src/agents/providers/scripted.ts src/pipeline/stages/agent.ts src/cli/preflight.ts tests/agents/pack.test.ts tests/pipeline/stage-agent.test.ts tests/cli/preflight.test.ts
git commit -m "fix(models): a request's context is the loaded context divided by the slots; a reply cap that does not fit stops preflight and the stage, in words"
```

#### Part B: an endpoint's refusal becomes a plain pause reason

- [ ] **Step 5: Write the failing tests** in `tests/agents/local.test.ts`:

```ts
test("a 400 about context size is reported as not fitting the context, with the endpoint's own line", async () => {
  // stand-in answers 400 {"error":{"message":"Context size has been exceeded."}}
  const r = await provider.turn(req);
  expect(r).toMatchObject({ kind: "error", cause: "context" });
  expect((r as { message: string }).message).toBe("the request did not fit the model's context (the endpoint said: Context size has been exceeded.)");
  expect((r as { transient?: unknown }).transient).toBeUndefined();
});
test("another refusal shows its status and the endpoint's line, scrubbed to one line", async () => {
  // stand-in answers 400 {"error":"bad\nrequest"}  ->  "the endpoint answered 400: bad request"; no cause
});
test("a refusal with no readable body keeps the old words", async () => { /* 500, body "x" -> "the endpoint answered 500" */ });
```
`tests/pipeline/stage-agent.test.ts`: `test("an over-context refusal pauses the stage saying what to change", ...)`: the stalled reason is `` `${title}: the request did not fit the model's context (the endpoint said: Context size has been exceeded.). Lower this stage's max_output_tokens, or load the model with a larger context in one slot, and resume.` `` and exactly one `model.request` was made (no retry).

- [ ] **Step 6: Run; expect FAIL** (message is "the endpoint answered 400")
- [ ] **Step 7: Implement.** In `local.ts`: `endpointSaid(parsed: unknown): string` reads `error.message`, else a string `error`, else a string `message`, through the provider's existing `#redact` (one line, 300 characters); `CONTEXT_RE = /context (?:size|length|window)|exceed\w* .{0,40}context|maximum context|n_ctx|too many tokens/i`. `Failure` carries the cause; `turn` copies it to the result. In `loop.ts` the error end copies `cause`. In `stageAgent` the `error` case with `cause === "context"` returns the reason above.
- [ ] **Step 8: Run (PASS), full suite, typecheck; commit** `fix(models): an endpoint's refusal is shown in its own words; an over-context request pauses the stage saying what to change`

#### Part C: no 300-second cut in the connectors

- [ ] **Step 9: Write the failing test.** Follow the test `ce27915` added for the model provider (`tests/agents/local.test.ts`, helper `tests/helpers/local-timeout.ts`): the same check for `tests/modules/connector-http.test.ts` and `tests/modules/connector-trino.test.ts`, each asserting that every `fetch` the connector makes is given `timeout: false` (wrap `globalThis.fetch` for the test, record each call's init, restore it in `finally`). The trino test covers the statement, a page fetch and the cancel `DELETE`.
- [ ] **Step 10: Run; expect FAIL.** **Step 11: Implement:** `timeout: false` in `http.ts`'s one `fetch` init and in `trino.ts`'s `init()`. Each connector's own `AbortController` timer stays the only deadline.
- [ ] **Step 12: Run (PASS), full suite, typecheck; commit** `fix(connectors): Bun's 300 s idle cut is off for http and trino; the source's own timeout is the only deadline`

#### Part D: `new-root` writes the stage settings CASE-1 arrived at

- [ ] **Step 13: Write the failing test** in `tests/cli/new-root.test.ts`:

```ts
test("the new root's stages and model carry the settings the first real run arrived at, and they fit 65536 tokens in one slot", () => {
  newRoot(root, { base_url: "http://127.0.0.1:1234/v1", model: "example/model-a" });
  const { pipeline } = loadPipeline(Registry.load([{ path: root, trusted: true, credentials: [] }]));
  const by = Object.fromEntries(pipeline!.stages.filter((s) => s.runs === "agent").map((s) => [s.role, [s.max_output_tokens, s.max_turns]]));
  expect(by).toEqual({ frame: [8192, 8], plan: [32768, 16], research: [16384, 24], assemble: [32768, 30], evaluate: [16384, 16], challenge: [16384, 16], publish: [16384, 8] });
  const model = Bun.YAML.parse(readFileSync(join(root, "models", "local.yaml"), "utf8")) as Record<string, unknown>;
  expect(model).toMatchObject({ max_output_tokens: 16384, timeout_ms: 600000, parallel: 1 });
  for (const [cap] of Object.values(by)) expect(fitProblem(65536, cap as number)).toBeNull();
});
```
- [ ] **Step 14: Run; expect FAIL.** **Step 15: Implement:** a table `STAGE_SETTINGS` keyed by the stage's parsed `role`; `pointStage` appends `max_output_tokens: <n>` and `max_turns: <n>` lines to a stage whose parsed model is not null, and its re-parse check expects them. The model file's lines change to the three values above. The sample's own stage files are not edited. Add three sentences to README "Before a run": load the model in one slot; `parallel` in the model manifest says how many slots share the context; `preflight` checks the reply caps against it.
- [ ] **Step 16: Run (PASS), full suite, typecheck; commit** `feat(cli): new-root writes per-stage reply caps and turn limits, and a model with one slot and a 600 s timeout`

#### Part E: the phase strip and the brief's buttons

- [ ] **Step 17: Write the failing tests** in `tests/web/derive.test.ts` (build states with `EntryBuilder`, `tests/helpers/entries.ts`):

```ts
test("the stage that wrote the latest draft reads 'sent back' once a review stage has failed it", () => {
  // run with assemble passed (draft 3 by an agent whose stage is assemble), checks finished fail on draft 3, run paused at the send-back cap
  expect(stageMark(state, stage("assemble"))).toBe("sent back");
  expect(sentBack(state, stage("assemble"))).toEqual({ draft: 3, by: "Checks" });
});
test("it reads running again as soon as it starts again, and passed when no review stage has failed the draft", () => { /* both */ });
test("a draft a person wrote marks no stage as sent back", () => { /* draft author kind human -> sentBack is null for every stage */ });
test("the brief never offers two buttons with one label or one command, in any run state", () => {
  for (const state of EVERY_RUN_STATE) {       // none, running, paused, paused with an unruled conflict, interrupted, waiting plan (free / costly), waiting publish (publishable / blocked), finished
    const { run, next } = briefButtons(state);
    if (run === null || next === null) continue;
    expect(next.label).not.toBe(run.label);
    expect("command" in next ? next.command : null).not.toBe(run.command ?? undefined);
  }
});
```
`tests/web/workarea.test.ts`: `test("the phase strip says which draft was sent back and by which stage", ...)`: the stage button's text is `Assemble ↩ draft 3 sent back by Checks`, its `data-mark` is `sent back`, and it has no `✓`.

- [ ] **Step 18: Run; expect FAIL.** **Step 19: Implement.** `sentBack`: the latest draft's author is an agent whose `stage` is this stage; the stage's status is `passed` or `idle`; `by` is the title of `run.sent_back_to[stage.id]` when set, else of the first stage in `run.stages` with `reviews` and status `failed`; null otherwise. `stageMark` returns `"sent back"` when `sentBack` is not null, before its other rules. `briefButtons` holds the rule `brief.ts` has inline today (at a gate the next-thing button stands for the run button; a resume is the run button's alone) and drops `next` when its label or command equals `run`'s; `brief.ts` renders from it. The button's class is `mark-sent-back`; its colour rule is added by Task 7, which owns `src/web/style.css` in this wave. Do not edit that file here.
- [ ] **Step 20: Run (PASS), full suite with the browser, typecheck; commit** `fix(web): the phase strip shows "draft N sent back by <stage>"; the brief's buttons come from one list with no duplicates`

#### Part F: the change terms live in the standard only

- [ ] **Step 21: Write the failing tests.** `tests/agents/draft.test.ts`: `termsOf` of the sample standard has `first_change === "first judgment"`; `termsOf` of a standard with `change_terms: []` is null; `composeChange("premier avis", "", "premier avis")` is `"Premier avis."`. `tests/pipeline/stages-analysis.test.ts`: with a standard whose `change_terms` are `[first judgment, consistent with, changes, withdraws]`, the schema Assemble sends (the pack's schema part and the structured-output schema) lists exactly those four for `change_kind` once something is published, and only `first judgment` before; `sample/context/schemas/assemble-output.yaml` no longer contains the word `consistent`.
- [ ] **Step 22: Run; expect FAIL.** **Step 23: Implement** per the Interfaces block. `assembleRunner`'s `narrow` is always set: `changeKinds(schema, terms.change_terms)`, then `firstJudgmentOnly(…, terms.first_change)` when nothing is published. In the schema file `change_kind` becomes `{"type": "string", "description": "one of the standard's change terms"}`. Add to the standard file's `note`: "The first change term is the one for a first judgment." `src/pipeline/checks.ts:45` reads the standard for the checks' input: if the input carries `change_terms`, switch the two literals in `sample/checks/10-change.ts` to its first entry; if it does not, leave the check and say so in the report.
- [ ] **Step 24: Run (PASS), full suite, typecheck; commit** `refactor(assemble): the change terms are read from the standard in one place`

#### Part G: a job names its sub-goal by id

- [ ] **Step 25: Write the failing tests.** `tests/core/state-run.test.ts`: a `job.started` with `subgoal: "g2"` folds to `jobs[job].subgoal === "g2"`, `request === null`; one without the fields folds with both null; `subgoal: 7` is skipped as malformed. `tests/pipeline/stages-front.test.ts`:

```ts
test("two sub-goals with the same title are each carried by their own finished job on resume", async () => {
  // plan with g1 and g2 both titled "Look it up"; run Research to the end of g1's researcher, pause, resume
  // expect: exactly one job.started with payload.subgoal "g1" and one with "g2"; g1's researcher made no model.request after the resume
});
test("a job recorded without a sub-goal id is still matched by its title", async () => { /* hand-write job.started {title: "Research: <g1 title>"} + job.finished done; resume starts no researcher for g1 */ });
```
- [ ] **Step 26: Run; expect FAIL.** **Step 27: Implement.** Research writes `subgoal: u.subgoal` and `request: <seq of the research.requested entry, or null>` on `job.started`. `carried` matches `e.payload.subgoal === g.id` when the entry has the field (`!== undefined`), else by title as now. The sent-back branch matches a finished job to a request by `payload.request === e.seq` when present, else by title.
- [ ] **Step 28: Run (PASS), full suite, typecheck; commit** `fix(research): a job names its sub-goal by id; titles are matched only for jobs recorded before this`

#### Part H: recovery at server start is pinned

- [ ] **Step 29:** Read `tests/server/commands.test.ts` around line 231. If no test there builds an app over a case left `running` and asserts, before any command is sent, that `hub.read(id).state.run.status === "interrupted"`, add `test("a case left running is read as interrupted as soon as the server starts", ...)` to that file. Run it (it passes: the fix is `7db2b74`); commit `test(server): recovery at start is pinned` only if a test was added.

---

### Task 1: The playbook manifest and its loader

**Files:**
- Create: `src/modules/playbooks.ts`, `sample/playbooks/address-triage.yaml`, `tests/modules/playbooks.test.ts`
- Modify: `src/modules/manifests.ts` (`schemaFor`), `src/modules/registry.ts`, `tests/sample/sample.test.ts` (only if it counts manifests)

**Interfaces (Produces):**
```ts
// src/modules/playbooks.ts
export const MAX_PLAYBOOK_STEPS = 12, DEFAULT_STEP_VALUES = 5, MAX_STEP_VALUES = 20, MAX_PLAYBOOK_LOOKUPS = 50;
export interface PlaybookInput { name: string; type: string }
export interface PlaybookStep { id: string; pivot: string; from: { input: string } | { step: string }; when: { step: string; is: "rows" | "empty" } | null; max_values: number }
export interface PlaybookManifest { id: string; title: string; hash: string; about: string; inputs: PlaybookInput[]; steps: PlaybookStep[]; end: string[] }
export const PLAYBOOK_SCHEMA: Schema;
/** Throws ManifestError naming the step for a `from` or `when` that is not in the grammar. */
export function toPlaybook(body: Record<string, Json>, hash: string): PlaybookManifest;
/** `from` and `when` as the manifest writes them: "input.address", "names", "names.rows". */
export function fromText(s: PlaybookStep): string; export function whenText(s: PlaybookStep): string | null;
/** The most lookups a run can send: 1 for a step from an input, max_values for a step from a step; at most MAX_PLAYBOOK_LOOKUPS. */
export function maxLookups(p: PlaybookManifest): number;
// Registry
playbooks(): PlaybookManifest[]; playbook(id: string): PlaybookManifest | null;
/** The ids of the playbook's pivots whose weight is above zero. */
costlyPivots(p: PlaybookManifest): string[];
```
`"playbook"` joins `TRUSTED_ONLY_KINDS`. Ids (`id` of a step, `name` of an input) match `/^[a-z][a-z0-9_]{0,31}$/`; `input` is not a step id. `end` defaults to `[<last step id>]`.

The sample manifest is the one in the design §5.1, exactly.

- [ ] **Step 1: Write the failing tests `tests/modules/playbooks.test.ts`** (a copy of the sample root via `copySample`, plus one playbook file written by the test):

```ts
test("the sample playbook loads with its steps parsed", () => {
  const p = registry.playbook("address-triage")!;
  expect(registry.problems).toEqual([]);
  expect(p.inputs).toEqual([{ name: "address", type: "address" }]);
  expect(p.steps.map((s) => [s.id, s.pivot, fromText(s), whenText(s), s.max_values])).toEqual([
    ["asset", "address_to_asset", "input.address", null, 5], ["lease", "address_to_asset_by_lease", "input.address", "asset.empty", 5],
    ["names", "address_to_domains", "input.address", null, 5], ["clients", "domain_to_clients", "names", "names.rows", 5]]);
  expect(p.end).toEqual(["asset"]);
  expect(maxLookups(p)).toBe(8);
  expect(registry.costlyPivots(p)).toEqual([]);
});
const REFUSED: [string, string, string][] = [                 // name, the YAML that differs from a good playbook, a fragment of the problem
  ["an unknown pivot", "pivot: nope", 'pivot "nope" is not loaded'],
  ["a step from a step that comes later", "from: later", '"later" is not an input or an earlier step'],
  ["a from of the wrong type", "{ id: a, pivot: domain_to_clients, from: input.address }", "takes a domain"],
  ["a when on an unknown step", "when: ghost.rows", '"ghost" is not an earlier step'],
  ["a when that is not rows or empty", "when: asset.partial", "rows or empty"],
  ["two inputs of one type", "inputs: [{ name: a, type: address }, { name: b, type: address }]", "two inputs of type address"],
  ["a step named input", "id: input", "may not be named input"],
  ["a duplicate step id", "two steps with id: asset", 'duplicate step id "asset"'],
  ["thirteen steps", "…", "at most 12 steps"],
  ["max_values of 21", "max_values: 21", "max_values"],
  ["an end naming no step", "end: [ghost]", '"ghost" is not a step'],
];
for (const [name, , fragment] of REFUSED) test(`a playbook with ${name} is rejected with the reason and nothing else is disturbed`, () => {
  // registry.playbook(id) is null; registry.problems has one entry for the file whose error contains `fragment`; the sample's own playbook still loads
});
test("a playbook in a root that is not trusted is refused", () => { /* "a playbook manifest is accepted only from a trusted root" */ });
test("a costly pivot is named by costlyPivots", () => { /* a playbook stepping address_to_verdict -> ["address_to_verdict"] */ });
```
- [ ] **Step 2: Run; expect FAIL** (module not found). Run: `timeout 120 bun test tests/modules/playbooks.test.ts`
- [ ] **Step 3: Implement.** `schemaFor("playbook")` returns `PLAYBOOK_SCHEMA` (shape and string forms only). The registry keeps playbooks in their own map beside pivots, drops them in `drop`, and in `crossCheck`, after pivots are settled, rejects a playbook for: a pivot not loaded; a `from` or `when` that names neither an input nor an earlier step; a `from` whose type (the input's type, or the earlier step's pivot `to`) is not this pivot's `from`; an `end` id that is no step.
- [ ] **Step 4: Run (PASS), full suite, typecheck; commit**

```bash
git add src/modules/playbooks.ts src/modules/manifests.ts src/modules/registry.ts sample/playbooks/address-triage.yaml tests/modules/playbooks.test.ts
git commit -m "feat(modules): a playbook is a manifest of pivot steps, loaded from trusted roots and checked against the pivots it names"
```

---

### Task 2: The record and the runner

**Files:**
- Create: `src/modules/playbook-run.ts`, `src/core/state/playbooks.ts`, `tests/modules/playbook-run.test.ts`, `tests/core/state-playbooks.test.ts`
- Modify: `src/core/types.ts`, `src/core/state/types.ts`, `state/index.ts`, `state/apply.ts`, `state/run.ts` (`isStep`, the job kinds, the `query.issued` branch), `src/modules/runner.ts`, `src/modules/pivots.ts`, `src/modules/reuse.ts`, `src/web/trail.ts` (one condition), `src/web/describe.ts` (three lines), `tests/modules/custody.test.ts`

**Interfaces:**
- Consumes: `PlaybookManifest`, `PlaybookStep`, `MAX_PLAYBOOK_LOOKUPS`, `Registry.playbook`, `Registry.costlyPivots` (Task 1); `answeredBefore`, `runPivot`, `yielded` (existing).
- Produces:
```ts
// src/core/types.ts
export type QueryPurpose = "result" | "estimate" | "verify" | "playbook";
/** True for a query made for its answer: a result or a playbook lookup. */
export const isAnswerPurpose = (p: QueryPurpose): boolean => p === "result" || p === "playbook";
// job kinds gain "playbook"
export interface PlaybookLookup { value: string; outcome: "answered" | "empty" | "partial" | "failed" | "needs_budget" | "refused"; rows: number | null; query: string | null; card: string | null; reused: boolean; detail: string }
"playbook.started": { job: string; playbook: string; playbook_hash: string; title: string; inputs: Observable[]; window: TimeWindow; why: string; plan_step: string | null; steps: { id: string; pivot: string; pivot_hash: string }[] };
"playbook.step": { job: string; step: string; pivot: string; status: "ran" | "skipped"; reason: string; lookups: PlaybookLookup[]; found: string[]; left: number };
"playbook.finished": { job: string; outcome: StepOutcome; end_step: string | null; cards: string[]; end_cards: string[]; caveats: string[]; lookups: number; reused: number };
// PlanStep gains:  playbook?: { id: string; hash: string; inputs: Observable[] }
// Payloads["query.issued"] gains:  inventory?: { id: string; hash: string; complete: boolean }
// src/core/state/types.ts
export interface PlaybookRunState {
  job: string; playbook: string; title: string; inputs: Observable[]; window: TimeWindow; plan_step: string | null; started_seq: number;
  status: "running" | "interrupted" | StepOutcome; end_step: string | null;
  steps: Record<string, Payloads["playbook.step"]>; order: string[]; cards: string[]; end_cards: string[]; caveats: string[];
}
// CaseState gains:  playbooks: Record<string, PlaybookRunState>   (keyed by job)
// src/modules/runner.ts, pivots.ts:  RunQueryInput and PivotInput gain  purpose?: "playbook"
// src/modules/playbook-run.ts
export interface PlaybookStart { playbook: PlaybookManifest; inputs: Observable[]; window: TimeWindow; why: string; actor: Actor; run?: string | null; stage?: string | null; subgoal?: string | null; plan_step?: string | null }
export interface PlaybookEnd { outcome: StepOutcome; end_step: string | null; cards: string[]; end_cards: string[]; caveats: string[]; lookups: number; reused: number }
/** Why this playbook cannot be started on these inputs and this window; null when it can. Reads the registry only. */
export function playbookProblem(deps: RunnerDeps, playbook: PlaybookManifest, inputs: Observable[], window: TimeWindow): string | null;
/** Writes job.started (kind "playbook") and playbook.started in one commit and returns the job id. Throws Refused with playbookProblem's words. */
export function beginPlaybook(session: CaseSession, deps: RunnerDeps, start: PlaybookStart): string;
/** Walks the steps. Always ends the job it was given, in one commit (playbook.finished + job.finished done, or job.finished failed if it threw), unless the job is no longer running; then it writes nothing and returns null. `stop` is asked before each lookup. */
export function runPlaybook(session: CaseSession, deps: RunnerDeps, job: string, start: PlaybookStart, stop?: () => boolean): Promise<PlaybookEnd | null>;
```

Rules the runner follows (the design §5.2; the tests pin each):

- `playbookProblem`: each input has exactly one value of its type, matching the type's pattern (`` `the playbook needs a ${type} for ${name}` ``, `` `"${value}" is not a ${type}` ``); a value of a type no input takes is refused (`` `the playbook takes no ${type}` ``); a window with an open end is refused when any step's pivot has `needs_window` (`"this playbook needs a window with both ends set"`).
- A step is **skipped** with one of these reasons, exactly: `` `${dep} was skipped` ``; `` `could not tell whether ${dep} returned rows` `` (the `when` step has neither rows nor empty); `` `${dep} returned no rows` `` (`when: dep.rows`); `` `${dep} returned rows` `` (`when: dep.empty`); `` `${dep} found no ${type}` `` (nothing to start from).
- *rows*: some lookup has `rows > 0`. *empty*: at least one lookup, and every lookup's outcome is `empty`.
- Values: the input's value, or the `from` step's `found` in order, first `max_values`; `left` is how many more there were.
- Before each lookup: if `stop?.()` is true, add the caveat `"stopped before every lookup was sent"` and end the walk; if the run's lookup count (sent plus reused) is 50, add `"stopped after 50 lookups"` and end the walk.
- Each lookup: `answeredBefore(...)`; when it returns one, the lookup is `{ reused: true, query, card, outcome, rows }` and nothing is sent. Else `runPivot` with `purpose: "playbook"`, `job`, `step: plan_step`, `subgoal`, `run`, `stage`, and `why` `` `${start.why} — ${playbook.title}: ${pivot.title}` ``. `needs_budget` and `refused` are lookup outcomes with the reason in `detail`.
- `found` is `yielded(pivot, result, observables)` over the step's lookups, distinct, in order.
- Caveats: `` `${step}: ${left} values not followed (limit ${max_values})` ``; `` `${step}: ${pivot} needs a budget` ``; `` `${step}: partial coverage (${reason})` ``.
- Outcome, from the first `end` step that ran: `partial` if any lookup is partial; else `answered` if any has rows; else `empty` if every lookup is empty; else `failed` if any failed; else `blocked`. No end step ran: `blocked`, `end_step: null`.
- `runQuery` sets the issued purpose to `"playbook"` only when the input says so and `verifies` is null. `answeredBefore` filters with `isAnswerPurpose(q.purpose)`; `src/web/trail.ts` does the same in place of `!== "result"`.
- Fold: `playbook.started` adds the run as `running`; `playbook.step` and `playbook.finished` for an unknown or finished job are skipped as malformed; `job.finished` with outcome `failed` turns a `running` playbook of that job to `interrupted`.

- [ ] **Step 1: Write the failing tests `tests/modules/playbook-run.test.ts`** (`sampleRoot`, a `Workbench` case as in `tests/helpers/tools-fixture.ts`; `START = "198.51.100.77"`, `KNOWN = "192.0.2.17"`, `WINDOW` from the fixture; `run(inputs)` = `beginPlaybook` then `await runPlaybook`):

```ts
test("every lookup is the runner's: issued with purpose playbook, linked to the job, with a card", async () => {
  const { job, end } = await run([{ type: "address", value: START }]);
  const issued = entries().filter((e) => e.type === "query.issued");
  expect(issued.length).toBe(end.lookups);
  for (const e of issued) { expect(e.payload.purpose).toBe("playbook"); expect(e.job).toBe(job); expect(e.actor).toEqual(person); }
  expect(entries().filter((e) => e.type === "model.request")).toEqual([]);
  expect(s.state.playbooks[job]!.status).toBe(end.outcome);
  expect(s.state.jobs[job]).toMatchObject({ kind: "playbook", status: "done" });
});
test("the branch on empty is taken for an address the asset list does not hold, and skipped for one it does", async () => {
  const a = await run([{ type: "address", value: START }]);
  expect(step(a.job, "asset").lookups[0]).toMatchObject({ outcome: "empty", rows: 0, reused: false });
  expect(step(a.job, "lease").status).toBe("ran");
  expect(a.end).toMatchObject({ outcome: "empty", end_step: "asset" });
  expect(a.end.end_cards.map((c) => s.state.cards[c]!.empty)).toEqual(["proven-negative"]);
  const b = await run([{ type: "address", value: KNOWN }]);
  expect(step(b.job, "lease")).toMatchObject({ status: "skipped", reason: "asset returned rows", lookups: [] });
  expect(b.end).toMatchObject({ outcome: "answered", end_step: "asset" });
});
test("with several end steps the outcome is the first listed one that ran", async () => { /* a test playbook with end: [lease, asset]: on START the end step is "lease"; on KNOWN, where lease is skipped, it is "asset" */ });
test("a step runs once for each value the earlier step found", async () => {
  const { job } = await run([{ type: "address", value: START }]);
  expect(step(job, "names").found).toContain("cdn-update.example.org");
  expect(step(job, "clients").lookups.map((l) => l.value)).toEqual(step(job, "names").found);
});
test("a second run reuses every full answer and sends nothing", async () => {
  await run([{ type: "address", value: START }]);
  const before = entries().filter((e) => e.type === "query.issued").length;
  const again = await run([{ type: "address", value: START }]);
  expect(entries().filter((e) => e.type === "query.issued").length).toBe(before);
  expect(again.end.reused).toBe(again.end.lookups);
  expect(Object.values(s.state.playbooks[again.job]!.steps).flatMap((x) => x.lookups).every((l) => l.reused && l.query !== null && l.card !== null)).toBe(true);
});
test("a researcher's answer is reused by a playbook, and a discarded or partial one is not", async () => { /* runPivot(address_to_asset, START) as an agent with purpose unset -> playbook's asset lookup is reused; discard that card -> the next run sends it; a source capped to max_rows 1 (partial) is never reused */ });
test("a step that could not be decided skips what depends on it", async () => { /* make address_to_asset fail (rename the file under the source) -> asset outcome "failed"; lease is skipped with "could not tell whether asset returned rows"; end outcome "failed" */ });
test("the fan-out cap leaves the count in the step and in the caveats", async () => { /* a playbook written by the test: clients with max_values: 1 over an address with 2 names -> clients.left === 1; caveats contain "clients: 1 values not followed (limit 1)" */ });
test("the run stops at 50 lookups and says so", async () => { /* a test playbook of 12 steps each from the same fan-out step with max_values 20 -> end.lookups === 50; caveats contain "stopped after 50 lookups" */ });
test("a costly step waits for a budget and the rest run", async () => { /* a test playbook: verdict (address_to_verdict) then names -> verdict lookup outcome "needs_budget"; names ran; no proposal.created; caveat "verdict: address_to_verdict needs a budget" */ });
test("stop is asked before each lookup, and a stopped run does not read as answered", async () => { /* stop returns true after the first lookup -> one query.issued; caveat "stopped before every lookup was sent"; outcome is not "answered" unless the end step had already run */ });
test("an interrupted playbook reads interrupted, and its re-run sends only what had no full answer", async () => {
  const job = beginPlaybook(s, deps, start);                       // started, never run: as a stopped server leaves it
  recoverSession(s);
  expect(s.state.jobs[job]!.status).toBe("failed");
  expect(s.state.playbooks[job]!.status).toBe("interrupted");
  /* then: run one lookup by hand with runPivot purpose "playbook"; a full run afterwards reuses exactly that one */
});
test("bad inputs are refused before anything is written", () => { /* each playbookProblem string; entries().length unchanged */ });
```
`tests/core/state-playbooks.test.ts`: the three entries fold; state at entry N during a run equals the fold of the first N entries; a `playbook.step` for an unknown job is in `skipped`; the input state is not mutated (deep-freeze it). `tests/modules/custody.test.ts`: extend the existing trace assertion so a card whose query has purpose `playbook` traces to `query.issued`, `query.result` and a blob.

- [ ] **Step 2: Run; expect FAIL.** Run: `timeout 120 bun test tests/modules/playbook-run.test.ts tests/core/state-playbooks.test.ts`
- [ ] **Step 3: Implement the core types and the fold** (`src/core/state/playbooks.ts` exports `applyPlaybooks`, wired in `apply.ts` beside `applyConflicts`; `initial()` gains `playbooks: {}`; `isStep` accepts an absent or well-formed `playbook`; the `query.issued` branch accepts an absent or well-formed `inventory`). `describe.ts` gains: `"playbook.started": ["playbook started", job · title]`, `"playbook.step": [ran → "playbook step", skipped → "playbook step skipped"; step · reason or lookup count]`, `"playbook.finished": ["playbook finished", job · outcome · "n lookups, m reused"]`.
- [ ] **Step 4: Implement `runner.ts`/`pivots.ts`/`reuse.ts`/`trail.ts` changes, then `playbook-run.ts`.**
- [ ] **Step 5: Run (PASS), full suite, typecheck; commit**

```bash
git add src/core/types.ts src/core/state/ src/modules/playbook-run.ts src/modules/runner.ts src/modules/pivots.ts src/modules/reuse.ts src/web/trail.ts src/web/describe.ts tests/modules/playbook-run.test.ts tests/core/state-playbooks.test.ts tests/modules/custody.test.ts
git commit -m "feat(playbooks): a playbook runs its pivots through the runner with no model, reuses answered lookups, and records each step"
```

---

### Task 3: The person starts a playbook

**Files:**
- Create: `src/server/playbook-commands.ts`, `tests/server/playbook-commands.test.ts`
- Modify: `src/server/app.ts` (import the new file beside `./seek`), `src/core/wire.ts`, `src/server/views.ts`, `tests/helpers/dom.ts` (`playbooks: []` in the two empty references)

**Interfaces:**
- Consumes: `beginPlaybook`, `runPlaybook`, `playbookProblem` (Task 2); `defineCommand`, `hub.background`, `hub.running` (existing).
- Produces:
```ts
// src/core/wire.ts
export interface PlaybookView { id: string; title: string; about: string; inputs: { name: string; type: string }[]; steps: { id: string; pivot: string; from: string; when: string | null; max_values: number }[]; end: string[]; free: boolean; max_lookups: number }
// Reference gains:  playbooks: PlaybookView[]
```
Command `run_playbook`, args `{ playbook: string, inputs: { type: string, value: string }[] (at least one), window: { from, to }, why: string, subgoal?: string }`, `then: "nothing"`. `perform`: `why` must not be blank (the same words as `run_route`); unknown playbook → `Refused("unknown playbook: <id>")`; `hub.engine(id)` is already made by the command path, so the case is recovered; the key `` `${case}:playbook:${id}:${canonical(inputs sorted by type)}:${from}:${to}` `` in `hub.running` → `Refused("this playbook is already running on this value")`; else add the key, `beginPlaybook`, and `hub.background(runPlaybook(...).finally(() => hub.running.delete(key)))`. The actor is the command's human actor.

- [ ] **Step 1: Write the failing tests `tests/server/playbook-commands.test.ts`** (`served()`; `SAMPLE_START`, `SAMPLE_WINDOW` from `scripts/make-sample-data`):

```ts
const start = (over: Record<string, unknown> = {}) => ({ playbook: "address-triage", inputs: [SAMPLE_START], window: SAMPLE_WINDOW, why: "first look", ...over });
test("the reference lists the sample playbook with what it takes and how much it can ask", async () => {
  const ref = (await (await s.get("/api/reference")).json()) as Reference;
  expect(ref.playbooks).toEqual([expect.objectContaining({ id: "address-triage", free: true, max_lookups: 8, inputs: [{ name: "address", type: "address" }] })]);
});
/** Holds every connector's `run` until `release()` is called, so a playbook is provably mid-run. */
const held = () => { /* wrap s.app.hub.deps.runner.pool.for: the connector it returns awaits a gate promise at the top of run(); returns { release(), started(): number } */ };
test("run_playbook returns while the first lookup is still held, then the job finishes with cards", async () => {
  const gate = held();
  const r = await s.command(id, "run_playbook", start());
  expect(r.status).toBe(200);
  const job = Object.values(state(id).jobs).at(-1)!;
  expect(job).toMatchObject({ kind: "playbook", status: "running" });
  expect(s.entries(id).filter((e) => e.type === "query.result")).toEqual([]);
  expect(s.entries(id).some((e) => e.type === "playbook.started" && e.payload.job === job.id)).toBe(true);
  gate.release(); await s.app.hub.idle();
  expect(state(id).jobs[job.id]!.status).toBe("done");
  expect(state(id).playbooks[job.id]!.cards.length).toBeGreaterThan(0);
  expect(s.entries(id).filter((e) => e.type === "model.request")).toEqual([]);
});
test("a second start on the same value is refused while the first is running, and no lookup is sent twice", async () => {
  const gate = held();
  expect((await s.command(id, "run_playbook", start())).status).toBe(200);
  const again = await s.command(id, "run_playbook", start());
  expect(again.status).toBe(409);
  expect(again.body).toEqual({ ok: false, refused: ["this playbook is already running on this value"] });
  expect((await s.command(id, "run_playbook", start({ inputs: [{ type: "address", value: "192.0.2.17" }] }))).status).toBe(200);   // another value is another run
  gate.release(); await s.app.hub.idle();
  const sent = s.entries(id).flatMap((e) => (e.type === "query.issued" ? [`${e.payload.pivot}|${JSON.stringify(e.payload.bound)}`] : []));
  expect(new Set(sent).size).toBe(sent.length);
  expect((await s.command(id, "run_playbook", start())).status).toBe(200);   // free again once it has ended; this run reuses every answer
});
test("an unknown playbook, a wrong value, an extra value, an open window and a blank reason are each refused with nothing written", async () => { /* five refusals; s.entries(id).length unchanged after each */ });
test("a requester may not run a playbook", async () => { /* served({ role: "requester" }) -> refused by the role check, as run_route is */ });
```
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** `views.ts` builds `playbooks` from `registry.playbooks()` with `fromText`/`whenText`, `free: registry.costlyPivots(p).length === 0`, `max_lookups: maxLookups(p)`, titles through the existing `shown(deps, …)`. `mayDo` already limits every command to the analyst; nothing is added there.
- [ ] **Step 4: Run (PASS), full suite, typecheck; commit**

```bash
git add src/server/playbook-commands.ts src/server/app.ts src/server/views.ts src/core/wire.ts tests/helpers/dom.ts tests/server/playbook-commands.test.ts
git commit -m "feat(server): run_playbook starts a playbook as a background job; a second start on the same value is refused"
```

---

### Task 4: The planner offers a playbook; Research runs it in code

**Files:**
- Modify: `src/pipeline/plans.ts`, `src/pipeline/stages/plan.ts`, `src/pipeline/stages/research.ts`, `src/agents/tools/index.ts`, `src/agents/tools/sources.ts`, `src/agents/tools/research.ts`, `sample/stages/plan.yaml` (tools gain `list_playbooks`), `sample/context/schemas/plan-output.yaml`, `sample/context/personas/planner.md` (one sentence)
- Test: `tests/pipeline/plans.test.ts`, `tests/pipeline/stages-front.test.ts`, `tests/agents/tools-sources.test.ts`, `tests/agents/tools-research.test.ts`

**Interfaces:**
- Consumes: `PlanStep.playbook` (Task 2); `beginPlaybook`, `runPlaybook`, `playbookProblem` (Task 2); `Registry.playbook`, `costlyPivots`, `maxLookups` (Task 1).
- Produces: `PlanOutput` sub-goals gain `playbook?: string`. `TOOL_NAMES` gains `"list_playbooks"` (no arguments but `why`); its view is `{ playbooks: { id, title, about, inputs: {name,type}[], finds: string, max_lookups: number, may_plan: boolean }[] }`, where `finds` is the `to` of the first `end` step's pivot.

Rules:

- **Schema.** In `plan-output.yaml` a sub-goal's `route` loses `minItems`, and `playbook` (`{"type": "string"}`) is added, not required. `shapeProblem` requires exactly one of: a non-empty `route`, or a `playbook` with an empty `route`; else `"each sub-goal needs a route of pivot ids, or a playbook and an empty route"`.
- **`buildPlan`, for a playbook sub-goal**, adds an error and skips the sub-goal for: `` `${name}: there is no playbook ${id}` ``; `` `${name}: the playbook ${id} has costly lookups (${ids}); a person can start it from the Pivot panel` ``; `` `${name}: ${playbookProblem(...)}` `` (with `have` as the inputs and the frame's window); `` `${name}: the playbook ${id} finds ${finds}, not ${want}` ``; a pivot of it on an unconfirmed source when the frame's limits do not allow one (`` `${name}: the playbook ${id} uses the unconfirmed source ${source}` ``). Otherwise one step: `pivot: ""`, `source: ""`, `from` the first input's observable, `to: want`, `window` the frame's, `needs_window` true if any pivot needs one, `free: true`, `weight: 0`, `estimate: null`, `empty_means` the first end step's pivot's, `warnings: []`, `playbook: { id, hash, inputs: have }`.
- **The planner's task text** gains: `Where a playbook fits a sub-goal (use list_playbooks), give its id as "playbook" and an empty route; code runs it with no further model call.`
- **`run_step`** on a step with `playbook` throws `ToolError("step <id> is a playbook; the engine runs it")`.
- **Research.** A sub-goal whose accepted steps are one playbook step is a playbook unit, in the same worker pool. It is skipped when the step's status is already `answered`, `empty` or `partial`. Running it: if `registry.playbook(id)` is null or its hash is not the step's, commit `step.started` and `step.finished { outcome: "blocked", cards: [], note: "the playbook <id> changed since the plan was accepted; re-plan to use it" }` and start no job. Else `beginPlaybook` with actor `{ kind: "system", id: "playbook" }`, `run`, `stage`, `subgoal`, `plan_step`, and `why` the sub-goal's question; commit `step.started`; `runPlaybook` with `stop = () => run is paused or finished`; commit `step.finished { outcome, cards: end.end_cards, note }` where `note` is `` `playbook ${id}: ${lookups} lookups (${reused} reused), ${outcome}` `` plus `; ` and the caveats when there are any. A stopped walk finishes the step `blocked` with the note ending `; stopped`, and the stage returns `{ kind: "stopped" }` as it does for a stopped researcher. The unit's result is an output end with `{ note }`, so the stage's own output is built as today.

- [ ] **Step 1: Write the failing tests**

`tests/pipeline/plans.test.ts`:
```ts
const out = (over = {}) => ({ goal: "g", subgoals: [{ title: "Triage", question: "What is it?", have: [{ type: "address", value: "198.51.100.77" }], want: "asset", route: [], playbook: "address-triage", ...over }] });
test("a playbook sub-goal becomes one free plan step that names the playbook and its hash", () => {
  const plan = buildPlan("plan-1", out(), deps, frame, null) as Plan;
  expect(plan.steps).toEqual([expect.objectContaining({ id: "s1", subgoal: "g1", pivot: "", source: "", to: "asset", free: true, weight: 0,
    playbook: { id: "address-triage", hash: registry.playbook("address-triage")!.hash, inputs: [{ type: "address", value: "198.51.100.77" }] } })]);
});
test("each way a playbook sub-goal can be wrong is refused with its reason", () => {
  // unknown id; a costly one (a test playbook stepping address_to_verdict); have of the wrong type; want "account"; both a route and a playbook; neither
});
```
`tests/pipeline/stages-front.test.ts`:
```ts
test("Research runs a playbook sub-goal with no researcher and no model call, and the sub-goal is answered by its step", async () => {
  // accepted plan = one playbook sub-goal on KNOWN (192.0.2.17); run researchRunner with a scripted provider that would fail the test if asked
  expect(entriesOf("model.request")).toEqual([]);
  expect(f.s.state.plan.steps.s1).toMatchObject({ status: "answered" });
  expect(Object.values(f.s.state.jobs).map((j) => j.kind)).toEqual(["playbook"]);
  expect(entriesOf("query.issued").every((e) => e.payload.purpose === "playbook" && e.actor.kind === "system" && e.actor.id === "playbook" && e.payload.step === "s1")).toBe(true);
  expect(end).toMatchObject({ kind: "finished", outcome: "pass" });
});
test("a proven negative from the playbook's end step answers the sub-goal; a not-seen one does not", async () => { /* the sample playbook over START ends on the complete asset list: step "empty", subgoalAnswered true; a test playbook with end: [lease] over START: step "empty" on a not-seen card, subgoalAnswered false, sub-goal outcome "blocked" */ });
test("a plan mixing a route sub-goal and a playbook sub-goal runs one researcher and one playbook", async () => { /* job kinds sorted: ["playbook", "research"] */ });
test("pausing stops the playbook before its next lookup and leaves the step unanswered; resuming reuses what was answered", async () => { /* pause from a connector hook after the first lookup; step status "blocked"; resume -> the first lookup is reused, the step ends answered */ });
test("a playbook changed since the plan was accepted is not run", async () => {
  // accept the plan, then rewrite the playbook file (add a space to its title) and reload the registry
  expect(f.s.state.plan.steps.s1).toMatchObject({ status: "blocked", note: "the playbook address-triage changed since the plan was accepted; re-plan to use it" });
  expect(entriesOf("query.issued")).toEqual([]);
});
```
`tests/agents/tools-sources.test.ts`: `list_playbooks` gives the sample playbook with `finds: "asset"`, `max_lookups: 8`, `may_plan: true`, and a costly test playbook with `may_plan: false`. `tests/agents/tools-research.test.ts`: `run_step` on a playbook step is refused with the words above and writes nothing.

- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement `plans.ts`, the schema and the tool.** **Step 4: Implement the Research unit** (a `Unit` gains `playbook: PlanStep | null`; `runUnit` branches on it).
- [ ] **Step 5: Run (PASS), `timeout 300 bun test tests/sample` (the scripted full run must be unchanged), full suite, typecheck; commit**

```bash
git add src/pipeline/plans.ts src/pipeline/stages/plan.ts src/pipeline/stages/research.ts src/agents/tools/index.ts src/agents/tools/sources.ts src/agents/tools/research.ts sample/stages/plan.yaml sample/context/schemas/plan-output.yaml sample/context/personas/planner.md tests/pipeline/plans.test.ts tests/pipeline/stages-front.test.ts tests/agents/tools-sources.test.ts tests/agents/tools-research.test.ts
git commit -m "feat(pipeline): the planner may offer a playbook as one plan step; Research runs it in code with no researcher"
```

---

### Task 5: Inventories and "Does it belong?"

**Files:**
- Create: `src/modules/inventories.ts`, `sample/inventories/assets.yaml`, `sample/inventories/leases.yaml`, `tests/modules/inventories.test.ts`
- Modify: `src/modules/manifests.ts` (`PIVOTS_SCHEMA`, `PivotManifest`, `toPivot`, `schemaFor`), `src/modules/registry.ts`, `src/modules/runner.ts` (`bodyOf`, the `query.issued` payload), `sample/pivots.yaml` (two pivots gain `inventory:`), `src/core/wire.ts`, `src/server/views.ts`, `src/server/playbook-commands.ts`, `tests/helpers/dom.ts` (`inventories: []`)
- Test: `tests/modules/runner.test.ts`, `tests/server/playbook-commands.test.ts`

**Interfaces:**
- Consumes: `PlaybookManifest`, `Payloads["query.issued"].inventory` (Tasks 1, 2); `beginPlaybook`, `runPlaybook` (Task 2); the `hub.running` pattern of `run_playbook` (Task 3).
- Produces:
```ts
// src/modules/inventories.ts
export interface InventoryManifest { id: string; title: string; hash: string; holds: string; scope: string; complete: boolean; basis: string; derived: boolean }
export const INVENTORY_SCHEMA: Schema;                       // required: kind, id, title, holds, scope, complete
export function toInventory(body: Record<string, Json>, hash: string): InventoryManifest;   // throws ManifestError: complete without basis; complete and derived
export const BELONGS_ID = "does-it-belong";
/** A playbook made on the spot: one step per inventory pivot that takes `type`, in pivot-id order, steps named i1, i2, …; end is every step. Null when no inventory pivot takes the type. Its hash is sha256 of the canonical list of [pivot id, pivot hash, inventory id, inventory hash]. */
export function belongsPlaybook(registry: Registry, type: string): PlaybookManifest | null;
// PivotManifest gains:  inventory: string | null
// Registry:  inventories(): InventoryManifest[]; inventory(id: string): InventoryManifest | null
// src/core/wire.ts
export interface InventoryView { id: string; title: string; holds: string; scope: string; complete: boolean }
// PivotView gains inventory: string | null;  Reference gains inventories: InventoryView[]
```
Command `check_belongs`, args `{ type: string, value: string, window: { from, to }, why: string }`: `belongsPlaybook(registry, type)` null → `Refused("no inventory takes a <type>")`; otherwise exactly `run_playbook`'s path with that playbook and `inputs: [{ type, value }]`.

Rules:

- `"inventory"` joins `TRUSTED_ONLY_KINDS`.
- `crossCheck`, for a pivot with `inventory`: rejected for `` `pivot "${id}": inventory "${inv}" is not loaded` ``; `` `pivot "${id}": only a pivot from a trusted root may name an inventory` ``; `` `pivot "${id}": it finds ${to}, but inventory "${inv}" holds ${holds}` ``; `` `pivot "${id}": empty_means ${stated} contradicts inventory "${inv}", which is ${complete ? "complete" : "not declared complete"}` `` (only when the pivot file states `empty_means`; `toPivot` must therefore keep whether it was stated). A pivot that states none gets `proven-negative` when the inventory is complete, else `not-seen`.
- `bodyOf` for a pivot with an inventory (title `T`, scope `S`): rows → `` `${rows} rows · in ${T}` ``; empty and proven → `` `No rows · proven negative · not in ${T}, which is complete for ${S}` ``; empty otherwise → `` `No rows · not seen (not proof of absence) · ${T} is not declared complete` ``; the partial suffix is appended as now. Without an inventory the body is unchanged.
- `query.issued` carries `inventory: { id, hash, complete }` for such a pivot, and no such key otherwise.
- Sample: `assets` (`holds: asset`, `scope: internal hosts`, `complete: true`, `basis: Every internal host is entered by hand before it is given an address.`, `derived: false`), named by `address_to_asset`; `leases` (`holds: asset`, `scope: addresses handed out by lease`, `complete: false`, `derived: true`), named by `address_to_asset_by_lease`. The two pivots keep their `empty_means` lines, which agree.

- [ ] **Step 1: Write the failing tests**

`tests/modules/inventories.test.ts`:
```ts
test("the sample's two inventories load and their pivots name them", () => {
  expect(registry.problems).toEqual([]);
  expect(registry.inventories().map((i) => [i.id, i.complete, i.derived])).toEqual([["assets", true, false], ["leases", false, true]]);
  expect(registry.pivot("address_to_asset")!.inventory).toBe("assets");
});
test("an inventory decides what an empty answer means for a pivot that states none", () => { /* remove the empty_means line from each sample pivot: address_to_asset -> "proven-negative", address_to_asset_by_lease -> "not-seen" */ });
const REFUSED: [string, string][] = [
  ["a complete inventory with no basis", "needs a basis"], ["a complete inventory that is derived", "a derived list cannot be complete"],
  ["a pivot naming an inventory that is not loaded", "is not loaded"], ["a pivot whose target is not what the inventory holds", "but inventory"],
  ["a pivot stating proven-negative on an inventory that is not complete", "contradicts inventory"],
  ["a pivot stating not-seen on a complete inventory", "contradicts inventory"], ["an inventory in a root that is not trusted", "only from a trusted root"],
];
for (const [name, fragment] of REFUSED) test(`${name} is rejected with the reason`, () => { /* the manifest is not loaded; one problem contains `fragment` */ });
test("does-it-belong is one step per inventory pivot that takes the type, and none for a type no inventory takes", () => {
  const p = belongsPlaybook(registry, "address")!;
  expect(p.id).toBe("does-it-belong");
  expect(p.steps.map((s) => [s.id, s.pivot, s.when])).toEqual([["i1", "address_to_asset", null], ["i2", "address_to_asset_by_lease", null]]);
  expect(belongsPlaybook(registry, "domain")).toBeNull();
});
```
`tests/modules/runner.test.ts`:
```ts
test("an inventory pivot's card says what the answer proves, and the query names the inventory", async () => {
  expect((await card("address_to_asset", "192.0.2.17")).body).toBe("1 rows · in Asset list");
  expect((await card("address_to_asset", "198.51.100.77")).body).toBe("No rows · proven negative · not in Asset list, which is complete for internal hosts");
  expect(lastIssued().payload.inventory).toEqual({ id: "assets", hash: registry.inventory("assets")!.hash, complete: true });
});
test("an incomplete inventory's empty answer is not seen, on the card and for the sub-goal rule", async () => {
  const c = await card("address_to_asset_by_lease", "198.51.100.77");
  expect(c.empty).toBe("not-seen");
  expect(c.body).toBe("No rows · not seen (not proof of absence) · Lease records is not declared complete");
  // a plan step finished "empty" on this card: subgoalAnswered(state, g) is false
});
test("a pivot with no inventory keeps its card body and its query has no inventory key", async () => { /* address_to_domains */ });
```
(Use the row count the sample really returns in the first assertion; the wording after it is fixed.) `tests/server/playbook-commands.test.ts`: `check_belongs` on `SAMPLE_START` returns at once, then the job is done with one `playbook.step` per inventory, purpose `playbook` on each query; on a `domain` it is refused with `"no inventory takes a domain"`; the reference lists both inventories and `pivots` carry `inventory`.

- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement** (`leases.yaml`'s title is `Lease records`).
- [ ] **Step 4: Run (PASS); fix card-body assertions elsewhere that the two sample pivots' new wording changes (see the Global Constraint on tests outside your Files); full suite, typecheck; commit**

```bash
git add src/modules/inventories.ts src/modules/manifests.ts src/modules/registry.ts src/modules/runner.ts sample/inventories sample/pivots.yaml src/core/wire.ts src/server/views.ts src/server/playbook-commands.ts tests/helpers/dom.ts tests/modules/inventories.test.ts tests/modules/runner.test.ts tests/server/playbook-commands.test.ts
git commit -m "feat(modules): an inventory declares whether its list is complete, and decides what an empty answer from it proves"
```

---

### Task 6: The interface

**Files:**
- Create: `src/web/panels/playbook.ts`, `src/web/belongs.ts`, `tests/web/playbook.test.ts`
- Modify: `src/web/panels/pivot.ts` (mount the block; pass it the values, window and reason), `src/web/commands.ts`, `src/web/lenses/steps.ts`, `src/web/style.css`, `tests/web/commands.test.ts`, `tests/web/steps.test.ts`

**Interfaces:**
- Consumes: `Reference.playbooks`, `Reference.inventories`, `PivotView.inventory` (Tasks 3, 5); `CaseState.playbooks`, `PlaybookRunState` (Task 2); commands `run_playbook`, `check_belongs`.
- Produces:
```ts
// src/web/panels/playbook.ts
export interface PlaybookBlock extends View { setValues(values: Observable[]): void }
export function makePlaybookBlock(ui: Ui, store: CaseStore, nav: Pick<Nav, "focusCard">, ask: { window(): TimeWindow | null; why(): string }): PlaybookBlock;
// src/web/belongs.ts
export type Verdict = "known" | "not known: proven" | "not seen" | "could not tell";
export function belongsLines(run: PlaybookRunState, ref: Pick<Reference, "pivots" | "inventories">): { inventory: string; title: string; line: string }[];
export function belongsVerdict(run: PlaybookRunState, ref: Pick<Reference, "pivots" | "inventories">): { verdict: Verdict; text: string };
// src/web/commands.ts:  Intent gains { kind: "playbook"; id: string; value: string }
```

What it shows (the design §5.3, §7.3). Every button says what will happen.

- **Playbooks the values can fill:** for each playbook in `ui.ref.playbooks` whose every input type is among the starting values' types, a button `` `Run ${title} on ${value} · up to ${max_lookups} lookups, no model` `` (the value of the first input). Disabled, with a title saying why, when the panel's window is not valid, the reason is blank, or the store is a replay. It sends `run_playbook` with the values the inputs take, the panel's window and reason. A playbook with `free: false` adds `· costly lookups will wait for a budget`.
- **Does it belong?:** one button `` `Does ${value} belong? · asks ${n} inventories` `` per starting value whose type some pivot with `inventory` takes. It sends `check_belongs`.
- **The trail** of the newest playbook job started from this block (the newest `state.playbooks` entry whose `started_seq` is above the store's seq when the button was pressed), read from `state.playbooks[job]`: its status; one line per step in `order`, `` `${step} · ${pivot title}` `` then each lookup as `` `${value}: ${outcome}` `` with a card chip, `reused, no query sent` for a reused one, or `` `skipped: ${reason}` ``; `` `${left} values not followed` `` when `left > 0`; then each caveat. Status `interrupted` reads `Interrupted: the server stopped. Run it again; answered lookups are reused.`
- **The verdict**, for a `does-it-belong` run, above its trail. Per inventory: `` `In ${title}` ``; `` `Not in ${title} · proven: it is complete for ${scope}` ``; `` `Not in ${title} · not proof: it is not declared complete` ``; `` `${title}: could not tell (${outcome})` ``. Overall: `Known asset` if any step has rows; else `` `Not a known asset: proven for ${scope}` `` if some complete inventory's step is empty (every lookup `empty`); else `Could not tell` if any lookup is partial, failed, refused or waiting; else `Not seen in any inventory; none is complete, so this proves nothing`.
- **Command bar:** `run playbook <id> on <value>` → `{ kind: "playbook", id, value }`. `perform`: no such playbook → say `` `There is no playbook ${id}` ``; more than one input → say `` `${title} takes ${n} values; start it from a card's Pivot panel` ``; the case window has an open end and the server would refuse → the server's refusal is shown as any refusal is. Else `ui.act("run_playbook", { playbook, inputs: [{ type: <the input's type>, value }], window: <the case window>, why: `run playbook ${id} on ${value}` })` and open the Jobs lens.
- **Steps lens:** a step with `playbook` reads `` `Playbook: ${title} · up to ${max_lookups} lookups · no model` `` in place of `pivot on source`; with the playbook no longer in the reference, `` `Playbook: ${id} (no longer loaded)` ``.

- [ ] **Step 1: Write the failing tests `tests/web/playbook.test.ts`** (`page()`, a sample case, a card opened to its Pivot panel as `tests/web/pivot.test.ts` does):

```ts
test("the panel offers the playbook the card's value can fill, saying what it will do", async () => {
  expect(p.q(".playbook-block button.run-playbook").textContent).toBe("Run Triage an address on 198.51.100.77 · up to 8 lookups, no model");
});
test("running it shows each step as it ends, with card chips, and no model request is made", async () => {
  p.click(".playbook-block button.run-playbook"); await p.settle();
  const lines = p.all(".playbook-trail .step").map((n) => n.textContent);
  expect(lines.some((t) => t!.startsWith("asset · Asset with the address"))).toBe(true);
  expect(p.all(".playbook-trail .chip.card").length).toBeGreaterThan(0);
  expect(p.s.entries("CASE-1").filter((e) => e.type === "model.request")).toEqual([]);
});
test("a second run reads 'reused, no query sent' on every lookup", async () => { /* click twice, settle between; every .lookup of the newest trail contains the words */ });
test("the trail says how many values were not followed", async () => { /* a playbook written into the root by `before` with max_values: 1 -> ".playbook-trail" contains "1 values not followed" and the caveat line */ });
test("the verdict never calls an incomplete inventory's silence a proven negative", async () => {
  // before: remove the assets inventory from the root, leaving only leases (not complete)
  p.click(".playbook-block button.belongs"); await p.settle();
  expect(p.q(".belongs-verdict").textContent).toBe("Not seen in any inventory; none is complete, so this proves nothing");
  expect(p.q(".belongs-lines").textContent).toContain("Not in Lease records · not proof: it is not declared complete");
  expect(p.root.textContent).not.toMatch(/proven/i);
});
test("with the complete asset list it reads proven for its scope, and known for an address on the list", async () => { /* START -> "Not a known asset: proven for internal hosts"; a card holding 192.0.2.17 -> "Known asset" */ });
test("the buttons are disabled in replay and when the reason is blank", async () => { /* both */ });
```
`tests/web/commands.test.ts`: `parseCommand("run playbook address-triage on 198.51.100.77", inCase)` is `{ kind: "playbook", id: "address-triage", value: "198.51.100.77" }`; outside a case it is the "Open a case first" line; `perform` with an unknown id says `There is no playbook nope`. `tests/web/steps.test.ts`: a proposed plan with a playbook step shows `Playbook: Triage an address · up to 8 lookups · no model`.

- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement** (DOM nodes only, through `ui.h`; no HTML strings). **Step 4: Run (PASS), `timeout 300 bun test tests/web` with `WORKBENCH_REQUIRE_BROWSER=1`, full suite, typecheck; commit**

```bash
git add src/web/panels/playbook.ts src/web/belongs.ts src/web/panels/pivot.ts src/web/commands.ts src/web/lenses/steps.ts src/web/style.css tests/web/playbook.test.ts tests/web/commands.test.ts tests/web/steps.test.ts
git commit -m "feat(web): start a playbook or ask 'does it belong?' from the Pivot panel or the command bar, and follow it step by step"
```

---

### Task 7: Timeline becomes Worklog

**Files:**
- Create: `src/web/lenses/soon.ts`
- Modify: `src/web/lenses/worklog.ts`, `src/web/lenses/index.ts`, `src/web/views/shelf.ts`, `src/web/style.css` (the `.worklog` and `.lens-button.soon` rules, and `.stage-button.mark-sent-back` in the attention colour for Task 0 part E), `docs/gui-guide.md` (§5.3: the Timeline and Worklog lines), `tests/web/lenses-simple.test.ts`
- Delete: `src/web/lenses/timeline.ts`

**Interfaces (Produces):**
```ts
// src/web/lenses/worklog.ts
/** Entry types the Activity view has a row for. A step.finished counts only when it was reused. */
export const ACTIVITY: ReadonlySet<string>;     // card.created, query.issued, stage.started, stage.finished, stage.sent_back, gate.waiting, gate.passed, draft.revised, product.published, playbook.started, playbook.finished
export function worklogRows(state: CaseState, entries: readonly Entry[], view: { every: boolean; kinds: ReadonlySet<"human" | "agent" | "system"> }): Entry[];   // in seq order, up to state.seq
export function makeWorklog(ui: Ui, open: Open): View;
// src/web/lenses/soon.ts
export function makeSoon(ui: Ui, title: string, text: string): View;
// LensDef gains  soon?: true
```
- The Worklog opens on Activity. A checkbox `Every entry` (remembered with `ui.prefs` under `worklog.every`) switches to every entry. The three actor checkboxes filter both views. Each row: UTC time with milliseconds, the actor-kind tag, the actor id, what, and the detail as text (not only a tooltip). A `card.created` row whose card still exists is a button that calls `nav.focusCard`, muted when the card is not in a lane. Rows are in seq order; a card's event time is not used.
- The Timeline entry in `LENSES` becomes `{ id: "timeline", key: "t", title: "Timeline", soon: true, make: (ui) => makeSoon(ui, "Timeline", "Soon: what was observed, on the data's own time axis. What the system did is in the Worklog (W).") }`. The shelf button reads `Timeline T · soon` with class `soon`. Key `t` and `open timeline` still open it.

- [ ] **Step 1: Write the failing tests** in `tests/web/lenses-simple.test.ts` (replace the Timeline tests; keep the Worklog test's assertions under "Every entry"):

```ts
test("the Worklog opens on what the system did, in the order of record, in UTC with milliseconds", async () => {
  await published(); p.press("w");
  const rows = p.all(".lens .worklog-row");
  const want = p.s.entries("CASE-1").filter((e) => ACTIVITY.has(e.type) || (e.type === "step.finished" && typeof e.payload.reused === "string"));
  expect(rows.map((r) => r.dataset.seq)).toEqual(want.map((e) => String(e.seq)));
  expect(rows[0]!.querySelector("time")!.textContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
test("Every entry shows every entry, and the choice is remembered", async () => { /* tick it: rows.length === entries.length; close and reopen the lens: still ticked */ });
test("the actor filters apply to both views", async () => { /* untick Agent in Activity and in Every entry: no row has the agent tag */ });
test("a card's row goes to the card and is muted until the card is kept", async () => { /* click -> navCalls has ["focusCard", id] */ });
test("Timeline is on the shelf marked soon, opens its explanation, and makes no rows", async () => {
  expect(p.q('.shelf [data-lens="timeline"]').textContent).toBe("Timeline T · soon");
  p.press("t");
  expect(p.q(".lens").textContent).toContain("on the data's own time axis");
  expect(p.all(".timeline-row")).toEqual([]);
});
```
- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement; delete `timeline.ts` and its import.** In `docs/gui-guide.md` §5.3 the two lines become: "**Timeline:** *soon* — what was observed, on the data's own time axis." and "**Worklog:** what the system did, in the order of record (human, agent, system); every entry one toggle away."
- [ ] **Step 4: Run (PASS), `grep -rn "timelineRows\|makeTimeline" src tests` (no hit), full suite with the browser, typecheck; commit**

```bash
git add src/web/lenses/worklog.ts src/web/lenses/soon.ts src/web/lenses/index.ts src/web/views/shelf.ts src/web/style.css docs/gui-guide.md tests/web/lenses-simple.test.ts
git rm src/web/lenses/timeline.ts
git commit -m "feat(web): the Timeline lens becomes the Worklog; Timeline stays on the shelf marked soon"
```

---

### Task 8: Custody acceptance and the documents

**Files:**
- Create: `tests/sample/playbook-custody.test.ts`
- Modify: `README.md`, `docs/security-notes.md`, `docs/gui-guide.md` (§5.4, the Pivot panel), `sample/README.md`, `tests/repo/` (the README test, if it checks quoted manifests)

- [ ] **Step 1: Write the test `tests/sample/playbook-custody.test.ts`** (`served()`):

```ts
test("after a playbook and a does-it-belong, every card traces to its query, result and bytes; the chain verifies; replay equals live", async () => {
  await s.command(id, "run_playbook", { playbook: "address-triage", inputs: [SAMPLE_START], window: SAMPLE_WINDOW, why: "first look" });
  await s.app.hub.idle();
  await s.command(id, "check_belongs", { type: "address", value: SAMPLE_START.value, window: SAMPLE_WINDOW, why: "is it ours" });
  await s.app.hub.idle();
  const entries = s.entries(id); const state = s.app.hub.read(id).state;
  for (const c of Object.values(state.cards)) {
    const q = state.queries[c.query!]!;
    expect(q.purpose).toBe("playbook");
    expect(entries.some((e) => e.type === "query.issued" && e.payload.query === q.id && e.job !== null)).toBe(true);
    expect(s.app.hub.read(id).blobs.has(q.result!.blob)).toBe(true);
  }
  // the second job reused the two inventory lookups the first had already answered
  expect(Object.values(state.playbooks).at(-1)!.steps.i1!.lookups[0]!.reused).toBe(true);
  expect(entries.filter((e) => e.type === "model.request")).toEqual([]);
  // verify: the same call tests/sample/full-run.test.ts makes on a finished case -> ok
  // replay: fold entries[0..n] for every n; the last equals `state`; none has a skipped entry
});
```
(Use the blob store's own existence check and the verify call as `tests/sample/full-run.test.ts` uses them.)

- [ ] **Step 2: Run it.** It should pass on Tasks 1 to 5. If it fails, the failure is a defect in an earlier task: fix it there, with a test in that task's file, and say so in the report.
- [ ] **Step 3: Write the documents.** No real name anywhere; every example uses the sample's names.
  - `README.md`, under "Point it at your own data": a section **Playbooks** (the manifest, the whole grammar from the design §5.1, what `rows` and `empty` mean, the limits 12 / 5 / 20 / 50, that it never spends a budget, how to start one, how the planner may offer one, what reuse does) and a section **Inventories** (the manifest, `inventory:` on a pivot, what complete means and that it needs a basis, that a derived list cannot be complete, the three card wordings, "Does it belong?"). In "Before a run": the fit rule. In "Known limits": a playbook cannot be given a budget; a step starts from the type its earlier step's pivot yields, not from a named column; the fast model has no dropdown.
  - `docs/security-notes.md`, under "What the server guarantees": "**A playbook reaches a source only through the runner.**" (what the entries are; `tests/modules/playbook-run.test.ts`, `tests/sample/playbook-custody.test.ts`); "**Playbooks and inventories load only from trusted roots.**" (`tests/modules/playbooks.test.ts`, `tests/modules/inventories.test.ts`). Under "What this does not do": a playbook's steps are fixed text from a trusted root, but the values it follows are source data; a hostile value can cost up to `max_values` lookups a step and 50 a run, all recorded.
  - `docs/gui-guide.md` §5.4: the playbook buttons, the trail, "Does it belong?" and its four verdicts, in the guide's own style.
  - `sample/README.md`: the sample playbook and the two inventories, and what each demonstrates.
- [ ] **Step 4: Run the README test, the hygiene test with the owner's terms (`WORKBENCH_PRIVATE_TERMS=<path> bun test tests/repo`; the controller supplies the path), the full suite, typecheck; commit**

```bash
git add tests/sample/playbook-custody.test.ts README.md docs/security-notes.md docs/gui-guide.md sample/README.md
git commit -m "docs: playbooks and inventories; test: a playbook's cards meet the custody acceptance test"
```

---

### Task 9: The fast decision model (optional; off by default; may be left for 6b)

Independent of Tasks 4 to 8. If the controller leaves it out, nothing else changes.

**Files:**
- Modify: `src/pipeline/manifests.ts`, `src/agents/loop.ts`, `src/pipeline/stages/agent.ts`, `src/cli/preflight.ts`
- Test: `tests/pipeline/manifests.test.ts`, `tests/agents/loop.test.ts`, `tests/pipeline/stage-agent.test.ts`, `tests/cli/preflight.test.ts`

**Interfaces (Produces):**
- `StageManifest` gains `fast_model?: ModelChoice | null` (schema: the same shape as `model`; null when absent).
- `AgentSpec` gains `fast?: { provider: Provider; model: string; effort: string | null }`.
- `resolveAgent(env, actorId, choice?: ModelChoice)`: resolves the stage's chosen model when `choice` is absent, else that one.

Rules (the design §8):

- A turn is a **routing turn** when `spec.fast` is set, the turn is not the last, the agent has not been re-asked, tools are on offer, and the loop is not in "answer now". A routing turn's request goes to `fast.provider` with `fast.model` and `fast.effort`; its `model.request` and `model.response` carry an actor that is the agent's with `model` and `where` set to the fast model's; the marking check for that turn uses `fast.provider.where`.
- When a routing turn's reply holds no tool call, its content is not used: the loop sets "answer now" and the next request goes to the stage's model with `tool_choice: "none"` (and structured output when the provider has it). That request counts as a turn.
- A reply cut at the output limit, a decline, an error and the retry of a failed attempt behave on a routing turn exactly as on any turn.
- `stageAgent`: when the stage has a `fast_model`, resolve it; if it resolves, pass it as `fast` and assemble the pack with `packBudget(Math.min(main.context, fast.context))`; if it does not, pass no `fast` (the stage's model takes every turn).
- `preflight`: a `fast_model` is one more model for the "model listed", "model loaded", "context", "context fit" and "marking policy" checks, named with its stage (`research (fast)`); the question is asked of it too.

- [ ] **Step 1: Write the failing tests** in `tests/agents/loop.test.ts` (two scripted providers, `main` and `fast`):

```ts
test("with a fast model, tool turns go to it and the answer comes from the stage's model", async () => {
  // fast script: [tool call run_pivot, tool call run_pivot, plain text "done"]; main script: [the JSON answer]
  const end = await runAgent(s, { ...spec, fast: { provider: fast, model: "small", effort: null } });
  expect(end.kind).toBe("done");
  const reqs = entries().filter((e) => e.type === "model.request");
  expect(reqs.map((e) => [e.payload.provider, e.payload.model, (e.actor as { model: string }).model])).toEqual([["fast", "small", "small"], ["fast", "small", "small"], ["fast", "small", "small"], ["main", "big", "big"]]);
  expect(JSON.parse(text(reqs[3]!.payload.messages)).tool_choice).toBe("none");
  expect((end as { content: string }).content).not.toContain("done");
});
test("without a fast model nothing changes", async () => { /* the same spec with no `fast`: every request names main; the existing loop tests are untouched */ });
test("a pack the fast model may not receive blocks the stage and makes no call", async () => { /* fast.where "hosted", policy forbids the pack's marking there -> end.kind "blocked"; one model.blocked whose payload.where is "hosted"; no model.request */ });
test("a re-ask and the last turn go to the stage's model", async () => { /* fast returns an empty answer once -> the re-ask's request names main; with max_turns 2 the second request names main */ });
```
`tests/pipeline/manifests.test.ts`: a stage with `fast_model: { provider: scripted, model: x }` loads with `effort: null`; a malformed one is a problem naming `fast_model`; absent is null. `tests/pipeline/stage-agent.test.ts`: a fast model the provider does not list is not used and the stage completes on its own model; the pack budget is the smaller context's. `tests/cli/preflight.test.ts`: a `fast_model` whose provider is not loaded is a `"model listed"` failure naming `research (fast)`.

- [ ] **Step 2: Run; expect FAIL.** **Step 3: Implement.** **Step 4: Run (PASS), full suite, typecheck; commit**

```bash
git add src/pipeline/manifests.ts src/agents/loop.ts src/pipeline/stages/agent.ts src/cli/preflight.ts tests/pipeline/manifests.test.ts tests/agents/loop.test.ts tests/pipeline/stage-agent.test.ts tests/cli/preflight.test.ts
git commit -m "feat(agents): a stage may name a fast model for its tool-choosing turns; off unless a manifest names one"
```

---

### Task 10: The owner's root (the controller's checklist; nothing here is committed)

Everything in this task is typed into `~/workbench-lake/root/`, outside the repository. The real schema, table, column and field names are in that root's existing `pivots.yaml` and `sources/lake.yaml` and in the controller's notes; this checklist names them only by placeholder. Read the owner's query rules (their location is in the notes) before writing a pivot. No lake query is sent by hand: the first statement each new pivot sends is a recorded lookup in step 8.

- [ ] **Step 1: Bring the root up to 6a.** From the repository's `sample/`, copy into the root: `stages/plan.yaml`'s `tools` line (it gains `list_playbooks`; keep the root's own `model`, `max_output_tokens`, `max_turns`), `context/schemas/plan-output.yaml`, `context/schemas/assemble-output.yaml`, `context/standards/icd203.yaml` (keep any term the owner corrected), `context/personas/planner.md`, and `checks/10-change.ts` if Task 0 part F changed it. Add `parallel: 1` to `models/<provider>.yaml`.
- [ ] **Step 2: Check the reply caps.** The owner's stages use larger caps than `new-root`'s defaults. With the model at 131072 tokens in one slot, a cap of 65536 fits exactly; nothing needs lowering. Do not change them.
- [ ] **Step 3: Write the inventory** `inventories/wazuh-agents.yaml`:

```yaml
kind: inventory
id: wazuh-agents
title: Wazuh agents seen in the lake
holds: host
scope: hosts that run a Wazuh agent and reported in the window
complete: false
derived: true
```
- [ ] **Step 4: Write its two pivots** in `pivots.yaml`, in the guarded shape the root's existing archive pivots use (the time column filtered by `{window.from}` and `{window.to}` first, a `group by`, `order by … limit 50`), on `<archive events table>`:
  - `address_to_wazuh_agent`: `from: address`, `to: host`, `inventory: wazuh-agents`, `needs_window: true`, `weight: 0`, no `empty_means` line; selects `<agent name column>`, a count, and the first and last `<event time column>`, where `<agent address column> = {value}`; `yields: { <agent name column>: host }`. Title: "Is the address a Wazuh agent?"
  - `host_to_wazuh_agent`: `from: host`, `to: host`, `inventory: wazuh-agents`, the same shape with `<agent name column> = {value}`. Title: "Is the host a Wazuh agent?"

  A third on `<normalised table>`'s agent fields can follow once these two have run; it is not needed for the first check.
- [ ] **Step 5: Write the device-triage playbooks.** The existing pivots are named here by what they do; use the root's own ids. Two files, because a playbook's inputs are fixed.

`playbooks/device-triage-mac.yaml`:
```yaml
kind: playbook
id: device-triage-mac
title: Triage a device by MAC
about: Where the device has been on WiFi, whether its addresses are Wazuh agents, what they looked up, which hosts saw their flows, and what fired on those hosts.
inputs:
  - { name: mac, type: mac }
steps:
  - { id: wifi,     pivot: <MAC to UniFi events, yields address>,  from: input.mac }
  - { id: agent,    pivot: address_to_wazuh_agent,                 from: wifi, when: wifi.rows, max_values: 3 }
  - { id: names,    pivot: <address to names looked up>,           from: wifi, when: wifi.rows, max_values: 3 }
  - { id: flows,    pivot: <address to hosts that saw its flows>,  from: wifi, when: wifi.rows, max_values: 3 }
  - { id: findings, pivot: <host to detection findings>,           from: flows, when: flows.rows, max_values: 5 }
end: [wifi]
```
`playbooks/device-triage-address.yaml`: the same with `inputs: [{ name: address, type: address }]`, a first step `{ id: wifi, pivot: <address to UniFi clients, yields mac>, from: input.address }`, and `agent`, `names`, `flows` taking `from: input.address` with no `when` and no `max_values`; `end: [flows]`.

  At most 15 lookups for the first and 9 for the second.
- [ ] **Step 6: Preflight.** `bun run preflight --config ~/workbench-lake/config.yaml`. Expected: every line `ok` or `note`, including "manifests" (now counting two playbooks and one inventory), "pivots" (eleven render against the guard), "context fit", and "model answers" (the question sized to 131072 − 2048). A `FAIL` on "context fit" or a refusal of the question means the model is not loaded in one slot: reload it, do not change `parallel` to match.
- [ ] **Step 7: Hygiene.** `WORKBENCH_PRIVATE_TERMS=~/workbench-lake/private-terms.txt bun test tests/repo` passes, and `git -C <repository> status` is clean: nothing from this task is in the repository.
- [ ] **Step 8: With the owner at the browser.** Restart `serve`. Open CASE-1 (or a new case on the same device). On a card holding the device's address: "Does it belong?" (expect "Not seen in any inventory; none is complete, so this proves nothing", or "Known asset"), then "Run Triage a device by MAC". Check, in the Worklog under Every entry: each lookup has `query.issued` with purpose `playbook`; a second run of the playbook sends nothing; no `model.request` was made by either. Run `bun run verify --config ~/workbench-lake/config.yaml <case>`: exit 0.
- [ ] **Step 9: Record** in this plan's execution ledger: the lookup counts, how many were reused, and anything a pivot returned that the playbook's shape did not expect. Later inventory sources (the UniFi client list by MAC, DHCP reservations, the Wazuh manager's own agent list) are each one manifest and one or two pivots; write none of them until the owner asks.

---

## Hand-back

When Tasks 0 to 8 (and 9, if built) are committed: the whole-branch review, one fix wave, then Task 10 with the owner. The rulings to report are the design's §12. Things this plan left for 6b or later: the observed-activity Timeline; the Graph lens; a budget for a playbook; a playbook step from a named column; per-source cost policy; the further inventory sources.
