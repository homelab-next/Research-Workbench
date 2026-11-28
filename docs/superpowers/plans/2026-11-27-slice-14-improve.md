# The improve loop (slice 14) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person attaches a known answer to a published product; a case with one is a task for its case type. An improve case, made from a loop's page, runs the loop `improve`: code selects tasks, a model proposes candidate changes to the target loop as builder changes, code runs every task under the unchanged loop and under each candidate as child cases, a model picks the candidate the contrasts support, code then scores every output against the known answers, a model proposes lessons, and a person accepts or rejects each file of the chosen candidate. Nothing is adopted and no lesson is accepted without a person.

**Architecture:** Eleven new entry types, folded by one new reducer `applyImprove` (`src/core/state/improve.ts`) into `state.answers` (a task case) and `state.improve` (an improve case, and the mark of a probe child). The improve loop is an ordinary loop manifest whose seven stages have seven new roles (`select`, `propose`, `probe`, `compose`, `judge`, `reflect`, `adopt`) and a third gate, `adopt`. A candidate is a `builder.proposed` change of the improve case's own ledger, made by slice 12's `propose_change` tool behind slice 12's save check plus the candidate rules (`src/modules/loop-stage.ts`). A candidate is staged by resolving the target loop over a copy of the root (slice 12's `plan` of `loop-write.ts`) into a lock; the bytes the live content store does not hold go to a staging store `<data>/staged/<improve case>/`, never to the chain, the registry or the content store. A probe child is an ordinary child case (slice 12's `ChildLink`, `subloop.child`) with one more entry, `probe.child`; its run binds the staged lock, which `LoopCatalog.fromLock(lock, over)` rebuilds reading the staging store over the content store. Probe ends each child at its publish gate and copies its draft into a blob of the improve case. Judge copies the known answers into a blob of the improve case and scores in code (`src/core/score.ts`). Adopt waits at the `adopt` gate; a decision is slice 12's `builderDecide`.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun test`, happy-dom and headless Chromium for interface tests. `pivot` v0.2.0 (not changed). No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-27-slice-14-improve-design.md` ("the design"; the owner's direction; the controller commits it from the scratchpad before Task 0). Branch `slice-14-improve` in the worktree `<repo>`, stacked on `slice-13-memory`. Decisions the design left open are the "Ruling:" lines in `.superpowers/sdd/2026-11-27-slice-14-improve/rulings.md`; where a task states one, it is the requirement.

## Global Constraints

- **The judge is blind until it runs.** A known answer's text and expected findings are read by `src/pipeline/improve/answers.ts` (the person's write) and `src/pipeline/improve/judge.ts` and by no other file under `src/pipeline/` or `src/agents/`. Select records of a known answer only the seq and hash of its entry. No `model.request` of any stage but `judge`, in the improve case or in any probe child, holds a known answer's text or an expected claim. `judge.scored` is skipped by the fold unless `compose.chosen` of the same run precedes it. Reflect is given scores, never answers.
- **Scores are code.** `scoreOutput` (`src/core/score.ts`) is a pure function of a probe output, a known answer, a likelihood scale and a claim-to-finding matching. A model, when the Judge stage runs one, only names which produced finding states an expected claim that code could not match; it never gives a number. Every score is an integer from 0 to 1000.
- **A person's gates stay a person's.** The only gate code passes is the plan gate of a probe child, by `{ kind: "system", id: "improve-probe" }`, through `probeAcceptPlan` (`src/pipeline/plans.ts`), when the improve loop's Probe stage declares `probe: { plan_gate: accept }`. The fold skips every entry by that actor in a case that is not a probe child, and every entry by it that is not one of the five it may write. Code never passes a publish gate or the adopt gate. A system acceptance carries no budget, so no costly step runs in a probe.
- **Nothing is adopted or accepted by code.** `builder.decided` is written only by `builderDecide` (`src/server/builder.ts`), by the person the server names; a file reaches a root only through `saveManifests`, as that person. Reflect files proposals through `MemoryHost.propose`; no file under `src/pipeline/improve/` imports `src/core/memstore.ts`.
- **A staged candidate never enters the live registry.** Staging writes nothing to a root, appends nothing to the workbench chain (no `loop.recorded`, no `module.loaded`, no `manifest.written`), and puts nothing in the workbench's content store. `LoopCatalog.list`, `current` and `atHash` never return a staged version. Only a probe child's engine reads the staging store, and only for the lock its own `loop.bound` names.
- **Custody.** Every probe query goes through `runQuery` in the child's own ledger. A probe child is marked at least as strictly as the improve case, which is marked at least as strictly as every task it selected and every known answer it will read. A task or an answer stricter than the improve case is left out by Select.
- **Probe children never publish.** `approve` refuses in a probe child; the fold skips `product.published` and a pass of the publish gate there.
- **The fold never throws and never mutates its input.** Every new payload belongs to a new entry type. A malformed payload is recorded in `skipped`.
- **Old ledgers fold unchanged and replay stays exact.** No existing payload gains a field. `GATES` gains `adopt`; no ledger written before this slice holds it or the actor `improve-probe`. Every existing field of `fold(entries, n)` for an old ledger is what it was. An improve case's fold reads no other ledger: what Select took of each task, each probe's output, the contrasts, the answers and the scores are blobs of the improve case.
- **A loop that is not an improve loop runs as before.** No sample loop, stage or profile that exists today is changed; their hashes and every slice 12 and 13 acceptance test are what they were.
- **No secret is read, written, exported or shown.** A candidate file is checked as a builder proposal is (`CREDENTIAL_REFUSAL`, `MARK_REFUSAL`, the save's own search). Every text shown to a model or a person is scrubbed as a card is.
- **Browser-safe core.** `src/core/state/**` imports nothing outside `src/core/`; no `Bun`, `process`, `Buffer`, `node:*`. `src/web/**` imports only `src/web`, `src/core/state`, `src/core/wire.ts`, `src/core/types.ts`, `src/core/canonical.ts`.
- **No HTML sink, no inline style.** Elements are made only by `h` and `s`. A known answer, a candidate's title, a reason, a diff line and a score are text nodes or the value of a fixed attribute.
- **Loopback only.** Every new route is in `src/server/app.ts`'s route table, behind `refusal()` (Host, Origin, JSON) and the role check. The server names the actor; no body may.
- **Exact values:** the configuration's `improve` block is `{ max_tasks: 3, max_candidates: 3, probe_lookups: 240, probe_tokens: 1200000, own_tokens: 400000, staged: "<data_dir>/staged" }`; a request asks for 1 to 8 tasks and 1 to 4 candidates, and no more than the configuration's two maxima; a task's id is `T1`, `T2`, …; a candidate's `K1`, `K2`, …; the unchanged loop is `base`; a probe's id is `<candidate>/<task>` (`base/T1`, `K2/T3`); a known answer's text is 1 to 600 characters, it has at most 12 expected findings, a claim is 1 to 300 characters; `CLAIM_MATCH` is `500`; `PROBE_OUTPUT_FORMAT` is `1`; `PROBE_PLAN_ACCEPTS` is `4`; the probe actor is `{ kind: "system", id: "improve-probe" }`; `WORKBENCH_VERSION` is `"0.14.0"`; the improve loop's id is `improve`.
- **Deterministic.** No `Math.random`, no `Date.now` in a fold, a hash, a selection, a score or a builder of entries; `<` on strings, not `localeCompare`, in new code. Scores are integers; a mean is `Math.round`.
- **The real environment stays out of the repository.** Tests and the sample use synthetic data only: the sample's names, loopback and RFC 5737 addresses, `example.*` domains. The owner's known answers are never written into `<repo>`: not in the sample, a test, a fixture, a document or a commit message. In anything committed, a path on the owner's machine is written `<repo>`, `<data>` or `<lake>`.
- **Tests:** `timeout 120 bun test <file>` while iterating; `timeout 900 bun test && timeout 300 bun run typecheck` before each commit, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. No test asserts an absolute duration. Every test makes its files under a fresh `mkdtempSync` directory and removes it, closes what it opens, and asserts `state.skipped` is `[]` when it drives a session. Report real RED: the failing run of the new tests, made before the implementation exists.
- **No wait loops, nothing left running.** Never wait with a `pgrep`-based loop or an `until` loop on a log (other sessions on this machine run `bun test` too, so such a loop never ends). Run commands in the foreground with a time limit. Leave no background process behind.
- **Commits:** on `slice-14-improve`, never pushed; `git add` by explicit path (other tasks may have uncommitted work in the tree). Never `git checkout`, `switch`, `stash` or `reset`. End every commit message with the attribution lines your own harness reminder gives you.
- **Other trees are not yours.** Do not touch any other worktree of this repository or `<lake>/`.
- **A test outside your task's Files that your change breaks:** fix it if no task running beside yours lists that file; otherwise report it and leave it.

## The ledgers: what is added, and why old ledgers and replay are unchanged

**In a task case's ledger** (folded into `state.answers`):

| Entry | Shape | Written by | Folded into |
|---|---|---|---|
| `answer.known` | `{ product: number; draft_hash: string; text: string; findings: ExpectedFinding[]; marking: Marking }` | a person | `answers[String(product)]`, replacing an earlier one for that product |
| `answer.withdrawn` | `{ product: number; reason: string }` | a person | removes `answers[String(product)]` |

`ExpectedFinding` is `{ claim: string; likelihood: string; confidence: "low" | "moderate" | "high" }`.

**In an improve case's ledger** (folded into `state.improve`; its candidates are slice 12's `builder.proposed` and `builder.decided`, folded into `state.builder` as they are today):

| Entry | Shape | Written by | Folded into |
|---|---|---|---|
| `improve.requested` | `{ target: string; case_type: string; tasks: number; candidates: number }` | the person, in the commit of `case.created` | `improve.request` |
| `improve.selected` | `{ target: string; version: number; loop_hash: string; lock: BlobRef; case_type: string; scale: string[]; left_out: { case: string; why: "marking" \| "cap" }[] }` | the engine (Select) | `improve.selected`; clears the tasks, candidates, probes, choice and scores of an earlier run |
| `improve.task` | `{ task: string; case: string; origin: string; head: { seq: number; hash: string }; product: { n: number; draft_hash: string }; answer: { seq: number; hash: string }; marking: Marking; inputs: BlobRef; record: BlobRef }` | the engine (Select), in the commit of `improve.selected` | `improve.tasks[task]`, `improve.task_order` |
| `improve.candidate` | `{ candidate: string; change: string; status: "staged" \| "dropped"; loop_hash: string \| null; lock: BlobRef \| null; reason: string }` | the engine (Propose, after its agent ends) | `improve.candidates[candidate]`, `improve.candidate_order` |
| `probe.started` | `{ probe: string; candidate: string; task: string; child: string; origin: string; loop_hash: string; input_hash: string; budgets: { lookups: number; tokens: number } }` | the engine (Probe) | `improve.probes[probe]`, `improve.probe_order` |
| `probe.finished` | `{ probe: string; child: string; child_run: string \| null; head: { seq: number; hash: string }; outcome: "drafted" \| "incomplete"; reason: string; draft_hash: string \| null; output_hash: string; output: BlobRef; lookups: number; tokens: number }` | the engine (Probe) | the probe's `finished` |
| `compose.chosen` | `{ candidate: string \| null; why: string; contrasts: BlobRef }` | the Compose stage's agent, or the engine when no candidate was staged | `improve.chosen` |
| `judge.scored` | `{ answers: BlobRef; scores: BlobRef; matcher: "code" \| "code+model"; summary: { candidate: string; score: number; drafted: number; tasks: number }[] }` | the engine (Judge) | `improve.scored` |

**In a probe child's ledger:** `probe.child { improve: string; origin: string; probe: string; candidate: string; task: string; plan_gate: "accept"; max_lookups: number }`, by the engine, in the commit of `case.created` after `subloop.child`; folded into `improve.probe_of`. The child's token budget is a `budget.set` of that commit, as a person's is.

`GATES` becomes `plan`, `publish`, `adopt`; `gate.waiting` and `gate.passed` carry `adopt` for the improve case's Adopt stage. `ROLES` gains the seven roles.

- **Old ledgers fold unchanged.** An old ledger holds none of the eleven types, no `adopt` gate and no entry by `improve-probe`. `state.answers` stays `{}` and `state.improve` stays `initialImprove()`. `applyImprove` is a new reducer, last in `REDUCERS`. The one change before the reducers is `probeVeto` in `applyWith`: it returns a reason only for an entry by `{ kind: "system", id: "improve-probe" }`, for `gate.passed { gate: "adopt" }` not by a person, and for `product.published` or `gate.passed { gate: "publish" }` in a case whose `improve.probe_of` is set; none of those can be in an old ledger.
- **Validated on fold.** Stated in Task 1, each skip with its sentence.
- **Replay stays exact.** An improve case at `n` is `fold(entries, n)`. The Improve lens at `n` shows scores only when `n` is at or after `judge.scored`. Each probe is shown from `probe.finished`: the child's id, the head it had (`seq` and `hash`) and the output blob of the improve case; the link to the child opens it at that seq. Replaying the improve case opens no child and no task.
- **`verify` passes.** The eleven types are in `ENTRY_TYPES`. `BLOB_FIELDS` gains `improve.selected: ["lock"]`, `improve.task: ["inputs", "record"]`, `improve.candidate: ["lock"]` (nullable), `probe.finished: ["output"]`, `compose.chosen: ["contrasts"]`, `judge.scored: ["answers", "scores"]`. `verifyProbes` and `verifyScores` (Task 16) are reports beside `verifyCase`'s; they do not change it.

## How the hard questions are answered

**How a staged candidate version is bound by probe children without entering the live registry.**
1. *Proposed.* Propose's agent calls slice 12's `propose_change`. Its check is the save's own (`checkChange`: the root copied to a temporary folder, the files laid over it, `loadRegistry` and `loadLoops` on the copy) and then `candidateProblems`. What it writes is `builder.proposed` and a bundle blob in the improve case: an entry and a blob, nothing else.
2. *Staged.* When the agent has ended, code stages each change once: `stageCandidate(deps, root, files, target, into)` runs the same plan with `into` (a `BlobStore` at `<data>/staged/<improve case>/blobs`) as the overlay's own folder. The copy's registry is loaded with no chain and no content store, so nothing is recorded; the overlay reads the workbench's content store and writes only to `into`. The target loop of the copy gives a lock; the catalog's `fromLock(lock, into)` rebuilds the loop from bytes alone, so nothing in it names the temporary folder, which is then removed. `improve.candidate` records the lock (a blob of the improve case) and its hash. A change whose lock hash equals the base's, or that does not resolve, is recorded `dropped` with the reason.
3. *Bound.* Probe makes each child with `ProbeCases.create` and drives it with `ProbeCases.drive(ref, { loop })`. For `base`, `loop` is `loops.atHash(target, selected.loop_hash)`: a recorded version. For a candidate, `loop` is `loops.fromLock(readLock(candidate lock blob), staged)`. `Engine.start(ENGINE, { loop })` puts the lock in the child's own blobs and writes `loop.bound`, as for any child.
4. *Rebuilt.* An engine made later for that child (a restart) reads the lock from the child's blobs; `Engine.bind` calls `loops.fromLock(lock, deps.improve?.staged(state.improve.probe_of))` only when `state.improve.probe_of` is set. No other engine is ever given the staging store.
5. *Never live.* `loadLoops`' slots, `recordLoops` and `atHash` read the registry and the chain; staging touches neither. Task 6 and Task 22 hold this with tests: after staging and after a whole probe, the chain's `loop.recorded`, `module.loaded` and `manifest.written` entries, every root's files and the content store's file list are what they were, and `loops.atHash(target, candidate hash)` is the "not in this workbench" sentence.
6. *Collected.* When the improve case's run ends (finished, however), and when a workbench is composed and finds a staging folder whose improve case has no run in progress, the folder is removed. Probe children are ended before that, so no run in progress needs it. Their ledgers, blobs and lock blobs stay: a finished child replays and verifies from its own folder. An adopted candidate was written into the root by the person's accepts; the reload that follows records it as a normal version. When every file of the chosen candidate was accepted on a root unchanged since, that version's hash is the candidate's.

**How the judge is kept blind until it runs.** Five locks:
1. *One reader.* `knownAnswerOf(entries, at)` in `src/pipeline/improve/answers.ts` is the only function that returns an answer's text or findings from a ledger; only `judge.ts` calls it. A boundary test holds the import graph and that no other file under `src/pipeline/` or `src/agents/` reads `state.answers` beyond its keys.
2. *Select copies no answer.* `improve.task` carries `answer: { seq, hash }`. `taskRecord` is built from named fields of the task's state (the question, the starting values, the window, the published product, the stages' outcomes, the queries' sources, pivots and row counts); it does not spread the state.
3. *The fold orders it.* `judge.scored` before `compose.chosen` of the same run is skipped: "the judge runs after Compose has chosen".
4. *The test.* Task 22's acceptance run uses known answers that each hold a canary token in their text and claims worded unlike any scripted finding. It then reads the `messages` blob of every `model.request` and the result of every `tool.returned` in the improve case and in every probe child, and every blob named by an entry of the improve case before `judge.scored`: none holds a canary, an answer's text or a claim. A second test runs the Judge with a model stand-in and shows the only requests that hold a claim are of stage `judge`.
5. *After the judge.* Reflect's pack holds the contrasts and the scores, not the answers: a lesson is shared with later cases, and later Propose runs read lessons.

**How scores are computed in code.** For one probe output and one known answer, with `scale` (the likelihood terms of the target loop's standard, least likely first, recorded by Select):
- `claimSimilarity(a, b)`: lower-case both, split on anything that is not a letter or a digit, drop empty tokens, take the two sets; `Math.round(1000 * |A ∩ B| / |A ∪ B|)`, `0` when either is empty.
- `matchClaims(expected, produced, extra)`: every pair with similarity at least `CLAIM_MATCH`, taken greatest first (ties: the earlier expected finding, then the earlier produced one), each expected and each produced finding used once. `extra` is the model's matching for expected findings code left unmatched (`{ expected: number; produced: string | null }[]`); an entry is used only when both are still free. Each match records `by: "code" | "model"`.
- A matched expected finding scores `500 + Math.round(250 * (1 − ld)) + Math.round(250 * (1 − cd))`, where `ld` is the distance between the two likelihood terms on `scale` divided by `scale.length − 1` (a term not on the scale, or a scale of one term: `1`), and `cd` is the distance between the two confidences on `low, moderate, high` divided by `2`. An unmatched one scores `0`.
- The output's score is `Math.round(mean of its expected findings' scores)`. An answer with no expected finding is scored from its text only when the Judge has a model: the model answers `agrees`, `partly` or `disagrees`, and code gives `1000`, `500` or `0`; with no model the output is `unscored` and counts in no mean. An `incomplete` output scores `0`.
- A candidate's score is `Math.round(mean of its scored outputs)`; `summary` lists `base` first, then the candidates in order. The sheet (`ScoreSheet`) keeps every match, both distances and every produced finding left over.
`verifyScores` recomputes the sheet from the improve case's own blobs and the recorded matches and compares it with the one recorded.

**The Adopt gate reuses the builder's accept.** The Adopt stage's runner passes with what is offered: the chosen candidate's change. `nextStep` then returns the gate `adopt` while that change has an undecided file; with no chosen candidate there is no gate and the run finishes `completed`. `adoptDecide(ctx, change, file, accept)` (`src/server/improve.ts`) refuses unless the run waits at `adopt` and `change` is the chosen candidate's, then calls `builderDecide` with the improve case's session: the stale check, the bundle's text, `saveManifests` as the person with `why: "builder"`, `builder.decided`, the reload. When no file is left undecided it writes `gate.passed { gate: "adopt" }` in that person's name. `adoptFinish` rejects the files still undecided and passes the gate in one commit. The scores shown beside the diffs are the whole candidate's.

**Budgets.** `improve.own_tokens` is the improve case's own run budget: Select writes `budget.set` when the run has none, and the existing budget stop of `runAgent` holds Propose, Compose, the Judge's matcher and Reflect to it. Probe divides the rest: with `C` staged candidates and `N` tasks there are `(C + 1) × N` children; each gets `Math.floor(probe_lookups / children)` lookups and `Math.floor(probe_tokens / children)` tokens, recorded in `probe.started`. Either below `1` stalls Probe with the sentence. The child's tokens are a `budget.set` of its first commit. Its lookups are `probe.child.max_lookups`: `runQuery` refuses, writing nothing, once the child's ledger holds that many `query.issued`. `probe.finished` records what the child used.

**Replay of the improve case using the children's recorded heads.** `probe.finished.head` is the child's head when Probe read its output; `output` is `probeOutputOf(child state at that head)` as a blob of the improve case and `output_hash` its hash. The improve case's fold, its lenses at any seq and `verifyScores` read only the improve case. `verifyProbes(caseDir, casesDir)` then checks each link against the child when it is there: the child's ledger holds an entry of that seq and hash; its `subloop.child` and `probe.child` name this case, probe, candidate and task; its first entry is the origin `probe.started` recorded; the run it ran bound `loop_hash`; and `probeOutputOf(fold(child entries, head.seq))` hashes to `output_hash`. A child that is not loaded is `not_loaded` and fails nothing.

**The one code-passed gate.** `probeAcceptPlan(session)` refuses unless `session.state.improve.probe_of?.plan_gate === "accept"`, the run waits at `plan` and a plan is proposed. It accepts every free step, with no budget, makes the lanes `acceptPlan` makes, and passes the gate, all by `improve-probe`. A plan with no free step is left waiting; Probe records the child `incomplete`. `spendPlanBudget` already ignores an acceptance that is not a person's. The driver calls it at most `PROBE_PLAN_ACCEPTS` times for one child.

## What can run in parallel

Tasks in one wave touch disjoint files. A wave starts when the one before it is committed.

| Wave | Tasks |
|---|---|
| 1 | **Task 0** (the loop file reads through `packfile.ts`) ∥ **Task 1** (vocabulary and the fold) ∥ **Task 2** (configuration, version, a scripted turn's `when`) |
| 2 | **Task 3** (known answers) ∥ **Task 4** (scores in code) ∥ **Task 5** (roles, the adopt gate, the improve loop's shape, a lock over a staging store) |
| 3 | **Task 6** (staging and the candidate rules) ∥ **Task 7** (the probe child: creation, lookups, no publishing, its plan gate) ∥ **Task 8** (the engine: runners, the adopt gate, the host) |
| 4 | **Task 9** (Select) ∥ **Task 10** (Propose) ∥ **Task 11** (Probe) ∥ **Task 12** (Compose) ∥ **Task 13** (Judge) ∥ **Task 14** (Reflect and Adopt's runner) |
| 5 | **Task 15** (the host over a workbench) ∥ **Task 16** (verify) |
| 6 | **Task 17** (server) ∥ **Task 18** (command line) |
| 7 | **Task 19** (the known-answer form and "Improve this loop") |
| 8 | **Task 20** (the Improve lens and the Adopt gate) |
| 9 | **Task 21** (the sample) |
| 10 | **Task 22** (acceptance, the blindness test, boundaries, documents) |

Task 5 owns `src/pipeline/manifests.ts`, `src/pipeline/loops.ts`, `src/core/blobs.ts` and the one import line of `src/modules/loop-write.ts` in wave 2; Task 6 owns `loop-write.ts` in wave 3. Task 8 creates `src/pipeline/improve/host.ts`, `runners.ts` and one stub file per stage; each wave 4 task owns its own stage file and no other task's. Task 10 also owns `src/agents/tools/builder.ts`, `src/agents/tools/index.ts` and `src/pipeline/stages/agent.ts`; Task 9 also owns `src/pipeline/memory.ts`. Task 15 owns `src/server/hub.ts` and `src/cli/compose.ts`; Task 17 owns the rest of `src/server/**`, `src/core/wire.ts` and `tests/helpers/served.ts`; Task 18 owns `src/cli/run.ts`, `src/cli/improve.ts` and `package.json`'s scripts (Task 2 changed its version in wave 1). Tasks 19 and 20 both change `src/web/app.ts`, `api.ts` and `style.css`, so they are two waves.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/packfile.ts`, `src/core/loopfile.ts` | One reader and one packer for case, memory and loop files | 0 |
| `src/core/types.ts` | The eleven payloads, `ExpectedFinding`, `GATES`, `ENTRY_TYPES`, `BLOB_FIELDS` | 1 |
| `src/core/state/improve.ts` (new) | `applyImprove`, `initialImprove`, `probeVeto`, the blob shapes and their readers | 1 |
| `src/core/state/types.ts`, `apply.ts`, `index.ts`, `run.ts`, `src/web/describe.ts` | `ImproveState`, `KnownAnswerState`, the reducer order, the veto, the third gate, the entries in words | 1 |
| `src/modules/config.ts`, `src/core/casefile.ts`, `package.json`, `src/agents/providers/scripted.ts` | The `improve` block; the version; a scripted turn's `when` | 2 |
| `src/pipeline/improve/answers.ts` (new) | `setKnownAnswer`, `withdrawKnownAnswer`, `knownAnswerOf` | 3 |
| `src/core/score.ts` (new) | `claimSimilarity`, `matchClaims`, `scoreOutput`, `scoreSheet`, `rescore` (in core, so `verify.ts` can recompute) | 4 |
| `src/pipeline/manifests.ts`, `src/pipeline/loops.ts`, `src/core/blobs.ts` | The seven roles, the gate, `probe:` on a stage, `improveProblem`, `OverlayBlobs`, `fromLock(lock, over)` | 5 |
| `src/modules/loop-write.ts`, `src/modules/loop-stage.ts` (new) | `planChange` with a kept overlay; `candidateProblems`, `stageCandidate`; `procedure` joins `WRITABLE_KINDS` | 6 |
| `src/core/workbench.ts`, `src/modules/runner.ts`, `src/pipeline/publish.ts`, `src/pipeline/plans.ts` | A probe child's and an improve case's first commit; the lookup cap; no publishing; `probeAcceptPlan` | 7 |
| `src/pipeline/engine.ts`, `src/pipeline/next.ts`, `src/pipeline/contract.ts`, `src/pipeline/improve/host.ts` (new), `runners.ts` (new) | The seven runners, the adopt gate, `bind` over the staging store, `endProbe`, `resumeProbe`, `ImproveHost` | 8 |
| `src/pipeline/improve/select.ts`, `src/pipeline/memory.ts` | Tasks, the base version, `taskRecord`, the lessons of the type | 9 |
| `src/pipeline/improve/propose.ts`, `src/agents/tools/builder.ts`, `src/agents/tools/index.ts`, `src/pipeline/stages/agent.ts` | The proposer's pack and tools; staging what it proposed | 10 |
| `src/pipeline/improve/probe.ts` | `probeBudgets`, `probeLink`, `driveProbe`, the runner | 11 |
| `src/pipeline/improve/compose.ts` | `contrastsOf`, the choice | 12 |
| `src/pipeline/improve/judge.ts` | The answers blob, the matcher, the sheet | 13 |
| `src/pipeline/improve/reflect.ts`, `adopt.ts` | Lesson proposals; what Adopt offers | 14 |
| `src/pipeline/improve/workbench-host.ts` (new), `src/server/hub.ts`, `src/cli/compose.ts` | `improveHost`; the hub's wiring; the sweep of staging folders | 15 |
| `src/core/verify.ts`, `src/cli/verify.ts` | `verifyProbes`, `verifyScores` | 16 |
| `src/server/improve.ts` (new), `improve-routes.ts` (new), `app.ts`, `commands.ts`, `roles.ts`, `src/core/wire.ts` | The routes, the commands, `adoptDecide`, `ImproveView` | 17 |
| `src/cli/improve.ts` (new), `src/cli/run.ts`, `package.json` | `bun run improve` | 18 |
| `src/web/lenses/narrative.ts`, `src/web/views/loop.ts`, `src/web/api.ts`, `app.ts`, `style.css` | The known-answer form; "Improve this loop" | 19 |
| `src/web/lenses/improve.ts` (new), `lenses/index.ts`, `lenses/pipeline.ts`, `src/web/app.ts`, `api.ts`, `commands.ts`, `derive.ts`, `style.css` | The Improve lens; the Adopt gate | 20 |
| `sample/**`, `scripts/make-sample-data.ts` | The `device-check` case type and loop, three tasks, the improve loop, the scripts | 21 |
| `tests/sample/improve-acceptance.test.ts` (new), `tests/**/boundaries.test.ts`, `README.md`, `docs/gui-guide.md`, `docs/security-notes.md` | End to end; blindness; boundaries; documents | 22 |

## Review Focus

Inputs the design implies and a person will meet, most likely first. Each has its test in the task named.

1. **A case from before the upgrade, paused or waiting at a gate.** It resumes and passes its gate as before; its fold has empty `answers` and `improve`, nothing is skipped, its hashes are the same. *Task 1 Step 9; Task 22.*
2. **A candidate that edits a check, a marking, a source's location or a credential, or adds a file.** Refused by `candidateProblems` with the reason, before anything is proposed. *Task 6 Step 1.*
3. **A person opens a probe child at its publish gate and presses Approve.** Refused: a probe child never publishes. *Task 7 Step 5.*
4. **The server stops in the middle of Probe.** After a restart Probe makes no second child for a probe it started, drives the one it finds, resumes an interrupted one once, and records each once. *Task 11 Step 5; Task 15 Step 3.*
5. **A probe child that asks the person a blocking question, meets a model that declines, or runs out of its budget.** It is recorded `incomplete` with the reason and scores 0; Probe does not wait on a person. *Task 11 Step 3.*
6. **The root changes between Select and Propose, or between Propose and Adopt.** Propose stalls with the sentence; an accept of a file that changed on disk is refused as stale. *Task 10 Step 5; Task 17 Step 5.*
7. **A known answer stricter than the improve case, or revised after Select.** Left out with the reason; the Judge reads the answer Select named, by seq and hash. *Task 9 Step 1; Task 13 Step 3.*
8. **A model writes a known answer into a lesson.** It cannot: Reflect's pack holds none. *Task 14 Step 1; Task 22.*
9. **Compose's model names a candidate that was dropped, or none.** A dropped or unknown one is re-asked once and then stalls; none finishes the run with nothing to adopt. *Task 12 Step 3.*
10. **A loop that runs a sub-loop, or the improve loop itself, as the target.** Refused when the improve case is made. *Task 17 Step 1.*
11. **Fewer tasks than asked, or none.** Select takes what there is; with none it fails with the sentence and the run pauses. *Task 9 Step 1.*
12. **A candidate's title, a reason or a diff line that looks like markup.** Drawn as text. *Task 20 Step 1.*
13. **A hand-made loop file** (a link, `../x`, a member outside `manifests/`, a wrong hash): refused with the sentences it was refused with before. *Task 0 Step 1.*

---

### Task 0: The loop file reads through `packfile.ts`

Carried from slice 13: `src/core/loopfile.ts` still calls `readTarGz` and `writeTarGz` itself, with a reader of its own (`readArchive`). Case files and memory files share `readPackFile`; the loop file joins them. The file format, every exported name and every refusal sentence of `loopfile.ts` stay what they are.

**Files:**
- Modify: `src/core/packfile.ts`, `src/core/loopfile.ts`
- Test: `tests/core/loopfile.test.ts`, `tests/core/packfile.test.ts` (new), `tests/core/casefile.test.ts`, `tests/core/memfile.test.ts`, `tests/modules/loop-import.test.ts`, `tests/server/boundaries.test.ts`

**Interfaces (Produces):**
```ts
// src/core/packfile.ts
PackKind<M> gains, all optional (absent: what a case file and a memory file do today):
  /** The folder every member but the manifest is under inside the archive ("manifests/" for a loop file). */
  prefix?: string;
  /** The kind's own rule for its list of files, in place of packFilesWellFormed: the refusal, or null. */
  filesProblem?(files: readonly PackEntry[]): string | null;
  /** The kind's own sentence for a tar problem; null: the shared sentence. */
  say?(problem: TarProblem): string | null;
/** Packs members given as bytes or pieces (not a folder): the manifest first, then each listed file under the kind's prefix. writePackFile is this over a folder. */
export async function writePackMembers<M extends { files: PackEntry[] }>(kind: PackKind<M>, dest: string, manifest: M, open: (f: PackEntry) => Iterable<Uint8Array>, notManifest: string): Promise<M>;
/** A Destination that keeps each member in memory and hands it over, whole, when it has ended (the reader has by then checked its size; its hash is checked at the same end, so `each` is called only for a member that is what the manifest lists). */
export function intoMemory(each: (path: string, bytes: Uint8Array) => void): Destination;
// src/core/loopfile.ts keeps: LOOP_FILE_FORMAT, MAX_LOOP_FILE_BYTES, LoopFileError, LoopFileEntry, LoopFileManifest, loopFileName, parseLoopFileName, writeLoopFile, checkLoopFile, readLoopFile
```
`loopfile.ts` becomes a `PackKind<LoopFileManifest>` (`LOOP_KIND`: manifest `loop.json`, prefix `manifests/`, its `manifestProblem` as `isManifest` and `filesProblem`, its `loopError` sentences as `say`) and the words to say it in. `checkLoopFile` is `readPackFile(LOOP_KIND, file, { max })`; `readLoopFile` is the same with `out: intoMemory(...)`. `writeLoopFile` keeps its temporary name and its `linkSync` (it never writes over a file at `dest`) around `writePackMembers`. A member's bytes reach `each` only after their hash is checked: if `readPackFile` hands pieces on before the hash is known, `intoMemory` must not call `each` until the reader's own `end` has compared it (change the order in `readPackFile`'s `end` if that is what it takes; a case file's extraction is not weakened by it).

- [ ] **Step 1: characterization tests first** (they pass before and after; write them, run them green on the old code, and report that run).

```ts
test("a loop file written for a fixed loop has the bytes it had: its sha256 is the one this test holds", () => {
  // write the same header and files twice into two folders; record the hash from the code as it is before the change, and hold it as a literal
});
test("every refusal of tests/core/loopfile.test.ts is said in the same words", () => {
  // the existing tests, unchanged: a link, a folder, ../x, a NUL, a backslash, a member outside manifests/, not listed, listed and absent, a wrong size, a wrong hash, twice, too large, loop.json not first, not a manifest of format 1
});
```
- [ ] **Step 2: failing tests** (`tests/core/packfile.test.ts`, `tests/server/boundaries.test.ts`).

```ts
test("writePackMembers writes the manifest first and each member under the kind's prefix", () => {});
test("readPackFile refuses a member outside the kind's prefix in the kind's words", () => { /* "x is outside manifests/" */ });
test("intoMemory hands a member over only after its size and hash are checked: a member with a wrong hash is never handed over", () => {});
test("src/core/loopfile.ts imports no reader or writer of tar: it reads and writes through packfile.ts", () => {
  // its imports from ./tar are types and `shown` only; readTarGz and writeTarGz are named in packfile.ts and tar.ts alone
});
```
- [ ] **Step 3: FAIL. Step 4: implement. Step 5: PASS**, with `tests/core/casefile.test.ts`, `tests/core/memfile.test.ts`, `tests/modules/loop-import.test.ts`, `tests/server/loops.test.ts` and `tests/sample/loops-acceptance.test.ts` unchanged and green. **Step 6:** `timeout 900 bun test && timeout 300 bun run typecheck`. **Step 7: commit** `refactor(core): the loop file is read and written by the one hardened packer`.

---

### Task 1: The vocabulary and the fold

**Files:**
- Create: `src/core/state/improve.ts`
- Modify: `src/core/types.ts`, `src/core/state/types.ts`, `src/core/state/apply.ts`, `src/core/state/index.ts`, `src/core/state/run.ts`, `src/web/describe.ts`
- Test: `tests/core/state-improve.test.ts` (new), `tests/core/whole-run.test.ts`, `tests/core/state-skipped.test.ts`, `tests/web/describe.test.ts`; and any test a new state field or the wider gate type breaks

**Interfaces (Produces):**
```ts
// src/core/types.ts
export interface ExpectedFinding { claim: string; likelihood: string; confidence: Finding["confidence"] }
StageDef["gate"]: "plan" | "publish" | "adopt" | null;      // GATES gains adopt
Payloads["answer.known"]: { product: number; draft_hash: string; text: string; findings: ExpectedFinding[]; marking: Marking };
Payloads["answer.withdrawn"]: { product: number; reason: string };
Payloads["improve.requested"]: { target: string; case_type: string; tasks: number; candidates: number };
Payloads["improve.selected"]: { target: string; version: number; loop_hash: string; lock: BlobRef; case_type: string; scale: string[]; left_out: { case: string; why: "marking" | "cap" }[] };
Payloads["improve.task"]: { task: string; case: string; origin: string; head: { seq: number; hash: string }; product: { n: number; draft_hash: string }; answer: { seq: number; hash: string }; marking: Marking; inputs: BlobRef; record: BlobRef };
Payloads["improve.candidate"]: { candidate: string; change: string; status: "staged" | "dropped"; loop_hash: string | null; lock: BlobRef | null; reason: string };
Payloads["probe.child"]: { improve: string; origin: string; probe: string; candidate: string; task: string; plan_gate: "accept"; max_lookups: number };
Payloads["probe.started"]: { probe: string; candidate: string; task: string; child: string; origin: string; loop_hash: string; input_hash: string; budgets: { lookups: number; tokens: number } };
Payloads["probe.finished"]: { probe: string; child: string; child_run: string | null; head: { seq: number; hash: string }; outcome: "drafted" | "incomplete"; reason: string; draft_hash: string | null; output_hash: string; output: BlobRef; lookups: number; tokens: number };
Payloads["compose.chosen"]: { candidate: string | null; why: string; contrasts: BlobRef };
Payloads["judge.scored"]: { answers: BlobRef; scores: BlobRef; matcher: "code" | "code+model"; summary: { candidate: string; score: number; drafted: number; tasks: number }[] };
// ENTRY_TYPES gains the eleven; BLOB_FIELDS and BLOB_NULLABLE as "The ledgers" lists
// src/core/state/types.ts
RunState.waiting: "plan" | "publish" | "adopt" | null;
export interface KnownAnswerState { product: number; draft_hash: string; text: string; findings: ExpectedFinding[]; marking: Marking; by: string; seq: number; hash: string; ts: string }
export interface TaskState { task: string; case: string; origin: string; head: { seq: number; hash: string }; product: { n: number; draft_hash: string }; answer: { seq: number; hash: string }; marking: Marking; inputs: BlobRef; record: BlobRef }
export interface CandidateState { candidate: string; change: string; status: "staged" | "dropped"; loop_hash: string | null; lock: BlobRef | null; reason: string; seq: number }
export interface ProbeState {
  probe: string; candidate: string; task: string; child: string; origin: string; loop_hash: string; input_hash: string; budgets: { lookups: number; tokens: number }; started_seq: number;
  finished: null | { child_run: string | null; head: { seq: number; hash: string }; outcome: "drafted" | "incomplete"; reason: string; draft_hash: string | null; output_hash: string; output: BlobRef; lookups: number; tokens: number; seq: number };
}
export interface ImproveState {
  /** What the person asked for when the improve case was made; null in every other case. */
  request: { target: string; case_type: string; tasks: number; candidates: number; by: string } | null;
  /** Of the run in progress or the last one: cleared by the next improve.selected. */
  selected: { target: string; version: number; loop_hash: string; lock: BlobRef; case_type: string; scale: string[]; left_out: { case: string; why: "marking" | "cap" }[]; run: string; seq: number } | null;
  tasks: Record<string, TaskState>; task_order: string[];
  candidates: Record<string, CandidateState>; candidate_order: string[];
  probes: Record<string, ProbeState>; probe_order: string[];
  chosen: { candidate: string | null; why: string; contrasts: BlobRef; by: string; seq: number } | null;
  scored: { answers: BlobRef; scores: BlobRef; matcher: "code" | "code+model"; summary: { candidate: string; score: number; drafted: number; tasks: number }[]; seq: number } | null;
  /** Set on a probe child. */
  probe_of: { improve: string; origin: string; probe: string; candidate: string; task: string; plan_gate: "accept"; max_lookups: number } | null;
}
CaseState.answers: Record<string, KnownAnswerState>;  CaseState.improve: ImproveState;
// src/core/state/improve.ts (browser-safe)
export const PROBE_ACTOR_ID = "improve-probe"; export const BASE = "base"; export const PROBE_OUTPUT_FORMAT = 1;
export const ANSWER_TEXT_MAX = 600; export const ANSWER_FINDINGS_MAX = 12; export const CLAIM_MAX = 300; export const TASKS_MAX = 8; export const CANDIDATES_MAX = 4;
export const probeId = (candidate: string, task: string): string => `${candidate}/${task}`;
export function initialImprove(): ImproveState;
export function applyImprove(s: CaseState, entry: Entry): CaseState;
/** Why the fold skips this entry before any reducer sees it; null for every entry an old ledger can hold. */
export function probeVeto(s: Readonly<CaseState>, entry: Entry): string | null;
/** The staged candidates, in order. */
export function stagedCandidates(state: Readonly<CaseState>): CandidateState[];
/** The probes a run needs: base and each staged candidate, for each task, base first, then candidate order, tasks in order. */
export function plannedProbes(state: Readonly<CaseState>): { probe: string; candidate: string; task: string }[];
/** The change Adopt offers (the chosen candidate's) and whether a file of it is undecided; null when nothing was chosen. */
export function adoptOffer(state: Readonly<CaseState>): { candidate: string; change: string; undecided: number } | null;
// the blobs of an improve case, with a reader each (null for bytes that are not one)
export interface TaskInputs { question: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking; title: string }
export interface TaskRecord { product: Product; stages: { id: string; title: string; status: string; attempts: number; last_reason: string | null }[]; queries: { source: string; pivot: string | null; outcome: string; rows: number | null }[]; questions: number; sendbacks: number; usage: { input: number; output: number; calls: number } }
export interface ProbeOutput { format: 1; outcome: "drafted" | "incomplete"; reason: string; draft_hash: string | null; product: Product | null; stats: { lookups: number; tokens: number; model_calls: number; stages: { id: string; status: string; attempts: number }[] } }
export interface Contrast { task: string; candidate: string; base: "drafted" | "incomplete"; now: "drafted" | "incomplete"; added: string[]; removed: string[]; changed: { statement: string; likelihood: [string, string] | null; confidence: [string, string] | null }[]; lookups: [number, number]; tokens: [number, number] }
export interface AnswerCopy { task: string; seq: number; hash: string; text: string; findings: ExpectedFinding[]; marking: Marking }
export interface FindingScore { expected: number; produced: string | null; by: "code" | "model" | null; similarity: number | null; likelihood_distance: number | null; confidence_distance: number | null; score: number }
export interface OutputScore { probe: string; candidate: string; task: string; outcome: "drafted" | "incomplete"; score: number | null; text: "agrees" | "partly" | "disagrees" | null; findings: FindingScore[]; left_over: string[] }
export interface ScoreSheet { format: 1; scale: string[]; outputs: OutputScore[]; summary: { candidate: string; score: number; drafted: number; tasks: number }[] }
export function readTaskInputs(b: Uint8Array): TaskInputs | null; // and readTaskRecord, readProbeOutput, readContrasts, readAnswers, readScoreSheet
/** What a probe child gives, from its state alone: drafted when it has a draft and its run waits at its publish gate or finished completed; else incomplete, with why. */
export function probeOutputOf(child: Readonly<CaseState>): ProbeOutput;
```
`probeOutputOf`: `drafted` gives the latest draft's hash and product and the reason `""`; `incomplete` gives `product: null`, `draft_hash: null` and the reason: the run's `pause_reason` when paused, else "its run has not started", "it waits for a person at its plan gate", "its run was interrupted", "its run was stopped" or "it finished with no draft". `stats.lookups` is the number of the child's queries, `stats.tokens` its usage's input plus output, `stats.stages` each stage's id, status and attempts. It reads nothing but the state, so `verifyProbes` can recompute it from a fold.

The fold's rules, each a `recordSkip` with its sentence:
- `answer.known`: by a person ("a known answer is a person's"); `product` is a product the case published, with that `draft_hash` ("a known answer names a product this case published"); `marking` at least the case's and that product's ("a known answer is marked at least as strictly as its case and its product"); not in a probe child or an improve case ("a known answer belongs to a case that was investigated"). `answer.withdrawn`: by a person; names an answer that is there ("there is no known answer for that product").
- `improve.requested`: by a person, at seq 3 or less, before any run, once ("an improve case is asked for by the person when it is made").
- `improve.selected`, `improve.task`, `improve.candidate`, `probe.started`, `probe.finished`, `judge.scored`: by a system actor ("recorded by the workbench"), in a run in progress of a case with a `request`. `improve.selected`: once per run. `improve.task`: after this run's `improve.selected`, its `task` the next `T<n>`. `improve.candidate`: its `candidate` the next `K<n>`; `change` a change of `state.builder.changes`; `staged` exactly when `loop_hash` and `lock` are set. `probe.started`: `probe` is `probeId(candidate, task)` of a planned probe, once. `probe.finished`: of a started, unfinished probe, the same child.
- `compose.chosen`: by an agent or a system actor, never a person ("Compose chooses; the person decides at Adopt"); once per run; every planned probe has finished ("Compose chooses once every probe has ended"); `candidate` null or a staged candidate.
- `judge.scored`: once per run, after `compose.chosen` ("the judge runs after Compose has chosen").
- `probe.child`: by a system actor, in a case with `loop.parent` set, before any run, once ("a probe child is marked by the workbench when it is made").
- `run.started` clears nothing here: the next `improve.selected` does.

`probeVeto` (called by `applyWith` before the reducers; a veto is `skip(state, entry, reason)`):
- an entry by `{ kind: "system", id: "improve-probe" }` when `improve.probe_of` is null: "improve-probe acts only in a probe child";
- such an entry that is not `plan.accepted`, `lane.created`, `gate.passed` with gate `plan`, `run.resumed` while the run is `interrupted`, or `run.finished` with outcome `stopped`: "improve-probe accepts a probe's plan, resumes an interrupted probe or ends it, and nothing else";
- `gate.passed { gate: "adopt" }` not by a person: "only a person passes the adopt gate";
- `product.published`, or `gate.passed { gate: "publish" }`, when `improve.probe_of` is set: "a probe child never publishes".

- [ ] **Step 1: failing tests for known answers and the request** (`tests/core/state-improve.test.ts`, with `EntryBuilder` from `tests/helpers/entries.ts`).

```ts
test("a ledger with none of the new entries has no answers and an empty improve", () => {
  expect(s.answers).toEqual({}); expect(s.improve).toEqual(initialImprove());
});
test("answer.known by a person on a published product is that product's known answer, with its seq, hash and time", () => {});
test("a second answer.known for the product replaces the first; answer.withdrawn removes it", () => {});
test("answer.known by an agent or by code, for a product not published, for another draft hash, or marked below the product, is skipped with its sentence", () => {});
test("a malformed answer.known is recorded as malformed", () => {
  // text "" · text of 601 characters · 13 findings · a claim of 301 characters · confidence "certain" · product 0 · marking "TLP:PINK"
});
test("improve.requested by the person in the first commit is the request; later, by code, or a second one is skipped", () => {});
```
- [ ] **Step 2: FAIL** (`improve.ts` does not exist; the types do not compile). **Step 3: implement.** `initial()` adds `answers: {}` and `improve: initialImprove()`. `REDUCERS` gains `applyImprove` last. **Step 4: PASS.**

- [ ] **Step 5: failing tests for the run of an improve case.**

```ts
test("improve.selected and its tasks, then candidates, then probes, fold in order with the ids T1, K1 and base/T1", () => {});
test("plannedProbes is base and each staged candidate for each task; a dropped candidate has none", () => {
  expect(plannedProbes(s).map((p) => p.probe)).toEqual(["base/T1", "base/T2", "K1/T1", "K1/T2"]);
});
test("compose.chosen before every planned probe has finished is skipped; after, it is the choice", () => {});
test("compose.chosen by a person, naming a dropped candidate, or a second one, is skipped", () => {});
test("judge.scored before compose.chosen is skipped: the judge runs after Compose has chosen", () => {});
test("a second run's improve.selected clears the first run's tasks, candidates, probes, choice and scores, and keeps the request", () => {});
test("adoptOffer is the chosen candidate's change with its undecided files, and null when nothing was chosen", () => {});
test("gate.waiting and gate.passed with gate adopt make the Adopt stage wait and pass; gate.passed adopt by code is skipped: only a person passes the adopt gate", () => {});
test("none of the eleven entries changes the run, the cards, the plan, the loop, the memory or the meta", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement** (`run.ts`'s `gate.waiting` and `gate.passed` already read `GATES`; the wider type is the change). **Step 8: PASS.**

- [ ] **Step 9: failing tests for the probe child, the veto, and that nothing old moved.**

```ts
test("probe.child in a child's first commit marks it; in a case with no parent, after a run started, or by a person, it is skipped", () => {});
test("in a probe child, plan.accepted, lane.created and gate.passed plan by improve-probe fold as a person's do", () => {});
test("in a case that is not a probe child, an entry by improve-probe is skipped and changes nothing: improve-probe acts only in a probe child", () => {});
test("in a probe child, improve-probe may not pass the publish gate, approve, answer a question or write a card", () => {});
test("run.resumed by improve-probe is read only while the run is interrupted; run.finished by it only as stopped", () => {});
test("product.published and gate.passed publish by a person in a probe child are skipped: a probe child never publishes", () => {});
test("probeOutputOf is drafted with the latest draft's product for a child waiting at its publish gate or finished completed, and incomplete with the reason for any other", () => {});
test("probeOutputOf of the same state is the same bytes: canonical(probeOutputOf(s)) twice", () => {});
test("the whole run's ledger folds to the state it folded to, with empty answers and improve beside it", () => {
  // tests/core/whole-run.test.ts: every other field equals the literal the test already holds; skipped is []
});
test("each of the eleven entry types has its words", () => {
  // "known answer set" product 1 · "known answer withdrawn" · "improve asked" investigation · "tasks selected" 3 · "task" T1 CASE-4 · "candidate staged" K1 · "candidate dropped" K2 · "probe child" K1/T2 · "probe started" base/T1 CASE-9 · "probe ended" drafted · "candidate chosen" K1 · "scored" base 333, K1 1000
});
```
- [ ] **Step 10: FAIL. Step 11: implement. Step 12: PASS.** **Step 13:** `timeout 900 bun test && timeout 300 bun run typecheck` (fix each `switch` and each literal type the third gate widens: `childWaitReason`, `RunSummary`, the web's `derive`; an `adopt` wait is said as "it waits for a person at its adopt gate"). **Step 14: commit** `feat(core): known answers, the improve case's record and the probe child's mark`.

---

### Task 2: Configuration, the version and a scripted turn's `when`

**Files:**
- Modify: `src/modules/config.ts`, `src/core/casefile.ts`, `package.json` (the version only), `src/agents/providers/scripted.ts`
- Test: `tests/modules/config.test.ts`, `tests/agents/scripted.test.ts`, and the tests that hold the version literal

**Interfaces (Produces):**
```ts
// src/modules/config.ts
Config["improve"]: { max_tasks: number; max_candidates: number; probe_lookups: number; probe_tokens: number; own_tokens: number; staged: string };
// defaults 3, 3, 240, 1200000, 400000, join(data_dir, "staged"); max_tasks 1..8, max_candidates 1..4, the three budgets integers of 1 or more; `staged` is placed as `memory.store` is
// src/core/casefile.ts
export const WORKBENCH_VERSION = "0.14.0";
// src/agents/providers/scripted.ts
export interface ScriptTurn { actor: string; reply: ScriptReply; /** Every string must be in the text of the request's messages for this turn to be one of the actor's turns for this request. */ when?: string[] }
```
A scripted provider answers `script.turns.filter((t) => t.actor === req.key && whenHolds(t, req))[req.ordinal]`. `whenHolds` is true with no `when`; else every string of `when` is contained in the concatenation of `req.messages`' contents. So one script can hold a variant per starting value and per skill text, which is how the sample's model "follows" a changed skill. A `when` that is not a list of non-empty strings is a `ManifestError` naming the turn.

- [ ] **Step 1: failing tests.**

```ts
test("the improve block defaults to 3 tasks, 3 candidates, 240 lookups, 1200000 and 400000 tokens, and <data_dir>/staged", () => {});
test("max_tasks above 8, max_candidates above 4, or a budget below 1 is a ConfigError naming the field", () => {});
test("a turn with when is one of the actor's turns only for a request whose messages hold every string of it", () => {
  // two variants for actor researcher, when ["192.0.2.21"] and when ["192.0.2.22"]: a request holding the second gets the second variant's first turn at ordinal 0
});
test("a turn with no when is a turn for every request, as before", () => {});
test("when must be a list of non-empty strings", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(modules): the improve block, version 0.14.0, and a scripted turn that answers by what it was shown`.

---

### Task 3: Known answers

**Files:**
- Create: `src/pipeline/improve/answers.ts`
- Test: `tests/pipeline/improve-answers.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`KnownAnswerState`, the limits), `redactSecrets` (`src/core/redact.ts`), `RunnerDeps.secrets`.
- Produces:
```ts
// src/pipeline/improve/answers.ts
export class AnswerRefused extends Refused {}
export interface KnownAnswerInput { product: number; text: string; findings: ExpectedFinding[]; marking: Marking; actor: Actor }
/** Why this is not a known answer for this case; null when it is. `likelihood` is the standard's terms when the host knows them: a term not among them is refused. */
export function answerProblem(state: Readonly<CaseState>, input: Omit<KnownAnswerInput, "actor">, likelihood: readonly string[] | null): string | null;
/** Writes answer.known by the person, its text and claims with every secret value redacted. Throws AnswerRefused, writing nothing. */
export function setKnownAnswer(session: CaseSession, deps: Pick<EngineDeps, "runner">, input: KnownAnswerInput, likelihood?: readonly string[] | null): void;
export function withdrawKnownAnswer(session: CaseSession, input: { product: number; reason: string; actor: Actor }): void;
/** The products of a case that have a known answer now, by number: no text, no findings. */
export function answeredProducts(state: Readonly<CaseState>): { product: number; draft_hash: string; marking: Marking; seq: number; hash: string }[];
/** The answer the entry at `at.seq` with hash `at.hash` holds; null when the ledger holds no such answer.known. The only reader of an answer's text and findings in src/pipeline and src/agents. */
export function knownAnswerOf(entries: readonly Entry[], at: { seq: number; hash: string }): { text: string; findings: ExpectedFinding[]; marking: Marking; product: number } | null;
```
Refusals, verbatim: "only a person sets a known answer" · "there is no published product N in this case" · "a known answer's text is 1 to 600 characters" · "a known answer has at most 12 expected findings" · "an expected finding's claim is 1 to 300 characters" · "<term> is not a likelihood term of this case's standard" · "a known answer is marked at least <marking>, as its case and its product are" · "a probe child and an improve case hold no known answer" · "withdrawing a known answer needs a reason". `draft_hash` is the published product's own; the person never types it.

- [ ] **Step 1: failing tests.**

```ts
test("setKnownAnswer writes answer.known by the person with the product's draft hash, and the fold reads it back", () => {});
test("each refusal is said in its words and writes nothing", () => {});
test("a secret value in the text or a claim is written redacted", () => {});
test("withdrawKnownAnswer removes it; with no reason, or for a product with none, it is refused", () => {});
test("answeredProducts lists number, draft hash, marking, seq and hash and nothing of the text", () => {
  expect(JSON.stringify(answeredProducts(s))).not.toContain("canary");
});
test("knownAnswerOf reads the answer at the seq and hash given, not a later one for the same product", () => {});
test("knownAnswerOf is null for a seq whose entry is not an answer.known, or whose hash differs", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): a person attaches a known answer to a published product`.

---

### Task 4: Scores in code

**Files:**
- Create: `src/core/score.ts` (in core: `src/core/verify.ts` recomputes with it, and core imports nothing from `src/pipeline`)
- Test: `tests/core/score.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`ProbeOutput`, `AnswerCopy`, `FindingScore`, `OutputScore`, `ScoreSheet`).
- Produces:
```ts
// src/core/score.ts — pure, browser-safe: no session, no deps, no model
export const CLAIM_MATCH = 500;
export function claimSimilarity(a: string, b: string): number;                                  // 0..1000
export interface ModelMatch { expected: number; produced: string | null }
export function matchClaims(expected: readonly ExpectedFinding[], produced: readonly Finding[], extra?: readonly ModelMatch[]): { expected: number; produced: string | null; by: "code" | "model" | null; similarity: number | null }[];
/** The expected findings code left unmatched, by index: what a model may be asked about. */
export function unmatched(expected: readonly ExpectedFinding[], produced: readonly Finding[]): number[];
export function scoreOutput(probe: { probe: string; candidate: string; task: string }, output: ProbeOutput, answer: AnswerCopy, scale: readonly string[], extra?: readonly ModelMatch[], text?: "agrees" | "partly" | "disagrees" | null): OutputScore;
export function scoreSheet(outputs: readonly OutputScore[], scale: readonly string[], order: readonly string[]): ScoreSheet;   // order: base, then the candidates
/** scoreSheet over scoreOutput, with the matches and text verdicts a recorded sheet holds as the model's part: what verifyScores compares. */
export function rescore(recorded: ScoreSheet, outputs: Record<string, ProbeOutput>, answers: readonly AnswerCopy[]): ScoreSheet;
```
The rules are those of "How scores are computed in code", exactly.

- [ ] **Step 1: failing tests.**

```ts
test("claimSimilarity is the share of shared words, in thousandths, whatever the case and the punctuation", () => {
  expect(claimSimilarity("The printer lp-3 held 192.0.2.21.", "192.0.2.21 was held by the printer LP-3")).toBe(/* computed by hand in the test's comment */);
});
test("claimSimilarity of an empty text is 0", () => {});
test("matchClaims pairs greatest similarity first, each finding once; a tie goes to the earlier expected, then the earlier produced", () => {});
test("a pair below 500 is no match", () => {});
test("a model's match is used only for an expected finding code left unmatched and a produced finding still free", () => {});
test("a matched finding with the same likelihood and confidence scores 1000", () => {});
test("a matched finding at the other end of a seven-term scale and of confidence scores 500", () => {});
test("one step of seven on likelihood and one of confidence scores 500 + round(250 * 5/6) + 125", () => {});
test("a likelihood term that is not on the scale is at distance 1", () => {});
test("an unmatched expected finding scores 0, and a produced finding matched by none is listed as left over", () => {});
test("the output's score is the rounded mean of its expected findings' scores", () => {});
test("an incomplete output scores 0", () => {});
test("an answer with no expected finding is unscored without a text verdict, and 1000, 500 or 0 with one", () => {});
test("a candidate's score is the rounded mean of its scored outputs; an unscored output counts in none", () => {});
test("the summary lists base first and then the candidates in order, with drafted and tasks counts", () => {});
test("rescore of a sheet over the same outputs and answers is that sheet", () => {});
test("every number in a sheet is an integer", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): a probe's output is scored against a known answer in code`.

---

### Task 5: Roles, the adopt gate, the improve loop's shape, and a lock over a staging store

**Files:**
- Modify: `src/pipeline/manifests.ts`, `src/pipeline/loops.ts`, `src/core/blobs.ts`, `src/modules/loop-write.ts` (its `Overlay` class becomes an import; nothing else)
- Test: `tests/pipeline/manifests.test.ts`, `tests/pipeline/loops.test.ts`, `tests/core/blobs.test.ts`, `tests/modules/loop-write.test.ts`

**Interfaces (Produces):**
```ts
// src/core/blobs.ts
/** A content store that reads `base` and keeps what is put in it apart, in its own folder (loop-write.ts's Overlay, moved). */
export class OverlayBlobs extends BlobStore { constructor(dir: string, base: BlobStore); }
/** Reads `over` first and then `base`; puts go to `over`. No folder of its own. */
export function readingOver(over: BlobStore, base: BlobStore): BlobStore;
// src/pipeline/manifests.ts
export const IMPROVE_ROLES = ["select", "propose", "probe", "compose", "judge", "reflect", "adopt"] as const;
ROLES gains the seven.
StageManifest gains: /** Set exactly on a stage of role probe. */ probe?: { plan_gate: "accept" } | null;
/** The builder tools a stage of role propose may list. */
export const PROPOSE_TOOL_NAMES = ["loop_catalogue", "adapter_catalogue", "validate_manifest", "propose_change"] as const;
/** Why these stages are not an improve loop's; null when they are, or when none of them has an improve role. */
export function improveProblem(stages: readonly StageManifest[]): string | null;
// src/pipeline/loops.ts
LoopCatalog.fromLock(lock: LoopLock, over?: BlobStore): ResolvedLoop | string;   // with `over`: every hash is read from it first, then from the content store
/** True for a loop one of whose stages has an improve role. */
export const isImproveLoop = (loop: Pick<ResolvedLoop, "pipeline">): boolean;
```
`stageFrom`: the stage schema takes `gate: adopt` and `probe: { plan_gate }`. A stage of role `probe` without `probe.plan_gate` is refused: "a probe stage says how its children's plan gate is passed: probe: { plan_gate: accept }"; any value but `accept`: "a probe's plan gate is accept in this version"; `probe` on any other role: "only a probe stage has probe". A stage of role `select`, `probe` or `adopt` has `runs: script` or `human` and no model; `propose`, `compose` and `reflect` run an agent; `judge` runs a script or an agent. A stage of role `propose` may list `PROPOSE_TOOL_NAMES` and no other tool (the refusal of a builder tool in any other stage stays). `gate: adopt` on a stage whose role is not `adopt` is refused, and an `adopt` stage has `gate: adopt`.
`improveProblem`: all seven roles, once each ("an improve loop has one stage of each of select, propose, probe, compose, judge, reflect and adopt; it has no <role>" / "two"); their `on_pass` chain is that order and Adopt's is null ("an improve loop runs select, propose, probe, compose, judge, reflect, adopt in that order"); no `on_fail`, no `reviews`, no plan or publish gate, no stage of another role. `resolveLoop` reports it as the loop's problem. `pipelineProblem` counts at most one stage per gate for three gates.

- [ ] **Step 1: failing tests.**

```ts
test("the seven improve roles are roles, and a stage of each parses", () => {});
test("a probe stage without probe.plan_gate, with another value, and probe on another role are refused with their sentences", () => {});
test("gate adopt parses on an adopt stage and is refused on any other; an adopt stage without it is refused", () => {});
test("a propose stage may list the four builder tools; any other stage listing one is refused as before", () => {});
test("improveProblem is null for the seven in order and for a loop with no improve role", () => {});
test("improveProblem names a missing role, a role twice, a wrong order, an on_fail, a publish gate and a stage of another role", () => {});
test("a loop whose stages break improveProblem is listed, not usable, with that problem", () => {});
test("OverlayBlobs and readingOver read their own store first and then the base, and put nothing in the base", () => {});
test("fromLock(lock, over) rebuilds a loop one of whose items is only in `over`; fromLock(lock) says the content store does not hold it", () => {});
test("fromLock with `over` puts nothing in the content store and appends nothing to the chain", () => {});
test("checkChange and saveManifests behave as they did (tests/modules/loop-write.test.ts unchanged)", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): the improve loop's seven roles, its adopt gate, and a lock rebuilt over a staging store`.

---

### Task 6: Staging and the candidate rules

**Files:**
- Create: `src/modules/loop-stage.ts`
- Modify: `src/modules/loop-write.ts`
- Test: `tests/modules/loop-stage.test.ts` (new), `tests/modules/loop-write.test.ts`

**Interfaces:**
- Consumes: Task 5 (`OverlayBlobs`, `fromLock(lock, over)`).
- Produces:
```ts
// src/modules/loop-write.ts
WRITABLE_KINDS gains "procedure".
/** plan(), exported. `opts.into`: the overlay's own store (kept; a check's temporary one when absent). `opts.loop`: the id of a loop whose lock, in the copy, is returned. */
export function planChange(deps: SaveDeps, root: string, files: ManifestFile[], opts?: { into?: BlobStore; loop?: string }): { check: ChangeCheck; lock: LoopLock | null };
// src/modules/loop-stage.ts
/** The kinds a candidate may change. */
export const CANDIDATE_KINDS: readonly string[] = ["skill", "procedure", "playbook", "source", "stage", "loop"];
/** Why these files are not an improve candidate for `target`; [] when they are. Reads the root and the target's lock; writes nothing. */
export function candidateProblems(deps: SaveDeps & { loops: LoopCatalog; registry: Registry }, root: string, files: ManifestFile[], target: string): string[];
/** checkChange, then candidateProblems. What the proposer's check and propose_change run. */
export function checkCandidate(deps: SaveDeps & { loops: LoopCatalog; registry: Registry }, root: string, files: ManifestFile[], target: string): ChangeCheck;
/** The target loop as these files would leave it, rebuilt from its lock over `into`; the bytes the content store lacks are in `into` and nowhere else. */
export function stageCandidate(deps: SaveDeps & { loops: LoopCatalog; registry: Registry }, root: string, files: ManifestFile[], target: string, into: BlobStore): { ok: true; loop: ResolvedLoop } | { ok: false; problems: string[] };
```
The candidate rules (each a sentence naming the path):
- the file exists in the root and is a manifest of the same kind and id ("a candidate changes what the loop has; it adds no file");
- its kind is one of `CANDIDATE_KINDS` ("an improve candidate may not change a <kind>"): so never a check, a check's script, rules, a profile, a persona, a schema, a standard, a framework, a model, a case-types or a lesson-seeds manifest;
- it is the target's: a skill, procedure or stage file is an item of the target's lock at that path; a playbook or a source is one the target's `uses` lists, or any loaded one when `uses` lists none; a loop file is the target's own ("<path> is not part of loop <target>");
- `skill`, `procedure`: only the text may differ;
- `playbook`: only `steps` and `end` may differ;
- `source`: only a column's or an endpoint field's `meaning`, `reveals` and `extract` may differ ("a candidate changes a source's field notes only: never its location, connector, credential, marking, tables or cost");
- `stage`, and an inline stage of the loop file: only `tools`, `max_turns`, `model.effort` and `fast_model.effort` may differ ("a candidate changes a stage's tools, turns or effort only");
- `loop`: `version` is the current version plus one ("a changed loop file is version <n>"); everything but its inline stages is unchanged;
- a difference is found on the parsed bodies with the allowed keys removed, compared as canonical JSON, so a re-ordered or re-quoted file is no difference.

- [ ] **Step 1: failing tests for the rules** (a copy of the sample root from `tests/helpers/sample-root.ts`; the target is `unknown-device`).

```ts
test("a changed skill text, a changed procedure text, a playbook's steps, a column's reveals and extract, and a stage's tools and effort are each a candidate", () => {});
test("a new file is refused: a candidate changes what the loop has; it adds no file", () => {});
test("a check, a check's script, the rules, the profile, a persona, a schema, the standard and a model are each refused by kind", () => {});
test("a source whose location, connector, credential, marking, where, cost or table names differ is refused", () => {});
test("a stage whose gate, reviews, role, runs, schema, on_pass, on_fail or model differ is refused", () => {});
test("a loop file whose profile, entry, stage list, components, uses, inputs, outputs or case_type differ is refused; one that keeps its version is told the version it needs", () => {});
test("a skill of another loop, or of none, is refused as not part of the target", () => {});
test("a file that holds a secret value, or a credential-named key, is refused by the save's own check before the rules are read", () => {});
test("the same text re-ordered or re-quoted is no change", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for staging.**

```ts
test("stageCandidate gives the target loop with the changed skill: its hash differs from the current version's, and its skill's text is the candidate's", () => {});
test("the staged loop names no temporary folder: every manifest's root and dir are as fromLock makes them", () => {});
test("staging writes nothing live: the chain's entries, every file of every root and the content store's file list are what they were", () => {
  // list the content store's folder and hash every root file before and after; compare chain.read().length
});
test("the bytes the content store lacks are in `into`: fromLock(lock, into) rebuilds the loop, fromLock(lock) does not", () => {});
test("loops.current(target) and loops.atHash(target, staged hash) do not return the staged version", () => {
  expect(loops.atHash("unknown-device", staged.pipeline.hash)).toContain("is not in this workbench");
});
test("a candidate that changes nothing the lock reads resolves to the current hash", () => {});
test("a candidate that breaks the loop is { ok: false } with the loop's problem, and `into` is left as it was", () => {});
test("staging the same files twice gives the same hash", () => {});
test("a procedure is saved by saveManifests for a person, and by no one else", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement** (`plan` takes the overlay's folder from `opts.into` when given; the temporary copy of the root is always removed). **Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(modules): a candidate is checked by the candidate rules and staged beside the live registry`.

---

### Task 7: The probe child: its first commit, its lookups, no publishing, its plan gate

**Files:**
- Modify: `src/core/workbench.ts`, `src/modules/runner.ts`, `src/pipeline/publish.ts`, `src/pipeline/plans.ts`
- Test: `tests/core/workbench-improve.test.ts` (new), `tests/modules/runner.test.ts`, `tests/pipeline/publish.test.ts`, `tests/pipeline/plans.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
```ts
// src/core/workbench.ts
export interface ProbeMark { improve: string; origin: string; probe: string; candidate: string; task: string; plan_gate: "accept"; max_lookups: number; max_tokens: number }
createCase(input, actor, opts: { …; probe?: ProbeMark; improve?: { target: string; case_type: string; tasks: number; candidates: number } }): CaseSession;
// src/pipeline/plans.ts
export const PROBE_ACTOR: Actor = { kind: "system", id: "improve-probe" };
/** Accepts the proposed plan of a probe child whose policy is accept: every free step, no budget, the lanes, the gate. False, writing nothing, when the plan has no free step. Throws PlanRefused anywhere else. */
export function probeAcceptPlan(session: CaseSession): boolean;
```
`createCase` with `probe`: needs `link` (a `TypeError` otherwise); writes, after `subloop.child` and `case.type_set`, `probe.child` (the mark without `max_tokens`) and `budget.set { tokens: max_tokens }`, both by the engine. With `improve`: needs a person as `actor`, a `loop` and a `type` equal to `improve.case_type`; writes `improve.requested` by that person as the commit's third entry at the latest. Both refuse what the fold would skip, before anything is written.
`runQuery`: first of all, when `session.state.improve.probe_of` is set and the case holds `max_lookups` or more `query.issued`, `{ status: "refused", reasons: ["this probe's lookup budget of <n> is used up"] }`, writing nothing.
`approve`: in a case whose `improve.probe_of` is set, `PublishRefused(["a probe child never publishes: its draft is what the improve case reads"])`, before anything is read.
`probeAcceptPlan` refuses with `PlanRefused("only a probe child whose improve loop says so has its plan accepted by code")` unless `improve.probe_of?.plan_gate === "accept"`; then as `proposedPlan` refuses. `acceptPlan`, `denyPlan` and `requestReplan` are not changed: they still refuse anyone but a person.

- [ ] **Step 1: failing tests.**

```ts
test("a probe child's first commit is case.created, case.loop_set, subloop.child, case.type_set, probe.child and budget.set, and folds with nothing skipped", () => {});
test("createCase with probe and no link, or with improve by code or without the type, is a TypeError and writes nothing", () => {});
test("an improve case's first commit holds improve.requested by the person, and its fold has the request", () => {});
test("findChild finds a probe child by its link; two probes of one stage attempt differ by their input hash", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the three locks.**

```ts
test("in a probe child with max_lookups 2, the third runQuery is refused with the sentence and writes nothing", () => {});
test("in a case that is no probe child, runQuery counts nothing", () => {});
test("approve in a probe child is refused: a probe child never publishes", () => {});
test("probeAcceptPlan accepts every free step with no budget, makes the lanes, and passes the plan gate as improve-probe; the run goes on", () => {
  // the entries are plan.accepted { budgets: {} }, lane.created…, gate.passed { gate: "plan" }, each by { kind: "system", id: "improve-probe" }
});
test("a costly step is left out of the acceptance, and spendPlanBudget gives it nothing", () => {});
test("a plan with no free step is not accepted: probeAcceptPlan is false and nothing is written", () => {});
test("probeAcceptPlan in a case that is not a probe child throws and writes nothing", () => {});
test("acceptPlan by improve-probe is refused as any actor but a person is", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(pipeline): a probe child is marked, capped, never published, and has its plan accepted by code`.

---

### Task 8: The engine: the seven runners, the adopt gate and the host

**Files:**
- Create: `src/pipeline/improve/host.ts`, `src/pipeline/improve/runners.ts`, and one stub each: `select.ts`, `propose.ts`, `probe.ts`, `compose.ts`, `judge.ts`, `reflect.ts`, `adopt.ts` (all under `src/pipeline/improve/`)
- Modify: `src/pipeline/engine.ts`, `src/pipeline/next.ts`, `src/pipeline/contract.ts`
- Test: `tests/pipeline/engine-improve.test.ts` (new), `tests/pipeline/next.test.ts`, `tests/pipeline/contract.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 5 (`fromLock(lock, over)`, the roles).
- Produces:
```ts
// src/pipeline/improve/host.ts
export interface TaskRef { case: string; origin: string }
export interface TaskView { ref: TaskRef; state: Readonly<CaseState>; head: { seq: number; hash: string }; entries(from?: number, to?: number): readonly Entry[] }
export interface ProbeRef extends ChildRef { probe: string }
export interface ImproveHost {
  /** The loaded cases of this type that have published a product, newest case first (the greater case number first). Reads; opens no engine. */
  tasks(caseType: string): TaskView[];
  /** The task Select named, when it is loaded and its first entry is that origin; null otherwise. */
  task(ref: TaskRef): TaskView | null;
  /** The staging store of an improve case: made when first asked for. */
  staged(improve: { case: string; origin: string | null }): BlobStore;
  /** stageCandidate over the roots as they are now, into this improve case's staging store. */
  stage(improve: { case: string; origin: string | null }, root: string, files: ManifestFile[], target: string): { ok: true; loop: ResolvedLoop } | { ok: false; problems: string[] };
  /** checkCandidate over the roots as they are now. */
  check(root: string, files: ManifestFile[], target: string): ChangeCheck;
  /** Removes the improve case's staging folder. Never throws. */
  clear(improve: { case: string; origin: string | null }): void;
  probes: {
    find(link: ChildLink): { id: string; origin: string } | null;
    create(input: NewCase, link: ChildLink, mark: ProbeMark, type: string): { id: string; origin: string };
    /** Starts the child on `loop` when it has no run, and carries it to where a probe ends (driveProbe). Passes no gate but the child's plan gate, by its policy. */
    drive(ref: ProbeRef, opts: { loop: ResolvedLoop }): Promise<RunSummary>;
    read(ref: ProbeRef): ChildView | null;
    /** Ends a probe child's run in progress as stopped, by improve-probe. Nothing when it has none. */
    end(ref: ProbeRef, reason: string): void;
  };
}
// src/pipeline/improve/runners.ts
export const IMPROVE_RUNNERS: Record<(typeof IMPROVE_ROLES)[number], StageRunner>;   // imports selectRunner … adoptRunner from the seven files
// src/pipeline/engine.ts
EngineDeps gains: improve?: ImproveHost;
Engine gains:
  /** In a probe child: writes run.resumed by improve-probe when the run is interrupted. True when it wrote. Throws RunRefused elsewhere. */
  resumeProbe(): boolean;
  /** In a probe child: ends the run in progress as stopped, by improve-probe, with the reason, and anchors the case closed. Throws RunRefused elsewhere. */
  endProbe(reason: string): void;
RunSummary.waiting: "plan" | "publish" | "adopt" | null;
// src/pipeline/contract.ts
EngineCommand gains "adoptDecide" | "adoptFinish" | "setKnownAnswer" | "withdrawKnownAnswer"; THEN_ADVANCE: adoptDecide true, adoptFinish true, the two answer commands false.
```
Each stub exports its runner (`selectRunner`, …) returning `{ kind: "stalled", reason: "<Role> is not built yet" }`; wave 4 replaces each file whole. The engine's `runners` gains `IMPROVE_RUNNERS`.
`Engine.bind`: when `s.improve.probe_of !== null` and `deps.improve` is set, the lock is rebuilt with `loops.fromLock(lock, deps.improve.staged({ case: probe_of.improve, origin: probe_of.origin }))`; in every other case exactly as today.
`nextStep`: a passed stage with `gate: "adopt"` gives `{ kind: "gate", gate: "adopt" }` while `adoptOffer(state)` is not null and has an undecided file; otherwise it goes on (`on_pass` null: `finish`). `finishOf` is unchanged: an improve loop has no publish gate, so its run ends `completed`.
`Engine.finish` and `Engine.stop`: after the run of a case with `improve.request` has ended, each probe child of that run whose probe is started and not finished is ended (`deps.improve.probes.end(ref, "its improve run ended")`), then `deps.improve.clear(…)`; each in a `try` whose failure goes to `onError`.
A sub-loop stage is unchanged. `childSettled` is unchanged: Probe never waits on a child.

- [ ] **Step 1: failing tests** (a seven-stage improve loop built in the test with inline stages; runners injected through `opts.runners`).

```ts
test("an improve run starts each of the seven stages in order with the runner of its role", () => {});
test("with a chosen candidate that has an undecided file, the run waits at the adopt gate after Adopt passes", () => {
  expect(engine.summary()).toMatchObject({ status: "waiting", waiting: "adopt" });
});
test("with nothing chosen there is no adopt gate: the run finishes completed", () => {});
test("gate.passed adopt by a person takes the run on to its end, completed", () => {});
test("a probe child's engine, made after a restart, rebuilds its staged version from its own lock and the staging store", () => {
  // a child bound to a staged loop; a new Engine on the same session with deps.improve.staged: engine.unusable is null and engine.loop.pipeline.hash is the staged hash
});
test("without the staging store that child's engine says its version is not in this workbench, and its run pauses on a drive", () => {});
test("an engine of a case that is no probe child never asks for a staging store", () => {});
test("resumeProbe writes run.resumed by improve-probe for an interrupted probe child, once; endProbe ends its run as stopped with the reason", () => {});
test("resumeProbe and endProbe throw in a case that is no probe child and write nothing", () => {});
test("when an improve case's run ends, finished or stopped by a person, the host is asked to end its unfinished probe children and then to clear its staging store", () => {});
test("the stub of a role that is not built stalls the run with its sentence", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): the engine runs an improve loop to its adopt gate and binds a probe child's staged version`.

---

### Task 9: Select

**Files:**
- Modify: `src/pipeline/improve/select.ts` (replace the stub whole), `src/pipeline/memory.ts`
- Test: `tests/pipeline/improve-select.test.ts` (new), `tests/pipeline/memory-select.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 3 (`answeredProducts`), Task 5 (`isImproveLoop`), Task 8 (`ImproveHost`, `TaskView`), `termsOf` (`src/agents/draft.ts`), `tooStrict` (`src/agents/pack.ts`), `memoryUses`.
- Produces:
```ts
// src/pipeline/improve/select.ts
/** Why `target` may not be improved here; null when it may. */
export function targetProblem(loops: LoopCatalog, target: string): string | null;
/** What Propose is told of a task's original run, from named fields of its state: never its answers. */
export function taskRecord(view: Pick<TaskView, "state">, product: number): TaskRecord;
export function taskInputs(state: Readonly<CaseState>): TaskInputs;
export const selectRunner: StageRunner;
// src/pipeline/memory.ts
/** The lock an improve run reads: every shared lesson of the type that is not stricter than the case, newest acceptance first, cut at max; each `matched` is ["every lesson of the type: an improve run reads them all"]. */
export function improveLock(store: { state: Readonly<StoreState>; origin: string | null; head: { seq: number; hash: string } }, type: string, marking: Marking, stages: readonly string[], opts: { max: number }): MemoryLock;
```
`targetProblem`: "there is no usable loop <target>: <its first problem>" · "an improve loop is not improved by an improve loop" · "loop <target> runs a sub-loop; this version improves a loop with none".
`selectRunner`, in order: stalls without `deps.improve` ("this workbench cannot run an improve loop here") or without `state.improve.request`; returns what is recorded when this run already has `improve.selected`; stalls on `targetProblem`. It takes `host.tasks(case_type)`, keeps a case with an answered product (`answeredProducts`; the greatest product number), no `improve.request` and no `improve.probe_of`; leaves out, as `marking`, one whose case, product or answer marking is stricter than the improve case's; cuts at `request.tasks`, the rest `cap`. With none it finishes `fail`: "there is no <case_type> case with a known answer on a published product here". One commit: `budget.set { tokens: config.improve.own_tokens }` when the run has no budget; `improve.selected` (the target's current version, its lock as a blob of this case, `scale` from the target's standard through its components, `[]` when it has none); one `improve.task` each with `inputs` and `record` blobs; and, when the improve loop's lock holds a `shared` memory use and `deps.memory` is set, `memory.bound` with `improveLock` for the stages of those uses. The stage's output is `{ target, version, loop_hash, tasks: [{ task, case }], left_out }`.

- [ ] **Step 1: failing tests** (a `ImproveHost` made in the test over sessions built with `EntryBuilder`).

```ts
test("Select takes the cases of the type with a known answer, newest first, up to the number asked, as T1, T2…", () => {});
test("a case with no known answer, of another type, an improve case and a probe child are not tasks", () => {});
test("a task whose case, product or answer is stricter than the improve case is left out for its marking; the rest beyond the cap for the cap", () => {});
test("with no task Select fails with the sentence and the run pauses", () => {});
test("improve.task holds the answer's seq and hash and nothing of its text: no blob of the improve case holds the canary", () => {
  // the known answer's text holds "canary-7f3a"; read every blob of the improve case's folder after Select
});
test("taskRecord holds the product, the stages, the queries, the counts and the usage, and is built from named fields: a state with an extra field holding the canary gives a record without it", () => {});
test("improve.selected names the target's current version, its hash and its lock, and the scale of its standard, least likely first", () => {});
test("a target that is not usable, is an improve loop, or runs a sub-loop stalls with its sentence", () => {});
test("Select sets the run's budget to improve.own_tokens when it has none, and leaves a budget a person set", () => {});
test("Select binds every shared lesson of the type for the stages that read memory, a triggered one too, and none stricter than the case", () => {});
test("run again after a stop of the process, Select writes nothing more", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): Select takes the tasks of a case type and the target loop's version`.

---

### Task 10: Propose

**Files:**
- Modify: `src/pipeline/improve/propose.ts` (replace the stub whole), `src/agents/tools/builder.ts`, `src/agents/tools/index.ts`, `src/pipeline/stages/agent.ts`
- Test: `tests/pipeline/improve-propose.test.ts` (new), `tests/agents/tools-builder.test.ts`

**Interfaces:**
- Consumes: Task 1, Task 6 (through `ImproveHost.check` and `stage`), Task 8, `writeRoot` (`src/modules/loop-write.ts`), `scrub`, `hideCredentials`.
- Produces:
```ts
// src/agents/tools/index.ts
BuilderTools gains: /** Set for an improve run's proposer: the target loop, and the most changes one run may propose. */ improve?: { target: string; max: number };
// src/pipeline/stages/agent.ts
stageAgent's opts gain: builder?: BuilderTools;      // handed to the ToolContext
// src/pipeline/improve/propose.ts
/** The parts the proposer is given beside its stage's own: each task's inputs and record, the target's outline, and each file a candidate may change with its path. */
export function improveParts(session: CaseSession, deps: EngineDeps): PackPart[];
/** The proposer's reader and check: `check` is the host's checkCandidate for the target. */
export function proposerTools(session: CaseSession, deps: EngineDeps): BuilderTools;
export const proposeRunner: StageRunner;
```
`need(ctx)` of `src/agents/tools/builder.ts` takes a session that is not a builder session only when `ctx.builder.improve` is set and the case has `improve.request`. `request_probe` refuses there ("a probe is the improve loop's own"). `propose_change` refuses once the stage pass holds `improve.max` changes: "this improve run takes at most <n> candidates". What it writes is what it writes in a builder session.
`improveParts`: per task, one part of kind `task` (the inputs and the record as text, marked the task's marking). One part of kind `loop`: the target's stages with role, tools, model, effort and turns. One part of kind `manifest` per file a candidate may change (the items of the target's lock of kind skill, procedure and stage that have a path, the playbooks and sources its `uses` lists, the loop file), titled by its root-relative path, its text scrubbed and with credentials hidden as the builder's `read` gives it. No part reads `state.answers`, a task case, or anything but the improve case's blobs and the roots.
`proposeRunner`: stalls unless this run has `improve.selected`; stalls when `loops.current(target)?.pipeline.hash !== selected.loop_hash`: "loop <target> changed since the tasks were selected; stop this run and start another". When this run has no `builder.proposed` of this stage yet, it runs `stageAgent` with `extras: improveParts(...)`, `builder: proposerTools(...)` and the task "Propose at most <K> changes to loop <target> that would make <case_type> cases more correct. Each is one call of propose_change. Change only what the parts titled by a path hold. Then answer with what you proposed." Then, with or without a model call (a restart after the agent ended), it stages every change of this run's stage that has no `improve.candidate` yet, oldest first: the bundle's files through `host.stage`; `staged` with the lock as a blob and its hash, or `dropped` with the first problem, or `dropped` "it changes nothing the loop reads" when the hash is the base's. One commit per candidate. The output is `{ candidates: [{ candidate, change, status }] }`. A model that proposes nothing passes with none.

- [ ] **Step 1: failing tests for the tools.**

```ts
test("in an improve case set up by Propose, propose_change checks with the candidate rules and writes builder.proposed with its bundle", () => {});
test("a change the candidate rules refuse is a tool refusal with the reason, and nothing is written", () => {});
test("the change after the last one allowed is refused with the sentence", () => {});
test("request_probe is refused in an improve case; in a case with no improve request every builder tool is refused as before", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the stage** (a scripted provider; a host stand-in whose `stage` is the real `stageCandidate` over a copy of the sample root).

```ts
test("the proposer's pack holds each task's question and record, the target's outline and each changeable file under its path", () => {});
test("the proposer's pack holds no known answer: the canary is in no model.request of the stage", () => {});
test("two proposed changes become K1 and K2, each staged with its lock and hash", () => {});
test("a change that resolves to the base's hash is dropped: it changes nothing the loop reads", () => {});
test("a change that no longer resolves when it is staged is dropped with the loop's problem", () => {});
test("when the target changed since Select, Propose stalls with the sentence and calls no model", () => {});
test("after a stop between the agent's end and the staging, Propose stages what was proposed and calls no model again", () => {});
test("a model that proposes nothing passes with no candidate", () => {});
test("no secret value and no source location is in anything the proposer was sent", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(pipeline): Propose makes candidates as builder changes and stages each beside the live loop`.

---

### Task 11: Probe

**Files:**
- Modify: `src/pipeline/improve/probe.ts` (replace the stub whole)
- Test: `tests/pipeline/improve-probe.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`plannedProbes`, `probeOutputOf`, `readTaskInputs`, `probeId`), Task 7 (`ProbeMark`, `probeAcceptPlan`), Task 8 (`ImproveHost`, `Engine.resumeProbe`, `Engine.endProbe`), `depthOf`, `readLock`.
- Produces:
```ts
// src/pipeline/improve/probe.ts
export const PROBE_PLAN_ACCEPTS = 4;
/** What each child of this run may spend; the sentence when the budget does not cover the children. */
export function probeBudgets(config: Config["improve"], children: number): { lookups: number; tokens: number } | string;
/** A probe's link: the improve case, its run, the Probe stage, attempt 1, and an input hash over the probe's id, the loop's hash and the task's inputs. */
export function probeLink(state: Readonly<CaseState>, stage: string, probe: { probe: string; loop_hash: string }, inputs: TaskInputs): ChildLink;
/** Carries a probe child to where a probe ends: starts it on `loop` when it has no run, resumes it once when interrupted, and accepts its plan by its policy (at most PROBE_PLAN_ACCEPTS times) each time it waits there. Returns when it waits at its publish gate, is paused, has finished, or waits at a plan that cannot be accepted. A host's `probes.drive` is this. */
export async function driveProbe(engine: Engine, session: CaseSession, loop: ResolvedLoop): Promise<RunSummary>;
export const probeRunner: StageRunner;
```
`probeRunner`, in order: stalls without the host, without this run's `improve.selected`, when the improve case is `loops.max_depth` deep, or on `probeBudgets` ("the probe budget of <n> lookups does not cover <m> children"). It first ends, through `host.probes.end`, every child of a probe this run has finished. Then, for each of `plannedProbes(state)` not finished, in order:
1. the loop: for `base`, `loops.atHash(target, selected.loop_hash)`; for a candidate, `loops.fromLock(readLock(its lock blob), host.staged(me))`, and when that is a sentence, the candidate is staged again from its bundle and must give the recorded hash. A loop that cannot be had stalls the stage: "<probe>: <why>".
2. when not started: the child found for the link, else made (`host.probes.create`) with the task's inputs, the improve case's marking, the task's case type, and the mark; then `probe.started`.
3. `host.probes.drive(ref, { loop })`; a throw is the probe's reason.
4. the child read again. A child that runs another version than the probe's stalls the stage, as a sub-loop stage does.
5. `probe.finished` with the child's head, `probeOutputOf(child state)` as a blob, its hash, the lookups (the child's queries) and the tokens (its usage) it used; then `host.probes.end(ref, "a probe ends at its publish gate")`.
Between two probes a run that is no longer `running`, or is another run, ends the stage `stopped`. With every probe finished the stage passes; its output lists `{ probe, child, outcome }`. Probe never returns `waiting_child` and never passes a gate itself.

- [ ] **Step 1: failing tests for the pieces.**

```ts
test("probeBudgets divides the two budgets by the children and floors; a share below 1 is the sentence", () => {
  expect(probeBudgets({ ...cfg, probe_lookups: 240, probe_tokens: 1200000 }, 12)).toEqual({ lookups: 20, tokens: 100000 });
});
test("probeLink is the same for the same probe and differs between two probes of one task", () => {});
test("driveProbe starts the child on the loop given, accepts its plan as improve-probe, and returns when it waits at its publish gate", () => {});
test("driveProbe passes no publish gate and writes nothing by a person", () => {});
test("driveProbe resumes an interrupted child once, and leaves a paused one paused", () => {});
test("a child that plans again is accepted again, four times at most", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the stage** (a workbench in a temporary folder, the sample's small loop, a scripted provider, a host stand-in built on the real workbench).

```ts
test("with one staged candidate and two tasks Probe makes four children, base first, each bound to its version", () => {
  // the two K1 children's loop.bound hash is the candidate's; the two base children's is selected.loop_hash
});
test("each child is marked a probe child, as strictly as the improve case, of the task's case type, with its lookup cap and token budget", () => {});
test("every query of a probe is in that child's own ledger, through runQuery, and none is in the improve case", () => {});
test("probe.finished holds the child's head, the hash of its output and the output as a blob of the improve case", () => {});
test("a child that pauses on a question to the person, on a declined model or on its budget is recorded incomplete with the reason, and Probe goes on", () => {});
test("after its probe is recorded a child's run is ended as stopped by improve-probe; nothing was published", () => {});
test("a process stopped after probe.started and before probe.finished: run again, Probe finds that child, makes no second one, and records it once", () => {});
test("a process stopped after probe.finished and before the child was ended: run again, the child is ended", () => {});
test("a person stops the improve run between two probes: Probe ends stopped and starts no other child", () => {});
test("a dropped candidate has no child", () => {});
test("Probe leaves the chain's loop.recorded entries, the roots and the content store as they were", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(pipeline): Probe runs every task under the base and each candidate as child cases`.

---

### Task 12: Compose

**Files:**
- Modify: `src/pipeline/improve/compose.ts` (replace the stub whole)
- Test: `tests/pipeline/improve-compose.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`Contrast`, `readProbeOutput`, `stagedCandidates`), Task 8, `stageAgent`, `agentActor`, `packPart`, `redactSecrets`, `scrub`.
- Produces:
```ts
// src/pipeline/improve/compose.ts
export const WHY_MAX = 2000;
/** For each task and each staged candidate, what its output has that the base's has not: pure, from the outputs alone. Two findings are the same when their statements are, lower-cased and trimmed. */
export function contrastsOf(state: Readonly<CaseState>, outputs: Record<string, ProbeOutput>): Contrast[];
export function composeParts(session: CaseSession, outputs: Record<string, ProbeOutput>, contrasts: readonly Contrast[]): PackPart[];
export const composeRunner: StageRunner;
```
`composeRunner`: returns what is recorded when this run has `compose.chosen`; stalls while a planned probe is unfinished. It reads every probe's output from the improve case's blobs. With no staged candidate it writes `compose.chosen { candidate: null, why: "no candidate was staged", contrasts }` by the engine and passes, with no model call. Otherwise it runs `stageAgent` with the stage's schema narrowed so `choice` is one of the staged candidates' ids or `none`, and the task "For each task you are given what the unchanged loop produced and what each candidate produced. Pick the one candidate the differences support across the tasks, or none. Say why from the differences. You are not told which answer is right." It writes `compose.chosen` by the stage's agent actor: the choice, `why` scrubbed, redacted and cut at `WHY_MAX`, and the contrasts as a blob. Parts: per task the question (from its inputs blob); per probe its outcome, reason, findings (statement, likelihood, confidence), summary, assessment, gaps and stats; the contrasts in words. Every part is marked the improve case's marking. Nothing here reads a task case, `state.answers`, or `improve.scored`.

- [ ] **Step 1: failing tests.**

```ts
test("contrastsOf lists the findings a candidate added, removed and changed against the base, per task, and the lookups and tokens of both", () => {});
test("a candidate whose output is the base's has an empty contrast", () => {});
test("an incomplete base and a drafted candidate is a contrast that says so", () => {});
test("contrastsOf is the same whatever order the outputs are given in", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the stage.**

```ts
test("Compose's model is given each task's question, each probe's output and the contrasts, and its choice is recorded with its reason and the contrasts blob", () => {});
test("the schema the model is held to names only the staged candidates and none", () => {});
test("an answer naming a dropped candidate is re-asked once and then stalls the stage", () => {});
test("none is a choice: compose.chosen has candidate null and the model's reason", () => {});
test("with no staged candidate the engine records none and calls no model", () => {});
test("Compose's pack holds no known answer and no score: the canary is in no model.request of the stage", () => {});
test("a secret value in the model's reason is written redacted", () => {});
test("run again after the choice is recorded, Compose calls no model", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(pipeline): Compose picks the candidate the contrasts support, or none`.

---

### Task 13: Judge

**Files:**
- Modify: `src/pipeline/improve/judge.ts` (replace the stub whole)
- Test: `tests/pipeline/improve-judge.test.ts` (new)

**Interfaces:**
- Consumes: Task 1, Task 3 (`knownAnswerOf`), Task 4 (`unmatched`, `scoreOutput`, `scoreSheet`, `ModelMatch`), Task 8 (`ImproveHost.task`), `stageAgent`.
- Produces:
```ts
// src/pipeline/improve/judge.ts
/** The answers Select named, read from their tasks' ledgers by seq and hash; the sentence when one cannot be read. */
export function answersOf(state: Readonly<CaseState>, host: Pick<ImproveHost, "task">): AnswerCopy[] | string;
/** What the matcher model is asked: per output, the expected claims code left unmatched and that output's findings by id; and, for an answer with no expected finding, its text. */
export function matcherParts(session: CaseSession, answers: readonly AnswerCopy[], outputs: Record<string, ProbeOutput>): PackPart[];
export const judgeRunner: StageRunner;
```
`judgeRunner`: returns what is recorded when this run has `judge.scored`; stalls unless this run has `compose.chosen` ("the judge runs after Compose has chosen"); stalls on `answersOf`'s sentence ("task <case> is not loaded; load it from the store so its known answer can be read" · "the known answer Select named is not in <case>'s ledger"). It scores every finished probe in code. When the stage runs an agent and something is left for it (an unmatched expected claim, or an answer with no expected finding), it asks its model once, schema `judge-output` (`{ matches: [{ probe, expected, produced }], texts: [{ probe, verdict }] }`); a match naming a probe, an expected index or a finding id that does not exist is dropped. A model that fails, declines or is blocked leaves the scores as code made them, with the reason in the stage's output: the judge never holds the run. One commit: `judge.scored` by the engine, with the answers blob, the sheet blob, `matcher` and the summary. The answers blob and the sheet are marked by the improve case; Select has left out any answer stricter than it.

- [ ] **Step 1: failing tests.**

```ts
test("answersOf reads each task's answer at the seq and hash Select recorded, though the person revised it since", () => {});
test("a task that is not loaded, or whose ledger holds no such entry, is the sentence", () => {});
test("the Judge stalls before Compose has chosen and reads no answer", () => {
  // the host's task() is never called
});
test("with a script stage every output is scored in code: the summary is base first, then the candidates", () => {
  expect(s.improve.scored!.summary).toEqual([{ candidate: "base", score: 333, drafted: 3, tasks: 3 }, { candidate: "K1", score: 1000, drafted: 3, tasks: 3 }]);
});
test("the answers blob and the sheet are blobs of the improve case, and the sheet is what scoreSheet gives for them", () => {});
test("with an agent stage the model is asked only about what code left unmatched, and its matches are scored by code", () => {});
test("a model's match that names a finding the output does not have is dropped", () => {});
test("a model that declines leaves the code's scores, matcher code, and the reason in the stage's output; the stage passes", () => {});
test("the only model requests of the case that hold a claim or an answer's text are the Judge's", () => {});
test("run again after the scores are recorded, the Judge reads nothing and writes nothing", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): the Judge scores every probe against its known answer after Compose has chosen`.

---

### Task 14: Reflect, and what Adopt offers

**Files:**
- Modify: `src/pipeline/improve/reflect.ts`, `src/pipeline/improve/adopt.ts` (replace each stub whole)
- Test: `tests/pipeline/improve-reflect.test.ts` (new), `tests/pipeline/improve-adopt.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 (`adoptOffer`, `readContrasts`, `readScoreSheet`), Task 8, `MemoryHost.propose`, `draftProblem` (`src/core/lessons.ts`), `stageAgent`, `MAX_PROPOSED` and `LESSONS_QUESTION` (`src/pipeline/lessons.ts`).
- Produces:
```ts
// src/pipeline/improve/reflect.ts
export function reflectParts(session: CaseSession): PackPart[];
export const reflectRunner: StageRunner;
// src/pipeline/improve/adopt.ts
export const adoptRunner: StageRunner;
```
`reflectRunner`: stalls unless this run has `judge.scored`. Parts: Compose's choice and reason; the contrasts in words; the sheet's summary and, per output, its score and each expected finding by its number with its match, distances and score. No part holds an answer's text or a claim: the sheet names expected findings by index. It asks the stage's model "What would make later <case_type> cases faster or more correct? Answer with at most 3 lessons, each from a difference between the probes that the scores bear out." (schema `lessons-output`), builds each draft with `case_type` the request's and a marking at least the improve case's and each request's of this pass, drops one `draftProblem` refuses, and files the rest through `deps.memory.propose` with the origin `{ kind: "case", case, origin, run, head: the stage's start, product: null, stage, model: true }`. The output is `{ lessons: [{ lesson, title, fresh }], dropped: [{ title, why }] }`. A model that fails, declines or is blocked, a workbench with no store, or a refusal, files nothing and the stage passes with the reason. Filing is idempotent as Feedback's is. Nothing is accepted.
`adoptRunner`: passes at once with `{ candidate, change, files }` from `adoptOffer(state)`, or `{ candidate: null }`. It writes nothing else: the gate is the engine's.

- [ ] **Step 1: failing tests.**

```ts
test("Reflect's model is given the choice, the contrasts and the scores, and its lessons are filed as proposals of the request's case type from this case and stage", () => {});
test("a lesson is marked at least as strictly as the improve case; none is accepted", () => {});
test("Reflect's pack holds no known answer's text and no claim: the canary and each claim are in no model.request of the stage", () => {});
test("a lesson that is not a lesson is dropped with its reason; a lesson holding a secret value is dropped and not named by its title", () => {});
test("a model that declines files nothing and the stage passes with the reason", () => {});
test("a stage run again files nothing twice", () => {});
test("Adopt passes with the chosen candidate's change and its file count, and with nothing when none was chosen", () => {});
test("no file under src/pipeline/improve imports src/core/memstore.ts", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(pipeline): Reflect proposes lessons from the contrasts and scores; Adopt offers the chosen change`.

---

### Task 15: The host over a workbench

**Files:**
- Create: `src/pipeline/improve/workbench-host.ts`
- Modify: `src/server/hub.ts`, `src/cli/compose.ts`
- Test: `tests/pipeline/improve-host.test.ts` (new), `tests/server/children.test.ts`, `tests/cli/compose-reload.test.ts`

**Interfaces:**
- Consumes: Task 6 (`stageCandidate`, `checkCandidate`), Task 7 (`createCase`'s `probe`), Task 8 (`ImproveHost`), Task 11 (`driveProbe`).
- Produces:
```ts
// src/pipeline/improve/workbench-host.ts
/** The folder of an improve case's staging store: "<case id>-<first 12 hex of its first entry's hash>". */
export function stagedFolder(improve: { case: string; origin: string | null }): string;
export function improveHost(opts: { wb: Workbench; deps: () => EngineDeps; engine: (id: string) => Engine; secrets: () => readonly string[]; onError: (e: unknown) => void }): ImproveHost;
/** Removes each staging folder whose improve case is loaded here with that origin and has no run in progress, and each folder that names no case. Returns what it removed. */
export function sweepStaged(config: Config, wb: Workbench): string[];
```
`improveHost`: `tasks` reads `wb.listCases()` and each loaded session's state (no engine is opened); `stage` and `check` build `SaveDeps` from the workbench's chain and content store and the deps' loops and registry as they are when called; `probes.find` and `read` are the hub's children's; `probes.create` is `wb.createCase(input, ENGINE, { loop: link.loop, link, probe: mark, type, type_by: { kind: "system", id: "improve-task" } })`; `probes.drive` refuses a case that is not the child the ref names, then `driveProbe(engine(ref.id), session, opts.loop)`; `probes.end` is `engine(ref.id).endProbe(reason)` when its run is in progress. `clear` removes the folder and reports a failure to `onError`.
The hub sets `deps.improve = improveHost({ wb, deps: () => this.deps, engine: (id) => this.engine(id), … })` beside `deps.children`. `compose` calls `sweepStaged` once, after the roots are loaded, and adds nothing to the problems for it.

- [ ] **Step 1: failing tests.**

```ts
test("tasks lists the loaded cases of the type that published, newest first, and opens no engine", () => {});
test("stage writes only under <data>/staged/<case>-<origin12>/ and returns the staged loop", () => {});
test("clear removes that folder, and a second clear is nothing", () => {});
test("probes.create makes a probe child of the task's type; probes.drive refuses a case that is not that child", () => {});
test("probes.end ends a waiting child's run as stopped by improve-probe and does nothing to a finished one", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the hub and compose.**

```ts
test("a hub's deps carry the improve host, and an improve case's run reaches Probe through it", () => {});
test("a new hub over the same data folder, mid-probe: the child's engine rebuilds its staged version and the probe is finished", () => {});
test("sweepStaged removes the folder of a finished improve case and of no case, and keeps the folder of a run in progress and of a case that is not loaded", () => {});
test("compose sweeps once and a reload does not", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(server): a workbench hosts improve runs: tasks, staging, probe children`.

---

### Task 16: Verify

**Files:**
- Modify: `src/core/verify.ts`, `src/cli/verify.ts`
- Test: `tests/core/verify.test.ts`, `tests/cli/cases.test.ts` (or the test that holds the verify command's lines)

**Interfaces:**
- Consumes: Task 1 (`probeOutputOf`, the readers), Task 4 (`rescore`).
- Produces:
```ts
// src/core/verify.ts
export interface ProbeReport { ok: boolean; probes: { probe: string; child: string; status: "matches" | "not_loaded" | "head_differs" | "not_its_child" | "version_differs" | "output_differs" }[] }
export function verifyProbes(caseDir: string, casesDir: string): ProbeReport;
export interface ScoreReport { ok: boolean; scored: boolean; problem: string | null }
export function verifyScores(caseDir: string): ScoreReport;
export function probeLines(r: ProbeReport): string[];
```
The checks are those of "Replay of the improve case using the children's recorded heads". `verifyScores` reads the improve case alone: its `judge.scored`, the answers blob, the sheet, and each probe's output blob; `rescore` must give the recorded sheet, and the recorded `summary` must be the sheet's. A case with no `judge.scored` is `{ ok: true, scored: false }`. Neither changes `verifyCase`'s report; the verify command prints their lines after the links' lines, for a case that has probes.

- [ ] **Step 1: failing tests.**

```ts
test("verifyProbes matches each probe of a finished improve case against its child at the recorded head", () => {});
test("a child whose ledger was cut before the head, whose probe.child names another probe, or whose run bound another version is reported as such", () => {});
test("an output blob that is not what the child's fold at that head gives is output_differs", () => {});
test("a child that is not in the folder is not_loaded and the report is ok", () => {});
test("verifyScores is ok for a recorded sheet and names the first score that differs when a score was edited", () => {});
test("verifyScores reads no other case: with every child and task removed it gives the same answer", () => {});
test("the verify command prints the probes' and the scores' lines for an improve case and nothing more for any other", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(core): verify checks an improve case's probes against their children and its scores against its blobs`.

---

### Task 17: The server: known answers, improve cases and the Adopt gate

**Files:**
- Create: `src/server/improve.ts`, `src/server/improve-routes.ts`
- Modify: `src/server/app.ts`, `src/server/commands.ts`, `src/server/roles.ts`, `src/core/wire.ts`, `tests/helpers/served.ts`
- Test: `tests/server/improve.test.ts` (new), `tests/server/improve-commands.test.ts` (new), `tests/server/boundaries.test.ts`, `tests/server/guard.test.ts`

**Interfaces:**
- Consumes: Tasks 1, 3, 9 (`targetProblem`), 15; `builderDecide`, `builderView` (`src/server/builder.ts`).
- Produces:
```ts
// src/core/wire.ts
export interface NewImproveInput { loop: string; case_type: string; tasks: number; candidates: number; marking: Marking }
export interface ImproveView {
  request: { target: string; case_type: string; tasks: number; candidates: number } | null;
  selected: null | { target: string; version: number; loop_hash: string; tasks: { task: string; case: string; marking: Marking }[]; left_out: { case: string; why: string }[] };
  candidates: { candidate: string; change: string; title: string; why: string; status: "staged" | "dropped"; reason: string; files: BuilderFileView[] }[];
  probes: { probe: string; candidate: string; task: string; child: string; head: { seq: number; hash: string } | null; outcome: "drafted" | "incomplete" | null; reason: string; lookups: number | null; tokens: number | null }[];
  chosen: { candidate: string | null; why: string } | null;
  /** Null until judge.scored. */
  scores: ScoreSheet | null;
  lessons: { lesson: string; title: string }[];
  adopt: { waiting: boolean; candidate: string; change: string; undecided: number } | null;
}
// src/server/improve.ts
export class ImproveRefused extends Refused {}
export function createImprove(d: { hub: CaseHub; deps: EngineDeps; wb: Workbench }, input: NewImproveInput, actor: Extract<Actor, { kind: "human" }>): { id: string };
export async function improveView(session: CaseSession, deps: EngineDeps, opts: { secrets: readonly string[] }): Promise<ImproveView>;
/** The person's decision on one file of the chosen candidate, at the adopt gate: builderDecide in the improve case, then the gate when no file is left. */
export function adoptDecide(ctx: BuilderContext, change: string, file: number, accept: boolean): void;
/** Rejects every file still undecided and passes the gate, in one commit. */
export function adoptFinish(ctx: BuilderContext): void;
// src/server/roles.ts
export const IMPROVE_COMMANDS = ["create_improve", "set_known_answer", "withdraw_known_answer", "adopt_decide", "adopt_finish"] as const;
Reading gains "improve".
```
Routes: `POST /api/improve` (`create_improve`; the body is a `NewImproveInput` and nothing else) and `GET /api/cases/:id/improve` (`improve`). The four case commands go through `COMMANDS` as every case command does: `set_known_answer { product, text, findings, marking }`, `withdraw_known_answer { product, reason }`, `adopt_decide { change, file, accept }`, `adopt_finish {}`; the two adopt commands advance the run afterwards.
`createImprove` refuses, having written nothing: "there is no usable improve loop here: <problem>" · `targetProblem`'s sentences · "there is no case type <id>" · "an improve run takes 1 to <max_tasks> tasks" · "an improve run takes 1 to <max_candidates> candidates". It makes the case with `wb.createCase({ title: "Improve <target> for <case_type>", asked: "Which change to loop <target> makes <case_type> cases more correct?", why: "an improve run the person asked for", starting: [], window: { from: null, to: null }, objective: null, marking }, actor, { loop: "improve", type: case_type, improve: {…} })`. It starts nothing: the client sends `start`.
`adoptDecide` refuses: "the run is not waiting at the adopt gate" · "<change> is not the change Adopt offers" · and as `builderDecide` refuses (a stale file is "this file changed since the candidate was proposed; run the improve loop again"). After `builderDecide` it writes `gate.passed { gate: "adopt" }` by the person when `adoptOffer(state).undecided` is `0`. `improveView` shows scores only from `state.improve.scored`; candidates' titles, reasons and diffs come from `builderView`; lessons from Reflect's recorded output.

- [ ] **Step 1: failing tests for the routes.**

```ts
test("POST /api/improve makes an improve case of the improve loop with its request, of the case type, and starts nothing", () => {});
test("each refusal of createImprove is a 409 with its sentence, and no case is made", () => {});
test("a body with an actor, or a field it should not have, is refused", () => {});
test("GET /api/cases/:id/improve of a case with no request is a view with request null", () => {});
test("a reader may read an improve view and may not create an improve case or decide at Adopt", () => {});
test("both routes are behind the Host and Origin guard", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**

- [ ] **Step 5: failing tests for the commands.**

```ts
test("set_known_answer writes the answer by the person the server names; a refusal is a 409 with its sentence", () => {});
test("withdraw_known_answer removes it", () => {});
test("adopt_decide accept writes the file into the trusted root as the person, records manifest.written with why builder, writes builder.decided and reloads", () => {});
test("the last decision passes the adopt gate in that person's name and the run finishes completed", () => {});
test("adopt_decide on a candidate that was not chosen, before the gate, or on a decided file is refused and writes nothing", () => {});
test("a file changed on disk since it was proposed is refused as stale, and the gate stays", () => {});
test("adopt_finish rejects what is undecided and passes the gate in one commit; nothing is written into a root", () => {});
test("after every file of the chosen candidate is accepted, the target's current version has the candidate's hash, and it is recorded on the chain", () => {});
test("the improve view shows no score before judge.scored and the sheet after", () => {});
test("no route and no command takes an actor", () => {});
```
- [ ] **Step 6: FAIL. Step 7: implement. Step 8: PASS.** **Step 9:** full run and typecheck. **Step 10: commit** `feat(server): known answers, improve cases and the Adopt gate over the builder's accept`.

---

### Task 18: The command line

**Files:**
- Create: `src/cli/improve.ts`
- Modify: `src/cli/run.ts`, `package.json` (the `improve` script)
- Test: `tests/cli/improve.test.ts` (new), `tests/cli/run.test.ts`

**Interfaces:**
- Consumes: Tasks 3, 9, 15.
- Produces: `bun run improve <command>`:
  - `answer <case> --product <n> --text <text> [--findings <file.json>] [--marking <marking>]`
  - `withdraw <case> --product <n> --reason <text>`
  - `start <loop> --type <case type> --marking <marking> [--tasks <n>] [--candidates <k>]`: makes the improve case, starts its run and carries it as far as it goes;
  - `show <case>`: the request, the tasks, the candidates, each probe with its child and outcome, the choice and reason, the scores once there are any, and where it waits.
`run.ts`'s host gives its deps the improve host (`improveHost`) beside `children`, so `investigate resume` and `stop` work on an improve case. The command line decides nothing at Adopt: at the gate `show` prints "decide each file in the browser: the case's Improve lens" (Ruling). Every command opens the workbench with the lock the other commands use, and exits 1 with the refusal's sentence.

- [ ] **Step 1: failing tests.**

```ts
test("answer writes a known answer by the person of the configuration, and prints the product it is for", () => {});
test("answer with findings from a file that is not a list of findings is refused with the sentence", () => {});
test("start makes the improve case, runs it to the adopt gate on the sample, and prints the scores and where it waits", () => {});
test("show before the Judge prints no score", () => {});
test("investigate resume on an improve case paused mid-probe carries it on", () => {});
test("each refusal exits 1 and writes nothing", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(cli): bun run improve sets known answers and starts and shows an improve run`.

---

### Task 19: The known-answer form and "Improve this loop"

**Files:**
- Modify: `src/web/lenses/narrative.ts`, `src/web/views/loop.ts`, `src/web/api.ts`, `src/web/app.ts`, `src/web/style.css`
- Create: `src/web/panels/answer.ts`
- Test: `tests/web/answer.test.ts` (new), `tests/web/loops.test.ts`, `tests/web/browser-improve.test.ts` (new)

**Interfaces:**
- Consumes: Task 17's routes and commands.
- Produces: `answerPanel(ctx, product)` (a form: the text, up to twelve rows of claim, likelihood from the case's standard terms, confidence; the marking, never below the product's; Save, Withdraw with a reason); `api.createImprove(input)`; on a loop's page a form "Improve this loop" (case type, tasks, candidates, marking) that makes the case and opens it.
The form is shown only on a published product of the Narrative lens, only to a person who may write, and never in a probe child or an improve case. A saved answer is shown under its product as text, with who set it and when. The loop's page shows the form only for a usable loop that `targetProblem` would take; a refusal is shown as the server said it.

- [ ] **Step 1: failing tests** (happy-dom).

```ts
test("a published product has a Known answer control; a draft, a probe child and a reader's view have none", () => {});
test("saving sends set_known_answer with the product, the text, the rows and the marking", () => {});
test("the marking offered is never below the product's", () => {});
test("a saved answer is drawn as text: markup in it is not an element", () => {});
test("Withdraw asks for a reason and sends withdraw_known_answer", () => {});
test("Improve this loop sends the loop, the case type, the two counts and the marking, and opens the new case", () => {});
test("the server's refusal is shown in the form and nothing navigates", () => {});
test("no element here is made by innerHTML and none has an inline style", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**
- [ ] **Step 5: one browser test** (`tests/web/browser-improve.test.ts`, headless Chromium over `tests/helpers/served.ts`): a person sets a known answer on the sample's published product and it is there after a reload. **Step 6: FAIL, implement, PASS.** **Step 7:** full run with `WORKBENCH_REQUIRE_BROWSER=1`, and typecheck. **Step 8: commit** `feat(web): a known answer on a published product, and Improve this loop`.

---

### Task 20: The Improve lens and the Adopt gate

**Files:**
- Create: `src/web/lenses/improve.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/lenses/pipeline.ts`, `src/web/app.ts`, `src/web/api.ts`, `src/web/commands.ts`, `src/web/derive.ts`, `src/web/style.css`
- Test: `tests/web/improve-lens.test.ts` (new), `tests/web/pipeline.test.ts`, `tests/web/derive.test.ts`, `tests/web/browser-improve.test.ts`

**Interfaces:**
- Consumes: Task 17 (`ImproveView`, `adopt_decide`, `adopt_finish`), Task 1 (the fold, for replay).
- Produces: the lens `improve`, offered only in a case with `improve.request`. Sections, in order: the request and the tasks (each a link to its case); the candidates (title, reason, status; a dropped one with why; each file's diff, drawn as the builder panel draws one); the probes as a table of candidate by task (outcome, lookups, tokens; each cell a link that opens the child at the recorded head's seq); Compose's choice and reason; the scores, only when the view has them (the summary, then per output its score and each expected finding by its number with its match and distances); the lessons proposed (links to the Memory page); and, while the run waits at `adopt`, the gate: per file of the chosen change, Accept and Reject, and "Finish: reject the rest". The scores beside the gate are said to be the whole candidate's.
In replay the lens is drawn from `fold(entries, n)` alone: at a seq before `judge.scored` there is no scores section and at a seq before `compose.chosen` no choice. `derive`'s "next" for a run waiting at `adopt` opens this lens; no key passes the gate.

- [ ] **Step 1: failing tests** (happy-dom).

```ts
test("the lens is offered in an improve case and in no other", () => {});
test("candidates, the probe table, the choice and the lessons are drawn from the view", () => {});
test("no score is drawn from a view whose scores are null", () => {});
test("in replay at a seq before judge.scored the scores section is absent, and at the end it is there", () => {});
test("a probe's cell links to its child at the recorded head", () => {});
test("at the adopt gate each file has Accept and Reject, which send adopt_decide with the change, the file and the choice", () => {});
test("Finish sends adopt_finish; a reader has no button", () => {});
test("a stale file's Accept is disabled and says why", () => {});
test("a title, a reason and a diff line that look like markup are text", () => {});
test("the pipeline lens names the third gate, and next at the adopt gate opens the Improve lens", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS.**
- [ ] **Step 5: one browser test**: an improve case at its adopt gate; accepting the one file writes it and the run finishes. **Step 6: FAIL, implement, PASS.** **Step 7:** full run with `WORKBENCH_REQUIRE_BROWSER=1`, and typecheck. **Step 8: commit** `feat(web): the Improve lens and the Adopt gate`.

---

### Task 21: The sample

**Files:**
- Create: `sample/loops/improve.yaml`, `sample/loops/device-check.yaml`, `sample/context/improve-profile.yaml`, `sample/context/device-check-profile.yaml`, `sample/context/personas/proposer.md`, `composer.md`, `reflector.md`, `sample/context/skills/find-the-device.md`, `sample/context/schemas/propose-output.yaml`, `compose-output.yaml`, `judge-output.yaml`, `sample/scripts/sample-check.yaml`, `sample/scripts/sample-improve.yaml`
- Modify: `sample/case-types.yaml`, `sample/models/scripted.yaml`, `sample/README.md`, `scripts/make-sample-data.ts` (only if the three addresses below are not already in the data)
- Test: `tests/sample/sample.test.ts`, `tests/sample/improve-sample.test.ts` (new)

**Interfaces:**
- Consumes: everything before it. Produces what Task 22 runs.

The story, all synthetic:
- **Case type** `device-check`: "Which device held this address?"
- **Target loop** `device-check` (`case_type: device-check`, profile `device-check`, every stage inline, model `{ provider: scripted, model: sample-check }`): Plan (plan gate), Research, Assemble, Checks (reviews), Publish (publish gate). Research's profile entry lists the skill `find-the-device`, whose text says to look the address up in the lease records. No memory components.
- **Three tasks**: three cases of the loop, each asking which device held one of three RFC 5737 addresses of the sample's data. For one the lease answers; for two only the WiFi log's connection message names the device. Run with the base skill the scripted analyst finds the first and writes "not seen" findings for the other two.
- **Known answers**: one per case, each with a canary token in its text (`answer-key-1`, `-2`, `-3`) and one expected finding whose claim is worded unlike any scripted finding (the test holds that the claim text is in no script), with a likelihood term of the sample's standard and a confidence.
- **The improve loop** `improve` (profile `improve`): Select (script), Propose (agent; the four builder tools; `propose-output`), Probe (script; `probe: { plan_gate: accept }`), Compose (agent; `compose-output`), Judge (script), Reflect (agent; `lessons-output`), Adopt (human; `gate: adopt`). Propose lists `reference:shared-lessons { memory: shared/* }`.
- **Scripts.** `sample-check` holds, for each actor of the target loop, one variant per address and per skill text, chosen by `when`: with the candidate skill's added sentence in its pack the researcher also runs the WiFi lookup and the analyst names the device. `sample-improve`: the proposer calls `propose_change` three times: a change to `find-the-device` that adds the sentence about the connection message (K1); a change to the Research stage's `max_turns` (K2, which changes no output); and a change to a check, which the candidate rules refuse. The composer picks K1 with a reason that names the two tasks it changed. The reflector answers with one lesson.
- **Expected scores**: `base` 333, `K1` 1000, `K2` 333 (one expected finding per task, each matched at full agreement or not at all).

- [ ] **Step 1: failing tests** (`tests/sample/improve-sample.test.ts`).

```ts
test("the sample root loads with no problems, with the loops improve and device-check usable and the case type device-check", () => {});
test("the investigation, triage and unknown-device loops have the hashes they had", () => {
  // the three literals the existing sample tests hold
});
test("a device-check case runs to its publish gate on the scripted model for each of the three addresses", () => {});
test("no script, loop, skill or schema of the sample holds a known answer's canary or claim", () => {});
test("every name in the new files is the sample's: loopback and RFC 5737 addresses, example domains", () => {});
```
- [ ] **Step 2: FAIL. Step 3: write the sample. Step 4: PASS.** **Step 5:** full run and typecheck. **Step 6: commit** `feat(sample): a device-check case type with three tasks and a scripted improve run`.

---

### Task 22: Acceptance, the blindness test, boundaries and documents

**Files:**
- Create: `tests/sample/improve-acceptance.test.ts`
- Modify: `tests/agents/boundaries.test.ts`, `tests/server/boundaries.test.ts`, `tests/core/browser-safety.test.ts`, `README.md`, `docs/gui-guide.md`, `docs/security-notes.md`, `sample/README.md`
- Test: those

The acceptance run, through the server (`tests/helpers/served.ts`) over a copy of the sample root in a temporary folder: three `device-check` cases are run and published by the person; the person sets a known answer on each; the person makes an improve case for `device-check` with 3 tasks and 3 candidates and starts it; it runs to the adopt gate; the person accepts the one file of K1.

- [ ] **Step 1: failing tests.**

```ts
test("the improve run reaches its adopt gate with K1 chosen, K2 staged and the third change refused; nine probes (base, K1 and K2 for three tasks), each with its own child", () => {});
test("the scores are base 333, K1 1000, K2 333, and verifyScores recomputes them from the improve case alone", () => {});
test("blind: no model request and no tool result of any stage but the Judge, in the improve case or in any probe child, holds a canary, an answer's text or a claim", () => {
  // read the messages blob of every model.request and the blob of every tool.returned of the improve case and of all nine children
});
test("blind: no blob named by an entry of the improve case before judge.scored holds a canary, an answer's text or a claim", () => {});
test("blind: compose.chosen is before judge.scored in the ledger, and the Judge's stage started after Compose's finished", () => {});
test("staged, not live: before the accept, the chain holds no loop.recorded of a candidate's hash, the root's files are what they were, and loops.atHash of each candidate hash is the not-in-this-workbench sentence", () => {});
test("custody: every query of every probe child was issued through runQuery in that child's ledger; every child verifies; no child published", () => {});
test("the only gate passed by code is each child's plan gate, by improve-probe; every other gate.passed of every ledger is a person's", () => {});
test("budgets: each child's lookups and tokens are within its share, and the shares add up to no more than the configuration's", () => {});
test("replay: the improve case folded at every seq equals the live state at that seq, with every child and every task case removed from the folder", () => {});
test("verifyProbes matches all nine probes against their children at the recorded heads", () => {});
test("Reflect filed one proposal for device-check from this case; it is not accepted, and no later case is given it", () => {});
test("accepting K1's file writes the skill into the root as the person; the run finishes completed; device-check's current version has K1's hash", () => {});
test("after the run the staging folder is gone, and each probe child still replays and verifies", () => {});
test("a new device-check case after the accept binds the adopted version", () => {});
test("the same improve run split across a stop of the server in the middle of Probe ends with the same scores and the same choice", () => {});
test("a case made before this slice (the sample's whole-run ledger) folds, verifies and resumes as it did", () => {});
```
- [ ] **Step 2: FAIL. Step 3: fix what the run shows** (in the file that owns it; report each). **Step 4: PASS.**

- [ ] **Step 5: failing boundary tests.**

```ts
test("an answer's text and findings are read only in src/pipeline/improve/answers.ts and judge.ts: no other file under src/pipeline or src/agents names knownAnswerOf or reads a value of state.answers", () => {});
test("gate.passed is written by a non-person in exactly one function, probeAcceptPlan", () => {});
test("src/pipeline/improve imports neither src/core/memstore.ts nor src/server", () => {});
test("stageCandidate and planChange with `into` are called only from src/pipeline/improve/workbench-host.ts", () => {});
test("src/core/state/improve.ts and src/core/score.ts are browser-safe", () => {});
test("builder.decided is written only in src/server/builder.ts", () => {});
```
- [ ] **Step 6: FAIL, fix, PASS.**
- [ ] **Step 7: documents.** `README.md`: the improve loop in a paragraph and `bun run improve`. `docs/gui-guide.md`: setting a known answer, "Improve this loop", the Improve lens, deciding at Adopt. `docs/security-notes.md`: the one code-passed gate, the staging store, the blindness rules, that a probe's queries reach the live sources within the two budgets. `sample/README.md`: the story of Task 21. Placeholders only; no real path, host or name.
- [ ] **Step 8:** `WORKBENCH_REQUIRE_BROWSER=1 timeout 900 bun test && timeout 300 bun run typecheck`. **Step 9: commit** `test(sample): an improve run end to end, blind until judged, staged beside the live loop`.
