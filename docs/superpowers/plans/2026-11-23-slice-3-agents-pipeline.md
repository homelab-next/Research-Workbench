# Agents and Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run one investigation from objective to published product with agents doing the legwork: model providers, the context pack, the fixed tools, one agent loop that logs everything, the pipeline engine with its nine stages and two gates, form checks, publishing, feedback, and a headless command that drives the whole thing on the sample with no model.

**Architecture:** One loop (`runAgent`) makes every model call and every tool call, and writes the ledger entry before each. Tools are thin wrappers over plan 2's `runPivot`, `runQuery` and `revalidateCard`, so every source contact still passes the one custody point. The engine is plain code: a pure function (`nextStep`) reads the folded state and says what happens next, a driver does it, and a person's commands (accept the plan, approve, reject, edit, pause) only write entries. Stages, context parts, checks, models and the scripted run are manifests in a module root.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `fetch`, `Bun.spawn`, `Bun.YAML`, `bun test`. No new npm dependencies.

**Spec:** [`docs/superpowers/specs/2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md), sections 6.3, 6.4, 8, 9, 12, 13, 16 and 17. Roadmap: [`2026-11-23-slice-roadmap.md`](2026-11-23-slice-roadmap.md). This is plan 3 of 5. It builds on plan 1 (`src/core/`) and plan 2 (`src/modules/`), on a new branch `slice-3-agents` from `slice-2-modules` at `e046572` (718 tests).

## Global Constraints

- **Everything an agent causes is in the ledger.** `model.request` is written before a provider is contacted and `model.response` or `model.declined` after. `tool.called` is written before a tool runs and `tool.returned` after. Request, response, reasoning and tool-result bytes are blobs.
- **Agents only propose.** No agent keeps, moves or discards a card, accepts a plan or a proposal, or publishes. The person gates the plan and publishing. Nothing is written to any other system; publishing writes a local bundle.
- **Agents never supply budgets.** No tool accepts a budget argument. Costly work becomes a `costly_query` proposal, and only a person's budget runs it, through `runProposal`.
- **One custody point for sources.** Nothing under `src/agents/tools/` or `src/pipeline/` imports from `src/modules/connectors/`. Tools reach sources only through `runPivot`, `runQuery` and `revalidateCard`. `src/cli/` is the only place that builds a `ConnectorPool`.
- **No method named `run`, `estimate` or `estimateRequest`.** `tests/modules/custody.test.ts` flags any `.run(`, `.estimate(` or `.estimateRequest(` call under `src/` outside `src/modules/runner.ts`. Name things `runAgent(...)`, `engine.advance()`, `provider.turn(...)`, `tool.call(...)`.
- **Markings decide where data goes.** The marking of a model call is the strictest of the case marking, every pack item and every tool result already in the conversation. It is checked against `config.marking_policy` and the provider's `where` before every call. A call that is not allowed is not made, and `model.blocked` is written.
- **No secrets** in entries, blobs, prompts, tool views, logs or the repository. Transport headers are never stored. A source's `location`, `credential` and `user` are never shown to a model.
- **Real hostnames and addresses never enter the repository.** Samples and tests use RFC 5737 addresses (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`), `example.*` names and invented accounts. The only network address in tests is `127.0.0.1`.
- **Honest outcomes.** A declined model, a model error, a blocked call and partial coverage are each recorded as themselves, never as an empty answer. Partial coverage is never a proven negative.
- **Code from module roots never runs inside the server.** The one exception is check scripts, which run as separate programs, with a timeout and a stripped environment, and only from roots whose configuration says `trusted: true`. Stage, profile, model, check and script manifests are accepted only from trusted roots.
- **Only a reviewed revision is published.** A draft revision is published only if every review stage passed that exact hash, and the hash is recomputed from the product immediately before publishing.
- **Browser-shared code stays browser-safe:** `src/core/canonical.ts`, `src/core/types.ts`, `src/core/schema.ts` and everything under `src/core/state/` import nothing from `bun:*`, `node:*`, `src/modules/`, `src/agents/` or `src/pipeline/`.
- **The fold never throws and never mutates its input.** New entry types get a reducer branch that validates shape and records a malformed payload in `skipped`.
- **TypeScript:** `strict: true`. No `any` in exported signatures.
- **Tests:** `bun test`, always under a time limit: `timeout 120 bun test <file>` while iterating, `timeout 900 bun test && timeout 300 bun run typecheck` before a commit. No network except stand-ins on `127.0.0.1` started by the test; never the real model. Every test creates its files under a fresh `mkdtempSync` directory and removes it. Every `Workbench` a test opens is closed, including on failure. Every test that drives a session asserts `session.state.skipped` is `[]` afterwards. Test output is clean.
- **Commits:** one per task, on the current branch, never pushed. End every commit message with the attribution lines your own harness reminder gives you (they name the model that wrote the code).

## What plans 1 and 2 built, that this plan must respect

Read `src/core/` and `src/modules/` before starting a task. These are the rules most likely to trip new code.

- **Writing entries.** Everything goes through `CaseSession.commit(build)`. Every id taken with `ids.next(kind)` must be matched by one creating entry of that kind in the same commit (`request` → `model.request`, `call` → `tool.called`, `challenge` → `challenge.raised`, `plan` → `plan.proposed`, `run` → `run.started`, `lane` → `lane.created`, `job` → `job.started`), or the commit throws `IdAllocationError`. A commit from inside a builder throws.
- **`draft.revised` is refused** unless `draft.hash === sha256Hex(canonical(draft.product))`.
- **Typed blob positions.** `BLOB_FIELDS` and `BLOB_NULLABLE` in `src/core/types.ts` list every payload field that holds a blob reference. A required position that is absent or malformed is refused at append.
- **The fold decides what counts.** `stage.finished` counts only while a run is in progress. A later `fail` removes a stage's pass for that draft hash. `publish.rejected` clears every pass for its hash. `run.started` clears all passes. `publishable(state, hash)` and `blockers(state, hash)` in `src/core/state/analysis.ts` are the publish rule; do not reimplement it.
- **Usage is a case total.** `runUsage(state)` gives this run's own figures, and `run.budget_tokens` is measured against it.
- **The runner decides cost.** `runQuery` ignores a budget from an agent and turns an agent's costly query into a `costly_query` proposal (an open one for the same request is reused). `runProposal` is the only way a proposal runs, and only for a human actor.
- **`RunQueryResult`** is one of `done`, `failed`, `needs_budget`, `refused`. `revalidateCard` returns `matches`, `differs`, `could_not_run` or `refused`.
- **The registry loads any manifest kind.** Kinds it does not know (`stage`, `profile`, `persona`, `schema`, ...) load as `LoadedManifest` with `body`, `text` (the Markdown after the front matter, for `.md` files) and `hash`. `registry.all(kind)`, `registry.get(kind, id)` and `registry.rootOf(path)` are how this plan reads them. Files that are not `.yaml`, `.yml` or `.md`, and folders named `data`, are not read as manifests.
- **Trust.** `RootConfig` is `{ path, trusted, credentials }`. Only a trusted root may name a credential, and only one in its `credentials` list.
- **One writer per data directory.** `Workbench.open` holds an exclusive lock until `close()`.
- **`canonical()` refuses** `undefined`, non-finite numbers, sparse arrays and non-plain objects. Anything hashed or logged must be plain JSON.

## Decisions this plan makes

These are the designer's, not the owner's. Each is listed again in the hand-back.

1. **Costly plan steps.** A person gives budgets when accepting the plan (`plan.accepted.budgets`). When a researcher's `run_step` on such a step raises its proposal, the engine (never the tool, never the agent) runs it with `runProposal`, naming the person who accepted the plan as the actor and using exactly their budget, once per step. A costly step with no budget stays an open proposal.
2. **The planner picks routes; code builds the plan.** The planner's output names sub-goals and, for each, a route by pivot ids. Code checks the route is one the seeker returns and builds the `Plan`. `PlanStep.from.value` is `""` for a hop whose value comes from an earlier hop. `PlanStep.estimate` is `null` in this plan (an estimate may contact the source, and only the runner may do that); the estimate appears on the proposal.
3. **Research passes when at least one sub-goal is answered.** Blocked sub-goals are carried to the analyst as gaps. Research goes back to Plan only when no sub-goal was answered. A sub-goal is answered when its last step finished `answered` or `partial`; the researcher's own claim is not trusted.
4. **The publisher does not write narrative.** Spec 8.2 lists `propose_narrative` for the publisher, but any text it added would change the reviewed hash (spec 9.5). The publisher's output is a title and a note that go in the bundle manifest only.
5. **A person's edit or rejection does not count against the send-back cap,** and resuming a run that paused at the cap allows exactly one more send-back along that edge.
6. **A stage stopped mid-way restarts from its beginning on resume.** Its earlier entries stay in the ledger.

## File Structure

```
src/agents/
  providers/types.ts     Provider, TurnRequest, TurnResult, ChatMessage, ToolCall, ToolSpec, ModelInfo
  providers/scripted.ts  replays a script
  providers/local.ts     OpenAI-compatible chat completions
  providers/index.ts     model manifests -> Providers
  context.ts             profiles and context parts read from the registry
  pack.ts                the pack, its budget, the marking rule
  draft.ts               DraftWork, buildProduct, draftOf
  tools/index.ts         the fixed list, parseCall, execTool, views
  tools/sources.ts       list_sources, describe_source, find_routes
  tools/research.ts      run_step, run_pivot, run_query
  tools/cards.ts         list_cards, read_card, verify_card
  tools/analysis.ts      propose_assessment, propose_narrative, request_research, raise_challenge, answer_challenge
  loop.ts                runAgent
src/pipeline/
  recover.ts             closes what a stopped process left open
  manifests.ts           stage and check manifests, loadPipeline
  next.ts                nextStep (pure)
  engine.ts              Engine: the driver and the person's commands
  plans.ts               buildPlan, acceptPlan, denyPlan, requestReplan, spendPlanBudget
  checks.ts              runCheck (a separate program)
  publish.ts             buildBundle, approve, reject
  feedback.ts            computeMops, recordFeedback
  stages/agent.ts        stageAgent: model, pack, loop, outcome mapping
  stages/{frame,plan,research,assemble,checks,evaluate,challenge,publish,feedback}.ts
src/cli/compose.ts       builds every dependency from a Config
src/cli/run.ts           the headless command
sample/models/  sample/context/  sample/stages/  sample/checks/  sample/scripts/
tests/agents/  tests/pipeline/  tests/cli/  tests/sample/full-run.test.ts
tests/helpers/model-standin.ts  tests/helpers/sample-root.ts
```

## Review Focus

1. **A model that calls tools badly.** Arguments that are not JSON, an unknown tool, a tool the stage does not grant, a missing `why`, an extra `budget` argument. Each is a recorded tool error the model can read; nothing runs; the loop goes on. (Tasks 5, 7)
2. **Stricter data arriving mid-conversation.** A tool returns a card from a source marked stricter than the chosen model may receive. The next model call is not made, `model.blocked` is written, and the run pauses. (Task 7)
3. **A model endpoint that is down, slow or returns rubbish.** Connection refused, a timeout, a 500, a body that is not JSON, no choices. The call is recorded with stop `error`, the run pauses saying why, and nothing downstream sees an empty answer. (Tasks 3, 8)
4. **A draft that changes after it was reviewed.** A person edits while review is running, or approves a draft that is not the latest, or whose stored hash no longer matches its product. Nothing is published and the reason is given. (Tasks 10, 12)
5. **A check script that misbehaves.** It hangs, crashes, prints something that is not findings, or looks for credentials in its environment. It is a failed check with a reason; the run does not hang; the environment has no credentials; a script from an untrusted root never runs; a Checks stage with nothing to run fails. (Task 11)

---

### Task 0: Close out plan 2

**Run this task first.** Plan 2's final re-review left one security gap, one vacuous test pair and four small gaps. The ledger ruling "plan 2 close-out" sends them here, with `source_hash` on proposals.

**Files:**
- Modify: `src/modules/registry.ts`, `src/modules/runner.ts`, `src/modules/proposals.ts`, `src/modules/observables.ts`, `src/modules/connectors/shared.ts`, `src/modules/connectors/http.ts`, `src/core/types.ts`, `src/core/state/run.ts`, `docs/superpowers/plans/2026-11-23-slice-2-modules.md`
- Test: `tests/modules/registry.test.ts`, `tests/modules/runner.test.ts`, `tests/modules/connector-http.test.ts`, `tests/modules/observables.test.ts`, `tests/core/state-run.test.ts`

**Interfaces:**
- Consumes: everything named in the files above.
- Produces:
  - `Proposal` (kind `costly_query`) gains `source_hash: string`.
  - `RunQueryInput` gains `accept?: { proposal: string } | null`.
  - No other name changes.

**An eighth change (controller ruling, added after the plan was written):** a manifest id loaded from two different roots is no longer "first loaded wins". The same kind and id from two roots is a registry problem for both and neither loads (within one root the existing first-wins rule stays). Otherwise an untrusted root listed first could take a trusted pivot's or source's id. Test: a trusted and an untrusted root both defining pivot `p1` → two problems, `registry.pivot("p1")` is null.

**The seven changes:**

- **(a) A pivot may not borrow a source.** In `Registry.crossCheck`: a pivot from an untrusted root may name only a source loaded from that same root. A pivot from a trusted root may name a source from its own root or from any trusted root. Otherwise the pivot is rejected with `pivot "<id>": source "<source>" belongs to another root; only a pivot from a trusted root may use it` and dropped.
- **(b) The proven-negative tests test something.** In `tests/modules/runner.test.ts`, "zero rows on a not-seen pivot is not a proven negative" and "zero rows with partial coverage is never a proven negative" pass `base.text` with a pivot, so the pivot is dropped and the test is vacuous. Pass the pivot's own text (`registry.pivot("seen")!.query`, `registry.pivot("peers")!.query`). Add the pair below.
- **(c) Nothing is accepted that does not run.** `runProposal` no longer writes `proposal.accepted` itself. It passes `accept: { proposal: p.id }` to `runQuery`, which writes `proposal.accepted` (actor `input.actor`, cause the proposal's `seq`, the budget given) only when the result query is about to be issued, and uses that entry as the query's cause. `accept` is ignored unless the actor is human. A refusal or `needs_budget` leaves the proposal open.
- **(d) The echo check sees more encodings.** `assertNoEcho` also matches the base64 of each secret at all three byte alignments (encode the secret prefixed by 0, 1 and 2 filler bytes and drop the leading and trailing partial groups). `HttpConnector` also passes `Bearer <secret>`.
- **(e) The pattern probe tries literal prefixes.** `probePattern` also probes, for each literal prefix of the pattern (the characters before its first quantified element), that prefix followed by each probe body.
- **(f) The plan 2 document matches the code.** Replace every `trusted_scripts` in `docs/superpowers/plans/2026-11-23-slice-2-modules.md` (lines 66, 95, 108, 177, 183) with the `{ path, trusted, credentials }` shape.
- **(g) Proposals cite their source.** `runQuery` writes `source_hash: source.hash` on a `costly_query` proposal; the fold's `isProposal` requires it; `openProposalFor` reuses only a proposal with the current hash; `runProposal` refuses with `the source <id> has changed since the proposal` when the hashes differ.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/modules/registry.test.ts
test("a pivot from an untrusted root may not name a trusted root's source", () => {
  // trusted root: http source `rep` (weight 5). untrusted root: pivot a_free_rep { source: rep, weight: 0, empty_means: proven-negative }
  expect(r.pivot("a_free_rep")).toBeNull();
  expect(r.problems.map((p) => p.error)).toContain('pivot "a_free_rep": source "rep" belongs to another root; only a pivot from a trusted root may use it');
});
test("an untrusted root's pivot may use its own sources", ...);
test("a trusted root's pivot may use another trusted root's source, never an untrusted one", ...);

// tests/modules/runner.test.ts
test("the same empty answer is a proven negative with full coverage and not-seen with partial", async () => {
  const text = registry.pivot("peers")!.query;                 // the proven-negative pivot
  await runQuery(s, stubDeps({ coverage: { kind: "full" } }), { ...none, text, pivot: registry.pivot("peers")! });
  await runQuery(s, stubDeps({ coverage: { kind: "partial", reason: "timeout" } }), { ...none, text, pivot: registry.pivot("peers")! });
  expect(s.state.cards.c1!.empty).toBe("proven-negative");
  expect(s.state.cards.c2!.empty).toBe("not-seen");
});
test("a proposal carries its source's hash", ...);                                   // proposal.source_hash === registry.source(id).hash
test("a proposal whose source has changed is refused and stays open", ...);          // reload the registry with an edited source
test("a budget below the fresh estimate leaves the proposal open", async () => {
  const r = await runProposal(s, deps, { proposal: "p1", budget: 0.5, actor: human });
  expect(r.status).toBe("needs_budget");
  expect(s.state.proposals.p1!.status).toBe("open");
  expect(s.entries().some((e) => e.type === "proposal.accepted")).toBe(false);
  expect((await runProposal(s, deps, { proposal: "p1", budget: 1, actor: human })).status).toBe("done");
});
test("a proposal the guard now refuses stays open", ...);
test("the accepted entry is the cause of the query it paid for", ...);

// tests/modules/connector-http.test.ts
test("a body holding base64 of the bearer header, or of the secret at any offset, is refused", ...);
// bodies: btoa("Bearer " + secret), btoa("x" + secret), btoa("xy" + secret + "z") -> query.failed "the source echoed the credential; result refused"

// tests/modules/observables.test.ts
test("a pattern that blows up only after a literal prefix is refused", () => {
  expect(probePattern("id-\\d*\\d*\\d*\\d*z")).toBeGreaterThan(PATTERN_PROBE_LIMIT_MS);
  expect(probePattern("x\\s*\\s*\\s*\\s*y")).toBeGreaterThan(PATTERN_PROBE_LIMIT_MS);
});

// tests/core/state-run.test.ts
test("a costly_query proposal without source_hash is malformed", ...);               // recorded in skipped
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 300 bun test tests/modules tests/core/state-run.test.ts`
Expected: the new tests fail; the two corrected tests pass.

- [ ] **Step 3: Make the seven changes.** Update every existing test fixture that builds a `costly_query` proposal to carry `source_hash`.

- [ ] **Step 4: Prove (b) by mutation.** In a scratch copy, remove `&& out.coverage.kind === "full"` from `runner.ts`; `bun test tests/modules/runner.test.ts` must now fail. Do not commit the mutation.

- [ ] **Step 5: Run the whole suite and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src tests docs/superpowers/plans/2026-11-23-slice-2-modules.md
git commit -m "fix(modules): close out plan 2: pivots may not borrow sources, proposals cite their source and are accepted only when they run"
```

---

### Task 1: Core additions and session recovery

**Files:**
- Modify: `src/core/types.ts`, `src/core/state/types.ts`, `src/core/state/index.ts`, `src/core/state/run.ts`, `src/core/state/analysis.ts`
- Create: `src/pipeline/recover.ts`
- Test: `tests/core/state-run.test.ts`, `tests/core/state-analysis.test.ts`, `tests/core/ledger.test.ts`, `tests/pipeline/recover.test.ts`

**Interfaces:**
- Consumes: `Payloads`, `BLOB_FIELDS`, `BLOB_NULLABLE`, `ENTRY_TYPES`, `CaseState`, `initial`, `CaseSession`.
- Produces:
  - `Payloads["check.run"]` gains `output: BlobRef` (the script's raw standard output). `BLOB_FIELDS["check.run"]` is `["input", "output"]`, both not nullable. The fold requires it.
  - `Payloads["stage.pack_limit_set"]: { stage: string; max_marking: Marking | null }` and `CaseState.pack_limits: Record<string, Marking>` (`null` removes the stage's limit). It applies with or without a run, like `stage.model_set`.
  - `Payloads["case.anchored"]: { case: string; seq: number; hash: string; why: "published" | "closed" }`. Written on the workbench chain only; the case fold ignores it.
  - `recoverSession(session: CaseSession): { queries: string[]; jobs: string[]; interrupted: boolean }`

`recoverSession` is called once, right after a case that was not created in this process is opened. In one commit, actor `{ kind: "system", id: "recovery" }`: for every query with status `running`, `query.failed { query, error: "interrupted" }` with cause its `issued_seq`; for every job with status `running`, `job.finished { job, outcome: "failed" }`; and `run.interrupted` when `run.status` is `running`. It writes nothing when there is nothing to close.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/core/state-analysis.test.ts
test("check.run without an output reference is malformed", ...);                 // skipped, review unchanged
// tests/core/ledger.test.ts
test("check.run with no output is refused at append", ...);                      // TypeError naming check.run and output
// tests/core/state-run.test.ts
test("stage.pack_limit_set records the limit and null removes it", () => {
  b.add("stage.pack_limit_set", { stage: "assemble", max_marking: "TLP:GREEN" });
  expect(fold(b.entries).pack_limits).toEqual({ assemble: "TLP:GREEN" });
  b.add("stage.pack_limit_set", { stage: "assemble", max_marking: null });
  expect(fold(b.entries).pack_limits).toEqual({});
});
test("an unknown marking in stage.pack_limit_set is malformed", ...);
test("case.anchored changes nothing but seq in a case fold", ...);

// tests/pipeline/recover.test.ts
test("a query left running is closed as failed: interrupted", () => {
  // commit query.issued only, close the workbench, reopen, recoverSession
  expect(r.queries).toEqual(["q1"]);
  expect(s.state.queries.q1).toMatchObject({ status: "failed", error: "interrupted" });
  expect(s.entries().at(-1)!.cause).toBe(s.state.queries.q1!.issued_seq);
});
test("a running job is finished as failed and a running run is marked interrupted", ...);
test("a waiting or paused run is left as it is", ...);
test("recovering twice writes nothing the second time", ...);                    // head seq unchanged
test("the case still verifies after recovery", ...);                             // verifyCase(dir).ok
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/core tests/pipeline/recover.test.ts`
Expected: FAIL.

- [ ] **Step 3: Make the core changes.** Add the three payload changes, the runtime list entries, the `initial()` field and the reducer branches. Update every existing test that builds a `check.run` entry to carry `output`.

- [ ] **Step 4: Implement `recoverSession` in `src/pipeline/recover.ts`**

- [ ] **Step 5: Run the whole suite and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core src/pipeline/recover.ts tests/core tests/pipeline
git commit -m "feat(core): check output blobs, pack limits, case anchors; recovery closes what a stopped process left running"
```

---

### Task 2: Provider interface, model manifests, the `scripted` provider

**Files:**
- Create: `src/agents/providers/types.ts`, `src/agents/providers/scripted.ts`, `src/agents/providers/index.ts`, `sample/models/scripted.yaml`
- Test: `tests/agents/scripted.test.ts`, `tests/agents/providers.test.ts`

**Interfaces:**
- Consumes: `Registry`, `Secrets`, `Where`, `Json`, `Schema`, `validate`, `canonical`, `Usage` (from `src/core/state`).
- Produces (`providers/types.ts`):

```ts
export interface ToolSpec { name: string; description: string; parameters: Schema }
/** `arguments` is the text the model gave, unparsed. */
export interface ToolCall { id: string; name: string; arguments: string }
export interface ChatMessage { role: "system" | "user" | "assistant" | "tool"; content: string; tool_calls?: ToolCall[]; tool_call_id?: string }
export interface ModelInfo { id: string; context: number | null; efforts: string[] }
/** `key` is the calling agent's actor id; `ordinal` is how many model requests that actor id has already made in the case. */
export interface TurnRequest { model: string; effort: string | null; messages: ChatMessage[]; tools: ToolSpec[]; key: string; ordinal: number }
export type TurnResult =
  | { kind: "answer"; content: string; reasoning: string | null; tool_calls: ToolCall[]; stop: "end" | "tool_calls" | "length"; usage: Usage; served_by: string; raw: Uint8Array }
  | { kind: "declined"; reason: string; served_by: string; raw: Uint8Array }
  | { kind: "error"; message: string; raw: Uint8Array | null };
export interface Provider {
  readonly id: string;
  readonly kind: "scripted" | "local";
  readonly where: Where;
  models(): Promise<ModelInfo[]>;
  /** The exact request body `turn` sends for this request. Pure; contacts nothing; never holds a header. */
  body(req: TurnRequest): Uint8Array;
  /** One model turn. Never throws: transport and protocol failures are `kind: "error"`. */
  turn(req: TurnRequest): Promise<TurnResult>;
}
```

- Produces (`scripted.ts`):

```ts
export type ScriptReply =
  | { content?: string; reasoning?: string; tool_calls?: { tool: string; args: Record<string, Json> }[]; usage?: Partial<Usage> }
  | { declined: string }
  | { error: string };
export interface ScriptTurn { actor: string; reply: ScriptReply }
export interface Script { id: string; turns: ScriptTurn[] }
export class ScriptedProvider implements Provider { constructor(opts: { id: string; scripts: Script[] }); }
export function toScript(manifest: LoadedManifest): Script;   // throws ManifestError on a bad body
```

- Produces (`index.ts`):

```ts
export class Providers { constructor(list: Provider[]); get(id: string): Provider | null; all(): Provider[] }
export function loadProviders(registry: Registry, secrets: Secrets): { providers: Providers; problems: Problem[] }
```

**The scripted provider.** A script is a `kind: script` manifest: `{ kind: script, id, title, turns: [{ actor, reply }] }`. Each script is one model, whose id is the script id. `turn(req)` takes the script named by `req.model`, keeps the turns whose `actor` equals `req.key`, and replays the one at index `req.ordinal`. The position is derived from the ledger by the caller, so a run split over several processes replays correctly.

- No such script, or no turn at that index: `{ kind: "error", message: "script <id> has no turn <ordinal + 1> for <key>" }`.
- `{ declined }` and `{ error }` replies become those kinds.
- Otherwise an `answer`: `stop` is `tool_calls` when the reply has any, else `end`. Tool call ids are `call-<ordinal>-<i>`. `arguments` is `JSON.stringify(args)`. `served_by` is the script id. `usage` defaults to `ceil(chars / 4)` of the request body, the content and the reasoning. `raw` is `canonical()` of the resolved reply.
- **Card placeholders.** Any string in `content` or `args` may hold `{{card:<title>}}`. Before replying, the provider parses every `tool` message in the request as JSON and collects every object that has string `id` and `title`; each placeholder is replaced by the id of the card with that exact title. One that cannot be resolved is `{ kind: "error", message: "script <id> refers to a card titled \"<title>\" that this conversation has not shown" }`. This keeps a script correct when parallel researchers number cards in a different order.
- `body(req)` is `canonical({ model, effort, key, ordinal, messages, tools })`.
- `where` is `machine`. `models()` lists each script with `context: null, efforts: []`.

**Model manifests.**

```yaml
kind: model
id: scripted          # the provider id a stage's model choice names
title: Scripted run
provider: scripted    # scripted | local
where: machine
# local only (Task 3): base_url, credential, context, efforts, timeout_ms
```

`loadProviders` reads every `model` manifest. It rejects (as a `Problem`, the rest still load): a manifest from an untrusted root; an unknown `provider`; a duplicate id; a body that fails the schema. A `scripted` provider holds every `script` manifest that loads from a trusted root; a bad script is a problem and is left out. In this task `provider: local` is a problem reading `the local provider is not built yet`; Task 3 replaces that.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agents/scripted.test.ts
test("replays the turn at the caller's ordinal for the caller's key", async () => {
  const p = new ScriptedProvider({ id: "scripted", scripts: [{ id: "s", turns: [
    { actor: "planner", reply: { content: "one" } }, { actor: "analyst", reply: { content: "A" } }, { actor: "planner", reply: { content: "two" } },
  ] }] });
  const r = await p.turn({ ...req, model: "s", key: "planner", ordinal: 1 });
  expect(r).toMatchObject({ kind: "answer", content: "two", stop: "end", served_by: "s" });
});
test("tool calls carry ids and their arguments as JSON text", ...);       // id "call-0-0", stop "tool_calls"
test("reasoning is returned beside the answer", ...);
test("a declined reply and an error reply are returned as themselves", ...);
test("running past the script is an error naming the turn", ...);         // message "script s has no turn 3 for planner"
test("a card placeholder is resolved from the tool results in the conversation", async () => {
  const messages = [...base, { role: "tool", tool_call_id: "x", content: JSON.stringify({ cards: [{ id: "c7", title: "Asset: 192.0.2.17" }] }) }];
  const r = await p.turn({ ...req, messages, key: "analyst", ordinal: 0 });   // reply args: { cites: ["{{card:Asset: 192.0.2.17}}"] }
  expect(r.kind === "answer" && JSON.parse(r.tool_calls[0]!.arguments).cites).toEqual(["c7"]);
});
test("an unresolved card placeholder is an error, not a guess", ...);
test("the body is canonical and the same for the same request", ...);
test("usage is deterministic", ...);

// tests/agents/providers.test.ts
test("the sample root yields the scripted provider on this machine", ...);         // providers.get("scripted")!.where === "machine", problems []
test("a model manifest from an untrusted root is a problem, not a provider", ...);
test("an unknown provider kind and a duplicate id are problems", ...);
test("a script with a turn that has no actor is left out with a problem", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/scripted.test.ts tests/agents/providers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `providers/types.ts`, `scripted.ts`, `index.ts`, and write `sample/models/scripted.yaml`** as shown above.

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass, including `tests/sample/sample.test.ts` (the new manifest is not a problem).

- [ ] **Step 5: Commit**

```bash
git add src/agents/providers sample/models tests/agents
git commit -m "feat(agents): provider interface, model manifests and the scripted provider"
```

---

### Task 3: The `local` endpoint provider

**Files:**
- Create: `src/agents/providers/local.ts`, `tests/helpers/model-standin.ts`
- Modify: `src/agents/providers/index.ts`
- Test: `tests/agents/local.test.ts`, `tests/agents/providers.test.ts`

**Interfaces:**
- Consumes: `Provider`, `TurnRequest`, `TurnResult`, `ModelInfo` (Task 2); `Secrets`; `parseBase`, `LOOPBACK`, `readCapped`, `scrub`, `assertNoEcho`, `loadCredential` from `src/modules/connectors/shared.ts` (helpers only; this file contacts no source).
- Produces:
  - `class LocalProvider implements Provider { constructor(opts: { id: string; base_url: string; where: Where; credential: string | null; secrets: Secrets; context: number | null; efforts: string[]; timeout_ms: number; max_bytes?: number }) }`
  - `const DEFAULT_CONTEXT = 8192`, `const MODEL_MAX_BYTES = 16 * 1024 * 1024`
  - `startModelStandin(opts: { models?: { id: string; loaded_context_length?: number }[]; details?: boolean; replies: (StandinReply | ((body: Record<string, Json>) => StandinReply))[] }): { url: string; requests: SeenRequest[]; stop(): void }` where `StandinReply = { status?: number; json?: Json; text?: string; delayMs?: number; redirect?: string }` and `url` ends in `/v1`.

**The protocol.** The owner's endpoint is LM Studio at `http://127.0.0.1:1234/v1`, model id `qwen/qwen3.6-35b-a3b`, loaded context 131072, returning `reasoning_content`. That address belongs in the owner's own model manifest (plan 5), not in this repository. Tests use the stand-in, shaped like it.

- `models()`: `GET <base>/models` gives `{ data: [{ id }] }`. Then `GET <origin>/api/v0/models` gives `{ data: [{ id, loaded_context_length }] }`; when that answers, each model's `context` is its `loaded_context_length`. Otherwise `context` is the manifest's `context`, else `DEFAULT_CONTEXT`. `efforts` is the manifest's list. A failure of the first request rejects with an error whose message holds no credential.
- `body(req)`: `JSON.stringify` of `{ model, messages, tools: [{ type: "function", function: { name, description, parameters } }], stream: false }`, with `tools` left out when empty and `reasoning_effort: effort` added only when `effort` is in the manifest's `efforts`. Messages map one to one; an assistant tool call is `{ id, type: "function", function: { name, arguments } }`.
- `turn(req)`: `POST <base>/chat/completions` with exactly `body(req)`, `content-type: application/json`, `authorization: Bearer <secret>` only when a credential is named, `redirect: "error"`, and the timeout. The reply is read with `readCapped` up to `max_bytes`.
  - `choices[0].message.content` (null becomes `""`), `.reasoning_content` (absent or empty becomes `null`), `.tool_calls[].{id, function.name, function.arguments}`.
  - `finish_reason`: `stop` → `end`, `tool_calls` → `tool_calls`, `length` → `length`. `content_filter`, or a message with a non-empty `refusal`, is `declined` with that text as the reason.
  - `usage`: `input = prompt_tokens`, `output = completion_tokens`, `reasoning = completion_tokens_details.reasoning_tokens`, each `0` when absent.
  - `served_by` is the reply's `model`, else the requested model. `raw` is the bytes received.
  - Anything else is `{ kind: "error" }` with a one-line message: a status that is not 200 (`the endpoint answered <status>`), a body that is not JSON, no `choices`, an unknown `finish_reason`, a timeout (`no answer within <ms> ms`), a refused connection, a redirect, a reply over the cap. Every message passes through `scrub` with the secret.
  - A reply that contains the credential in any form `assertNoEcho` knows is `{ kind: "error", message: "the endpoint echoed the credential; response refused", raw: null }`. The bytes are not kept.

**Manifest rules** (`loadProviders`, replacing Task 2's placeholder):

```yaml
kind: model
id: lmstudio
title: Local model
provider: local
where: machine
base_url: http://127.0.0.1:1234/v1
credential: null
context: null
efforts: []
timeout_ms: 120000
```

- `base_url` is https, or http for a loopback host only (`parseBase`).
- `where: machine` is accepted only for a loopback host; any other host must say `network` or `hosted`.
- A `credential` must be in the root's `credentials` list.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agents/local.test.ts
test("lists models with the context the endpoint has loaded", async () => {
  const m = startModelStandin({ models: [{ id: "qwen/qwen3.6-35b-a3b", loaded_context_length: 131072 }], replies: [] });
  expect(await provider(m.url).models()).toEqual([{ id: "qwen/qwen3.6-35b-a3b", context: 131072, efforts: [] }]);
});
test("without the details endpoint the manifest's context is used, else the default", ...);   // details: false -> 8192
test("sends exactly the bytes body() returned and no stored header", async () => {
  expect(m.requests[0]!.body).toBe(new TextDecoder().decode(p.body(req)));
  expect(new TextDecoder().decode(p.body(req))).not.toContain("authorization");
});
test("an answer carries content, reasoning, usage and the model that served it", ...);
// reply: { choices: [{ finish_reason: "stop", message: { content: "ok", reasoning_content: "thinking" } }], usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 3 } }, model: "served" }
// -> { kind: "answer", content: "ok", reasoning: "thinking", stop: "end", usage: { input: 10, output: 4, reasoning: 3 }, served_by: "served" }
test("tool calls come back with their argument text untouched", ...);          // arguments '{"why": "x", "value": "a\\"b"}' kept byte for byte
test("a length stop and a content filter are told apart", ...);                // "length" -> answer/length; "content_filter" -> declined
test("the credential is sent as a bearer token and never returned", ...);      // header seen by the stand-in; JSON.stringify(result) lacks it
test("a 500, a non-JSON body, no choices and an unknown finish reason are errors", ...);
test("a slow endpoint is an error after the timeout, not a hang", ...);        // delayMs 2000, timeout_ms 200 -> message "no answer within 200 ms"
test("a refused connection is an error", ...);                                 // stop the stand-in first
test("a redirect is refused", ...);
test("a reply over the size cap is an error", ...);                            // max_bytes 1024
test("a reply that echoes the credential is refused and its bytes are dropped", ...);
test("turn never throws", ...);                                                // every case above resolved, none rejected

// tests/agents/providers.test.ts
test("a local model on another host may not say it is on this machine", ...);  // base_url https://models.example.net/v1, where machine -> problem
test("plain http is accepted for loopback only", ...);
test("a credential the root was not granted is a problem", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/local.test.ts tests/agents/providers.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `tests/helpers/model-standin.ts`** on `startStandin`, with routes `GET /v1/models`, `GET /api/v0/models` (404 when `details` is false) and `POST /v1/chat/completions` (replies consumed in order; none left is a 500).

- [ ] **Step 4: Implement `LocalProvider` and the manifest rules**

- [ ] **Step 5: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/providers tests/agents tests/helpers/model-standin.ts
git commit -m "feat(agents): local endpoint provider for chat completions with tool calls"
```

---

### Task 4: Context parts, the pack, its budget, the marking rule

**Files:**
- Create: `src/agents/context.ts`, `src/agents/pack.ts`, and the sample context below
- Test: `tests/agents/context.test.ts`, `tests/agents/pack.test.ts`, `tests/helpers/sample-root.ts`

**Interfaces:**
- Consumes: `Registry`, `LoadedManifest`, `CaseState`, `CardState`, `PackItem`, `Marking`, `Where`, `isMarking`, `strictest`, `MARKINGS`, `sha256Hex`.
- Produces (`context.ts`):

```ts
export class ContextError extends Error {}
export interface PackPart { kind: string; id: string; title: string; text: string; marking: Marking | null; fixed: boolean }
export interface ProfileStage { agent: string; persona: string; goal: string; procedure: string | null; skills: string[]; references: string[]; gates: string[] }
export interface Profile { id: string; title: string; hash: string; rules: string; framework: string | null; standard: string | null; stages: Record<string, ProfileStage> }
export function loadProfile(registry: Registry, id: string): Profile;                                  // throws ContextError
export function partOf(registry: Registry, kind: string, id: string, fixed?: boolean): PackPart;       // throws ContextError
export function stageParts(registry: Registry, profile: Profile, stage: string, opts: { schema: string | null; objective: string | null }): PackPart[];
export function casePart(state: Readonly<CaseState>): PackPart;
export function cardPart(card: CardState): PackPart;
export function schemaOf(registry: Registry, id: string): Schema;                                      // throws ContextError
```

- Produces (`pack.ts`):

```ts
export const CHARS_PER_TOKEN = 3;
export const PACK_SHARE = 0.5;
export interface Pack { parts: PackPart[]; items: PackItem[]; left_out: PackItem[]; chars: number; budget: number; marking: Marking }
export function packBudget(contextTokens: number): number;       // Math.floor(contextTokens * PACK_SHARE) * CHARS_PER_TOKEN
export function assemblePack(parts: PackPart[], opts: { budget: number; case_marking: Marking; max_marking: Marking | null }): Pack | { too_big: PackItem[] };
export function renderPack(pack: Pack): string;
export function mayGo(marking: Marking, where: Where, policy: Record<Marking, Where[]>): boolean;
export function tooStrict(marking: Marking | null, max: Marking | null): boolean;   // true when max is set and marking is stricter than it
```

**Context parts** are manifests. A part's `text` is the Markdown after the front matter for a `.md` file, and `JSON.stringify(body, null, 2)` for a `.yaml` file. Its `marking` is the manifest's `marking` when that is a valid marking, else `null`. `partOf` throws `ContextError` naming the kind and id when the manifest is missing, comes from an untrusted root, or has empty text.

`stageParts` returns, in this order: the profile's rules (fixed); the stage's persona; a `goal` part made from the profile's goal text (id `<stage>-goal`); the procedure; each skill; the output schema (fixed, when `opts.schema` is set); each reference; each gate; the objective (when set); the framework; the standard. `casePart` is fixed, kind `case`, marked with the case marking, and states the case id, title, what was asked and why, the starting values and the window. `cardPart` is kind `card`, marked with the card's marking: title, body, source, coverage, what empty means, and the first 10 preview rows.

**The pack.**

- `PackItem.hash` is `sha256Hex(part.text)`; `chars` is `part.text.length`.
- Parts are taken in the order given, which is their priority. Every fixed part goes in. If the fixed parts alone exceed `budget`, the result is `{ too_big: <the fixed items> }` and no call can be made.
- A part that is not fixed goes in when it still fits, else to `left_out`; later, smaller parts are still tried.
- With `max_marking` set, a part that is not fixed and is stricter than it goes to `left_out` whatever its size.
- `Pack.marking` is `strictest(case_marking, ...markings of the parts that went in)`.
- `renderPack` writes each part as `## <title>\n<text>`, separated by blank lines, and ends with `Left out of this turn: <titles>` when anything was left out.
- `mayGo(marking, where, policy)` is `policy[marking].includes(where)`.

**Sample context** (all in `sample/context/`; every text is short, synthetic and plain):

| File | Kind, id | Holds |
|---|---|---|
| `profile.yaml` | `profile`, `investigation` | `rules: base-rules`, `framework: intel-cycle`, `standard: icd203`, and `stages` for `frame` (agent `orchestrator`), `plan` (`planner`), `research` (`researcher`), `assemble` (`analyst`), `evaluate` (`evaluator`), `challenge` (`adversary`), `publish` (`publisher`), each with a persona of the same name as its agent, a one-sentence goal, and the procedure where one is listed below |
| `rules.md` | `rules`, `base-rules` | Propose, never write. Cite cards by id in brackets. Never call an empty result proof unless the card says proven negative. Every tool call needs a why. Reply with JSON only when a schema is given. |
| `personas/<agent>.md` ×7 | `persona` | Who the agent is and the one bounded thing it does |
| `procedures/research.md` | `procedure`, `research-sop` | Run the accepted steps; on a dead end ask for routes and try a free pivot; say what was not found |
| `procedures/assemble.md` | `procedure`, `assemble-sop` | One finding at a time; likelihood and confidence in separate sentences; name every partial card under gaps |
| `objective.yaml` | `objective`, `sample-objective` | `chain` (strategic, operational, tactical, task; one line each) and `measures` (below) |
| `framework.yaml` | `framework`, `intel-cycle` | `phases`: `direction`, `collection`, `processing`, `analysis`, `dissemination`, `feedback`, each with a title |
| `standards/icd203.yaml` | `standard`, `icd203` | the scale below |
| `schemas/<id>.yaml` ×8 | `schema` | `frame-output`, `plan-output`, `research-output`, `assemble-output`, `evaluate-output`, `challenge-output`, `publish-output`, `product`; each `{ kind: schema, id, title, schema: <JSON Schema> }`. The seven stage schemas are given in Tasks 9, 10 and 12; `product` mirrors `Product` in `src/core/types.ts` with `additionalProperties: false` at every level |

Objective measures: `elapsed_seconds`, `queries_run`, `query_cost`, `model_tokens`, `steps_blocked`, `send_backs`, `checks_failed` (kind `mop`), and `answered_the_question`, `time_saved` (kind `moe`), each `{ id, kind, title, target }`.

The standard, a data file the owner can correct against the published directive:

```yaml
kind: standard
id: icd203
title: Likelihood and confidence terms (after ICD 203)
note: Check these terms and ranges against the published directive before relying on them.
likelihood:
  - { term: almost no chance,   also: [remote],                           range: [1, 5] }
  - { term: very unlikely,      also: [highly improbable],                range: [5, 20] }
  - { term: unlikely,           also: [improbable],                       range: [20, 45] }
  - { term: roughly even chance, also: [roughly even odds],               range: [45, 55] }
  - { term: likely,             also: [probable, probably],               range: [55, 80] }
  - { term: very likely,        also: [highly probable],                  range: [80, 95] }
  - { term: almost certain,     also: [almost certainly, nearly certain], range: [95, 99] }
confidence: [low, moderate, high]
judgment_markers: [we assess, we judge, we estimate]
change_terms: [first judgment, consistent with, changes]
```

`tests/helpers/sample-root.ts` exports `copySample(into: string): void` (the manifests without `data/` and `fixture/`, as `tests/sample/sample.test.ts` does today) and `sampleRoot(dir: string): { root: string; registry: Registry; deps: RunnerDeps; seeker: Seeker; fixture: { url: string; stop(): void }; close(): void }`, which copies the sample, generates its data, starts the reputation fixture on port 0, points the reputation source at it and loads the registry as trusted. Later tasks use it.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agents/pack.test.ts
test("the budget is half the context at three characters a token", () => {
  expect(packBudget(131072)).toBe(196608);
});
test("every part that fits goes in, in order, with its hash and size", ...);
test("a part that does not fit is left out and listed, and a later smaller part still goes in", () => {
  const p = assemblePack([fixed("rules", 100), part("big", 500), part("small", 50)], { budget: 200, case_marking: "TLP:CLEAR", max_marking: null }) as Pack;
  expect(p.items.map((i) => i.id)).toEqual(["rules", "small"]);
  expect(p.left_out.map((i) => i.id)).toEqual(["big"]);
});
test("fixed parts that do not fit mean no pack at all", ...);                        // { too_big: [...] }
test("the pack's marking is the strictest of the case and what went in", ...);       // case GREEN, a card AMBER -> AMBER
test("a part with an unknown marking counts as the most restrictive", ...);          // marking "TLP:PURPLE" as never -> TLP:RED
test("with a limit, stricter parts are left out and do not raise the marking", ...); // max GREEN, card AMBER left out, marking GREEN
test("a limit never removes a fixed part", ...);                                     // the case part stays; marking stays the case's
test("mayGo follows the policy", () => {
  expect(mayGo("TLP:AMBER", "hosted", policy)).toBe(false);
  expect(mayGo("TLP:AMBER", "machine", policy)).toBe(true);
});
test("the rendered pack names what was left out", ...);

// tests/agents/context.test.ts
test("the sample profile loads with a persona for each agent stage", ...);           // 7 stages, each persona part has text
test("stage parts come in priority order with rules and schema fixed", ...);         // kinds: rules, persona, goal, procedure, schema, objective, framework, standard
test("a missing persona is a ContextError naming it", ...);
test("a part from an untrusted root is refused", ...);
test("the case part states the question and carries the case marking", ...);
test("a card part carries the card's marking and at most ten rows", ...);
test("schemaOf returns a schema the validator accepts", ...);                        // validate(schemaOf(r, "product"), goodProduct) is []
test("the sample root still loads with no problems", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/pack.test.ts tests/agents/context.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `context.ts` and `pack.ts`**

- [ ] **Step 4: Write the sample context files and `tests/helpers/sample-root.ts`**

- [ ] **Step 5: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/context.ts src/agents/pack.ts sample/context tests/agents tests/helpers/sample-root.ts
git commit -m "feat(agents): context parts, the pack with its budget, and the marking rule"
```

---

### Task 5: The fixed tool list: sources, research and cards

**Files:**
- Create: `src/agents/tools/index.ts`, `src/agents/tools/sources.ts`, `src/agents/tools/research.ts`, `src/agents/tools/cards.ts`
- Test: `tests/agents/tools-sources.test.ts`, `tests/agents/tools-research.test.ts`, `tests/agents/tools-cards.test.ts`, `tests/agents/boundaries.test.ts`

**Interfaces:**
- Consumes: `runPivot`, `runQuery`, `RunnerDeps`, `RunQueryResult`, `revalidateCard`, `yielded`, `Seeker`, `SeekLimits`, `Registry`; `CaseSession`; `ToolSpec` (Task 2); `Schema`, `validate`, `parseJson`.
- Produces (`tools/index.ts`):

```ts
export const TOOL_NAMES = ["list_sources", "describe_source", "find_routes", "run_step", "run_pivot", "run_query", "list_cards", "read_card", "verify_card",
  "propose_assessment", "propose_narrative", "request_research", "raise_challenge", "answer_challenge"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export const TOOL_VIEW_CHARS = 6000;
export const VIEW_ROWS = 20;
export class ToolError extends Error {}
export interface ToolContext {
  session: CaseSession; deps: RunnerDeps; seeker: Seeker; actor: Extract<Actor, { kind: "agent" }>;
  link: { run: string | null; stage: string | null; job: string | null };
  subgoal: string | null; window: TimeWindow; limits: SeekLimits;
  /** Set by the engine. Called when a costly step raised a proposal; returns the result if the person's plan budget ran it, else null. */
  onNeedsBudget?: (proposal: string, step: string | null) => Promise<RunQueryResult | null>;
}
/** `view` is what the model is given; `marking` is the marking of any source data in it. */
export interface ToolResult { ok: boolean; summary: string; view: Json; marking: Marking | null }
export interface ToolDef { name: ToolName; description: string; parameters: Schema; call(ctx: ToolContext, args: Record<string, Json>): Promise<ToolResult> }
export const TOOLS: Record<ToolName, ToolDef>;
export function toolSpecs(names: readonly ToolName[]): ToolSpec[];
export interface ParsedCall { tool: ToolDef | null; name: string; args: Json; why: string; error: string | null }
export function parseCall(allowed: readonly ToolName[], name: string, argumentsText: string): ParsedCall;   // pure
export function execTool(ctx: ToolContext, parsed: ParsedCall): Promise<ToolResult>;                         // never throws
export function viewText(result: ToolResult): string;                                                        // at most TOOL_VIEW_CHARS
```

The five analysis tools are in `TOOL_NAMES` from this task, with `TOOLS` entries that Task 6 fills; until then each returns `{ ok: false, summary: "not available" }`.

**Rules for every tool.**

- `parameters` is an object schema with `additionalProperties: false` and a required `why` (string, `minLength: 1`). A `budget` argument is therefore a schema error.
- `parseCall`: unparseable `argumentsText` gives `args: { _raw: <the text, at most 2000 characters> }` and error `the arguments were not valid JSON`. An unknown name gives error `unknown tool: <name>`. A known tool not in `allowed` gives `this stage may not use <name>`. Arguments that fail the schema give `invalid arguments: <path> <message>; ...` (first three). `why` is `args.why` when it is a non-empty string, else `""`.
- `execTool`: a parsed call with an error returns `{ ok: false, summary: <error>, view: { error }, marking: null }` and runs nothing. Otherwise it calls the tool; a `ToolError` or any other throw becomes `{ ok: false, summary: "<first line>" }`.
- `viewText` is `JSON.stringify(view)`. When longer than `TOOL_VIEW_CHARS`, the tool's row list is halved until it fits and `truncated: true` is set; the record is never trimmed.
- A view never contains a source's `location`, `credential`, `user`, `root` or `dir`.

**The nine tools of this task** (every one also takes `why`):

| Tool | Arguments | Does | View |
|---|---|---|---|
| `list_sources` | none | reads the registry | `{ sources: [{ id, title, connector, marking, where, confirmed, adhoc, free, unit, quality }] }` |
| `describe_source` | `source` | reads one source and the pivots that use it | `{ id, title, marking, confirmed, adhoc, cost, limits, quality, quality_notes, tables: [{ name, time_column, columns }], pivots: [{ id, title, from, to, free, needs_window, empty_means }] }`; unknown source is a `ToolError` |
| `find_routes` | `have: [{ type, value }]`, `want` | `ctx.seeker.routes(types of have, want, ctx.limits)` | `{ routes: [{ weight, hops: Hop[] }] }`; contacts no source |
| `run_step` | `step`, `value?` | below | below |
| `run_pivot` | `pivot`, `value` | below | below |
| `run_query` | `source`, `text`, `bound?` | `runQuery` as the agent with no pivot, `window: ctx.window` | as `run_pivot` |
| `list_cards` | `subgoal?` | reads state; discarded cards are left out | `{ cards: [{ id, title, body, source, marking, coverage, empty, row_count, place, subgoal, validated }] }`; marking is the strictest of the cards listed |
| `read_card` | `card` | reads the card and its query's `query.issued` entry | `{ id, title, body, columns, rows (first VIEW_ROWS), row_count, coverage, empty, marking, quality_notes: [text], provenance: { query, source, source_hash, text, bound, window, why, by, issued, result_sha256, rows_hash } }`; marking is the card's. For an `http` source, `text` is shown without its origin (path and query only) |
| `verify_card` | `card` | `revalidateCard(session, deps, { card, actor, why })` | `{ outcome, detail, rerun, proposal }`; a refusal is a `ToolError` |

`run_pivot` and `run_step` share one result view: `{ status, outcome, card, rows, coverage, empty, columns, data (first VIEW_ROWS rows), found: [values of the pivot's target type], proposal, estimate, reasons }`, with the fields that do not apply set to `null`. `marking` is the source's marking when anything ran. `ok` is `true` for `done` and for `needs_budget` (waiting for a person is not an error), `false` for `failed` and `refused`. The summary says what happened in plain words: `14 rows · full coverage`, `no rows · proven negative`, `no rows · not seen (not proof of absence)`, `200 rows · partial: row_limit`, `waiting for a person's budget (proposal p1)`.

`run_pivot`: the pivot must be free (weight 0), else `ToolError("<pivot> is costly; it must be a plan step")`. It must serve an accepted goal: with `goal` the `to` type of the last step of `ctx.subgoal` (or of any sub-goal when `ctx.subgoal` is null), the pivot's `to` is `goal` or `ctx.seeker.routes([pivot.to], goal, ctx.limits)` is not empty; else `ToolError("<pivot> does not lead to this sub-goal")`. A plan that is not accepted is a `ToolError`. Then `runPivot` as the agent with `window: ctx.window`, `subgoal`, and the link.

`run_step`: the plan must be accepted, the step in `accepted_steps`, and (when `ctx.subgoal` is set) the step's sub-goal equal to it; each failure is a `ToolError`. The value is `step.from.value` when not empty, else `args.value`; none is `ToolError("this step needs a value from an earlier step")`. Then:

```
commit step.started { step }
r = runPivot(agent, pivot: step.pivot, value, window: step.window, step: step.id, subgoal: step.subgoal)
if r is needs_budget with a proposal and ctx.onNeedsBudget is set:
    paid = await ctx.onNeedsBudget(proposal, step.id);  if paid is not null: r = paid
commit step.finished { step, outcome, cards, note }
```

`outcome` is the result's own (`answered`, `empty`, `partial`) when done, `failed` when failed, `blocked` otherwise. `cards` is the step's earlier cards plus this one. `note` is the summary.

- [ ] **Step 1: Write the failing tests**

Each test file opens a workbench and a case on `sampleRoot`, accepts a hand-built plan where one is needed, and uses an agent actor `{ kind: "agent", id: "researcher-g1", stage: "research", profile: "investigation", model: "s", effort: null, where: "machine" }`.

```ts
// tests/agents/tools-sources.test.ts
test("every tool requires why and refuses unknown arguments", () => {
  for (const name of TOOL_NAMES) {
    expect(TOOLS[name].parameters.required).toContain("why");
    expect(TOOLS[name].parameters.additionalProperties).toBe(false);
  }
});
test("arguments that are not JSON are a parsed error that keeps the text", () => {
  const p = parseCall(["run_pivot"], "run_pivot", '{"pivot": "a", "value": "x');
  expect(p.error).toBe("the arguments were not valid JSON");
  expect(p.args).toEqual({ _raw: '{"pivot": "a", "value": "x' });
});
test("an unknown tool, a tool the stage lacks, a missing why and a budget argument are each an error", ...);
test("a parsed error runs nothing and is a result the model can read", ...);       // head seq unchanged, ok false
test("a tool that throws is a failed result, not a crash", ...);
test("list_sources and describe_source never show where a source is or how to sign in", () => {
  const text = JSON.stringify([listed.view, described.view]);
  for (const key of ['"location"', '"credential"', '"user"', '"root"', '"dir"', "127.0.0.1"]) expect(text).not.toContain(key);
});
test("find_routes returns the seeker's routes and writes nothing", ...);
test("a view over the size limit is cut and says so", ...);

// tests/agents/tools-research.test.ts
test("run_pivot runs a free pivot through the runner as the agent", ...);          // query.issued actor is the agent, why as given, card made
test("run_pivot refuses a costly pivot and one that leads away from the sub-goal", ...);
test("run_pivot on a value of the wrong type is a refusal the model can read", ...);
test("run_step runs an accepted step and records its start and finish", async () => {
  const r = await call("run_step", { step: "s1", why: "is it internal" });
  expect(r.summary).toBe("no rows · proven negative");
  expect(s.state.plan.steps.s1).toMatchObject({ status: "empty", cards: ["c1"] });
});
test("run_step on a later hop needs a value, and takes one", ...);
test("run_step refuses a step that was not accepted or belongs to another sub-goal", ...);
test("a costly step becomes a proposal and the step is blocked", ...);             // no onNeedsBudget: proposal p1 open, step blocked, ok true
test("a costly step the engine pays for comes back done", ...);                    // onNeedsBudget stub returns a done result
test("run_query is refused on a source that does not allow agent queries", ...);   // ok false, the runner's reason, nothing written
test("a partial result says partial and is never called a negative", ...);

// tests/agents/tools-cards.test.ts
test("list_cards leaves out discarded cards and carries the strictest marking", ...);
test("read_card gives the exact query, its source hash and the result's hash", ...);
test("read_card on a card from an http source does not show the service's address", ...);
test("verify_card re-runs the query and reports matches", ...);
test("verify_card on an unknown card is an error result", ...);

// tests/agents/boundaries.test.ts
test("no file under src/agents/tools or src/pipeline imports from modules/connectors", ...);
test("no file under src/agents/tools imports runProposal or names a budget", ...);  // no "modules/proposals" import; no /\bbudget\s*:/ in the files
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/tools-sources.test.ts tests/agents/tools-research.test.ts tests/agents/tools-cards.test.ts tests/agents/boundaries.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `tools/index.ts`, then `sources.ts`, `research.ts`, `cards.ts`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass, including `tests/modules/custody.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add src/agents/tools tests/agents
git commit -m "feat(agents): the fixed tool list for sources, research and cards"
```

---

### Task 6: Analysis tools and the draft builder

**Files:**
- Create: `src/agents/draft.ts`, `src/agents/tools/analysis.ts`
- Modify: `src/agents/tools/index.ts`
- Test: `tests/agents/draft.test.ts`, `tests/agents/tools-analysis.test.ts`

**Interfaces:**
- Consumes: Task 5's `ToolContext`, `ToolDef`, `ToolError`; `Finding`, `Product`, `Draft`, `Section`, `CardState`, `SourceManifest`, `strictest`, `canonical`, `sha256Hex`, `CONFIDENCES`, `SEVERITIES`, `ANSWER_ACTIONS`.
- Produces:

```ts
export type TextSection = Exclude<Section, "key_findings">;
export class DraftWork {
  constructor(previous: Product | null);            // starts from the previous revision's findings and sections
  readonly findings: Finding[];
  readonly sections: Record<TextSection, string>;
  readonly research: { question: string; why: string }[];
  /** Adds a finding as f<n>, or replaces the one named. Throws ToolError when `replaces` names none. */
  setFinding(f: Omit<Finding, "id">, replaces: string | null): string;
  setSection(section: TextSection, text: string): void;
}
export function buildProduct(work: DraftWork, facts: {
  objective: string; question: string; case_marking: Marking; cards: Readonly<Record<string, CardState>>;
  source: (id: string) => SourceManifest | null; assumptions: string[]; change: string;
}): Product;
export function draftOf(product: Product, n: number, author: Actor, reason: string): Draft;   // hash = sha256Hex(canonical(product))
```

  - `ToolContext` gains `draft: DraftWork | null` and `draft_hash: string | null`.

**The five tools** (each also takes `why`):

| Tool | Arguments | Does |
|---|---|---|
| `propose_assessment` | `statement`, `likelihood`, `confidence` (low, moderate, high), `confidence_basis`, `cites: [card id]` (at least one), `assumptions: [string]`, `reasoning`, `replaces?` | needs `ctx.draft`; every cited card must exist; `ctx.draft.setFinding(...)`; view `{ finding: <id> }` |
| `propose_narrative` | `section` (summary, gaps_and_limits, alternatives, assessment), `text`, `cites: [card id]` | needs `ctx.draft`; every cited card must exist; `setSection`; view `{ section }` |
| `request_research` | `question` | needs `ctx.draft`; commits `research.requested { question, why }` and adds it to `ctx.draft.research`; view `{ requested: true }` |
| `raise_challenge` | `severity` (must_address, consider), `text`, `cites: [card id]` | needs `ctx.draft_hash`; commits `challenge.raised` with `ids.next("challenge")` and that hash; view `{ challenge: <id> }` |
| `answer_challenge` | `challenge`, `answer`, `action` (revised, rebutted) | the challenge must be open; commits `challenge.answered`; view `{ answered: <id> }` |

A tool whose need is not met is a `ToolError`: `no draft is being assembled in this stage`, `no draft is under review in this stage`, `unknown card: <id>`, `challenge <id> is not open`. These tools check shape and that citations resolve, nothing more: form is the checks' job (Task 11). Their `marking` is `null`.

**`buildProduct`.** `objective`, `question`, `assumptions` and `change` are as given. `key_findings` and the four text sections come from the work. Cited cards are those named in any finding's `cites`. `sources` has one entry per distinct source of the cited cards, sorted by id: `quality` is the source manifest's `quality` followed by the text of each quality note named on a cited card of that source, joined by a space. `marking` is `strictest(case_marking, ...cited cards' markings)`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agents/draft.test.ts
test("findings are numbered in order and a replacement keeps its id", () => {
  const w = new DraftWork(null);
  expect(w.setFinding(f("a"), null)).toBe("f1");
  expect(w.setFinding(f("b"), null)).toBe("f2");
  expect(w.setFinding(f("a2"), "f1")).toBe("f1");
  expect(w.findings.map((x) => x.statement)).toEqual(["a2", "b"]);
});
test("replacing a finding that does not exist is a ToolError", ...);
test("a new revision starts from the previous one", ...);                      // new DraftWork(prev) has its findings and sections
test("the product's marking is the strictest of the case and the cited cards", ...);
test("each cited source appears once with its quality and the notes on the cited cards", ...);
test("draftOf hashes the canonical product", () => {
  expect(draftOf(p, 1, analyst, "first draft").hash).toBe(sha256Hex(canonical(p as unknown as Json)));
});
test("the same work and facts always give the same hash", ...);

// tests/agents/tools-analysis.test.ts
test("propose_assessment adds a finding and refuses a card that does not exist", ...);
test("propose_assessment with no citation is a schema error", ...);
test("propose_narrative sets a section and refuses key_findings", ...);
test("the drafting tools fail plainly outside a drafting stage", ...);         // ctx.draft null -> ok false, "no draft is being assembled in this stage"
test("request_research is recorded with its why", ...);                        // research.requested entry by the agent
test("raise_challenge records the challenge against the draft under review", ...);
test("answer_challenge closes an open challenge and refuses a closed one", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/draft.test.ts tests/agents/tools-analysis.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `draft.ts` and `tools/analysis.ts`; add the two fields to `ToolContext`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents tests/agents
git commit -m "feat(agents): analysis tools and the draft builder"
```

---

### Task 7: The agent loop

**Files:**
- Create: `src/agents/loop.ts`
- Test: `tests/agents/loop.test.ts`

**Interfaces:**
- Consumes: `Provider`, `TurnRequest`, `ChatMessage` (Task 2); `Pack`, `renderPack`, `mayGo`, `tooStrict` (Task 4); `ToolContext`, `ToolName`, `toolSpecs`, `parseCall`, `execTool`, `viewText` (Task 5); `CaseSession`, `runUsage`, `strictest`, `validate`, `parseJson`.
- Produces:

```ts
export const MAX_TURNS = 16;
export interface AgentSpec {
  actor: Extract<Actor, { kind: "agent" }>; provider: Provider; model: string; effort: string | null;
  pack: Pack; task: string; tools: readonly ToolName[]; ctx: ToolContext; schema: Schema | null;
  policy: Record<Marking, Where[]>; max_marking: Marking | null; max_turns?: number;
}
export interface CallRecord { call: string; tool: string; args: Json; ok: boolean }
export type AgentEnd =
  | { kind: "done"; content: string; output: Json | null; calls: CallRecord[] }
  | { kind: "invalid"; errors: string[]; calls: CallRecord[] }
  | { kind: "declined"; reason: string }
  | { kind: "blocked"; marking: Marking }
  | { kind: "error"; message: string }
  | { kind: "stopped"; why: "paused" | "budget" | "turns" };
export function extractJson(content: string): { value: Json } | null;
export function runAgent(session: CaseSession, spec: AgentSpec): Promise<AgentEnd>;   // never throws for anything a model or tool does
```

**The loop.** The conversation starts as a system message (`renderPack(spec.pack)`) and a user message (`spec.task`). `marking` starts as `spec.pack.marking`. Every entry carries `spec.ctx.link` as its run, stage and job. Then, up to `max_turns` times:

1. **Stop checks.** `session.state.run.status === "paused"` ends with `stopped: paused`. A run budget that `runUsage(state)` input plus output has reached ends with `stopped: budget`.
2. **Marking.** If `!mayGo(marking, provider.where, policy)`: commit `model.blocked { stage, marking, model, where }` and end with `blocked`. The provider is not contacted.
3. **Request.** `ordinal` is the number of `model.request` entries in the case whose actor id is this actor's. `body = provider.body(req)`, stored as a blob. Commit `model.request { request: ids.next("request"), provider, model, effort, where, marking, pack: pack.items, left_out: pack.left_out, messages: <blob>, tools }` as the agent.
4. **Turn.** `result = await provider.turn(req)`.
5. **Response.** In one commit, caused by the request entry:
   - `answer`: `model.response { request, response: <blob of raw>, stop, usage, served_by, reasoning: <blob of the reasoning text, or null> }`.
   - `declined`: `model.declined { request, reason }` (the reason cut to 2000 characters). End with `declined`.
   - `error`: `model.response` with `stop: "error"`, zero usage, `served_by` the requested model, and `response` the blob of `raw`, or of `{"error": <message>}` when there is none. End with `error`.
6. **Tool calls**, one at a time, in the order given. For each: `parsed = parseCall(spec.tools, name, arguments)`; commit `tool.called { request, call: ids.next("call"), tool: name, args: parsed.args, why: parsed.why }` as the agent; `result = await execTool(ctx, parsed)`; a result whose marking is `tooStrict` for `spec.max_marking` is replaced, for the model only, by `{ ok: false, summary: "withheld: marked <marking>, which this model may not receive" }`; otherwise `marking = strictest(marking, result.marking)`; commit `tool.returned { call, ok, summary, result: <blob of viewText(result)> }` caused by the `tool.called` entry. Append the assistant message with its tool calls, then one `tool` message per call holding the view text. Go to 1.
7. **No tool calls: the answer.** With no schema, end `done` with `output: null`. With a schema: `extractJson` takes the first JSON object in the content (a fenced block or bare text). If it validates, end `done`. If not, and this is the first failure, append the assistant message and a user message `Your reply did not match the required output: <errors>. Reply again with the corrected JSON only.` and go to 1. A second failure ends `invalid` with the errors. A `length` stop counts as a failure with the error `the reply was cut off`.

Running out of turns ends with `stopped: turns`.

- [ ] **Step 1: Write the failing tests**

Tests build an `AgentSpec` on `sampleRoot`, an inline `ScriptedProvider` and a pack of two small parts. A `spy` wrapper records what the provider was asked.

```ts
test("a request is in the ledger before the provider is contacted, and its response after", async () => {
  // the spy reads session.entries() when turn() is called
  expect(seenAtTurn.at(-1)!.type).toBe("model.request");
  expect(types()).toEqual(["case.created", "model.request", "model.response"]);
});
test("the request blob is the exact body and the response blob the exact reply", ...);   // blobs.text(messages.blob) === decode(provider.body(req))
test("the request records the pack, what was left out, the marking and the tools", ...);
test("reasoning text is stored as its own blob", ...);                                   // blobs.text(reasoning.blob) === "because"
test("a tool call is recorded before it runs and its return after", async () => {
  // script: list_sources, then a final answer
  expect(types().slice(1)).toEqual(["model.request", "model.response", "tool.called", "tool.returned", "model.request", "model.response"]);
  expect(called.payload).toMatchObject({ tool: "list_sources", why: "see what there is" });
  expect(blobs.text(returned.payload.result!.blob)).toBe(secondRequestToolMessage);
});
test("the model is given the tool's view and answers from it", ...);
test("arguments that are not JSON, an unknown tool, a missing why and a budget argument are tool results, and the loop goes on", async () => {
  // four bad calls in one turn, then a final answer
  expect(end.kind).toBe("done");
  expect(returns.map((e) => e.payload.ok)).toEqual([false, false, false, false]);
  expect(s.entries().some((e) => e.type === "query.issued")).toBe(false);
});
test("a call whose marking the model may not receive is not made", async () => {
  // provider.where "hosted", case marking TLP:AMBER, default policy
  expect(end).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
  expect(spy.turns).toBe(0);
  expect(types()).toEqual(["case.created", "model.blocked"]);
});
test("stricter data from a tool blocks the next call", async () => {
  // case TLP:CLEAR, hosted provider; the tool reads a card from a source marked TLP:AMBER
  expect(spy.turns).toBe(1);
  expect(end).toEqual({ kind: "blocked", marking: "TLP:AMBER" });
});
test("with a limit, a stricter tool result is withheld and the conversation goes on", ...);   // max_marking TLP:GREEN: tool message says withheld; second turn made
test("output that fails its schema gets one retry carrying the errors", ...);                 // second request's last message names the error; end done
test("output that fails twice is invalid, with the errors", ...);
test("JSON inside a fenced block is read", ...);
test("a declined model is recorded as declined, never as an empty answer", ...);              // model.declined entry; end.kind "declined"
test("a provider error is recorded with stop error and ends the loop", ...);
test("a paused run stops the loop before the next call", ...);
test("at the run's token budget the loop stops before the next call", ...);
test("the loop gives up after max_turns", ...);                                               // max_turns 2, a script that always calls a tool
test("every request has one response and every call one return", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/agents/loop.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `runAgent` and `extractJson` in `src/agents/loop.ts`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/agents/loop.ts tests/agents/loop.test.ts
git commit -m "feat(agents): one agent loop that records every model call and tool call"
```

---

### Task 8: Pipeline manifests and the engine

**Files:**
- Create: `src/pipeline/manifests.ts`, `src/pipeline/next.ts`, `src/pipeline/engine.ts`, `sample/stages/*.yaml` (nine)
- Test: `tests/pipeline/manifests.test.ts`, `tests/pipeline/next.test.ts`, `tests/pipeline/engine.test.ts`

**Interfaces:**
- Consumes: `Registry`, `Config`, `RunnerDeps`, `Seeker`, `Providers`, `Profile`, `ToolName`, `TOOL_NAMES`; `StageDef`, `CaseState`, `latestDraft`, `CaseSession`.
- Produces (`manifests.ts`):

```ts
export const ROLES = ["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"] as const;
export type Role = (typeof ROLES)[number];
export interface StageManifest extends StageDef { hash: string; order: number; role: Role; tools: ToolName[]; schema: string | null; on_pass: string | null; on_fail: string | null }
export interface Pipeline { id: string; hash: string; stages: StageManifest[] }      // stages sorted by order
export function loadPipeline(registry: Registry): { pipeline: Pipeline | null; problems: string[] };
```

- Produces (`next.ts`):

```ts
export const SEND_BACK_CAP = 3;
export type Step =
  | { kind: "idle" }
  | { kind: "start"; stage: string; attempt: number; sent_back: { from: string; to: string; reason: string; count: number } | null }
  | { kind: "exec"; stage: string }
  | { kind: "gate"; gate: "plan" | "publish" }
  | { kind: "pause"; reason: string }
  | { kind: "finish"; outcome: "published" | "stopped" };
export function nextStep(state: Readonly<CaseState>, pipeline: Pipeline, opts?: { allow_capped?: boolean }): Step;
export function firstUnpassedReview(state: Readonly<CaseState>, pipeline: Pipeline): string | null;   // for the latest draft; null when all passed or there is no draft
```

- Produces (`engine.ts`):

```ts
export interface EngineDeps {
  config: Config; registry: Registry; runner: RunnerDeps; seeker: Seeker; providers: Providers; pipeline: Pipeline; profile: Profile;
  anchor?: (a: { case: string; seq: number; hash: string; why: "published" | "closed" }) => void;
}
export interface StageEnv { session: CaseSession; deps: EngineDeps; stage: StageManifest; attempt: number }
export type StageEnd =
  | { kind: "finished"; outcome: "pass" | "fail"; draft_hash: string | null; output: Json | null; reason: string | null }
  | { kind: "declined"; reason: string }
  | { kind: "blocked"; marking: Marking }     // model.blocked is already written
  | { kind: "stalled"; reason: string }       // the run pauses and the stage stays running
  | { kind: "stopped" };                      // a person paused mid-stage
export type StageRunner = (env: StageEnv) => Promise<StageEnd>;
export interface RunSummary { status: RunState["status"]; waiting: "plan" | "publish" | null; current: string | null; pause_reason: string | null; outcome: "published" | "stopped" | null }
export class RunRefused extends Error {}
export class Engine {
  constructor(session: CaseSession, deps: EngineDeps, opts?: { runners?: Partial<Record<Role, StageRunner>> });
  start(actor: Actor): void;
  advance(opts?: { allow_capped?: boolean }): Promise<RunSummary>;
  pause(actor: Actor): void;
  resume(actor: Actor): Promise<RunSummary>;
  setModel(stage: string, choice: ModelChoice, actor: Actor): void;
  setBudget(tokens: number | null, actor: Actor): void;
  setPackLimit(stage: string, max: Marking | null, actor: Actor): void;
  summary(): RunSummary;
}
```

**Stage manifests.** One file per stage in `sample/stages/`:

```yaml
kind: stage
id: research
title: Research
order: 3
phase: collection        # a phase id of the framework
runs: agent              # agent | script | human
role: research           # which built-in stage runner
gate: null               # plan | publish | null
reviews: false           # true: must pass before publishing
tools: [find_routes, run_step, run_pivot, run_query, list_cards, read_card]
schema: research-output
model: { provider: scripted, model: sample-run, effort: null }
on_pass: assemble
on_fail: plan
```

| id | order | phase | runs | gate | reviews | tools | schema | on_pass | on_fail |
|---|---|---|---|---|---|---|---|---|---|
| frame | 1 | direction | agent | | no | list_sources, describe_source | frame-output | plan | |
| plan | 2 | direction | agent | plan | no | list_sources, describe_source, find_routes | plan-output | research | |
| research | 3 | collection | agent | | no | as above | research-output | assemble | plan |
| assemble | 4 | analysis | agent | | no | list_cards, read_card, propose_assessment, propose_narrative, request_research, answer_challenge | assemble-output | checks | research |
| checks | 5 | processing | script | | yes | | | evaluate | assemble |
| evaluate | 6 | analysis | agent | | yes | list_cards, read_card, verify_card | evaluate-output | challenge | assemble |
| challenge | 7 | analysis | agent | | yes | list_cards, read_card, verify_card, raise_challenge | challenge-output | publish | assemble |
| publish | 8 | dissemination | agent | publish | no | | publish-output | feedback | assemble |
| feedback | 9 | feedback | human | | no | | | | |

`role` equals `id` for all nine. Stages run by a script or a person have `model: null`.

`loadPipeline` takes every `stage` manifest. A manifest is a problem and is left out when: it comes from an untrusted root; it fails its schema; its `role` is not in `ROLES`; a tool is not in `TOOL_NAMES`; a stage that runs an agent has no `model`. The pipeline is `null`, with a problem saying why, when: no stage is left; two share an `order`; `on_pass` or `on_fail` names no stage; there is not exactly one stage for each gate; no stage has `reviews: true`; the publish stage comes before a review stage. `Pipeline.id` is `"default"`. `Pipeline.hash` is `sha256Hex(canonical([[id, hash], ...]))` over the stages in order.

**`nextStep`** (pure; the algorithm the tests alone do not determine):

```
run.status is not "running"                      -> idle
no stage has started (run.current is null)       -> start(first stage, attempt 1)
st = the current stage's state, m = its manifest
st.status running                                -> exec(st)
st.status blocked or declined                    -> start(st, attempts + 1)
st.status waiting                                -> idle
st.status failed:
    m.on_fail is null                            -> pause("<title> failed: <last_reason>")
    n = run.sendbacks["<st>><on_fail>"] ?? 0
    n >= SEND_BACK_CAP and not allow_capped      -> pause("<title> has sent work back to <target title> 3 times. Last reason: <last_reason>")
    otherwise                                    -> start(on_fail, its attempts + 1, sent_back { from, to, reason: last_reason, count: n + 1 })
st.status passed:
    m.gate is "plan":   plan.status proposed     -> gate(plan)
                        plan.status replanning   -> start(st, attempts + 1)
                        plan.status denied       -> idle
                        plan.status accepted     -> continue below
    m.gate is "publish" and the latest draft is not in state.published:
                        u = firstUnpassedReview  -> u ? start(u, its attempts + 1) : gate(publish)
    m.on_pass is null                            -> finish(published when state.published is not empty, else stopped)
    t = the on_pass stage
    t.reviews or t.gate is "publish":
        no draft                                 -> pause("there is no draft to review")
        u = firstUnpassedReview                  -> if u is not null: start(u, its attempts + 1)
    in every remaining case                      -> start(t, its attempts + 1)
```

The review rule is what makes an edit go back through stages 5 to 7: review stages always examine the latest draft, and nothing reaches the publish stage until every review stage has passed that hash.

**The driver.** `start` refuses (`RunRefused`) when a run is active, and commits `run.started { run: ids.next("run"), pipeline: "default", pipeline_hash, stages }` as the actor. `advance` loops on `nextStep` until it is `idle` (a `pause` or `finish` step is carried out and ends the loop too), and a second call while one is in flight returns the same promise:

- `start`: one commit as `{ kind: "system", id: "engine" }`: `stage.sent_back` when there is one, `case.phase_changed` when the stage's phase differs from `state.phase`, then `stage.started { stage, attempt }`. Putting the send-back and the start in one commit means a stop between them cannot count the send-back twice.
- `exec`: calls the stage's runner. `finished` → `stage.finished { stage, attempt, outcome, draft_hash, output: <blob of canonical(output), or null>, reason }`. `declined` → `stage.finished` with outcome `declined`, and `run.paused { reason: "The model declined at <title>: <reason>. Choose another model and resume." }`. `blocked` → `run.paused { reason: "<title>: the chosen model may not receive data marked <marking>. Choose an allowed model, or leave the stricter items out, and resume." }`. `stalled` → `run.paused { reason }`. `stopped` → nothing. A runner that throws is `stalled` with `<title> failed unexpectedly: <first line>`.
- `gate` → `gate.waiting`. `pause` → `run.paused`. `finish` → `run.finished`.

`pause` commits `run.paused { reason: "paused by <actor id>" }`. `resume` commits `run.resumed` (on a paused or an interrupted run) and calls `advance({ allow_capped: true })`. `allow_capped` applies to the first step of that call only, so a resume lets exactly one capped send-back through. `setModel`, `setBudget` and `setPackLimit` commit `stage.model_set`, `budget.set` and `stage.pack_limit_set`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/manifests.test.ts
test("the sample pipeline has nine stages in order with two gates and three review stages", () => {
  expect(pipeline.stages.map((s) => s.id)).toEqual(["frame", "plan", "research", "assemble", "checks", "evaluate", "challenge", "publish", "feedback"]);
  expect(pipeline.stages.filter((s) => s.reviews).map((s) => s.id)).toEqual(["checks", "evaluate", "challenge"]);
});
test("a stage naming a tool outside the fixed list is left out with a problem", ...);
test("a stage manifest from an untrusted root is not used", ...);
test("a pipeline with no review stage, or with publish before review, is refused", ...);
test("a dangling on_fail and a duplicate order are refused", ...);
test("adding a stage file adds a stage", ...);                              // a tenth manifest between evaluate and challenge
test("the pipeline hash changes when a stage manifest changes", ...);

// tests/pipeline/next.test.ts   (states built with EntryBuilder and fold)
test("a new run starts at the first stage", ...);
test("a passed stage hands off to its on_pass stage", ...);
test("a failed stage sends back along on_fail with the count", () => {
  expect(nextStep(state, pipeline)).toEqual({ kind: "start", stage: "assemble", attempt: 2,
    sent_back: { from: "checks", to: "assemble", reason: "confidence-and-likelihood failed", count: 1 } });
});
test("the fourth send-back along one edge pauses instead", ...);            // sendbacks { "checks>assemble": 3 } -> pause
test("allow_capped lets one more through", ...);
test("the cap is per edge", ...);                                           // "evaluate>assemble": 3 does not stop checks>assemble
test("a passed plan stage waits at the plan gate until the plan is accepted", ...);
test("a re-plan request runs the plan stage again", ...);
test("nothing reaches publish until every review stage passed the latest draft", ...);   // a newer draft.revised -> start checks
test("a stage left running is executed again, not restarted", ...);
test("a declined or blocked stage starts again with a new attempt", ...);
test("the last stage passing finishes the run as published", ...);
test("a paused, waiting, interrupted or finished run is idle", ...);

// tests/pipeline/engine.test.ts   (stub runners injected for every role; the plan stub commits plan.proposed, the assemble stub a draft.revised)
test("a run goes stage to stage on its own and stops at the plan gate", ...);
test("every transition is an entry", ...);                                  // stage.started and stage.finished pairs in order; phase changes recorded
test("a send-back and the restart of its target are one commit", ...);
test("three send-backs along one edge, then the run pauses and says why", async () => {
  // a checks stub that always fails
  expect(sum.status).toBe("paused");
  expect(sum.pause_reason).toStartWith("Checks has sent work back to Assemble 3 times.");
  expect(s.state.run.sendbacks).toEqual({ "checks>assemble": 3 });
});
test("resuming after the cap allows one more send-back", ...);
test("pause stops the next stage from starting, and resume continues", ...);        // pause from a subscriber on stage.started(research)
test("a stalled stage pauses the run and runs again on resume", ...);
test("a declined model pauses the run; a new model and resume run the stage again", ...);
test("a blocked stage pauses the run with both ways on", ...);
test("a runner that throws pauses the run instead of crashing it", ...);
test("an interrupted run resumes at the stage it was in", ...);                     // recoverSession, then resume
test("two advance calls at once do the work once", ...);
test("starting a second run while one is active is refused", ...);
test("the state at every entry of the run equals the fold to that entry", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/pipeline`
Expected: FAIL.

- [ ] **Step 3: Write the nine stage manifests; implement `manifests.ts`, `next.ts`, `engine.ts`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline sample/stages tests/pipeline
git commit -m "feat(pipeline): stage manifests and the engine with gates, the send-back cap, pause and resume"
```

---

### Task 9: Stage runners: Frame, Plan, Research

**Files:**
- Create: `src/pipeline/stages/agent.ts`, `src/pipeline/stages/frame.ts`, `src/pipeline/stages/plan.ts`, `src/pipeline/stages/research.ts`, `src/pipeline/plans.ts`
- Modify: `src/pipeline/engine.ts` (register the runners; add the plan commands)
- Test: `tests/pipeline/stage-agent.test.ts`, `tests/pipeline/plans.test.ts`, `tests/pipeline/stages-front.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 8; `runProposal`.
- Produces:

```ts
// stages/agent.ts
export type AgentStageEnd = { kind: "output"; output: Json; calls: CallRecord[] } | Exclude<StageEnd, { kind: "finished" }>;
export function stageAgent(env: StageEnv, opts: {
  actor_id: string; task: string; extras: PackPart[]; subgoal?: string | null; job?: string | null;
  draft?: DraftWork | null; draft_hash?: string | null; onNeedsBudget?: ToolContext["onNeedsBudget"];
}): Promise<AgentStageEnd>;
export function lastOutput(session: CaseSession, stage: string): Json | null;    // the output blob of the stage's latest stage.finished with outcome pass
export function frameOf(session: CaseSession): { window: TimeWindow; limits: SeekLimits };   // from Frame's output, with max_hops from DEFAULT_LIMITS; the case window and DEFAULT_LIMITS when there is none

// plans.ts
export class PlanRefused extends Error {}
export function buildPlan(id: string, output: PlanOutput, deps: Pick<EngineDeps, "registry" | "seeker" | "config" | "runner">, frame: { window: TimeWindow; limits: SeekLimits }, research: { where: Where } | null): Plan | { errors: string[] };
export function acceptPlan(session: CaseSession, input: { steps?: string[]; budgets?: Record<string, number>; actor: Actor }): void;
export function denyPlan(session: CaseSession, input: { reason: string; actor: Actor }): void;
export function requestReplan(session: CaseSession, input: { note: string; actor: Actor }): void;
export function spendPlanBudget(session: CaseSession, deps: RunnerDeps, proposal: string, step: string | null): Promise<RunQueryResult | null>;
// Engine gains: acceptPlan(input), denyPlan(input), replan(input)   (each calls the function above; none advances)
```

**`stageAgent`** is what every agent stage shares:

1. The model choice is `state.run.stages[stage].model`. No choice, an unknown provider, or a model the provider does not list is `stalled` with a reason naming it.
2. Parts are `stageParts(registry, profile, stage.id, { schema: stage.schema, objective: case objective })`, then `casePart(state)`, then `opts.extras`. The pack is `assemblePack(parts, { budget: packBudget(info.context ?? DEFAULT_CONTEXT), case_marking, max_marking: state.pack_limits[stage.id] ?? null })`. `too_big` is `stalled`: `<title>: the fixed context does not fit this model`.
3. The actor is `{ kind: "agent", id: opts.actor_id, stage: stage.id, profile: profile.id, model, effort, where: provider.where }`. The tool context has `window` and `limits` from `frameOf`, and the link `{ run, stage, job }`.
4. `runAgent`, mapped: `done` → `output`; `invalid` → `stalled` (`<title>'s output failed its schema twice: <errors>`); `declined` → `declined`; `blocked` → `blocked`; `error` → `stalled` (`<title>: the model call failed: <message>`); `stopped: paused` → `stopped`; `stopped: budget` → `stalled` (`The model budget for this run is used up (<used> of <budget> tokens). Raise it and resume.`); `stopped: turns` → `stalled`.

**Output schemas** (`sample/context/schemas/`, each an object with `additionalProperties: false` and every listed field required):

- `frame-output`: `goals: [{ title, question, want }]` (at least one), `window: { from, to }` (each a UTC timestamp with milliseconds, by pattern), `limits: { allow_unconfirmed: boolean, max_weight: number | null }`, `notes: string`.
- `plan-output`: `goal: string`, `subgoals: [{ title, question, have: [{ type, value }], want, route: [pivot id] }]` (at least one; `route` at least one).
- `research-output`: `outcome` (answered, blocked), `found: [{ type, value }]`, `note: string`.

**Frame** (actor id from the profile: `orchestrator`). Task: the question asked, why, the starting values and the case window. Finishes `pass` with the output.

**Plan** (actor `planner`). Extras: Frame's output, and the person's re-plan note when the plan status is `replanning`. The output goes to `buildPlan`:

- Each sub-goal is `g1`, `g2`, ... and its steps `s1`, `s2`, ... numbered across the whole plan.
- `route` must equal the pivot ids of one of `seeker.routes(types of have, want, frame.limits)`; otherwise the error is `sub-goal "<title>": the route <ids> is not one the route finder offers from <types> to <want>`.
- Each `have` value must match its type.
- Step fields come from the hop: `pivot`, `source`, `to`, `needs_window`, `free`, `weight`, `empty_means`. `from` is `{ type: hop.from, value }` with the sub-goal's value of that type for the first hop and `""` after. `window` is the frame's. `estimate` is `null`.
- `warnings`: `unconfirmed source` when the hop's source is not confirmed; `this source is marked <marking>, which the Research stage's model may not receive` when `research` is given and `!mayGo(hop.marking, research.where, policy)`.

Errors from `buildPlan` are treated like a schema failure: the runner asks the planner once more with the errors as the task, and a second failure is `stalled`. `buildPlan` is first called with the id `""` to find errors. On success, one commit: `plan.proposed { plan }`, the plan built again inside the builder with `ids.next("plan")`. `research` is the `where` of the provider chosen for the first stage whose role is `research`, or `null` when it cannot be resolved. The stage finishes `pass` with the output; the engine then writes `gate.waiting`.

**The plan commands** (a person's; each throws `PlanRefused` and writes nothing when refused):

- `acceptPlan`: only a human; a plan must be proposed. `steps` defaults to every step. A budget must name an accepted costly step and be a finite number above zero. One commit as the person: `plan.accepted { plan, steps, budgets }`, a `lane.created { lane, title: sub-goal title, subgoal }` for each sub-goal with an accepted step, and `gate.passed { gate: "plan" }`.
- `denyPlan`: `plan.denied`, then `run.finished { outcome: "stopped" }`.
- `requestReplan`: `plan.replan_requested { plan, note }`.

**`spendPlanBudget`.** Finds the `plan.accepted` entry. Returns `null` unless `step` has a budget in it, the proposal is open, it is for that step, and no earlier `proposal.accepted` exists for a proposal of that step. Otherwise returns `runProposal(session, deps, { proposal, budget, actor: <the actor of the plan.accepted entry> })`.

**Research.** One researcher per sub-goal that has an accepted step, at most `config.research.parallel` at once. Each is one job: `job.started { job, title: "Research: <sub-goal title>", kind: "research", source: null }`, then `stageAgent` with actor id `researcher-<sub-goal id>`, the sub-goal, the job, `onNeedsBudget: (p, step) => spendPlanBudget(session, deps.runner, p, step)`, and a task naming the sub-goal's question and its steps; then `job.finished`. A researcher is not started when the run is paused, or when every accepted step of its sub-goal already finished `answered`, `empty` or `partial` (a restarted stage does not redo finished sub-goals).

When the stage was sent back by Assemble, it instead runs one researcher per `research.requested` entry written since Research last finished: actor id `researcher-r<n>`, no sub-goal, the question as the task.

The stage's output is `{ subgoals: [{ id, title, outcome, cards, note }], requested: [{ question, note }] }`. A sub-goal's outcome is `answered` when its last accepted step finished `answered` or `partial`, else `blocked`; the note is the researcher's. The stage finishes `pass` when any sub-goal is answered or any requested research ran, else `fail` with reason `no sub-goal could be answered: <notes>`. A researcher that ends `declined`, `blocked`, `stalled` or `stopped` ends the stage that way once the others have finished.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/stage-agent.test.ts
test("the stage's agent runs on the stage's chosen model with the stage's pack and tools", ...);
test("a model set for the stage by a person is the one used", ...);                 // stage.model_set before the run
test("a model the provider does not list stalls the stage and names it", ...);
test("a pack limit set for the stage leaves stricter cards out", ...);              // model.request.left_out names the card
test("each outcome of the loop maps to its stage end", ...);                        // invalid, declined, blocked, error, budget

// tests/pipeline/plans.test.ts
test("a route the seeker offers becomes numbered steps", () => {
  const plan = buildPlan("plan-1", out, deps, frame, null) as Plan;
  expect(plan.steps.map((s) => [s.id, s.subgoal, s.pivot, s.from.value, s.free])).toEqual([
    ["s1", "g1", "address_to_asset", "198.51.100.77", true], ["s2", "g1", "asset_to_accounts", "", true], ["s3", "g2", "address_to_verdict", "198.51.100.77", false],
  ]);
});
test("a route the seeker does not offer is an error naming it", ...);
test("a starting value of the wrong type is an error", ...);
test("a step on a source the research model may not receive carries a warning", ...);
test("accepting makes one lane per sub-goal and passes the gate, in one commit", ...);
test("accepting only the free steps leaves the costly one out", ...);
test("a budget for a free step, an unknown step, or a budget of zero is refused and nothing is written", ...);
test("an agent or the system cannot accept a plan", ...);
test("denying the plan stops the run", ...);
test("a plan budget runs the step's proposal once, in the name of the person who accepted", async () => {
  expect(r?.status).toBe("done");
  expect(accepted.actor).toEqual(human);
  expect(accepted.payload).toEqual({ proposal: "p1", budget: 1 });
  expect(await spendPlanBudget(s, deps, "p2", "s3")).toBeNull();      // the step's budget is spent
});
test("a step with no budget is not paid for", ...);

// tests/pipeline/stages-front.test.ts   (the engine on sampleRoot with inline scripts)
test("Frame's validated output is the stage's output blob", ...);
test("Plan proposes a plan and the run waits at the plan gate; nothing has run", ...);       // no query.issued
test("Plan's route errors go back to the planner once, then the run pauses", ...);
test("a re-plan request runs the planner again with the note", ...);
test("Research runs one researcher per sub-goal, each as its own job", ...);
test("no more researchers run at once than the configured number", ...);                     // parallel 1: jobs never overlap
test("a dead end is followed by a re-route, and the sub-goal is answered", ...);             // s1 empty, a free pivot, s1 again, s2
test("a costly step with a plan budget runs; without one it stays a proposal and its sub-goal is blocked", ...);
test("Research passes with one sub-goal answered and one blocked", ...);
test("Research fails back to Plan when nothing was answered", ...);
test("a researcher's claim of success does not make a blocked sub-goal answered", ...);
test("research asked for by the analyst runs one researcher per question", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/pipeline/stage-agent.test.ts tests/pipeline/plans.test.ts tests/pipeline/stages-front.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the three schemas; implement `stages/agent.ts`, `plans.ts`, `stages/frame.ts`, `stages/plan.ts`, `stages/research.ts`; register the runners and add the three commands to `Engine`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline sample/context/schemas tests/pipeline
git commit -m "feat(pipeline): Frame, Plan and Research stages, the plan gate and plan budgets"
```

---

### Task 10: Stage runners: Assemble, Evaluate, Challenge; draft revisions

**Files:**
- Create: `src/pipeline/stages/assemble.ts`, `src/pipeline/stages/evaluate.ts`, `src/pipeline/stages/challenge.ts`, `src/pipeline/revise.ts`
- Modify: `src/pipeline/engine.ts`
- Test: `tests/pipeline/stages-analysis.test.ts`, `tests/pipeline/revise.test.ts`

**Interfaces:**
- Consumes: `stageAgent`, `lastOutput` (Task 9); `DraftWork`, `buildProduct`, `draftOf` (Task 6); `latestDraft`, `blockers`.
- Produces:
  - `class ReviseRefused extends Error {}`
  - `reviseDraft(session: CaseSession, pipeline: Pipeline, input: { product: Product; reason: string; actor: Actor }): Draft`
  - `Engine` gains `revise(input: { product: Product; reason: string; actor: Actor }): Draft`

**Output schemas:** `assemble-output`: `done: boolean`, `change: string`, `assumptions: [string]`, `note: string`. `evaluate-output`: `pass: boolean`, `findings: [{ check, where, message }]`. `challenge-output`: `done: boolean`, `summary: string`.

**Assemble** (actor `analyst`). The work is `new DraftWork(latestDraft(state)?.product ?? null)`. Extras, in order: what must be fixed in the latest draft (each failed check's findings, a failed evaluation's findings, each open challenge with its id and severity, and a person's rejection reason, all read from state); Research's output; then a `cardPart` for every card that is not discarded, newest first. The task says: propose one finding at a time, set each section, answer each open challenge, then reply with the output.

When the loop ends:

- `work.research` is not empty → the stage finishes `fail`, `draft_hash: null`, reason `more research is needed: <questions>`. No draft is written.
- Otherwise the product is `buildProduct(work, { objective: the objective's title (or "" when the case has none), question: case asked, case_marking, cards, source, assumptions, change })`. One commit as the analyst: `draft.revised { draft: draftOf(product, drafts.length + 1, actor, reason) }`, then `assessment.made { finding, draft_hash }` for each finding. The reason is `first draft`, or `revised after <stage title>: <its last reason>`. The stage finishes `pass` with that hash and the output.

**Evaluate** (actor `evaluator`). The draft is pinned when the stage begins: `d = latestDraft(state)`. Extras: the draft's product as a part, and a `cardPart` for each card it cites. The task: check that every finding is supported by what its cited cards say; verify a card where it matters. On output, one commit as the evaluator: `evaluation.made { draft_hash: d.hash, pass, findings }`. The stage finishes `pass` or `fail` on `d.hash`; a `fail` with no finding is `stalled` (`Evaluate failed the draft without saying why`). The fail reason is the first finding's message.

**Challenge** (actor `adversary`), with `draft_hash: d.hash` in the tool context. Extras as for Evaluate, plus earlier challenges on this hash with their answers. The stage finishes `fail` on `d.hash` when a `must_address` challenge against `d.hash` is open, with reason `challenge <id> must be addressed: <text>`; else `pass`.

**A person's edit.** `reviseDraft`: only a human; a run must be in progress and not finished; the product must have the shape the fold requires. One commit as the person: `draft.revised` with `n = drafts.length + 1`, the person as author and the given reason. When the run is waiting at the publish gate, the same commit also holds `stage.started` for the first review stage (as the engine actor), which takes the run out of the gate. In every other state the next `nextStep` sends the run to the first review stage that has not passed the new hash. An edit is not a send-back and does not count against the cap.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/stages-analysis.test.ts
test("the analyst's proposals become draft 1 with its hash, and each finding is recorded against it", async () => {
  const d = s.state.drafts[0]!;
  expect(d.n).toBe(1);
  expect(d.hash).toBe(sha256Hex(canonical(d.product as unknown as Json)));
  expect(made.map((e) => e.payload.draft_hash)).toEqual([d.hash, d.hash]);
  expect(d.author).toMatchObject({ kind: "agent", id: "analyst" });
});
test("objective, question, marking and source quality are filled in by code, not by the model", ...);
test("a revision starts from the previous draft and changes only what was proposed again", ...);   // draft 2 keeps f2 and the sections
test("the analyst is told what failed", ...);                              // the second attempt's request blob holds the failed check's message
test("a request for research sends the run back to Research with no draft written", ...);
test("the analyst never keeps, moves or discards a card", ...);            // no card.kept / card.moved / card.discarded by an agent
test("Evaluate records its verdict against the hash it examined", ...);
test("a failed evaluation sends the draft back to Assemble with the finding as the reason", ...);
test("an evaluation that fails with no finding pauses the run", ...);
test("a must-address challenge sends the draft back; a consider challenge does not", ...);
test("an answered challenge no longer blocks the same draft", ...);        // rebutted, same hash, adversary passes
test("an edit made while Evaluate is running is reviewed from Checks, and the old verdict stays on the old hash", ...);

// tests/pipeline/revise.test.ts
test("a person's edit is a new numbered revision in their name", ...);
test("an edit at the publish gate leaves the gate and starts review again", async () => {
  expect(s.state.run.waiting).toBeNull();
  expect(s.state.run.current).toBe("checks");
  expect(blockers(s.state, edited.hash)).toContain("Checks has not passed this revision");
});
test("an edit does not count as a send-back", ...);                        // run.sendbacks unchanged
test("an agent cannot use reviseDraft", ...);
test("an edit after the run finished is refused", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 120 bun test tests/pipeline/stages-analysis.test.ts tests/pipeline/revise.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write the three schemas; implement the three runners and `revise.ts`; register them**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline sample/context/schemas tests/pipeline
git commit -m "feat(pipeline): Assemble, Evaluate and Challenge stages, and draft revisions"
```

---

### Task 11: The checks runner and the eleven form checks

**Files:**
- Create: `src/pipeline/checks.ts`, `src/pipeline/stages/checks.ts`, `sample/checks/NN-<id>.yaml` and `sample/checks/NN-<id>.ts` (eleven of each)
- Modify: `src/pipeline/manifests.ts`, `src/pipeline/engine.ts`
- Test: `tests/pipeline/checks.test.ts`, `tests/sample/form-checks.test.ts`

**Interfaces:**
- Consumes: `Registry`, `staysInside`, `StageRunner`, `schemaOf`, `Product`, `CheckFinding`, `MARKINGS`.
- Produces:

```ts
// manifests.ts
export interface CheckManifest { id: string; title: string; order: number; hash: string; path: string; script: string; runner: "bun" | "exec"; timeout_ms: number }
export function loadChecks(registry: Registry): { checks: CheckManifest[]; problems: string[] };
// checks.ts
export interface CheckInput {
  check: string;
  draft: { n: number; hash: string; product: Product };
  cards: Record<string, { id: string; title: string; source: string | null; marking: Marking; coverage: Coverage | null; empty: EmptyMeans | null; row_count: number; quality_notes: string[] }>;
  sources: Record<string, { quality: string; quality_notes: { id: string; text: string }[]; marking: Marking }>;
  schema: Json; standard: Json; markings: Marking[];
  objective: { id: string; title: string } | null; question: string;
  earlier: { n: number; hash: string }[];
}
export interface CheckOutcome { pass: boolean; findings: CheckFinding[]; script_hash: string; input: Uint8Array; output: Uint8Array }
export const CHECK_MAX_OUTPUT = 1048576;
export function checkInput(check: string, state: Readonly<CaseState>, draft: Draft, registry: Registry, profile: Profile): CheckInput;
export function runCheck(check: CheckManifest, input: CheckInput): Promise<CheckOutcome>;   // never throws
```

**A check is a program: JSON in on standard input, `{ "pass": boolean, "findings": [{ "where": string, "message": string }] }` out on standard output.**

```yaml
kind: check
id: confidence-and-likelihood
title: Confidence and likelihood are kept apart
order: 3
script: 03-confidence-and-likelihood.ts
runner: bun            # bun: run with this Bun; exec: run the file itself
timeout_ms: 10000
```

`loadChecks` leaves a check out, with a problem, when its root is not trusted (`check <id> is in a root that is not trusted for scripts; it will not run`), when `script` is not a plain file name inside the manifest's folder, when `staysInside(root, script path)` is false, or when the file is missing.

`runCheck`:

- Reads the script and hashes its bytes: that is `script_hash`. `input` is `canonical(input)`.
- Spawns `[process.execPath, <script>]` for `bun`, `[<script>]` for `exec`, with `cwd` the script's folder, the input on standard input, and the environment `{ PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }` and nothing else.
- Kills it at `timeout_ms`.
- `pass` is true only when the program exited 0, its output parsed to the shape above, `pass` was `true` and `findings` was empty. Each finding gets `check: <id>`.
- Every failure to do so is `pass: false` with one finding, `where: "check"`: `timed out after <ms> ms`, `exited with code <n>`, `did not return valid findings`, `returned more than 1 MiB`.
- `output` is the bytes the program wrote (cut at `CHECK_MAX_OUTPUT`).

**`checkInput`.** `cards` holds every card the product cites that exists. `sources` holds each of those cards' sources. `schema` is the `product` schema, `standard` the body of the profile's standard, `markings` is `MARKINGS`, `earlier` is `state.published`.

**The Checks stage.** `d = latestDraft(state)`. No runnable check is `stalled`: `Checks has nothing to run: <problems>`. Otherwise each check runs in `order`, and after each, one commit as `{ kind: "system", id: "checks" }`: `check.run { check, script_hash, input: <blob>, output: <blob>, draft_hash: d.hash, pass, findings }`. The stage finishes `pass` on `d.hash` when all passed, else `fail` with reason `<id> failed: <first message>` for the first failing check (plus `and <n> more` when there are others). Its output is `{ checks: [{ check, pass }] }`.

**The eleven checks.** Each script stands alone: it reads standard input, imports nothing outside Bun's built-ins, and prints one JSON object. `where` names the finding (`f1`), the section, or `product`.

| # | id | Fails when |
|---|---|---|
| 1 | `schema` | the product does not match `input.schema`. The script carries its own small validator for the keywords the product schema uses: `type`, `required`, `properties`, `additionalProperties`, `items`, `enum`, `minLength`, `minItems` |
| 2 | `likelihood-term` | a key finding's `likelihood` is not a `term` of the standard; or its statement does not hold exactly one likelihood term or variant (longest match first, so "very likely" is not also "likely"); or that one is not its `likelihood` |
| 3 | `confidence-and-likelihood` | a key finding's `confidence` is not in the standard's levels; or its `confidence_basis` is empty; or any sentence of a statement, the summary or the assessment holds both `<level> confidence` and a likelihood term or variant |
| 4 | `citations` | a key finding cites no card; or a cited id is not in `input.cards` |
| 5 | `source-quality` | a cited card's source has no entry in `product.sources`, or one with empty `quality`; or a quality note named on a cited card is missing from that entry's text |
| 6 | `assumptions-and-judgments` | no assumption is listed anywhere (the product's list and every finding's are empty); or an assumption holds a card citation like `[c3]`; or a key finding's statement holds none of the standard's `judgment_markers` |
| 7 | `alternatives` | `alternatives` is empty or only white space |
| 8 | `gaps-and-negatives` | `gaps_and_limits` is empty; or a cited card with partial coverage is not named (`[c3]`) in `gaps_and_limits`; or a finding cites a card with no rows that is not a proven negative with full coverage |
| 9 | `objective-and-question` | `objective` or `question` is empty; or `objective` is not `input.objective.title` when one is given |
| 10 | `change` | `change` is empty; or it does not start with one of the standard's `change_terms`; or it starts with "first judgment" while `input.earlier` is not empty, or with another term while it is empty |
| 11 | `marking` | `product.marking` is less restrictive (by `input.markings`) than a cited card's, or is not a marking |

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/checks.test.ts   (scripts written into a temp trusted root by each test)
test("a check gets the input on standard input and its findings come back with its id", ...);
test("the script's hash and the exact input and output bytes are returned", ...);     // script_hash === sha256Hex(script bytes)
test("a check that hangs is killed at its timeout and fails", async () => {
  const o = await runCheck({ ...check, timeout_ms: 300 }, input);                     // script: for(;;) {}
  expect(o).toMatchObject({ pass: false, findings: [{ check: "slow", where: "check", message: "timed out after 300 ms" }] });
});
test("a check that exits non-zero, prints rubbish or prints too much fails with the reason", ...);
test("a check that says pass but lists findings fails", ...);
test("a check sees no credentials in its environment", async () => {
  process.env.RW_TEST_SECRET = "s3cr3t-value";                                        // restored in finally
  // script prints { pass: Object.keys(process.env).sort().join() === "LANG,PATH", findings: [] }
  expect((await runCheck(check, input)).pass).toBe(true);
});
test("a check from an untrusted root is not loaded and never runs", ...);             // problem text; a marker file the script would write is absent
test("a script path that leaves its folder is refused", ...);                         // script: ../outside.ts
test("the Checks stage records each run against the draft's hash with input and output blobs", ...);
test("a failing check fails the stage and names itself in the reason", ...);
test("a Checks stage with nothing to run pauses the run instead of passing", ...);

// tests/sample/form-checks.test.ts
// `good` is a product, cards and sources that pass all eleven: f1 cites c2 (rows, full) and c3 (partial, named in gaps_and_limits); f2 cites c1 (no rows, a proven negative).
// Each case is run through runCheck with the sample's own script.
test("the good product passes all eleven checks", ...);
test.each([
  ["schema", (i) => { Object.assign(i.draft.product, { extra: 1 }); }, "product"],
  ["likelihood-term", (i) => { i.draft.product.key_findings[0]!.likelihood = "quite likely"; }, "f1"],
  ["likelihood-term", (i) => { i.draft.product.key_findings[0]!.statement = "We assess it is likely, and very likely, that this is so."; }, "f1"],
  ["confidence-and-likelihood", (i) => { i.draft.product.summary += " We have moderate confidence that this is likely."; }, "summary"],
  ["confidence-and-likelihood", (i) => { i.draft.product.key_findings[0]!.confidence_basis = ""; }, "f1"],
  ["citations", (i) => { i.draft.product.key_findings[0]!.cites = []; }, "f1"],
  ["citations", (i) => { i.draft.product.key_findings[0]!.cites = ["c99"]; }, "f1"],
  ["source-quality", (i) => { i.draft.product.sources = []; }, "sources"],
  ["assumptions-and-judgments", (i) => { i.draft.product.assumptions = ["The asset list is current [c2]."]; }, "assumptions"],
  ["assumptions-and-judgments", (i) => { i.draft.product.key_findings[0]!.statement = "The account is very likely behind it."; }, "f1"],
  ["alternatives", (i) => { i.draft.product.alternatives = "  "; }, "alternatives"],
  ["gaps-and-negatives", (i) => { i.draft.product.gaps_and_limits = "None known."; }, "gaps_and_limits"],       // the partial card is not named
  ["gaps-and-negatives", (i) => { i.cards.c1!.empty = "not-seen"; }, "f2"],                                       // a zero-row card cited as a negative
  ["objective-and-question", (i) => { i.draft.product.question = ""; }, "product"],
  ["change", (i) => { i.draft.product.change = "No comment."; }, "change"],
  ["change", (i) => { i.earlier = [{ n: 1, hash: "0".repeat(64) }]; }, "change"],                                 // says first judgment, but one exists
  ["marking", (i) => { i.cards.c2!.marking = "TLP:RED"; }, "product"],
])("%s fails when it should", async (id, spoil, where) => { ... expect(o.pass).toBe(false); expect(o.findings[0]!.where).toBe(where); });
test("each failing case fails only the check it is aimed at", ...);                   // the other ten still pass
test("the sample root loads eleven checks in order with no problems", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 300 bun test tests/pipeline/checks.test.ts tests/sample/form-checks.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement `loadChecks`, `checks.ts` and `stages/checks.ts`; register the runner**

- [ ] **Step 4: Write the eleven manifests and scripts**

- [ ] **Step 5: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/pipeline sample/checks tests/pipeline tests/sample/form-checks.test.ts
git commit -m "feat(pipeline): checks run as separate programs; the eleven form checks"
```

---

### Task 12: Publishing and feedback

**Files:**
- Create: `src/pipeline/publish.ts`, `src/pipeline/feedback.ts`, `src/pipeline/stages/publish.ts`, `src/pipeline/stages/feedback.ts`
- Modify: `src/pipeline/engine.ts`
- Test: `tests/pipeline/publish.test.ts`, `tests/pipeline/feedback.test.ts`

**Interfaces:**
- Consumes: `publishable`, `blockers`, `latestDraft`, `canonical`, `sha256Hex`, `stageAgent`, `lastOutput`, `Entry`, `runUsage`.
- Produces:

```ts
// publish.ts
export class PublishRefused extends Error { readonly reasons: string[] }
export interface Bundle { manifest: BundleManifest; files: Record<string, string> }
export interface BundleManifest { case: string; n: number; draft: number; draft_hash: string; head: { seq: number; hash: string }; marking: Marking; title: string; note: string; files: { name: string; sha256: string; bytes: number }[] }
export function draftProblem(draft: Draft): string | null;   // recomputes the hash from the product
export function buildBundle(session: CaseSession, draft: Draft, cover: { title: string; note: string }, head: { seq: number; hash: string }, n: number): Bundle;
export function approve(session: CaseSession, deps: EngineDeps, input: { actor: Actor }): { n: number; dir: string; draft_hash: string };
export function reject(session: CaseSession, pipeline: Pipeline, input: { reason: string; stop: boolean; actor: Actor }): void;
// feedback.ts
export const MOP_IDS = ["elapsed_seconds", "queries_run", "query_cost", "model_tokens", "steps_blocked", "send_backs", "checks_failed"] as const;
export function computeMops(entries: readonly Entry[], state: Readonly<CaseState>): { measure: string; value: number | string; note: string }[];
export class FeedbackRefused extends Error {}
export function recordFeedback(session: CaseSession, registry: Registry, input: { measure: string; value: number | string; note: string; actor: Actor }): void;
// Engine gains: approve(input), reject(input), feedback(input)
```

**The Publish stage** (actor `publisher`, no tools). `publish-output`: `title: string` (`minLength: 1`), `note: string`. Extras: the draft's product. The stage finishes `pass` on the latest draft's hash with output `{ title, note, preview: <the manifest of buildBundle with the current head> }`. The engine then writes `gate.waiting`.

**The bundle.** `files`, all text:

- `product.json` is exactly `canonical(draft.product)`, so its SHA-256 is the draft hash.
- `product.md`: the marking alone on the first line and alone on the last; the title; the objective and the question; draft number and hash; then Summary, Key findings (each with its statement, likelihood, confidence and basis, citations as `[c3]`, and assumptions), Assessment, Alternatives considered, Gaps and limits, Sources and their quality, Assumptions, Change from earlier judgments.
- `provenance.json`: for every cited card, in id order: `{ card, title, source, source_hash, query, text, bound, window, why, by, issued, marking, coverage, empty, rows, rows_hash, result_sha256 }`, read from the card and its `query.issued` and `query.result` entries.
- `provenance.md`: the same, readable, with the marking on the first and last lines.

`manifest.files` lists each with its SHA-256. `manifest.head` is the chain head given. Nothing in a bundle comes from a clock.

**`approve`** (throws `PublishRefused` and writes nothing when refused):

1. Only a human. The run must be waiting at the publish gate.
2. `d = latestDraft(state)`. If `draftProblem(d)` is not null: refused with it. (The ledger already refuses such a draft; this is the last check before bytes leave.)
3. `blockers(state, d.hash)` not empty: refused with those reasons.
4. `cover` is Publish's last output. `n = state.published.length + 1`. `head = session.head()`. Build the bundle, write its files and `manifest.json` to `<case dir>/published/<n>/`, and store `canonical({ manifest, files })` as the bundle blob.
5. One commit whose builder throws if `state.seq !== head.seq` (another entry arrived; remove the folder and start again from step 2, at most three times). As the person: `gate.passed { gate: "publish" }`; `lane.created { title: "Cited evidence", subgoal: null }` when there is no lane at all; `card.kept { card, lane, index: null }` for each cited card that is not in a lane, into the lane of its sub-goal, else the first lane; `product.published { n, draft_hash: d.hash, head_hash: head.hash, dir: "published/<n>", bundle }`.
6. `deps.anchor?.({ case, seq, hash, why: "published" })` with the new head.

**`reject`**: only a human, at the publish gate. One commit: `publish.rejected { draft_hash, reason, stop }` as the person. With `stop`, also `run.finished { outcome: "stopped" }`. Without, as the engine: `stage.finished` for the publish stage with outcome `fail` and the reason, `stage.sent_back { from: publish, to: its on_fail, reason, count }`, and `stage.started` for that stage. The cap does not stop a person's rejection.

**The Feedback stage** (run by code on the person's behalf). One commit as `{ kind: "system", id: "feedback" }`: a `feedback.recorded { measure, kind: "mop", value, note }` for each `computeMops` result whose id the case's objective lists as a `mop` measure (all of them when the case has no objective). The stage finishes `pass`, and the engine finishes the run as `published`.

`computeMops`, from the entries of the current run (from its `run.started`):

| measure | value |
|---|---|
| `elapsed_seconds` | whole seconds from `run.started` to `product.published` |
| `queries_run` | the number of `query.issued` |
| `query_cost` | the sum of `query.result.cost` by unit, as text: `1 lookups`, or `0` |
| `model_tokens` | `runUsage(state)` input plus output |
| `steps_blocked` | the number of `step.finished` with outcome `blocked` or `failed` |
| `send_backs` | the number of `stage.sent_back` |
| `checks_failed` | the number of `check.run` with `pass: false` |

`recordFeedback` is the person's measures of effectiveness: only a human; the measure must be a `moe` measure of the case's objective, else `FeedbackRefused`. It commits `feedback.recorded` with kind `moe`. It works after the run has finished.

- [ ] **Step 1: Write the failing tests**

Tests drive the engine on `sampleRoot` to the publish gate with a short inline script (a helper in the test file).

```ts
// tests/pipeline/publish.test.ts
test("the publisher's title and a preview of the bundle are the Publish stage's output", ...);
test("approving writes the bundle and records it", async () => {
  const r = engine.approve({ actor: human });
  const dir = join(s.dir, r.dir);
  expect(readdirSync(dir).sort()).toEqual(["manifest.json", "product.json", "product.md", "provenance.json", "provenance.md"]);
  expect(sha256Hex(readFileSync(join(dir, "product.json")))).toBe(r.draft_hash);
  expect(s.state.published).toHaveLength(1);
  expect(verifyCase(s.dir).ok).toBe(true);
});
test("the product carries its marking on its first and last lines", ...);
test("the provenance appendix gives each cited card's source, exact query, why, who, when, marking and hashes", ...);
test("the bundle records the chain head at the moment of publishing", ...);          // manifest.head.hash === hash of the entry before gate.passed
test("approving keeps the cited cards into their sub-goals' lanes", ...);
test("a draft that has not passed review cannot be published", () => {
  // a draft.revised committed straight to the session while the run waits at the gate (not through reviseDraft)
  expect(() => approve(s, deps, { actor: human })).toThrow(PublishRefused);
  expect(err.reasons).toContain("Checks has not passed this revision");
  expect(s.state.published).toEqual([]);
});
test("an edit goes back through Checks, Evaluate and Challenge before it can be approved", ...);   // then approve publishes the edited hash
test("draftProblem names a draft whose hash is not the hash of its product", ...);   // { ...draft, product: { ...draft.product, summary: "changed" } } -> "the draft's hash does not match its product"; an intact draft -> null
test("a draft with an open must-address challenge is refused, naming it", ...);
test("an agent or the system cannot approve", ...);
test("approving when the run is not at the publish gate is refused", ...);
test("rejecting sends the run back to Assemble with the reason, and the draft must pass review again", ...);
test("rejecting with stop finishes the run as stopped", ...);
test("publishing is anchored on the workbench chain", ...);                           // the anchor callback got the new head
test("a second product in the same case is numbered 2", ...);

// tests/pipeline/feedback.test.ts
test("measures of performance are computed from the ledger", () => {
  expect(Object.fromEntries(computeMops(entries, state).map((m) => [m.measure, m.value]))).toEqual({
    elapsed_seconds: 42, queries_run: 5, query_cost: "1 lookups", model_tokens: 1234, steps_blocked: 1, send_backs: 1, checks_failed: 1,
  });                                                                                 // entries built with EntryBuilder
});
test("only the current run is counted", ...);
test("after approval the measures are recorded and the run finishes as published", ...);
test("a person records a measure of effectiveness, after the run too", ...);
test("an unknown measure, a performance measure by hand, or an agent is refused", ...);
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 300 bun test tests/pipeline/publish.test.ts tests/pipeline/feedback.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `publish-output`; implement `publish.ts`, `feedback.ts` and the two runners; add the three commands to `Engine`**

- [ ] **Step 4: Run the tests and the type check**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/pipeline sample/context/schemas tests/pipeline
git commit -m "feat(pipeline): the publish gate, the bundle, and feedback from the ledger"
```

---

### Task 13: The scripted run, the headless command, the custody acceptance test

**Files:**
- Create: `sample/scripts/sample-run.yaml`, `src/cli/compose.ts`, `src/cli/run.ts`
- Modify: `package.json` (script `"investigate": "bun run src/cli/run.ts"`), `sample/README.md`, `docs/superpowers/plans/2026-11-23-slice-roadmap.md` (plan 3's task list, to match this plan)
- Test: `tests/sample/full-run.test.ts`, `tests/cli/run.test.ts`

**Interfaces:**
- Consumes: everything above; `loadConfig`, `Workbench`, `Registry`, `Observables`, `Secrets`, `ConnectorPool`, `SEEKERS`, `recoverSession`, `verifyCase`, `ensureSampleData`, `startReputationFixture`.
- Produces:
  - `compose(config: Config, wb: Workbench): { deps: EngineDeps; problems: string[]; close(): void }` — loads the registry (recording on the workbench chain), observables, secrets, the connector pool, the seeker named in the configuration, the providers, the pipeline and the `investigation` profile. `deps.anchor` appends `case.anchored` to `wb.chain`. `close()` closes the pool. It throws when there is no usable pipeline.
  - The command below.

**The command.**

```
bun run src/cli/run.ts start  --title T --asked Q --why W --start type=value [--start ...] --from TS --to TS [--objective ID] [--marking M]
bun run src/cli/run.ts accept-plan <case> [--steps s1,s2] [--budget step=amount ...]
bun run src/cli/run.ts replan      <case> --note N
bun run src/cli/run.ts approve     <case>
bun run src/cli/run.ts reject      <case> --reason R [--stop]
bun run src/cli/run.ts resume      <case>
bun run src/cli/run.ts feedback    <case> --measure ID --value V [--note N]
bun run src/cli/run.ts status      <case>
```

Options for every form: `--config <file>`, and `--sample-fixture [port]` (generate the sample data under the first root if it is missing and serve its reputation stand-in on `127.0.0.1:<port>`, default 4801, while the command runs).

Every form opens the workbench, composes, and (for an existing case) calls `recoverSession`. `start` creates the case and starts a run. Every form but `status` and `feedback` then calls `advance()` (`resume` calls `engine.resume`). The actor is `{ kind: "human", id: config.user }`. Before it exits the command anchors the case head (`why: "closed"`) and closes everything.

It prints registry and pipeline problems to standard error, then one line per case to standard output: `<case> <status>` followed, as they apply, by ` waiting=plan|publish`, ` stage=<id>`, ` draft=<n>`, ` published=<dir>`, and ` reason="<pause reason>"`. At the plan gate it also prints each step (`s3 costly lookups address_to_verdict 198.51.100.77`); at the publish gate, each blocker. Exit codes: `0` when the run is waiting, finished, or status was asked; `1` when it is paused or interrupted or a command was refused (the reason on standard error); `2` for a usage error.

**The scripted run** (`kind: script`, `id: sample-run`). It starts from `198.51.100.77` over `SAMPLE_WINDOW`. Card titles are `<pivot title>: <value>`, which is how `{{card:...}}` finds them. Turns, by actor, in order:

| Actor | Turns |
|---|---|
| `orchestrator` | `list_sources`; then the frame: goals "Who is behind the traffic" (want `account`) and "Is the address known to be bad" (want `verdict`), the sample window, `allow_unconfirmed: false`, `max_weight: null` |
| `planner` | `find_routes` to `account`; `find_routes` to `verdict`; then the plan: sub-goal 1 with route `[address_to_asset, asset_to_accounts]`, sub-goal 2 with route `[address_to_verdict]`, both from the starting address |
| `researcher-g1` | `run_step s1` (no rows, proven negative: a dead end); `find_routes` to `account`; `run_pivot address_to_internal_peers` on the starting address (partial, finds `192.0.2.17`); `run_step s1` with `192.0.2.17`; `run_step s2` with `ws-17.example.net`; `run_pivot account_to_signin_addresses` on `j.doe`; then `answered` |
| `researcher-g2` | `run_step s3` (costly; paid from the plan budget); then `answered` |
| `analyst` (draft 1) | `list_cards`; `propose_assessment` f1, citing the peers, asset and accounts cards, with likelihood `very likely` and the statement "We assess that the account j.doe is very likely behind the regular connections from ws-17.example.net to 198.51.100.77, and we have moderate confidence in this." (the planted fault: one sentence holds a confidence and a likelihood); `propose_assessment` f2, citing the proven-negative card: "We assess that 198.51.100.77 is almost certainly not an internal host."; `propose_narrative` for summary, gaps_and_limits (naming the partial peers card), alternatives and assessment; then the output with `change: "First judgment on this question."` and one assumption |
| `analyst` (draft 2) | `list_cards`; `propose_assessment` replacing f1 with the first sentence only; then the output |
| `evaluator` | `list_cards`; `read_card` on the accounts card; `verify_card` on the asset card for `192.0.2.17`; then `pass: true` |
| `adversary` | `list_cards`; `raise_challenge` with severity `consider`, citing the peers card; then `done: true` |
| `publisher` | `{ title: "Regular connections to 198.51.100.77", note: "Sample run." }` |

So the run has exactly one send-back (Checks to Assemble, on check 3), one dead end with a re-route, one partial result, one proven negative and one costly step.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/sample/full-run.test.ts   (in process: sampleRoot, compose-like deps, the sample's own script)
test("a full scripted run reaches the publish gate", async () => {
  engine.start(human);
  expect((await engine.advance()).waiting).toBe("plan");
  engine.acceptPlan({ budgets: { s3: 1 }, actor: human });
  const sum = await engine.advance();
  expect(sum).toMatchObject({ status: "waiting", waiting: "publish" });
  expect(s.state.run.sendbacks).toEqual({ "checks>assemble": 1 });
  expect(s.state.drafts.map((d) => d.n)).toEqual([1, 2]);
  expect(blockers(s.state, s.state.drafts[1]!.hash)).toEqual([]);
  expect(s.state.skipped).toEqual([]);
});
test("the run found the account, hit a dead end, a partial result and a proven negative, and paid for one lookup", ...);
test("custody: every card traces to a query issued, a query result and a blob", () => {
  for (const card of Object.values(s.state.cards)) {
    const q = s.state.queries[card.query!]!;
    expect(entries.find((e) => e.seq === q.issued_seq)?.type).toBe("query.issued");
    expect(entries.some((e) => e.type === "query.result" && e.payload.query === q.id)).toBe(true);
    expect(s.blobs.check(q.result!.blob)).toBe("ok");
  }
});
test("custody: every model request has its response and every tool call its return, each with blobs that are there", ...);
test("custody: chain verification passes, for the case and for the workbench chain", ...);
test("custody: replay ends in the same state as live, and matches at every entry", () => {
  expect(fold(s.entries())).toEqual(s.state);
  for (const [seq, live] of seenLive) expect(s.stateAt(seq)).toEqual(live);     // seenLive filled by a subscriber during the run
});
test("no agent accepted, kept, moved, discarded or published anything, and none set a budget", ...);   // by actor kind over the entry types
test("no secret is in any entry or blob, and no source location is in anything a model was sent", ...);   // a planted env secret: absent everywhere; the fixture's URL: absent from every model.request and tool.returned blob
test("approving publishes exactly the reviewed revision and finishes the run", async () => {
  const r = engine.approve({ actor: human });
  expect(r.draft_hash).toBe(s.state.drafts[1]!.hash);
  expect((await engine.advance()).outcome).toBe("published");
  expect(s.state.feedback.map((f) => f.measure)).toEqual([...MOP_IDS]);
  expect(s.state.feedback.find((f) => f.measure === "send_backs")!.value).toBe(1);
  expect(verifyCase(s.dir).ok).toBe(true);
});
test("the same run split across a stop and a recovery ends in the same published hash", ...);   // close and reopen at the plan gate and mid-research
test("with three researchers at once the script still resolves every card", ...);               // research.parallel 3

// tests/cli/run.test.ts   (Bun.spawnSync with a 60 s timeout each; a temp config whose root is a copy of the sample on a free port)
test("start runs to the plan gate and prints the steps", ...);                 // exit 0; stdout "CASE-1 waiting waiting=plan"; a line for s3 marked costly
test("accept-plan with a budget runs to the publish gate", ...);               // "CASE-1 waiting waiting=publish stage=publish draft=2"
test("approve publishes and finishes", ...);                                   // "CASE-1 finished published=published/1"; the folder exists
test("the verify command passes on the finished case", ...);                   // bun run src/cli/verify.ts <case dir> exits 0
test("status changes nothing in the case", ...);                               // the case's head seq is the same before and after
test("a refused command exits 1 with the reason and writes nothing", ...);     // approve at the plan gate
test("a usage error exits 2", ...);
test("the lock is released after every command", ...);                         // a second command right after the first succeeds
```

- [ ] **Step 2: Run the tests to see them fail**

Run: `timeout 600 bun test tests/sample/full-run.test.ts tests/cli/run.test.ts`
Expected: FAIL.

- [ ] **Step 3: Write `sample/scripts/sample-run.yaml`** from the table. Run the in-process test after each actor's turns are added; a turn that does not match what the tools return shows up as a script error naming the turn.

- [ ] **Step 4: Implement `src/cli/compose.ts` and `src/cli/run.ts`; add the package script**

- [ ] **Step 5: Update `sample/README.md` and the roadmap.** The README gains the three commands of a demo run (`start ... --sample-fixture`, `accept-plan CASE-1 --budget s3=1 --sample-fixture`, `approve CASE-1`). The roadmap's plan 3 task list becomes this plan's fourteen tasks.

- [ ] **Step 6: Run the whole suite three times, and the type check**

Run: `for i in 1 2 3; do timeout 900 bun test || break; done; timeout 300 bun run typecheck`
Expected: all pass, every round.

- [ ] **Step 7: Run the demo by hand once**

Run, with a scratch configuration whose `data_dir` is a temp folder:
`timeout 120 bun run src/cli/run.ts start --config <cfg> --sample-fixture --title "Sample" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN`, then `accept-plan CASE-1 --budget s3=1`, then `approve CASE-1`, then `bun run src/cli/verify.ts <data_dir>/cases/CASE-1`.
Expected: the three status lines above and `chain intact`.

- [ ] **Step 8: Commit**

```bash
git add sample src/cli package.json tests/sample/full-run.test.ts tests/cli docs/superpowers/plans/2026-11-23-slice-roadmap.md
git commit -m "feat: a scripted investigation end to end from the command line, with the custody acceptance test"
```

---

## Left for later plans

- **Plan 4 (server and interface):** the Agent lens's conversational agent (`agent.asked`, `agent.answered`); the dropdowns, including showing a model that is not allowed as disabled with the reason; the commands that call `setModel`, `setPackLimit`, `revise`, `pause`; surfacing `state.skipped`; local query timeouts in a worker (deadline carried from plan 2); a blob-to-rows reader per connector for the row-level difference in re-validation (deadline carried from plan 2); `runRoute` behind the Pivot panel; plan-time estimates for costly steps, through an export of the runner.
- **Plan 5 (real run):** the owner's model manifest for the local endpoint, outside the repository; guardrail soundness on guarded lake tables (deadline carried from plan 2); the real investigation.
- **After the slice:** the `claude` provider and provider fallback after a decline (spec 8.3); model prices and a cost in currency.
- **Not taken up from plan 2's re-review, because the close-out ruling does not list it:** pivot and source ids are first-loaded-wins across roots, so an untrusted root listed before a trusted one can take a trusted pivot's id.
