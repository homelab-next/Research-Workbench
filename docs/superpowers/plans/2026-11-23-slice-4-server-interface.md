# Server and Interface Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put the investigation in front of the analyst: a loopback server that turns the engine's commands into JSON endpoints and streams ledger entries, and the interface from the GUI guide for every part the design puts in this slice, including the Pipeline and Replay lenses.

**Architecture:** The server is a thin shell over what plans 1 to 3 built: each command endpoint checks the request, the role and the arguments, calls one function that writes entries through `CaseSession.commit`, and returns only "done, the head is now N" or the refusal. The browser receives the case's entries over a server-sent-events stream and folds them with the same `apply` the server uses (bundled from `src/core/state/`), so the screen is a pure function of entries and Replay is the same render at an earlier entry. The interface has no framework: views are functions that build DOM nodes through one helper that cannot inject HTML, and every keyboard shortcut comes from one table that also draws the "?" card.

**Tech Stack:** Bun 1.3.14 (`Bun.serve`, `Bun.build`, `Worker`, `WebSocket`), TypeScript 7 (strict), `bun test`. One new dev dependency: `happy-dom` (the DOM for interface tests). No runtime dependency. The browser run drives a local headless Chromium over its debugging protocol from a test helper; no Playwright package.

**Spec:** [`docs/superpowers/specs/2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md), sections 3, 5, 6.5 to 6.7, 8.3, 8.5, 9.2, 9.3, 9.5, 9.7, 10, 11 and 13. Interface reference: [`docs/gui-guide.md`](../../gui-guide.md) (cited below as "guide §n"). Roadmap: [`2026-11-23-slice-roadmap.md`](2026-11-23-slice-roadmap.md). This is plan 4 of 5. It builds on plans 1 to 3, on a new branch `slice-4-interface` from `slice-3-agents` at `578a236` (1221 tests).

## Global Constraints

- **Loopback only.** The server binds `127.0.0.1` and nothing else. Every request must carry `Host: 127.0.0.1:<port>` exactly; an `Origin` header, when present, must be `http://127.0.0.1:<port>`; every `POST` must carry that `Origin` and `Content-Type: application/json`. Anything else is refused before any handler runs. Tests use no address but `127.0.0.1`.
- **The screen is a fold of entries.** Everything the interface shows about a case is computed in the browser from that case's ledger entries by `apply` from `src/core/state/`. A command's response carries `{ ok, seq }` or a refusal, never state. The server hands the browser only three things that are not entries, each labelled as what it is: reference data from the registry (what may be asked, never case state), check results computed from the record (the custody report, a row-level difference), and previews that are a pure function of the ledger (the bundle preview).
- **Entries are streamed exactly as recorded.** The stream never rewrites an entry: a rewritten entry would not hash, and the browser's state would differ from the server's.
- **No secrets reach the browser.** Entries and blobs already hold no secret value (plans 1 to 3). Everything else the server sends is a view: a source is described without its `location`, `credential`, `user`, `dir` or `root`; any text that came from a source error, a manifest problem or an unexpected exception is passed through `scrub(registry, text)` from `src/agents/tools/kit.ts` before it leaves the server.
- **No HTML injection.** Nothing under `src/web/` uses `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `DOMParser`, `createContextualFragment`, `srcdoc`, `eval`, `new Function` or a string passed to `setTimeout`/`setInterval`. Nodes are built with `h()` from `src/web/dom.ts`; text goes in as text. A link is made only by `link()`, only for an `https:` URL, with `rel="noopener noreferrer"` and `target="_blank"`. A lint test enforces this, and the page is served with a content security policy that forbids inline script and requires trusted types.
- **The person is the only one who passes gates.** The server names the actor itself (`{ kind: "human", id: config.user }`); a request body that names an actor is refused. Every command and every read is checked against `config.role` on the server; hiding a control is never the only check.
- **Commands never advance on their own.** A command writes its entries and returns. The server then calls `engine.advance()` in the background for exactly the commands `THEN_ADVANCE` in `src/pipeline/contract.ts` marks, and for no other.
- **Reads write nothing.** A `GET` never appends an entry, never loads a registry onto the workbench chain and never recovers a case. Recovery happens once, when the first command for a case arrives.
- **One custody point for sources.** Nothing under `src/server/` or `src/web/` imports from `src/modules/connectors/`. Sources are reached only through `runPivot`, `runRoute`, `runProposal` and `revalidateCard`. `src/cli/` stays the only place that builds a `ConnectorPool`. `tests/modules/custody.test.ts` flags any `.run(`, `.estimate(` or `.estimateRequest(` call under `src/` outside `src/modules/runner.ts`: name things `perform`, `advance`, `handle`.
- **Honest outcomes on screen** (guide §2). Partial coverage is tagged and never drawn as a proven negative. A declined model, a blocked call, a failed query and an interrupted run are each shown as themselves. Proposed things are drawn dashed, accepted things solid. Colour is never the only signal: every tag has text.
- **Wording** (guide §10). Labels are a verb or noun in sentence case, one to three words; a button says what will happen ("Accept: run 4 steps"); the full text goes in the tooltip and the accessible name.
- **Times** (spec §10.2). UTC with milliseconds in provenance, the Worklog and Replay; short local time elsewhere, with the UTC time as the tooltip.
- **Accessibility** (guide §12). Everything is reachable by keyboard, focus rings are visible in the accent colour, every button and input has an accessible name, and all motion is off under `prefers-reduced-motion: reduce`.
- **Browser-shared code stays browser-safe.** `src/core/canonical.ts`, `src/core/types.ts`, `src/core/schema.ts`, `src/core/wire.ts`, everything under `src/core/state/` and everything under `src/web/` except `src/web/build.ts` import nothing from `bun:*`, `node:*`, `src/modules/`, `src/agents/`, `src/pipeline/` or `src/server/`, and use no `Bun`, `process` or `Buffer` global.
- **The fold never throws and never mutates its input.** A new entry type gets a reducer branch that validates shape and records a malformed payload in `skipped`.
- **Real hostnames and addresses never enter the repository.** Samples and tests use RFC 5737 addresses, `example.*` names and invented accounts.
- **Few dependencies.** `happy-dom` as a dev dependency is the only addition. The interface is plain TypeScript and one stylesheet.
- **TypeScript:** `strict: true`. No `any` in exported signatures.
- **Tests:** `bun test`, always under a time limit: `timeout 120 bun test <file>` while iterating, `timeout 900 bun test && timeout 300 bun run typecheck` before a commit. Every test creates its files under a fresh `mkdtempSync` directory and removes it. Every `Workbench`, server, worker and browser a test opens is closed, including on failure. Every test that drives a session asserts `session.state.skipped` is `[]` afterwards. Test output is clean. Report real RED: a task report without the failing run of its new tests, made before the implementation existed, is incomplete.
- **Commits:** one per task, on `slice-4-interface`, never pushed. End every commit message with the attribution lines your own harness reminder gives you (they name the model that wrote the code).

## What plans 1 to 3 built, that this plan must respect

Read these files before starting a task: `src/pipeline/engine.ts`, `src/core/session.ts`, `src/core/state/` (all of it), `src/core/types.ts`, `src/core/workbench.ts`, `src/cli/compose.ts`, `src/cli/run.ts`.

- **Writing entries.** Everything goes through `CaseSession.commit(build)`. Every id taken with `ids.next(kind)` must be matched by one creating entry of that kind in the same commit, or the commit throws `IdAllocationError`. A commit from inside a builder throws.
- **The engine.** `new Engine(session, deps)` writes nothing; `Engine.open(session, deps)` recovers the case first, once per open session. Commands: `start`, `pause`, `resume`, `stop`, `acceptPlan`, `denyPlan`, `replan`, `revise`, `answerChallenge`, `approve`, `reject`, `feedback`, `setModel`, `setBudget`, `setPackLimit`. `advance()` drives the run as far as it goes without a person; a second call while one is in flight returns the same promise. `resume` drives by itself. `summary()` is the read.
- **Refusals** are thrown: `RunRefused`, `PlanRefused`, `ReviseRefused`, `PublishRefused` (with `reasons: string[]`), `FeedbackRefused`. Task 0 gives them a common base, `Refused`.
- **The stream.** `session.subscribe(fn)` calls `fn(entry, stateAsOfThatEntry)` in seq order for every entry appended after the call. `session.entries(after, limit)` reads the ledger. `session.stateAt(seq)` folds to an entry. `isNext(state, entry)` says whether an entry is the one right after a state.
- **The fold holds no card or lane commands.** `card.kept`, `card.moved`, `card.discarded`, `card.restored`, `card.sent_back`, `card.pinned`, `lane.created`, `lane.renamed`, `lane.removed`, `lane.target_set` and `undo` have reducers (`src/core/state/cards.ts`) but nothing a person can call writes them yet. Task 2 adds that. The same is true of `agent.asked` and `agent.answered` (Task 11).
- **The publish rule** is `publishable(state, hash)` and `blockers(state, hash)` in `src/core/state/analysis.ts`. The interface calls them; it does not reimplement them.
- **The runner decides cost.** A person's costly query with no budget returns `{ status: "needs_budget", proposal: null, estimate }` and runs nothing but the estimate query. An agent's becomes a `costly_query` proposal that only `runProposal`, for a human actor, runs.
- **`revalidateCard`** returns `matches`, `differs`, `could_not_run` or `refused`, and records `verify.run`.
- **One writer per data directory.** `Workbench.open` holds an exclusive lock until `close()`. While the server runs, `src/cli/run.ts` is refused with `WorkbenchLockedError` on the same data directory.
- **`canonical()` refuses** `undefined`, non-finite numbers, sparse arrays and non-plain objects.
- **Scripted models are positional.** The scripted provider answers by the calling actor's id and how many requests that actor has already made in the case, so a new agent (Task 11's `assistant`) needs its own turns in `sample/scripts/sample-run.yaml`.

## Decisions this plan makes

These are the designer's, not the owner's. Each is listed again in the hand-back.

1. **Entries reach the browser unscrubbed; everything else is a view.** The owner's constraint says no secrets reach the browser and names scrubbed views for source errors. The design says the browser folds the same entries and must reach the same state. An entry cannot be both scrubbed and the same. Resolved: entries and blobs go as recorded (plans 1 to 3 already keep secret values out of both, and a server test plants a credential and looks for it in every response), and the scrub applies to everything the server derives outside the ledger: source descriptions, manifest problems, refusal and error text.
2. **One origin.** Only `127.0.0.1:<port>` is accepted as `Host`. A request to `localhost:<port>` is refused with a line naming the right address, so there is one origin to reason about.
3. **The DOM for tests is `happy-dom`,** created per test (`new Window()`), never registered globally, so the 1221 existing tests keep the runtime's own `fetch` and globals. Interface code never touches a global `document`: every view receives a `Ui` that holds the document.
4. **The browser run needs no package.** `tests/helpers/chrome.ts` starts a headless Chromium found on the machine (`WORKBENCH_CHROME`, then the Playwright cache under `~/.cache/ms-playwright`, then `chromium` or `google-chrome` on the path) with `--remote-debugging-port=0` and a host rule that resolves nothing but `127.0.0.1`, and speaks the debugging protocol over the runtime's `WebSocket`. When no browser is found the browser test is skipped with one printed line; with `WORKBENCH_REQUIRE_BROWSER=1` it fails instead, and Task 14 runs it that way. The same whole-sample run is also driven through `happy-dom` against the in-process server, so the flow is covered on a machine with no browser. The controller may additionally walk the interface by hand with its own browser tool; that is not part of the suite.
5. **Dragging uses pointer events, not HTML drag-and-drop,** so the same code is driven by a mouse, by a test and by the debugging protocol. The upper half of a card drops above it and the lower half below. The guide's middle third (link two cards) belongs to the Graph design (spec §15) and is not built.
6. **Single-key shortcuts fire only when focus is on a card, a column, a lens or the page itself;** never while focus is in a button, input, textarea, select or link (`Esc` excepted). `Enter` on a card opens it and moves focus to its first action, and `Tab` then walks the actions as usual. This keeps the guide's `Tab` = next column and still leaves every control reachable.
7. **Plan-time estimates are asked for, not automatic.** A costly plan step shows "Estimate". Pressing it prices the step through the runner (which records the estimate query, if the source needs one) and records the figure as a new entry, `step.estimated`, so the number on screen comes from the ledger. A step whose starting value comes from an earlier step cannot be priced before that step runs, and says so.
8. **Your agent is a profile stage named `agent`.** The sample profile gains it, with a persona `assistant`. It has no tools. Its model is the Assemble stage's unless the person picks another in the Agent lens (`stage.model_set` for stage `agent`). The loop gets one option, `outside_run`, so the conversation works while a run is paused or finished.
9. **Accepting a narrative proposal is an edit.** "Propose as Summary" on an answer makes a `narrative` proposal. Accepting it calls `engine.revise` with that section replaced, in the person's name, so it goes back through checks, evaluation and challenge like any edit (spec §9.5). With no draft yet, it is refused with the reason.
10. **Bundles and previews are served from the ledger's blob, not from the folder.** `published/<n>/<file>` is read out of the bundle blob the `product.published` entry names, so no request ever touches a path built from the URL.
11. **`u` (undo), `c` (cite), `Enter` (open) and `x` (discard) also work on a lane card.** The guide lists `U` under Incoming and `C` under Notes; the slice has no Notes lens, Cite is a card action, and a kept card must be reachable by the same keys as one in Incoming.
12. **Your agent's answers arrive whole.** The guide says answers stream in. The ledger records whole responses and the screen shows what the ledger holds, so an answer appears when its entry does; the turn reads `thinking…` until then.

## Carried items, and where they land

| From | Item | Lands in |
|---|---|---|
| Plan 3 ledger, items (a) to (i) | The nine close-out rulings | Task 0 |
| Plan 2 ledger | Local `sql` and `files` queries ignore `timeout_ms` and block the thread | Task 0 |
| Plan 2 ledger | A blob-to-rows reader per connector, for the row-level difference | Task 13 |
| Plan 2 final review, finding 1 | The `http` connector must refuse the server's own port | Task 1 |
| Plan 1 ledger (Task 5 ruling) | Show `CaseState.skipped` as a warning in the brief | Task 6 |
| Plan 1 final review | Intermediate review stages still read `passed` after a send-back | Task 6 (phase strip) |
| Plan 3 final review, finding 13 | A model request or tool call left open by a stopped process shows as pending | Task 9 |
| Plan 3 final review | Budgets are given at plan acceptance with no estimate shown | Task 8 |
| Plan 3 ledger (Task 10 minor) | `answer_challenge` can close a challenge from an earlier run | Task 2 |
| Plan 3 final review | No security notes say that check programs are not filesystem-sandboxed | Task 14 |
| Plan 3 ledger (Task 0, 8, 9, 12 minors) | `runQuery`'s `accept` unchecked against the proposal; reused proposal keeps its old step id; done-ness by job title; carry-over drops a twice-cited card | Not in this plan: none is reachable from the interface in a way that fails open. Listed in the hand-back for plan 5's close-out. |

## File Structure

```
src/core/refused.ts            Refused, the base of every refusal
src/core/wire.ts               the types that cross between server and browser besides entries (browser-safe)
src/core/state/cites.ts        CARD_REF and cardRefs, shared with the browser
src/pipeline/contract.ts       the engine's contract for a server: EngineCommand, THEN_ADVANCE
src/modules/connectors/
  local-worker.ts              the worker: owns the SQLite handle, runs one query at a time
  local-host.ts                LocalQueryHost: posts a request, enforces timeout_ms by ending the worker
  rows.ts                      rowsOfBlob: stored result bytes back into columns and rows
src/server/
  guard.ts                     Host and Origin check, security headers
  roles.ts                     what each role may read and do
  hub.ts                       CaseHub: sessions, engines, background drives
  views.ts                     reference data as the browser may see it; scrubbed text
  stream.ts                    the entry stream (server-sent events)
  commands.ts                  the command table, argument checks, refusal mapping
  triage.ts                    card, lane and undo commands
  evidence.ts                  blobs, bundles, the bundle preview, the custody report
  plan-commands.ts             estimate a step; run or reject a costly proposal
  draft-commands.ts            accept a narrative proposal
  seek.ts                      routes for the Pivot panel, run a route or a lookup, verify a card
  converse.ts                  your agent
  app.ts                       createApp, startServer
src/cli/serve.ts               the command that starts the server
src/web/
  build.ts                     bundles the interface (server side only)
  main.ts  app.ts              boot; screens and the route in the address
  dom.ts  ui.ts  api.ts  store.ts  prefs.ts  time.ts  chips.ts
  derive.ts  describe.ts  stagerecord.ts  replay.ts  trail.ts  markdown.ts      pure functions of state and entries
  keys.ts  commands.ts  drag.ts  motion.ts
  views/   home.ts pick.ts newcase.ts trail.ts topbar.ts workarea.ts incoming.ts brief.ts lanes.ts
           card.ts toasts.ts help.ts shelf.ts
  lenses/  index.ts steps.ts timeline.ts worklog.ts discarded.ts jobs.ts pipeline.ts narrative.ts
           agent.ts replay.ts
  panels/  pivot.ts verify.ts
  style.css
sample/context/personas/assistant.md   sample/context/profile.yaml (stage `agent`)   sample/scripts/sample-run.yaml (assistant turns)
docs/security-notes.md
tests/server/  tests/web/  tests/helpers/served.ts  tests/helpers/dom.ts  tests/helpers/chrome.ts
```

## Review Focus

1. **Hostile text from a source on screen.** A card title, a cell, a query error or a model's answer holding `<img src=x onerror=...>`, `javascript:` and `http:` URLs, right-to-left and control characters, or a 4,096-character cell. It is shown as text, no link is made unless it is `https:`, and the layout holds. (Tasks 4, 6)
2. **A stream that drops, repeats or jumps.** The laptop sleeps, the tab is in the background, the server restarts mid-run. The store notices an entry that is not the next one, reads again from its own head, and ends in the server's state; after a restart the run shows as interrupted with a Resume button, not as running for ever. (Tasks 1, 4, 6)
3. **The same command twice.** A double-click on Approve or Accept, or a keep from a second tab that is behind. The second gets a plain refusal as a toast; no entry is written twice; nothing crashes. (Tasks 2, 6)
4. **A request the page did not make.** Another site's page or another local program calls the server: a wrong `Host` (DNS rebinding), a cross-origin `POST` as `text/plain`, a `POST` with no `Origin`, a blob or bundle path with `..`, `%2f`, an upper-case hash or a huge number. Each is refused and writes nothing. (Tasks 1, 3)
5. **A long case.** Five thousand entries and five hundred cards in Incoming. Stepping in Replay and rendering live stay within a time bound, because the store keeps snapshots and lists are patched by key instead of rebuilt. (Tasks 4, 6, 12)

---

### Task 0: Close out plan 3, and move local queries off the server's thread

**Run this task first.** The plan 3 ledger carries nine rulings, (a) to (i), to this task, and the plan 2 ledger carries one deadline: local queries must not be able to block the server.

**Files:**
- Create: `src/core/refused.ts`, `src/pipeline/contract.ts`, `src/modules/connectors/local-worker.ts`, `src/modules/connectors/local-host.ts`
- Modify: `src/pipeline/revise.ts`, `src/pipeline/stages/checks.ts`, `src/pipeline/manifests.ts`, `src/pipeline/engine.ts`, `src/pipeline/stages/assemble.ts`, `src/pipeline/stages/research.ts`, `src/pipeline/plans.ts`, `src/pipeline/publish.ts`, `src/pipeline/feedback.ts`, `src/agents/tools/kit.ts`, `src/agents/draft.ts`, `sample/checks/06-assumptions-and-judgments.ts`, `src/core/verify.ts`, `src/cli/verify.ts`, `src/modules/connectors/sqlite.ts`, `src/modules/connectors/files.ts`
- Test: `tests/pipeline/revise.test.ts`, `tests/pipeline/checks.test.ts`, `tests/pipeline/engine.test.ts`, `tests/pipeline/stages-analysis.test.ts`, `tests/pipeline/stages-front.test.ts`, `tests/agents/tools-scrub.test.ts`, `tests/agents/draft.test.ts`, `tests/sample/form-checks.test.ts`, `tests/core/verify.test.ts`, `tests/pipeline/contract.test.ts` (new), `tests/modules/connector-sqlite.test.ts`, `tests/modules/connector-files.test.ts`

**Interfaces:**
- Consumes: everything named in the files above.
- Produces:
  - `export class Refused extends Error { readonly reasons: string[]; constructor(message: string, reasons?: string[]) }` in `src/core/refused.ts` (`reasons` defaults to `[message]`). `RunRefused`, `PlanRefused`, `ReviseRefused`, `PublishRefused` and `FeedbackRefused` extend it and keep their names and constructors.
  - `src/pipeline/contract.ts`: `export type EngineCommand = "start" | "pause" | "resume" | "stop" | "acceptPlan" | "denyPlan" | "replan" | "revise" | "answerChallenge" | "approve" | "reject" | "feedback" | "setModel" | "setBudget" | "setPackLimit"` and `export const THEN_ADVANCE: Readonly<Record<EngineCommand, boolean>>`.
  - `verifyPublished(caseDir: string): PublishedReport` and `verifyCase(caseDir): VerifyReport & { published: PublishedReport }` in `src/core/verify.ts`.
  - `class LocalQueryHost { constructor(spec: LocalSpec); query(req: QueryRequest): Promise<QueryOutcome>; close(): void }` in `src/modules/connectors/local-host.ts`. `SqliteConnector` and `FilesConnector` keep their public shape.

**The nine rulings, as the ledger states them:**

- **(a) A person's edit takes the previous draft's marking as a floor.** In `reviseDraft`, before the hash is computed: `product.marking` becomes `strictest(product.marking, latest.product.marking)` when there is a latest draft. The returned `Draft` shows the marking that was recorded.
- **(b) A check that cannot be loaded stalls the run; it does not send back to Assemble.** `checksRunner` returns `{ kind: "stalled", reason: "Checks cannot run: check <id> could not be loaded: <problem>" }` (the first broken check, then ` and N more`) before running anything, and writes no `check.run`. In `loadChecks`, a manifest the registry refused is recognised by its parsed kind: `parseManifestFile(path, bytes).kind === "check"`, with its id from the parsed body; the `kind: check` text match goes. A refused file in a trusted root that cannot be parsed at all counts as a broken check when its folder holds any other check manifest (loaded or broken), so an unreadable check cannot drop out silently.
- **(c) A stage that finishes after a person stopped the run writes nothing.** In `Engine.exec`, the commit that records the stage's end returns `[]` when the state it is given has `run.id !== ` the run the stage started in, or `run.status === "finished"`; `exec` then returns `false`. The commits in `assemble.ts` that write `draft.revised` and `assessment.made` do the same check inside their builders.
- **(d) Model-written text given to a researcher as its task carries the marking of the request that produced it.** In `research.ts`, the sent-back question (`research.requested`) and the planner's sub-goal title and question leave the `task` string and become a pack part made with `packPart({ kind: "question", id, title: "The question", text, fixed: false, entries, written_by, floor: null })`, passed in `extras`. `written_by` is the `research.requested` entry for a sent-back question, and `requestsOfPass(entries, lastPass(session, <plan stage>).entry)` for a sub-goal. The task says `Answer the question in the part titled "The question".` and, for a sub-goal, still lists the accepted steps.
- **(e) The URL pattern in `scrub` is linear.** `URL_RE` becomes `/(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/\S+/gi`, so a match can start only at the start of a scheme.
- **(f) Only lower-case card ids are citations.** `CARD_REF` becomes `/(?<![\w])c\d+(?![\w])/g` (no `i` flag). `c2`, `[c2]`, `[c1, c2]` and `[Card c2]` cite; `C2 traffic` does not. Check 6 spells the same pattern, and the existing test that holds the two together still passes.
- **(g) A case too strict for a stage's model says so.** In `Engine.exec`, on `blocked`: when the case's own marking may not go to the stage's model (`!mayGo(state.meta.marking, provider.where, config.marking_policy)`) or is above the stage's pack limit (`tooStrict(state.meta.marking, pack_limits[stage])`), the pause reason is `<Title>: this case is marked <M>, which this stage's model may not receive. Choose a model that may receive <M> and resume.` Otherwise the existing text stays.
- **(h) `verify` checks published folders.** `verifyPublished` reads the ledger's `product.published` entries and, for each, compares `published/<n>/` with the bundle blob the entry names. `bun run src/cli/verify.ts <case-dir>` prints one line per bundle that is not `ok` and one per unrecorded folder, and exits 1 when there is any.
- **(i) The engine's contract for a server is written down in one place.** `src/pipeline/contract.ts` opens with a comment that says: commands write entries and never advance the run; the server calls `advance()` after the commands `THEN_ADVANCE` marks; `summary()` is the read and writes nothing; `session.subscribe` is the entry stream; every refusal is a `Refused`. `THEN_ADVANCE` is: `start`, `acceptPlan`, `replan`, `revise`, `approve`, `reject` true; all others false (`resume` drives by itself; `denyPlan` and `stop` end the run; `answerChallenge` leaves a paused run paused).

```ts
// src/core/verify.ts
export interface PublishedReport {
  ok: boolean;
  /** One per product.published entry, in order. "missing": no folder (the bundle is still in the blob). "differs": a file or the manifest is not what the blob holds. "bad_head": the head the manifest names is not an entry of this ledger. "bad_blob": the bundle blob is missing, corrupt or unreadable. */
  bundles: { n: number; seq: number; state: "ok" | "missing" | "differs" | "bad_head" | "bad_blob"; detail: string }[];
  /** Folders under published/ that no entry records (names starting ".tmp-" are leftovers and are listed too). */
  unrecorded: string[];
}
```

A bundle is `ok` when the folder holds exactly `manifest.json` and the files the manifest lists; each file's bytes hash to the manifest's `sha256`; `manifest.json` equals the canonical manifest in the blob; the SHA-256 of `product.json` equals the entry's `draft_hash`; and the entry at `manifest.head.seq` has hash `manifest.head.hash`, which equals the entry's `head_hash`. `src/core/` does not import `src/pipeline/`: declare the manifest's shape locally.

**The worker.** `SqliteConnector.run` and `FilesConnector.run` no longer touch a database on the calling thread. Each connector owns a `LocalQueryHost`, created on first use.

```ts
// src/modules/connectors/local-host.ts
export type LocalSpec =
  | { kind: "sql"; path: string }                                   // resolved and checked to be inside the root by the connector
  | { kind: "files"; files: { table: TableManifest; path: string; file: string }[] };
```

- `local-worker.ts` is the worker's entry. It receives `{ id, spec, req }`, opens the database itself (read-only for `sql`; for `files`, the in-memory database built as `FilesConnector.refresh` builds it today, rebuilt when a file's size or modified time changes), calls `runOnDatabase(db, req)` and posts `{ id, outcome, notes }` or `{ id, error, connector: boolean }`. `raw` is transferred, not copied.
- `LocalQueryHost.query` posts one request and waits. A reply with `error` is rethrown as `ConnectorError` when `connector` is true, else as `Error`. After `req.timeout_ms` with no reply it ends the worker (`worker.terminate()`), drops it so the next query starts a new one, and resolves with `{ columns: [], rows: [], raw: <the bytes of {"columns":[],"rows":[]}>, media: "application/json", cost: null, coverage: { kind: "partial", reason: "timeout", detail: "no complete result within <timeout_ms> ms" } }`, the same shape the `http` and `trino` connectors give. Queries on one host run one at a time, in order.
- The worker is started with `new Worker(new URL("./local-worker.ts", import.meta.url).href)` and `unref()`ed. `close()` terminates it.
- `render`, `estimate`, `estimateRequest` and `readEstimate` stay on the calling thread and are unchanged. The path checks (`staysInside`, file exists, size limit) stay in the connector, before anything is posted.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/revise.test.ts
test("a person's edit cannot lower the marking below the previous draft's", () => {
  // latest draft is TLP:AMBER; the edit asks for TLP:CLEAR and changes the summary
  const d = reviseDraft(session, pipeline, { product: { ...latest.product, marking: "TLP:CLEAR", summary: "edited" }, reason: "tidy", actor: human });
  expect(d.product.marking).toBe("TLP:AMBER");
  expect(d.hash).toBe(sha256Hex(canonical(d.product as unknown as Json)));
});

// tests/pipeline/checks.test.ts
test("a check that cannot be loaded stalls the stage and records no check run", async () => {
  // a trusted root with one good check and one whose script file is missing
  const end = await checksRunner(env);
  expect(end).toEqual({ kind: "stalled", reason: "Checks cannot run: check c-missing could not be loaded: script \"gone.ts\" is missing" });
  expect(session.entries().some((e) => e.type === "check.run")).toBe(false);
});
test("a refused check manifest is recognised by its parsed kind", () => {
  // manifest text: `{ "kind": "check", "id": "dup" }` written as flow YAML on one line, with an id another root already took
  expect(loadChecks(registry).broken.map((b) => b.id)).toContain("dup");
});
test("an unparseable file beside a check manifest counts as a broken check", ...);

// tests/pipeline/engine.test.ts
test("a stage that ends after the person stopped the run writes nothing", async () => {
  // the frame runner calls engine.stop(human, "enough") and then returns { kind: "finished", outcome: "pass", ... }
  await engine.advance();
  const after = session.entries().filter((e) => e.seq > stopSeq).map((e) => e.type);
  expect(after).toEqual([]);
});
test("a case too strict for the stage's model says the case is the problem", async () => {
  // case TLP:RED, policy lets RED go to "machine" only, the stage's model is on "network"
  expect(session.state.run.pause_reason).toBe("Frame: this case is marked TLP:RED, which this stage's model may not receive. Choose a model that may receive TLP:RED and resume.");
});

// tests/pipeline/stages-analysis.test.ts
test("Assemble writes no draft after the run was stopped while its model was answering", ...);   // no draft.revised and no assessment.made after run.finished

// tests/pipeline/stages-front.test.ts
test("a researcher's question from a model that saw TLP:RED is a TLP:RED pack part, not task text", async () => {
  // the planner's model.request was recorded with marking TLP:RED; Research's model is on "network", which may not receive RED
  expect(session.entries().some((e) => e.type === "model.blocked" && e.payload.marking === "TLP:RED")).toBe(true);
  expect(taskTextOfLastResearchRequest()).not.toContain(subgoal.question);
});

// tests/agents/tools-scrub.test.ts
test("scrub is linear on a long token with no URL in it", () => {
  const t0 = performance.now();
  scrub(registry, "a".repeat(200_000));
  expect(performance.now() - t0).toBeLessThan(500);
});
test("a URL is still hidden", () => expect(scrub(registry, "see https://example.net/x now")).toBe("see [hidden] now"));

// tests/agents/draft.test.ts
test("only lower-case card ids are citations", () => {
  expect(cardRefs("C2 traffic to c3, [c1, c2] and [Card c4]; C5.")).toEqual(["c3", "c1", "c2", "c4"]);
});

// tests/core/verify.test.ts  (published bundles: build a case with one product.published entry and its folder by hand)
test("an untouched published folder is ok", () => expect(verifyPublished(dir)).toEqual({ ok: true, bundles: [{ n: 1, seq, state: "ok", detail: "" }], unrecorded: [] }));
test("an edited product.md is reported as differs", ...);          // state "differs", detail names product.md
test("a product.json that is not the draft's is reported as differs", ...);
test("a deleted folder is reported as missing", ...);
test("a manifest head that is not an entry is reported as bad_head", ...);
test("a folder no entry records is listed as unrecorded", ...);    // published/7 and published/.tmp-2-abc
test("verifyCase is not ok when a bundle differs, and the command exits 1", ...);

// tests/pipeline/contract.test.ts
test("every refusal is a Refused", () => {
  for (const C of [RunRefused, PlanRefused, ReviseRefused, FeedbackRefused]) expect(new C("no")).toBeInstanceOf(Refused);
  expect(new PublishRefused(["a", "b"]).reasons).toEqual(["a", "b"]);
  expect(new RunRefused("no").reasons).toEqual(["no"]);
});
test("THEN_ADVANCE names every engine command, and no command advances the run itself", async () => {
  expect(Object.keys(THEN_ADVANCE).sort()).toEqual(["acceptPlan", "answerChallenge", "approve", "denyPlan", "feedback", "pause", "reject", "replan", "resume", "revise", "setBudget", "setModel", "setPackLimit", "start", "stop"]);
  // on the sample: engine.start(human) leaves run.current null and no stage.started until advance() is called
});

// tests/modules/connector-sqlite.test.ts
test("a query that never ends is stopped at timeout_ms and does not block the thread", async () => {
  let ticks = 0;
  const timer = setInterval(() => { ticks++; }, 20);
  const out = await connector.run({ text: "with recursive n(x) as (select 1 union all select x + 1 from n) select count(*) as c from n", bound: {}, window: { from: null, to: null }, max_rows: 10, timeout_ms: 300, budget: null });
  clearInterval(timer);
  expect(out.coverage).toEqual({ kind: "partial", reason: "timeout", detail: "no complete result within 300 ms" });
  expect(out.rows).toEqual([]);
  expect(ticks).toBeGreaterThan(5);
});
test("the next query on the same connector runs in a new worker", ...);   // full coverage, the expected rows
test("a write is still refused, as a ConnectorError", ...);
// tests/modules/connector-files.test.ts: the same never-ending query over a files source; and a changed file is re-read
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/pipeline tests/agents/tools-scrub.test.ts tests/agents/draft.test.ts tests/core/verify.test.ts tests/modules/connector-sqlite.test.ts tests/modules/connector-files.test.ts`
Expected: the new tests FAIL (`Refused` and `THEN_ADVANCE` not found; the never-ending query hangs until the test's own timeout; the others on their assertions).

- [ ] **Step 3: Make the nine changes and build the worker**, as specified above. Existing tests that asserted the old behaviour of (b) (a broken check fails the stage and sends back) and of (f) (upper-case ids cite) are updated to the ruling, and the report lists each one changed.

- [ ] **Step 4: Run everything**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS, including `tests/sample/full-run.test.ts` (the sample still publishes with eleven checks passing) and `tests/modules/custody.test.ts`.

- [ ] **Step 5: Commit**

```bash
git add -A src tests sample
git commit -m "fix(pipeline): close out plan 3; local queries run in a worker and stop at their timeout"
```

---

### Task 1: The server: loopback, the request guard, roles, cases and the entry stream

**Files:**
- Create: `src/core/wire.ts`, `src/server/guard.ts`, `src/server/roles.ts`, `src/server/hub.ts`, `src/server/views.ts`, `src/server/stream.ts`, `src/server/app.ts`, `tests/helpers/served.ts`
- Modify: `src/modules/connectors/types.ts`, `src/modules/connectors/http.ts`, `src/cli/compose.ts`
- Test: `tests/server/guard.test.ts`, `tests/server/reads.test.ts`, `tests/server/stream.test.ts`, `tests/modules/connector-http.test.ts`

**Interfaces:**
- Consumes: `Workbench`, `CaseSession`, `Engine`, `EngineDeps`, `compose`, `Config`, `scrub` (`src/agents/tools/kit.ts`), `mayGo` (`src/agents/pack.ts`).
- Produces:

```ts
// src/server/app.ts
export interface Assets { html: string; js: string; css: string }      // Task 4 builds the real ones
export interface AppOptions {
  config: Config; wb: Workbench; deps: EngineDeps; problems: string[]; assets: Assets;
  origin: string;                                                         // "http://127.0.0.1:<port>"
  onError?: (error: unknown) => void;
}
export interface App { readonly hub: CaseHub; handle(req: Request): Promise<Response>; close(): Promise<void> }
export function createApp(opts: AppOptions): App;
export interface Running { port: number; origin: string; app: App; stop(): Promise<void> }
/** Binds 127.0.0.1 only. Port 0 picks a free one. */
export function startServer(opts: Omit<AppOptions, "origin">, port: number): Running;

// src/server/guard.ts
/** Null when the request may go on; otherwise the refusal. */
export function refusal(req: Request, origin: string): Response | null;
export function secure(res: Response, kind: "page" | "api" | "download"): Response;

// src/server/roles.ts
export type Role = Config["role"];
export type Reading = "page" | "me" | "cases" | "reference" | "entries" | "models" | "custody" | "blob" | "bundle" | "preview" | "routes";
export function mayRead(role: Role, what: Reading): boolean;
export function mayDo(role: Role, command: string): boolean;

// src/server/hub.ts
export class CaseHub {
  constructor(wb: Workbench, deps: EngineDeps, onError: (error: unknown) => void);
  /** For reads: the session, with no engine and no recovery. Throws CaseNotFoundError. */
  read(id: string): CaseSession;
  /** For commands: the case's one engine, made with Engine.open on first use. */
  engine(id: string): Engine;
  create(input: NewCase, actor: Actor): CaseSession;
  /** Calls engine.advance() without waiting; a failure goes to onError. */
  drive(id: string): void;
  /** Tracks other work that goes on after a response (a resume, a model turn, a route); a failure goes to onError. */
  background(work: Promise<unknown>): void;
  /** Resolves when no drive and no background work is in flight. Tests wait on it. */
  idle(): Promise<void>;
}

// src/core/wire.ts — what crosses between server and browser besides entries. Types only, browser-safe; the server and src/web/ both import from here.
export interface Me { user: string; role: "analyst" | "requester" | "leader"; origin: string; markings: Marking[]; policy: Record<Marking, Where[]>; problems: string[] }
export interface CaseSummaryView { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }
export interface NewCaseInput { title: string; asked: string; why: string; starting: Observable[]; window: TimeWindow; objective: string | null; marking: Marking }
export interface SourceView { id: string; title: string; connector: string; marking: Marking; where: Where; confirmed: boolean; adhoc: boolean; cost: { weight: number; unit: string }; quality: string }
export interface PivotView { id: string; title: string; from: string; to: string; source: string; free: boolean; weight: number; needs_window: boolean; empty_means: EmptyMeans }
export interface Reference {
  types: { id: string; title: string }[]; sources: SourceView[]; pivots: PivotView[];
  objectives: { id: string; title: string; measures: { id: string; kind: "mop" | "moe"; title: string }[] }[];
  phases: { id: string; title: string }[]; profile: { id: string; title: string };
}
export interface ModelView { provider: string; model: string; where: Where; efforts: string[]; context: number | null; allowed: boolean; reason: string | null }

// src/server/views.ts
export function referenceOf(deps: EngineDeps): Reference;
/** Every model every provider lists, each marked allowed or not for this marking under the policy. A provider that cannot list is left out. */
export function modelsFor(deps: EngineDeps, marking: Marking): Promise<ModelView[]>;
/** Text that came from a source, a manifest or an exception, safe to send. */
export function shown(deps: EngineDeps, text: string): string;

// tests/helpers/served.ts
export interface Served {
  dir: string; app: App; origin: string; config: Config; wb: Workbench;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  newCase(over?: Partial<NewCase>): Promise<string>;                      // the sample question; returns the case id
  entries(id: string): Entry[];
  close(): Promise<void>;
}
/** The sample as a trusted root, a workbench, compose and an app, all in process; requests go straight to app.handle with the right Host and Origin. */
export function served(opts?: { role?: Role; listen?: boolean; credential?: { name: string; value: string } }): Promise<Served>;
```

**Routes this task serves** (all `GET`; every other path is 404 and every other method 405, until later tasks add them):

| Path | Returns |
|---|---|
| `/` | `assets.html` |
| `/app.js`, `/app.css` | the bundle |
| `/api/me` | `{ user, role, origin, markings: MARKINGS, policy: config.marking_policy, problems: string[] }`, each problem through `shown` |
| `/api/cases` | `wb.listCases()` |
| `/api/reference` | `referenceOf(deps)` |
| `/api/cases/<id>/models` | `modelsFor(deps, <the case's marking>)` |
| `/api/cases/<id>/entries` | the entry stream |

Until Task 4 builds the interface, `served()` passes placeholder assets: `{ html: "<!doctype html><title>Workbench</title>", js: "", css: "" }`.

`POST /api/cases` creates a case (body: `NewCase`), returns `{ id }`, and is the one write in this task. It refuses a body that names an `actor`, an unknown marking, a starting value that is not of its type (`deps.runner.observables.matches`), an unknown objective, and a window that is not two UTC millisecond timestamps in order; each with status 400 and `{ ok: false, refused: [reason] }`.

**The guard** (`refusal`), in this order:

1. `Host` is not exactly `new URL(origin).host` → 421, body `This workbench answers only at <origin>.`
2. `Origin` present and not `origin` → 403.
3. `Sec-Fetch-Site` present and not `same-origin` or `none` → 403.
4. Method not `GET` or `POST` → 405.
5. `POST` without `Origin`, or whose `Content-Type` does not start with `application/json` → 403.
6. A body longer than 1,048,576 bytes (by `Content-Length`, and again when read) → 413.

`secure` sets on every response: `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Cross-Origin-Resource-Policy: same-origin`. For `page` it adds `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'`. No response ever carries an `Access-Control-Allow-*` header.

**Roles.** `analyst` may read everything and do every command. `requester` and `leader` may read `page` and `me` only, and do nothing, in this slice. A refused read or command is 403 with `{ ok: false, refused: ["the <role> view may not <read|do> <what>"] }`. The check sits in one place in `app.ts`, before the handler, for reads and commands alike.

**The stream** (`GET /api/cases/<id>/entries`, optional `?after=<seq>`; a `Last-Event-ID` header wins over the query when both are present). Response `Content-Type: text/event-stream`. The handler subscribes to the session first and holds what arrives, then sends every entry after `after` from `session.entries(after)`, then releases the held entries and goes on live, sending each seq once and in order. Each entry is one event: `id: <seq>`, `data: <canonical JSON of the entry>`. A comment line (`: keep`) goes out every 15 seconds. When the request is aborted the subscription is removed. `after` that is not a non-negative integer is 400. `Bun.serve` is started with `idleTimeout: 0` so a quiet stream is not cut.

**The server's own port is not a source.** `ConnectorContext` gains `refuse_hosts?: () => readonly string[]`. `HttpConnector` refuses, with `ConnectorError("this source points at the workbench's own server")`, a location whose `host` is in that list, at construction and again before each request. `compose(config, wb, opts?: { refuse_hosts?: () => readonly string[] })` passes it to the pool; Task 14's `serve` gives it the server's host.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/guard.test.ts  (s = await served())
test("a request with another Host is refused before anything else", async () => {
  const res = await s.app.handle(new Request(`${s.origin}/api/cases`, { headers: { host: "evil.example:4747" } }));
  expect(res.status).toBe(421);
  expect(await res.text()).toBe(`This workbench answers only at ${s.origin}.`);
});
test("localhost is not the server's origin", ...);                       // host "localhost:<port>" → 421
test("a GET from another origin is refused", ...);                       // origin "https://example.net" → 403
test("a POST with no Origin is refused and writes nothing", async () => {
  const before = s.wb.listCases().length;
  const res = await s.app.handle(new Request(`${s.origin}/api/cases`, { method: "POST", headers: { host: new URL(s.origin).host, "content-type": "application/json" }, body: "{}" }));
  expect(res.status).toBe(403);
  expect(s.wb.listCases().length).toBe(before);
});
test("a cross-site form post (text/plain) is refused", ...);            // right Origin missing, content-type text/plain → 403
test("Sec-Fetch-Site: cross-site is refused", ...);
test("PUT and DELETE are 405", ...);
test("a body over 1 MiB is 413", ...);
test("every response carries nosniff, no-store and no CORS header; the page carries the content security policy", ...);
test("the requester view may read the page and nothing else", async () => {
  const r = await served({ role: "requester" });
  expect((await r.get("/")).status).toBe(200);
  expect((await r.get("/api/cases")).status).toBe(403);
  expect(await (await r.get("/api/cases")).json()).toEqual({ ok: false, refused: ["the requester view may not read cases"] });
  expect((await r.post("/api/cases", sampleCase)).status).toBe(403);
});
test("the server listens on 127.0.0.1 only", async () => {
  const s = await served({ listen: true });
  expect(new URL(s.origin).hostname).toBe("127.0.0.1");
  expect((await fetch(`${s.origin}/api/me`)).status).toBe(200);          // the runtime's fetch sets Host itself
});

// tests/server/reads.test.ts
test("a source is described without where it is or how to sign in", async () => {
  const s = await served({ credential: { name: "SAMPLE_PLANTED_SECRET", value: "planted-secret-value-91d7" } });
  const text = await (await s.get("/api/reference")).text();
  for (const banned of ["planted-secret-value-91d7", "SAMPLE_PLANTED_SECRET", "127.0.0.1:", s.dir, "flows.sqlite"]) expect(text).not.toContain(banned);
  expect(Object.keys(JSON.parse(text).sources[0]).sort()).toEqual(["adhoc", "confirmed", "connector", "cost", "id", "marking", "quality", "title", "where"]);
});
test("manifest problems are scrubbed before they are sent", ...);       // a broken source manifest whose error names its path → /api/me problems hold "[hidden]"
test("models are marked allowed or not for the case's marking", async () => {
  // a second model manifest with where: hosted; the case is TLP:RED
  expect(views.find((m) => m.where === "hosted")).toMatchObject({ allowed: false, reason: "TLP:RED may not go to a hosted model" });
  expect(views.find((m) => m.where === "machine")).toMatchObject({ allowed: true, reason: null });
});
test("creating a case writes case.created in the person's name and nothing else", ...);   // actor { kind: "human", id: config.user }
test("a body that names an actor is refused", ...);                     // 400, refused: ["the server names the actor"]
test("a starting value that is not of its type is refused", ...);
test("reads write nothing: the case head and the workbench chain head are unchanged after every GET", ...);
test("an unknown case is 404", ...);
test("the http connector refuses a source that points at the server", ...);   // tests/modules/connector-http.test.ts

// tests/server/stream.test.ts
/** Reads events from a streaming response until `n` have arrived. */
async function take(res: Response, n: number): Promise<{ id: number; entry: Entry }[]> { ... }
test("the stream replays from the start, then goes on live, in order and without repeats", async () => {
  const id = await s.newCase();
  const res = await s.get(`/api/cases/${id}/entries`);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const session = s.app.hub.read(id);
  session.commit(() => [{ type: "lane.target_set", actor: human, payload: { lane: "l1" } }]);   // any second entry
  const got = await take(res, 2);
  expect(got.map((g) => g.id)).toEqual([1, 2]);
  expect(got.map((g) => g.entry)).toEqual(s.entries(id));
});
test("after=N and Last-Event-ID start after that entry", ...);
test("an entry appended while the backlog is being sent is delivered once", ...);   // 300 entries in the ledger, commits racing the read
test("the bytes of each event are the canonical JSON of the entry", ...);   // sha256 over prev_hash and the fields reproduces entry.hash
test("closing the response removes the subscription", ...);
test("after=abc is 400", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 120 bun test tests/server`
Expected: FAIL, `Cannot find module "../../src/server/app"`.

- [ ] **Step 3: Implement the files above.** `app.ts` is one `handle` function: guard, then a small route table (method, a path pattern, the `Reading` or command it needs, the handler), then the role check, then the handler; an unexpected exception becomes 500 with `{ ok: false, refused: ["the server failed: " + shown(firstLine)] }` and goes to `onError`. `CaseNotFoundError` is 404.

- [ ] **Step 4: Run the tests**

Run: `timeout 120 bun test tests/server tests/modules/connector-http.test.ts && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server src/modules/connectors/types.ts src/modules/connectors/http.ts src/cli/compose.ts tests/server tests/helpers/served.ts tests/modules/connector-http.test.ts
git commit -m "feat(server): loopback server with a Host and Origin guard, roles, reference views and the entry stream"
```

---

### Task 2: Commands: the run and its gates, triage, settings

**Files:**
- Create: `src/server/commands.ts`, `src/server/triage.ts`
- Modify: `src/core/wire.ts`, `src/server/app.ts`, `src/server/hub.ts`, `tests/helpers/served.ts`
- Test: `tests/server/commands.test.ts`, `tests/server/triage.test.ts`

**Interfaces:**
- Consumes: Task 0's `Refused` and `THEN_ADVANCE`; Task 1's `App`, `CaseHub`, `mayDo`, `shown`, `modelsFor`.
- Produces:

```ts
// src/server/commands.ts
export interface CommandContext { hub: CaseHub; case: string; session: CaseSession; engine: Engine; deps: EngineDeps; actor: Extract<Actor, { kind: "human" }> }
export interface CommandDef {
  /** JSON Schema (src/core/schema.ts) for the args object; additionalProperties is always false. */
  args: Schema;
  /** Whether the server calls engine.advance() in the background once perform has returned. */
  then: "advance" | "nothing";
  perform(ctx: CommandContext, args: Record<string, Json>): void | Promise<void>;
}
export const COMMANDS: Record<string, CommandDef>;
/** Later tasks add their commands here, in their own files, and import those files from app.ts. A name defined twice throws. */
export function defineCommand(name: string, def: CommandDef): void;
// CommandResult is declared in src/core/wire.ts: export type CommandResult = { ok: true; seq: number } | { ok: false; refused: string[] };
export class SettingRefused extends Refused {}

// src/server/triage.ts
export class TriageRefused extends Refused {}
export function keepCard(session: CaseSession, actor: Actor, input: { card: string; lane?: string; index?: number | null }): void;
export function moveCard(session: CaseSession, actor: Actor, input: { card: string; lane: string; index: number }): void;
export function discardCard(session: CaseSession, actor: Actor, card: string): void;
export function restoreCard(session: CaseSession, actor: Actor, card: string): void;
export function sendBackCard(session: CaseSession, actor: Actor, card: string): void;
export function pinCard(session: CaseSession, actor: Actor, card: string, pinned: boolean): void;
export function addLane(session: CaseSession, actor: Actor, title: string): string;
export function renameLane(session: CaseSession, actor: Actor, lane: string, title: string): void;
export function removeLane(session: CaseSession, actor: Actor, lane: string): void;
export function setTarget(session: CaseSession, actor: Actor, lane: string): void;
export function undo(session: CaseSession, actor: Actor, target?: number): void;

// tests/helpers/served.ts gains
command(id: string, name: string, args?: Record<string, unknown>): Promise<{ status: number; body: CommandResult }>;
toPlanGate(id: string): Promise<void>;        // start_run, then hub.idle()
toPublishGate(id: string): Promise<void>;     // toPlanGate, accept_plan { budgets: { s3: 1 } }, then hub.idle()
```

**The endpoint.** `POST /api/cases/<id>/commands` with body `{ "command": "<name>", "args": { ... } }`.

1. An unknown command name, a body that is not that shape, a body with an `actor` key anywhere at its top level or in `args`, or `args` that fail the command's schema → 400, `{ ok: false, refused: [<what is wrong>] }`, nothing written.
2. `mayDo(config.role, name)` false → 403.
3. The context is built with `hub.engine(id)` (so the case is recovered on its first command) and `actor = { kind: "human", id: config.user }`.
4. `perform` runs. A thrown `Refused` → 409 with `{ ok: false, refused: err.reasons.map(shown) }`. Anything else is the app's 500.
5. On success: when `then` is `"advance"`, `hub.drive(id)`; respond 200 `{ ok: true, seq: session.head().seq }` without waiting for the drive.

**The commands of this task.** `then` is `advance` exactly where `THEN_ADVANCE` is true for the engine command called.

| Command | Args | Calls | Then |
|---|---|---|---|
| `start_run` | none | `engine.start(actor)` | advance |
| `pause` | none | `engine.pause(actor)` | nothing |
| `resume` | none | `engine.resume(actor)`, not awaited; its promise goes to `hub.background` | nothing |
| `stop` | `reason` | `engine.stop(actor, reason)` | nothing |
| `accept_plan` | `steps?: string[]`, `budgets?: { <step>: number }` | `engine.acceptPlan` | advance |
| `deny_plan` | `reason` | `engine.denyPlan` | nothing |
| `replan` | `note` | `engine.replan` | advance |
| `revise` | `product`, `reason` | `engine.revise` | advance |
| `answer_challenge` | `challenge`, `answer`, `action: "revised" \| "rebutted"` | `engine.answerChallenge`, refused first with `challenge <id> is from an earlier run` when `state.challenges[id].run !== state.run.id` | nothing |
| `approve` | none | `engine.approve` | advance |
| `reject` | `reason`, `stop: boolean` | `engine.reject` | advance |
| `feedback` | `measure`, `value: number \| string`, `note` | `engine.feedback` | nothing |
| `set_model` | `stage`, `provider`, `model`, `effort: string \| null` | `engine.setModel`, after the checks below | nothing |
| `set_budget` | `tokens: integer ≥ 1 \| null` | `engine.setBudget` | nothing |
| `set_pack_limit` | `stage`, `max_marking: Marking \| null` | `engine.setPackLimit` | nothing |
| `keep`, `move`, `discard`, `restore`, `send_back`, `pin`, `add_lane`, `rename_lane`, `remove_lane`, `set_target`, `undo` | as the triage functions take them | the triage function | nothing |

`set_model` is refused (`SettingRefused`) unless: `stage` is a stage of the pipeline or the literal `agent`; some `ModelView` from `modelsFor(deps, <case marking>)` has that provider and model; `effort` is null or one of that view's `efforts`; and the view is `allowed` (otherwise the refusal is the view's `reason`).

**Triage rules.** Every check is made inside the commit builder, on the state the builder is given, and a failed check throws `TriageRefused` so nothing is written.

- `keepCard`: the card exists and is in Incoming (`card <id> is already kept` for one in a lane; `card <id> is discarded; restore it first`). The lane is `input.lane`, else `state.target`. When the case has no lane at all, the same commit first writes `lane.created` with title `Kept`. Writes `card.kept`.
- `moveCard`: the card is in a lane and the target lane exists; `index` is an integer ≥ 0. Writes `card.moved`.
- `discardCard`: not already discarded. `restoreCard`: must be discarded. `sendBackCard`: must be in a lane.
- `addLane`: the title, trimmed, is 1 to 80 characters. `renameLane`: the same rule. `removeLane`: the lane exists and is empty (`lane <title> still holds <n> cards`). `setTarget`: the lane exists.
- `undo`: `target` omitted means the newest item of `state.undoable`; an item that is not there is `nothing to undo`. Writes `undo` with that item's `seq` as `target` and its `card`, `place`, `lane`, `index`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/commands.test.ts
test("start_run starts the run and the server drives it to the plan gate", async () => {
  const id = await s.newCase();
  const r = await s.command(id, "start_run");
  expect(r).toEqual({ status: 200, body: { ok: true, seq: expect.any(Number) } });
  await s.app.hub.idle();
  expect(s.app.hub.read(id).state.run).toMatchObject({ status: "waiting", waiting: "plan" });
});
test("a command returns before the run has moved on", ...);          // the response's seq is below the head once idle() resolves
test("the sample runs to a published product through commands alone", async () => {
  const id = await s.newCase();
  await s.toPublishGate(id);
  expect((await s.command(id, "approve")).status).toBe(200);
  await s.app.hub.idle();
  const st = s.app.hub.read(id).state;
  expect(st.run).toMatchObject({ status: "finished", outcome: "published" });
  expect(st.skipped).toEqual([]);
  // every entry a person caused carries the configured user
  for (const e of s.entries(id)) if (e.actor.kind === "human") expect(e.actor.id).toBe(s.config.user);
});
test("pause, set_budget, set_model, set_pack_limit, feedback and stop do not move the run", ...);   // for each: head after the response plus idle() holds exactly the command's own entries
test("a refusal is 409 with the engine's own words and writes nothing", async () => {
  const id = await s.newCase();
  const before = s.entries(id).length;
  expect(await s.command(id, "approve")).toEqual({ status: 409, body: { ok: false, refused: [expect.stringContaining("publish")] } });
  expect(s.entries(id).length).toBe(before);
});
test("approving twice publishes once", async () => {
  await s.toPublishGate(id);
  const [a, b] = await Promise.all([s.command(id, "approve"), s.command(id, "approve")]);
  expect([a.status, b.status].sort()).toEqual([200, 409]);
  await s.app.hub.idle();
  expect(s.entries(id).filter((e) => e.type === "product.published").length).toBe(1);
});
test("accepting the plan twice writes one plan.accepted", ...);
test("an unknown command, unknown argument or wrong type is 400 and writes nothing", ...);   // { command: "nope" }; accept_plan { budgets: { s3: "1" } }; keep { card: "c1", extra: 1 }
test("a body that names an actor is 400", ...);                       // { command: "approve", args: {}, actor: {...} } and { command: "keep", args: { card: "c1", actor: "x" } }
test("a requester may do nothing", ...);                              // served({ role: "requester" }) → 403, { ok: false, refused: ["the requester view may not do approve"] }
test("set_model refuses a model the case's marking may not go to", ...);   // 409, refused: ["TLP:RED may not go to a hosted model"]
test("set_model refuses a model no provider lists, and an effort the model does not have", ...);
test("answer_challenge refuses a challenge from an earlier run", ...);
test("the first command on a case left running by a stopped process finds it interrupted", ...);   // close and reopen served on the same dir with run.status "running" on disk; GET writes nothing; the first command sees run.interrupted in the ledger
test("a refusal that quotes a source error is scrubbed", ...);        // a PlanRefused whose text holds a URL arrives as "[hidden]"

// tests/server/triage.test.ts  (a case at the publish gate has cards in Incoming and lanes from the plan)
test("keep puts a card in the target lane, and undo puts it back where it was", async () => {
  const card = state().incoming[1]!;
  await s.command(id, "keep", { card });
  expect(state().cards[card]).toMatchObject({ place: "lane", lane: state().target });
  await s.command(id, "undo");
  expect(state().incoming[1]).toBe(card);
});
test("keep with no lane in the case makes a lane called Kept first", ...);      // a fresh case with one hand-made card.created
test("move, discard, restore, send_back and pin each write their one entry", ...);
test("undo reverses keep, move, discard and send_back, newest first", ...);
test("keeping a kept card, discarding a discarded card and undo with nothing to undo are refused and write nothing", ...);   // 409 each; "card c2 is already kept", "nothing to undo"
test("the same keep sent twice at once keeps once", ...);            // Promise.all → one 200, one 409, one card.kept
test("a lane with cards cannot be removed; an empty one can", ...);
test("a lane title is trimmed and must be 1 to 80 characters", ...);
test("an agent or system actor is never written by a triage command", ...);     // every entry these commands wrote has actor.kind "human"
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/server/commands.test.ts tests/server/triage.test.ts`
Expected: FAIL, 404 for `/api/cases/<id>/commands`.

- [ ] **Step 3: Implement `commands.ts`, `triage.ts`, the endpoint in `app.ts`, and the helpers in `served.ts`**

- [ ] **Step 4: Run the tests**

Run: `timeout 300 bun test tests/server && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server tests/helpers/served.ts
git commit -m "feat(server): command endpoint for the run, its gates, triage and settings; the server advances only where the contract says"
```

---

### Task 3: Evidence: blobs, bundles, the bundle preview and the custody report

**Files:**
- Create: `src/server/evidence.ts`
- Modify: `src/core/wire.ts`, `src/core/verify.ts`, `src/server/app.ts`, `src/pipeline/publish.ts`
- Test: `tests/server/evidence.test.ts`, `tests/pipeline/publish.test.ts`

**Interfaces:**
- Consumes: `BlobStore`, `BLOB_FIELDS`, Task 0's `verifyCase`, `buildBundle`, Task 1's route table.
- Produces:
  - `previewBundle(session: CaseSession, deps: EngineDeps): Bundle | { reasons: string[] }` in `src/pipeline/publish.ts`: the bundle `approve` would write now, or why there is none (no draft; the Publish stage has not named this draft; the blockers). It writes nothing. `approve` builds its bundle through the same function, so the two cannot differ.
  - `src/server/evidence.ts`: `blobResponse(session, hash): Response`, `bundleFile(session, n, file): Response`, `custodyOf(session): Custody`.
  - In `src/core/wire.ts`: `export type Preview = { manifest: { n: number; draft: number; draft_hash: string; marking: Marking; title: string; note: string; files: { name: string; sha256: string; bytes: number }[] }; files: Record<string, string> } | { reasons: string[] }`.
  - In `src/core/wire.ts` (the `PublishedReport` interface moves there from `src/core/verify.ts`, which re-exports it): `export interface Custody { ok: boolean; entries: number; head: string; first_bad: { seq: number; reason: string } | null; bad_blobs: { blob: string; state: string; seq: number }[]; published: PublishedReport; skipped: number; line: string }` where `line` is `chain intact · <n> entries` when `ok`, else the first of: `chain broken at entry <seq> (<reason>)`, `<k> blob(s) missing or corrupt, first at entry <seq>`, `published bundle <n> <state>`.

**Routes** (all `GET`):

| Path | Returns |
|---|---|
| `/api/cases/<id>/blobs/<hash>` | the blob's bytes |
| `/api/cases/<id>/published/<n>/<file>` | one file of bundle `n` |
| `/api/cases/<id>/preview` | `previewBundle` as JSON: `{ manifest, files }` or `{ reasons }` |
| `/api/cases/<id>/custody` | `custodyOf(session)` |

**Blobs.** `<hash>` must match `/^[0-9a-f]{64}$/` (else 400) and be referenced by an entry of this case at a `BLOB_FIELDS` position (else 404; a hash that is merely present in the folder is not served). The bytes come from `session.blobs.get(hash)`, which checks them against their name; a missing or corrupt blob is 404 with `{ ok: false, refused: ["blob <hash> is missing"] }` or `"... is corrupt"`. The content type is chosen from the `media` recorded on the reference, through a fixed list: `application/json` → `application/json`; `text/plain`, `text/csv`, `application/x-ndjson` → `text/plain; charset=utf-8`; anything else, or none → `application/octet-stream`. Never `text/html`, whatever was recorded. Headers: `secure(res, "download")` adds `Content-Disposition: attachment; filename="<first 12 of hash>.<json|txt|bin>"` and `Content-Security-Policy: sandbox; default-src 'none'`.

**Bundles.** `<n>` must match `/^[1-9][0-9]{0,5}$/` and be the `n` of a `product.published` entry (else 404). `<file>` must be `manifest.json` or a name in that bundle's manifest (else 404); the route's pattern admits only `[a-z.]+`, so no separator can arrive. The bytes come from the bundle blob the entry names (`{ manifest, files }`), never from the folder: `manifest.json` is the canonical manifest, a file is `files[name]`. Content type: `.md` → `text/markdown; charset=utf-8`, `.json` → `application/json`; sent as an attachment named `<case>-<n>-<file>`.

**Custody.** `custodyOf` calls `verifyCase(session.dir)` (which opens the ledger file read-only beside the open session) and adds `skipped: session.state.skipped.length`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/evidence.test.ts  (id = a published sample case)
test("a result blob is served as an attachment with the type that was recorded", async () => {
  const ref = (s.entries(id).find((e) => e.type === "query.result")!.payload as Payloads["query.result"]).result;
  const res = await s.get(`/api/cases/${id}/blobs/${ref.blob}`);
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("application/json");
  expect(res.headers.get("content-disposition")).toStartWith("attachment;");
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(sha256Hex(new Uint8Array(await res.arrayBuffer()))).toBe(ref.blob);
});
test("a blob recorded as text/html is served as octet-stream", ...);       // put a blob with media "text/html", reference it from a hand-made tool.returned
test("a hash that is not 64 lower-case hex characters is 400", async () => {
  for (const bad of ["..%2f..%2fledger.sqlite", "A".repeat(64), "abc", "a".repeat(65), `${"a".repeat(64)}%00`]) expect((await s.get(`/api/cases/${id}/blobs/${bad}`)).status).toBe(400);
});
test("a blob in the folder that no entry references is 404", ...);
test("a blob from another case is 404", ...);
test("a corrupt blob is 404 and says corrupt", ...);
test("each bundle file is served byte for byte as published", async () => {
  for (const f of ["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]) {
    const res = await s.get(`/api/cases/${id}/published/1/${f}`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array(readFileSync(join(caseDir, "published", "1", f))));
  }
});
test("a bundle is still served after its folder is deleted", ...);
test("bundle paths cannot leave the bundle", async () => {
  for (const p of ["1/..%2f..%2fledger.sqlite", "1/../../ledger.sqlite", "0/product.md", "9999999/product.md", "1/ledger.sqlite", "1/PRODUCT.MD", "x/product.md"]) expect([400, 404]).toContain((await s.get(`/api/cases/${id}/published/${p}`)).status);
});
test("the preview at the publish gate is exactly what approve then writes", async () => {
  await s.toPublishGate(id2);
  const preview = await (await s.get(`/api/cases/${id2}/preview`)).json();
  const headBefore = s.app.hub.read(id2).head().seq;
  expect(s.app.hub.read(id2).head().seq).toBe(headBefore);                  // the preview wrote nothing
  await s.command(id2, "approve");
  for (const [name, text] of Object.entries(preview.files)) expect(readFileSync(join(dirOf(id2), "published", "1", name), "utf8")).toBe(text as string);
});
test("with no draft the preview gives the reason", ...);                    // { reasons: ["there is no draft to publish"] }
test("custody of an untouched case is intact and counts its entries", async () => {
  const c = await (await s.get(`/api/cases/${id}/custody`)).json();
  expect(c).toMatchObject({ ok: true, first_bad: null, bad_blobs: [], skipped: 0, line: `chain intact · ${s.entries(id).length} entries` });
});
test("custody names the entry behind a deleted blob", ...);                // ok false; line "1 blob(s) missing or corrupt, first at entry <seq>"
test("custody names an edited published file", ...);                       // line "published bundle 1 differs"
test("no response in a whole published run holds the planted credential", async () => {
  // served({ credential }) ; collect the text of /api/me, /api/reference, the whole entry stream, every referenced blob, every bundle file, the preview and custody
  for (const body of bodies) expect(body).not.toContain("planted-secret-value-91d7");
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/server/evidence.test.ts`
Expected: FAIL with 404s.

- [ ] **Step 3: Implement `evidence.ts`, `previewBundle`, and the four routes**

- [ ] **Step 4: Run the tests**

Run: `timeout 300 bun test tests/server tests/pipeline/publish.test.ts tests/sample && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server src/pipeline/publish.ts tests/server tests/pipeline/publish.test.ts
git commit -m "feat(server): blobs and bundles served from the record with safe types, a bundle preview, and the custody report"
```

---

### Task 4: Interface foundation: build, the DOM helper, the store that folds entries, and the injection lint

**Files:**
- Create: `src/web/build.ts`, `src/web/main.ts`, `src/web/app.ts`, `src/web/dom.ts`, `src/web/ui.ts`, `src/web/api.ts`, `src/web/store.ts`, `src/web/prefs.ts`, `src/web/time.ts`, `src/web/chips.ts`, `src/web/style.css`, `tests/helpers/dom.ts`
- Modify: `package.json` (dev dependency `happy-dom`, pinned to the exact version installed; commit `bun.lock`), `tests/core/browser-safety.test.ts`
- Test: `tests/web/dom.test.ts`, `tests/web/store.test.ts`, `tests/web/lint.test.ts`, `tests/web/build.test.ts`

**Interfaces:**
- Consumes: `apply`, `initial`, `isNext` from `src/core/state/`; the types in `src/core/wire.ts`; Task 1's `Assets`; `tests/helpers/served.ts`.
- Produces:

```ts
// src/web/build.ts  (the only file under src/web/ that may use Bun)
/** Bundles src/web/main.ts for the browser and reads style.css. The page is a constant: no data is ever written into it. */
export function buildInterface(): Promise<Assets>;

// src/web/dom.ts
export type Child = Node | string | number | null | undefined | false | Child[];
export interface Props {
  class?: string; id?: string; title?: string; name?: string;            // name → aria-label
  role?: string; tabindex?: number; type?: string; value?: string; placeholder?: string; for?: string;
  disabled?: boolean; checked?: boolean; hidden?: boolean; current?: boolean;   // current → aria-current="true"
  data?: Record<string, string>; aria?: Record<string, string>;
  on?: Record<string, (event: Event) => void>;
}
export type H = (tag: string, props?: Props | null, ...children: Child[]) => HTMLElement;
/** Children that are strings or numbers become text nodes. A tag outside TAGS, or a prop outside Props, throws. */
export function makeH(doc: Document): H;
export const TAGS: readonly string[];   // div span p h1 h2 h3 header footer main nav section article aside button input textarea select option label ul ol li table thead tbody tr th td pre code time details summary form fieldset legend kbd
/** An anchor only for a URL that parses with protocol "https:"; rel="noopener noreferrer", target="_blank". Anything else is a span holding the label. */
export function link(h: H, url: string, label: string): HTMLElement;
/** An anchor to a blob or bundle of this server: the path must match /^\/api\/cases\/CASE-[0-9]+\/(blobs|published)\/[a-z0-9./]+$/ and hold no "..". Otherwise a span. */
export function fileLink(h: H, path: string, label: string): HTMLElement;
/** Makes `parent`'s element children match `items` by key, reusing nodes: `make` for a new key, `update` for a kept one; order follows `items`; focus stays on a kept node. */
export function syncList<T>(parent: HTMLElement, items: readonly T[], key: (item: T) => string, make: (item: T) => HTMLElement, update: (el: HTMLElement, item: T) => void): void;
export function clear(el: HTMLElement): void;

// src/web/ui.ts
export interface View { el: HTMLElement; update(): void; destroy?(): void }
export interface Ui {
  doc: Document; win: Window; h: H; api: Api; prefs: Prefs; me: Me; ref: Reference;
  toast(message: string, undo?: { label: string; act(): void }): void;
  reducedMotion(): boolean;
  /** Sends a command for the case on screen. A refusal becomes a toast with the server's words. Refused locally while replaying. Resolves true when done. */
  act(command: string, args?: Record<string, unknown>): Promise<boolean>;
}

// src/web/api.ts
export type Fetcher = (req: Request) => Promise<Response>;
export interface EntrySource { open(caseId: string, after: number, onEntry: (entry: Entry) => void, onDrop: () => void): () => void }
export interface Api {
  me(): Promise<Me>; cases(): Promise<CaseSummaryView[]>; reference(): Promise<Reference>; models(caseId: string): Promise<ModelView[]>;
  newCase(input: NewCaseInput): Promise<{ id: string } | { refused: string[] }>;
  command(caseId: string, name: string, args: Record<string, unknown>): Promise<CommandResult>;
  custody(caseId: string): Promise<Custody>; preview(caseId: string): Promise<Preview>;
  blobText(caseId: string, hash: string): Promise<string>;
  blobPath(caseId: string, hash: string): string; bundlePath(caseId: string, n: number, file: string): string;
  entries: EntrySource;
}
export function makeApi(fetcher: Fetcher, origin: string, entries: EntrySource): Api;
/** The browser's source: an EventSource on /api/cases/<id>/entries?after=N. */
export function eventSourceEntries(win: Window, origin: string): EntrySource;

// src/web/store.ts
export const SNAPSHOT_EVERY = 200;
export class CaseStore {
  constructor(id: string);
  readonly id: string;
  readonly entries: Entry[];                        // every entry received, in order
  connection: "live" | "reconnecting";
  get live(): CaseState;                            // the fold to the newest entry
  get at(): number | null;                          // the replay position; null is live
  get shown(): CaseState;                           // live, or the fold to `at`
  /** "applied" when it was the next entry; "duplicate" when its seq is not above the head; "gap" when it skips ahead (nothing is applied). */
  push(entry: Entry): "applied" | "duplicate" | "gap";
  goTo(seq: number | null): void;
  /** The fold to `seq`, from the nearest snapshot at or before it. */
  stateAt(seq: number): CaseState;
  subscribe(fn: () => void): () => void;            // called after every push that applied and every goTo
}
/** Keeps a store fed: opens the source after the store's head; on "gap" or a drop, closes and reopens after the head (after 1 s, 2 s, then every 5 s), setting `connection`. Returns the stop function. */
export function follow(store: CaseStore, source: EntrySource, win: Window): () => void;

// src/web/prefs.ts
export interface Prefs { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
/** Remembered choices under "rw:<key>" as JSON. A storage that throws or is null falls back to memory. */
export function makePrefs(storage: Storage | null): Prefs;

// src/web/time.ts
export function utc(ts: string): string;                                // the ISO text with milliseconds, as recorded
export function shortLocal(ts: string, now: Date, zone?: string): string;   // "14:02" today, "23 Nov 14:02" otherwise
/** <time datetime=ts>: mode "utc" shows utc(ts); mode "local" shows shortLocal with utc(ts) as the tooltip. */
export function timeEl(ui: Ui, ts: string, mode: "utc" | "local"): HTMLElement;

// src/web/chips.ts
export type TagKind = "done" | "attention" | "agent" | "system" | "human";    // green, amber, violet, blue, neutral
export function tag(ui: Ui, kind: TagKind, text: string, tooltip?: string): HTMLElement;
/** The full marking text, always; class "tlp-red" | "tlp-amber" | "tlp-green" | "tlp-clear". */
export function markingChip(ui: Ui, marking: Marking): HTMLElement;
/** A button reading the card id; activating it calls onOpen. Dashed when `proposed`. */
export function cardChip(ui: Ui, card: string, onOpen: (card: string) => void, proposed?: boolean): HTMLElement;

// src/web/app.ts  (Task 5 fills it in)
export function startApp(ui: Ui, root: HTMLElement): { destroy(): void };

// tests/helpers/dom.ts
export interface Page {
  s: Served; win: Window; doc: Document; ui: Ui; root: HTMLElement;
  press(key: string, mods?: { shift?: boolean; alt?: boolean }): void;      // a keydown on the focused element, bubbling
  click(target: string | Element): void; fill(target: string | Element, text: string): void;
  q(selector: string): HTMLElement; all(selector: string): HTMLElement[]; text(): string;
  /** Waits until the server is idle and every entry it wrote has been rendered. */
  settle(): Promise<void>;
  toasts(): string[];
  close(): Promise<void>;
}
/** served(), a happy-dom Window at the server's origin, makeApi over app.handle, an EntrySource over hub.read(id).subscribe, and startApp. `reducedMotion` sets what ui.reducedMotion() answers. */
export function page(opts?: { role?: Role; reducedMotion?: boolean; hash?: string }): Promise<Page>;
```

**The page** `buildInterface` returns, exactly:

```html
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workbench</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>
```

`main.ts` builds the `Ui` from `window` (`makeH(document)`, `makeApi((r) => fetch(r), location.origin, eventSourceEntries(window, location.origin))`, `makePrefs(localStorage)` inside a try, `reducedMotion: () => matchMedia("(prefers-reduced-motion: reduce)").matches`), loads `me` and `reference`, and calls `startApp(ui, document.getElementById("app"))`. `ui.toast` and `ui.act` are stubs here that Task 6 replaces.

**The stylesheet** fixes the visual language (guide §3) as custom properties on `:root`, used everywhere after:

```css
--bg: #0b1020; --panel: #121a2e; --panel-2: #18223a; --line: #26324d; --text: #dbe4f5; --muted: #8a97b3;
--accent: #7cc4ff; --green: #5fd38d; --amber: #f2b84b; --violet: #b69cff; --blue: #6fa8ff;
--tlp-red: #ff5c5c; --tlp-amber: #ffb000; --tlp-green: #33c26b; --tlp-clear: #e6e6e6;
--radius: 10px; --radius-lg: 16px; --font: system-ui, sans-serif; --mono: ui-monospace, monospace;
```

Body text 14px, headings weight 300, borders `1px solid var(--line)`, `:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }`, `.proposed { border-style: dashed }`, monospace only on `pre`, `code` and `.query`. It ends with `@media (prefers-reduced-motion: reduce) { *, *::before, *::after { transition: none !important; animation: none !important; scroll-behavior: auto !important } }`. It has no `@import` and no `url(`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/dom.test.ts
test("text with markup in it is shown as text", () => {
  const evil = `<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>`;
  const el = h("div", { title: evil }, evil);
  expect(el.children.length).toBe(0);
  expect(el.textContent).toBe(evil);
  expect(el.getAttribute("title")).toBe(evil);
  expect((win as unknown as { pwned?: number }).pwned).toBeUndefined();
});
test("h refuses a tag or a prop it does not know", () => {
  for (const t of ["script", "iframe", "a", "style", "object", "img"]) expect(() => h(t)).toThrow();
  expect(() => h("div", { onclick: "x" } as unknown as Props)).toThrow();
  expect(() => h("div", { href: "x" } as unknown as Props)).toThrow();
});
test("a link is made only for https", () => {
  const a = link(h, "https://example.net/a?b=1", "report");
  expect([a.tagName, a.getAttribute("rel"), a.getAttribute("target"), a.getAttribute("href")]).toEqual(["A", "noopener noreferrer", "_blank", "https://example.net/a?b=1"]);
  for (const bad of ["http://example.net", "javascript:alert(1)", " javascript:alert(1)", "data:text/html,x", "//example.net", "/api/me", "file:///etc/passwd", "https:", "\u0000https://example.net", ""]) {
    const s = link(h, bad, "label");
    expect([s.tagName, s.textContent]).toEqual(["SPAN", "label"]);
  }
});
test("a file link is made only for this server's blobs and bundles", () => {
  expect(fileLink(h, `/api/cases/CASE-1/blobs/${"a".repeat(64)}`, "raw").tagName).toBe("A");
  expect(fileLink(h, "/api/cases/CASE-1/published/1/product.md", "product").tagName).toBe("A");
  for (const bad of ["https://example.net/x", "/api/cases/CASE-1/published/../../x", "/api/me", "//example.net/api/cases/CASE-1/blobs/aa", "javascript:alert(1)"]) expect(fileLink(h, bad, "x").tagName).toBe("SPAN");
});
test("syncList reuses nodes by key, follows the new order and keeps focus", ...);
test("a marking chip always reads the full marking", () => expect(markingChip(ui, "TLP:AMBER+STRICT").textContent).toBe("TLP:AMBER+STRICT"));
test("every tag has text as well as a colour class", ...);
test("timeEl shows UTC with milliseconds, or local time with UTC as the tooltip", () => {
  expect(timeEl(ui, "2026-11-23T20:02:11.482Z", "utc").textContent).toBe("2026-11-23T20:02:11.482Z");
  const t = timeEl(ui, "2026-11-23T20:02:11.482Z", "local");
  expect(t.getAttribute("title")).toBe("2026-11-23T20:02:11.482Z");
  expect(shortLocal("2026-11-23T20:02:11.482Z", new Date("2026-11-23T21:00:00Z"), "UTC")).toBe("20:02");
  expect(shortLocal("2026-11-22T20:02:11.482Z", new Date("2026-11-23T21:00:00Z"), "UTC")).toBe("22 Nov 20:02");
});
test("prefs survive a storage that throws", ...);

// tests/web/store.test.ts
/** A published sample run, made once for the file: its entries and the state the session's subscribers saw at each one. */
let run: { entries: Entry[]; live: Map<number, CaseState>; session: CaseSession };
test("the bundled browser code folds every entry to the server's state", async () => {
  const out = await Bun.build({ entrypoints: [join(SRC, "web/store.ts")], target: "browser", format: "esm", outdir: tmp });
  const { CaseStore } = await import(out.outputs[0]!.path) as typeof import("../../src/web/store");
  const store = new CaseStore(run.session.id);
  for (const e of run.entries) {
    expect(store.push(JSON.parse(JSON.stringify(e)))).toBe("applied");      // as it arrives over the wire
    expect(canonical(store.live as unknown as Json)).toBe(canonical(run.live.get(e.seq) as unknown as Json));
  }
  for (const n of [1, 2, 199, 200, 201, 399, 400, run.entries.length]) expect(canonical(store.stateAt(n) as unknown as Json)).toBe(canonical(run.session.stateAt(n) as unknown as Json));
});
test("the store fed by the server's stream ends in the server's state", ...);   // served({ listen: true }); an EntrySource over fetch; a whole run by commands; canonical(store.live) === canonical(session.state)
test("a repeated entry is ignored and a skipped one is not applied", () => {
  const store = new CaseStore("CASE-1");
  store.push(run.entries[0]!);
  expect(store.push(run.entries[0]!)).toBe("duplicate");
  expect(store.push(run.entries[2]!)).toBe("gap");
  expect(store.live.seq).toBe(1);
});
test("follow reopens the stream after its own head on a gap and on a drop, and ends in the right state", ...);   // a fake EntrySource that skips entry 5, then drops at 9; open() calls were after 0, after 4, after 8
test("goTo shows the state at that entry and null returns to live", ...);       // shown equals session.stateAt(7); entries arriving while replaying do not move `shown`
test("replay over a long case does not refold from the start", () => {
  const store = longCase(5000);                                               // 5,000 hand-made entries: card.created, card.kept, card.moved in turn
  const t0 = performance.now();
  for (let seq = 5000; seq > 4900; seq--) store.stateAt(seq);
  expect(performance.now() - t0).toBeLessThan(1500);
});

// tests/web/lint.test.ts
const BANNED: [string, RegExp][] = [
  ["innerHTML", /\binnerHTML\b/], ["outerHTML", /\bouterHTML\b/], ["insertAdjacentHTML", /\binsertAdjacentHTML\b/], ["document.write", /\bdocument\s*\.\s*write(ln)?\b/],
  ["DOMParser", /\bDOMParser\b/], ["createContextualFragment", /\bcreateContextualFragment\b/], ["srcdoc", /\bsrcdoc\b/], ["eval", /\beval\s*\(/], ["new Function", /\bnew\s+Function\b/],
  ["string timer", /\bset(?:Timeout|Interval)\s*\(\s*["'`]/], ["setAttribute", /\bsetAttribute(NS)?\s*\(/], ["createElement", /\bcreateElement(NS)?\s*\(/],
  ["href or src", /\.\s*(?:href|src|action|formAction)\s*=[^=]/], ["style text", /\.\s*(?:cssText)\s*=|\binsertRule\b/], ["location change", /\blocation\s*\.\s*(?:assign|replace)\b|\blocation\s*(?:\.\s*href)?\s*=[^=]/], ["window.open", /\b(?:window|win)\s*\.\s*open\s*\(/],
];
test("nothing under src/web uses an HTML sink", () => {
  // every .ts under src/web except build.ts, comments stripped; dom.ts alone may use setAttribute, createElement and href
  expect(violations).toEqual([]);
});
test("the scan catches each banned form", () => { for (const [name, re] of BANNED) expect(re.test(SAMPLES[name]!)).toBe(true); });
test("the stylesheet loads nothing", () => { expect(css).not.toMatch(/@import|url\(/); });

// tests/web/build.test.ts
test("the bundle is browser code: no bun: or node: import, no Bun, process or Buffer", ...);
test("the page is the constant shell and holds no inline script or style", ...);
test("the server serves the page, the script and the stylesheet with their types", ...);   // text/html; charset=utf-8, text/javascript; charset=utf-8, text/css; charset=utf-8
// tests/core/browser-safety.test.ts: add src/web/main.ts and src/core/wire.ts to ENTRY_POINTS (build.ts is not reachable from main.ts)
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun add -d --exact happy-dom && timeout 300 bun test tests/web tests/core/browser-safety.test.ts`
Expected: FAIL, `Cannot find module "../../src/web/dom"`.

- [ ] **Step 3: Implement the files above.** `served()` now builds real assets once per process with `buildInterface()`.

- [ ] **Step 4: Run the tests**

Run: `timeout 300 bun test tests/web tests/core tests/server && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json bun.lock src/web tests/web tests/helpers/dom.ts tests/helpers/served.ts tests/core/browser-safety.test.ts
git commit -m "feat(web): interface build, a DOM helper that cannot inject HTML, the store that folds entries in the browser, and the injection lint"
```

---

### Task 5: Home, "which one?", New investigation, the trail, the top bar and the command bar

**Files:**
- Create: `src/web/views/home.ts`, `src/web/views/pick.ts`, `src/web/views/newcase.ts`, `src/web/views/trail.ts`, `src/web/views/topbar.ts`, `src/web/commands.ts`
- Modify: `src/web/app.ts`, `src/web/style.css`
- Test: `tests/web/home.test.ts`, `tests/web/commands.test.ts`

**Interfaces:**
- Consumes: Task 4's `Ui`, `View`, `h`, `Api`, `CaseStore`, `follow`, chips; `POST /api/cases` and `start_run`.
- Produces:

```ts
// src/web/app.ts
export type LensId = "agent" | "steps" | "timeline" | "narrative" | "worklog" | "discarded" | "jobs" | "pipeline" | "replay";
export type Route = { screen: "home" } | { screen: "pick" } | { screen: "new" } | { screen: "soon"; mode: string } | { screen: "case"; id: string };
/** "#/" · "#/investigate" · "#/investigate/new" · "#/soon/<mode>" · "#/case/CASE-1". Anything else is home. */
export function parseRoute(hash: string): Route;
export function routeHash(route: Route): string;
export interface Nav {
  go(route: Route): void;
  openLens(id: LensId, arg?: string): void; closeLens(): void;
  focusCard(card: string): void;                    // scrolls to the card where it lives, opens and focuses it; a discarded card opens the Discarded lens
  pivot(card: string, values: Observable[]): void;  // Task 13
  ask(text: string): void;                          // Task 11
  /** One step up: close what is open, else go up a level (case → which one? → home). */
  up(): void;
}
/** Set by the case screen (Task 6); null on every other screen. */
export interface Open { store: CaseStore; nav: Nav }

// src/web/views/home.ts
export interface Mode { id: string; column: "help" | "work" | "resources"; label: string; roles: readonly Me["role"][]; live: boolean }
export const MODES: readonly Mode[];

// src/web/commands.ts
export type Intent =
  | { kind: "open_case"; id: string }
  | { kind: "go"; to: "home" | "investigate" }
  | { kind: "lens"; id: LensId }
  | { kind: "run" } | { kind: "pause" } | { kind: "accept_plan" } | { kind: "approve" }
  | { kind: "verify"; card: string }
  | { kind: "replay"; seq: number | null }
  | { kind: "ask"; text: string }
  | { kind: "say"; text: string };                                          // nothing to do; show this
export function parseCommand(text: string, ctx: { cases: { id: string; title: string }[]; in_case: boolean; cards: string[] }): Intent;
```

**Home** (guide §4.1; `data-screen="home"`, the only vertically centred screen). The question `How can I help you today?` in light type. Under it, the columns the role may see, each with a bold title, a one-line subtitle and its mode tiles as wide short rows; then, for an analyst only, a command input (placeholder `investigate CASE-1`); then the hint `Press ? for keys`.

| Column | Subtitle | Modes (label · roles) |
|---|---|---|
| Get help | Ask the team | Ask for help · requester; My requests · requester; Give feedback · requester |
| Do the work | Pick up a case | Work tickets · analyst; Investigate · analyst; Hunt · analyst; Actors · analyst; My folders · analyst |
| Resources | What steers the work | Strategy · analyst, leader; Requirements · analyst, leader; Gaps · analyst, leader; Priorities · leader; Learn · analyst; Agent inventory · analyst |

Only Investigate is live. Its count is `<n> open` (cases whose run is not finished). Every other tile's count is `soon`; it is dimmed (`class="soon"`) and still a button, and opens `#/soon/<id>`: a top-aligned stage with the mode's label as heading and the line `Not built yet. This part comes after the investigation slice.` A column with no mode for the role is not drawn.

**Which one?** (guide §4.2; top-aligned). Heading `Investigate: which one?`. A filter box matching title, id, marking and run status, case-insensitively; `Enter` opens the first match; `Esc` clears it. A grid of square tiles: first a dashed tile `+ New investigation`, then one per case, newest first. A case tile has fixed slots: a two-line head (the title), a descriptor of up to three lines (`CASE-3 · <phase title or "not started"> · <run status in words>`), and one row of chips (the marking chip, `<n> incoming`, `<n> kept`). Overflow is cut with an ellipsis; the tile's `title` and accessible name carry the full text. With a filter that matches nothing, the grid shows `Nothing matches` after the New tile. Run status in words: `none` → `not started`, `running`, `paused`, `waiting` → `waiting for you`, `interrupted`, `finished`.

**New investigation** (`#/investigate/new`, spec §10.1). Fields, each with a label: Title; What was asked; Why; Starting values (rows of a type select from `ref.types` and a value input, with `+ Add a value` and a remove button per row; at least one); Window from and to (text inputs holding UTC timestamps like `2026-11-17T00:00:00.000Z`, pre-filled with seven days ago at midnight UTC and the coming midnight UTC); Objective (select: `None`, then `ref.objectives`); Marking (select of `me.markings`, default `TLP:AMBER`). The button reads `Create and frame the run`. It calls `api.newCase`; on `{ id }` it sends `start_run` for that case and goes to `#/case/<id>`; on `{ refused }` it shows each reason as text above the button and keeps every field.

**The trail** (guide §4.3; top-left on every screen but home). A home dot (button, name `Home`), then levels. At the mode level the current mode is a labelled pill and the other modes the role may see are small dots whose `title` and accessible name are their labels; hovering or focusing the Investigate dot or pill opens a fly-out list of its cases. At the item level the current case is a pill (`CASE-1`) and the other cases are dots. At the lane level (in a case) the target lane is a pill and the other lanes are dots; activating one moves column focus to that lane. Every pill and dot is one activation away from its level.

**The top bar** (guide §4.4). Left: the trail. Centre: the command bar (an input, name `Command`, placeholder `open, run, verify c3, or ask`). Right: the connection state when it is not `live` (`reconnecting…`, amber), and the jobs indicator, a button reading `jobs (<n>)` with `n` the running jobs of `store.shown.jobs`, which opens the Jobs lens.

**The command bar** (spec §10.2). `parseCommand` trims and lower-cases for matching, and decides by the first word or two; navigation happens only on these explicit words (guide §6):

| Input | Intent |
|---|---|
| `CASE-3`, `open CASE-3`, `investigate CASE-3`, `investigate <words matching exactly one case title>` | `open_case` |
| `investigate` alone, `go to investigate`, `open investigate` | `go` investigate |
| `go to home`, `home` | `go` home |
| `open <lens>`, `go to <lens>` (agent, steps, timeline, narrative, worklog, discarded, jobs, pipeline, replay) | `lens` |
| `run`, `pause`, `accept plan`, `approve` (the whole input) | that intent |
| `verify c12` | `verify`; a card not in `ctx.cards` → `say` `There is no card c12` |
| `replay`, `replay 137` | `replay` |
| `summarize` | `ask` with `Give a synopsis of this case.` |
| anything else, in a case | `ask` with the text as typed |
| anything else, outside a case | `say` `Open a case first: investigate CASE-1` |

`investigate` or `open` followed by words that match no case and no lens is an `ask` in a case: a question that begins with a verb never leaves the case. The bar performs the intent on `Enter`: `run` sends `start_run` when the run is `none` or `finished` and `resume` when it is `paused` or `interrupted`; `accept_plan` sends `accept_plan` with no arguments; `verify` and `replay` open the card's Verify and the Replay lens (Tasks 13 and 12); `ask` calls `nav.ask`. The input is cleared after a performed intent and kept after a `say`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/home.test.ts
test("an analyst's home has Do the work and Resources, with Investigate live and the rest soon", async () => {
  const p = await page();
  expect(p.q("[data-screen=home] h1").textContent).toBe("How can I help you today?");
  expect(p.all("[data-column] h2").map((e) => e.textContent)).toEqual(["Do the work", "Resources"]);
  expect(p.all("[data-column=work] button").map((e) => e.textContent)).toEqual(["Work ticketssoon", "Investigate0 open", "Huntsoon", "Actorssoon", "My folderssoon"]);
  expect(p.all("[data-column=resources] button").map((e) => e.getAttribute("aria-label"))).not.toContain("Priorities: soon");
});
test("a requester's home has Get help only and no command input", ...);
test("a soon tile opens an explanatory stage", ...);                    // click Hunt → heading "Hunt", the line "Not built yet. This part comes after the investigation slice."
test("which one? lists New investigation first, then cases newest first, and filters", async () => {
  // two cases exist: "Odd traffic" (TLP:GREEN) and "Sign-in burst" (TLP:AMBER)
  p.click("[data-mode=investigate]");
  expect(p.q("h1").textContent).toBe("Investigate: which one?");
  expect(p.all(".tile").map((t) => t.getAttribute("aria-label")!.split(" · ")[0])).toEqual(["New investigation", "Sign-in burst", "Odd traffic"]);
  expect(p.q(".tile.proposed").textContent).toBe("+ New investigation");
  p.fill("[aria-label=Filter]", "amber");
  expect(p.all(".tile").length).toBe(2);
  p.fill("[aria-label=Filter]", "zzz");
  expect(p.text()).toContain("Nothing matches");
  p.press("Escape");
  expect(p.all(".tile").length).toBe(3);
});
test("Enter in the filter opens the first match", ...);
test("a tile's accessible name is its full text, and its chips include the full marking", ...);
test("New investigation creates the case, starts the run and opens it", async () => {
  p.click(".tile.proposed");
  p.fill("[aria-label=Title]", "Odd traffic"); p.fill("[aria-label='What was asked']", "Who is behind the traffic to 198.51.100.77?"); p.fill("[aria-label=Why]", "test");
  p.fill("[aria-label='Starting value 1']", "198.51.100.77");               // type select defaults to the first type, address
  p.fill("[aria-label='Window from']", "2026-11-17T00:00:00.000Z"); p.fill("[aria-label='Window to']", "2026-11-24T00:00:00.000Z");
  expect(p.q("button.primary").textContent).toBe("Create and frame the run");
  p.click("button.primary");
  await p.settle();
  expect(p.win.location.hash).toBe("#/case/CASE-1");
  expect(p.s.app.hub.read("CASE-1").state.run.waiting).toBe("plan");
});
test("a refused new case shows the reason and keeps the fields", ...);   // starting value "not-an-address" → the server's reason as text; Title still filled; no case created
test("the trail offers every level in one activation", ...);            // in a case: home dot, Investigate pill, CASE-1 pill, other cases as dots with their titles as names
test("the jobs indicator counts running jobs", ...);
test("/ focuses the command bar", ...);

// tests/web/commands.test.ts
const ctx = { cases: [{ id: "CASE-1", title: "Odd traffic" }, { id: "CASE-2", title: "Sign-in burst" }], in_case: true, cards: ["c1", "c12"] };
test.each([
  ["CASE-2", { kind: "open_case", id: "CASE-2" }],
  ["investigate case-1", { kind: "open_case", id: "CASE-1" }],
  ["investigate odd traffic", { kind: "open_case", id: "CASE-1" }],
  ["investigate", { kind: "go", to: "investigate" }],
  ["go to home", { kind: "go", to: "home" }],
  ["open pipeline", { kind: "lens", id: "pipeline" }],
  ["run", { kind: "run" }], ["Pause", { kind: "pause" }], ["accept plan", { kind: "accept_plan" }], ["approve", { kind: "approve" }],
  ["verify c12", { kind: "verify", card: "c12" }],
  ["verify c99", { kind: "say", text: "There is no card c99" }],
  ["replay", { kind: "replay", seq: null }], ["replay 137", { kind: "replay", seq: 137 }],
  ["summarize", { kind: "ask", text: "Give a synopsis of this case." }],
  ["what does investigate mean here?", { kind: "ask", text: "what does investigate mean here?" }],
  ["investigate why the host went quiet", { kind: "ask", text: "investigate why the host went quiet" }],
  ["open the pod bay doors", { kind: "ask", text: "open the pod bay doors" }],
  ["run the numbers again", { kind: "ask", text: "run the numbers again" }],
])("%s", (input, intent) => expect(parseCommand(input, ctx)).toEqual(intent));
test("outside a case a question does not go to the agent", () => expect(parseCommand("what is this?", { ...ctx, in_case: false })).toEqual({ kind: "say", text: "Open a case first: investigate CASE-1" }));
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 120 bun test tests/web/home.test.ts tests/web/commands.test.ts`
Expected: FAIL (`parseCommand` not found; the home screen is empty).

- [ ] **Step 3: Implement the views, the routes in `app.ts` (the case screen is a placeholder holding the top bar until Task 6), and `parseCommand`**

- [ ] **Step 4: Run the tests**

Run: `timeout 300 bun test tests/web && timeout 300 bun run typecheck`
Expected: PASS, including the lint.

- [ ] **Step 5: Commit**

```bash
git add src/web tests/web
git commit -m "feat(web): home kiosk, which-one grid, new investigation, trail, top bar and command bar"
```

---

### Task 6: The work area: Incoming, the brief with its phase strip and custody chip, lanes, cards, the shelf and toasts

**Files:**
- Create: `src/web/views/workarea.ts`, `src/web/views/incoming.ts`, `src/web/views/brief.ts`, `src/web/views/lanes.ts`, `src/web/views/card.ts`, `src/web/views/shelf.ts`, `src/web/views/toasts.ts`, `src/web/lenses/index.ts`, `src/web/derive.ts`
- Modify: `src/web/app.ts`, `src/web/main.ts`, `src/web/style.css`, `src/core/state/run.ts`, `src/core/state/index.ts`, `src/pipeline/stages/research.ts`
- Test: `tests/web/workarea.test.ts`, `tests/web/card.test.ts`, `tests/web/derive.test.ts`, `tests/core/state-run.test.ts`

**Interfaces:**
- Consumes: Tasks 4 and 5; the triage and run commands of Task 2; `GET /api/cases/<id>/custody`.
- Produces:

```ts
// src/core/state/run.ts  (the rule moves here from src/pipeline/stages/research.ts, which now calls it)
/** True when the sub-goal's last accepted step finished answered or partial, or came back empty as a proven negative with full coverage on every card. */
export function subgoalAnswered(state: Readonly<CaseState>, subgoal: SubGoal): boolean;

// src/web/derive.ts — pure functions of the state; no DOM
export type IncomingSort = "arrived" | "event_time" | "step" | "source" | "started_by" | "status";
export type IncomingGroup = "none" | "step" | "source" | "started_by" | "type";
export interface IncomingView { sort: IncomingSort; reverse: boolean; group: IncomingGroup }
/** Incoming in display order: pinned cards first within each group, then by the sort; groups in order of their first card. */
export function orderIncoming(state: CaseState, view: IncomingView): { group: string | null; cards: string[] }[];
export type CardStatus = "answered" | "partial" | "proven negative" | "nothing found";
export function cardStatus(card: CardState): CardStatus;
/** "<type>|<value>" for every starting value and every typed cell of a kept card. */
export function knownValues(state: CaseState): Set<string>;
export function goals(state: CaseState): { done: number; of: number };
export type StageMark = "passed" | "passed earlier draft" | "running" | "failed" | "waiting" | "declined" | "blocked" | "idle";
/** A review stage reads "passed" only when it passed the latest draft's hash; a pass on an older draft reads "passed earlier draft". */
export function stageMark(state: CaseState, stage: StageState): StageMark;
/** What Shift+Enter does now, with the words its button carries; null when the run waits on nothing a single key should do. */
export function nextThing(state: CaseState): { label: string; command: "accept_plan" | "approve" | "resume" } | { label: string; lens: LensId } | null;
export function runButton(state: CaseState): { label: string; command: "start_run" | "resume" | null; lens: LensId | null; disabled: boolean };

// src/web/lenses/index.ts
export interface LensDef { id: LensId; key: string; title: string; make(ui: Ui, open: Open, arg: string | null): View }
/** In shelf order. Each lens task adds its entry here; a lens with no entry has no button and no key. */
export const LENSES: LensDef[];

// src/web/views/workarea.ts
export interface WorkArea extends View {
  selected(): string | null;                         // the card that has the selection, in whichever column has focus
  select(card: string | null): void;
  column(): "incoming" | string;                     // "incoming" or a lane id
  focusColumn(column: "incoming" | string): void;
  openCards(): string[]; open(card: string, keep?: boolean): void; close(card: string): void;
  lens(): LensId | null;
}
export function makeWorkArea(ui: Ui, open: Open): WorkArea;
```

**Layout** (guide §5; no file tree). A grid: the top bar; Incoming on the left; the stage to its right holding the brief, then the lanes in a row ending in `+ New lane`; the shelf along the bottom. An open lens docks at the bottom (wide) or on the right (tall); the side is remembered (`prefs` key `dock`). Inner screens are top-aligned and each column scrolls on its own, so nothing recentres as content arrives. Every column root has `tabindex="0"` and `data-area` (`incoming`, `lanes`, `lens`).

**Incoming.** A bar with a sort select (Arrived, Event time, Step, Source, Started by, Status), a reverse button (`↑↓`, name `Reverse order`) and a group select (No groups, Step, Source, Started by, Type); the three choices are remembered (`prefs` key `incoming`). "Started by" is the actor of the card's query (`state.queries[card.query].by.id`), else `card.made_by`. Pinned cards stay on top. The footer reads `J/K move · Space keep · X discard · ? keys`.

**The brief** (spec §10.2). Collapsible with `Hide`/`Show`, remembered (`prefs` key `brief`).

- Line 1: `Brief: <case id> ·` the marking chip `· <title>`; at the right the custody chip and the hide button.
- Line 2: `Asked for: <asked>`, then status buttons that open a lens: `✔ <done>/<of> goals` (Steps; from `goals`), the plan's state in words (`no plan`, `plan proposed`, `plan accepted`, `plan denied`, `re-planning`; Steps), `draft <n>` when there is one (Narrative); at the right the run button (`runButton`), `Pause` (enabled while the run is `running` or `waiting`), `Stop` (asks for a reason in an inline input, then sends `stop`), and the next-thing button when `nextThing` is not null.
- Line 3: the phase strip. Stages in pipeline order, grouped under `ref.phases` by `stage.phase` (the phase title above its group), joined by `▸`. Each stage is a button reading its title and its mark in words and a sign: `✓` passed, `✓ earlier draft` (muted), `● running` (with `● <n> running` when the stage is the run's current one and `n > 1` research jobs are running), `✗ failed`, `◌ waiting`, `declined`, `blocked`. Activating it calls `nav.openLens("pipeline", stage.id)`.
- When the run is paused: an amber line `Paused: <pause_reason>`. When interrupted: `Interrupted: the server stopped during this run.` with the Resume button beside it.
- The custody chip shows `Custody.line` from `api.custody`, as a green tag when `ok` and an amber one otherwise, with the head hash as its tooltip. It is fetched when the case opens, after each `product.published` entry, and when activated. It is labelled as a check, with the time it was made as a tooltip suffix (`checked 14:02`).
- When `state.skipped` is not empty: an amber tag `<n> entries not applied`, whose tooltip lists each as `<seq> <type>: <reason>`.

`runButton`: no run → `Run` / `start_run`; `running` → `Running`, disabled; `paused` or `interrupted` → `Resume` / `resume`; waiting at the plan gate → `Review plan` (Steps lens); at the publish gate → `Review draft` (Narrative lens); `finished` → `Run again` / `start_run`.

`nextThing`: at the plan gate with no costly step in the plan → `Accept plan: run <n> steps` / `accept_plan`; with costly steps → `Review plan: <k> steps need a budget` (Steps lens); at the publish gate when `publishable(state, latest.hash)` → `Approve: publish draft <n>` / `approve`, otherwise `Review draft: <k> blockers` (Narrative lens); `paused` or `interrupted` → `Resume the run` / `resume`; otherwise null.

**Lanes.** One column per lane, in order. The target lane has `aria-current="true"` and the class `target`. A lane header shows its title (tooltip: its sub-goal's question, when it has one), the card count, and a remove button (`×`, name `Remove lane <title>`) only while the lane is empty. Activating the header sends `set_target`. `F2` or a double-click on the title swaps it for an input: `Enter` sends `rename_lane`, `Esc` cancels. `+ New lane` shows an input and sends `add_lane`.

**Cards** (guide §5.1). Closed, top to bottom: the title (bold) and tags; a one-line body; the first three rows of the table when it has rows. Tags, each with its words: `new` (in Incoming and not opened in this session), `partial` (amber; tooltip the reason and detail), `proven negative` (green), `nothing found` (neutral), `pinned`, the maker (`agent` violet, `human` neutral, `system` blue), and after a Verify: `validated <local time>` (green), `differs` (amber), `could not verify` (amber), each with `card.validated.detail` as tooltip. A card with partial coverage never carries `proven negative` (`cardStatus` decides, and its test pins this).

The table: every cell in a column whose `column_types[i]` is not null is a value chip (a button; its name is `<type> <value>`). Activating it calls `nav.pivot(card.id, [{ type, value }])`; activating the column header calls it with every distinct value in the column. A value not in `knownValues(state)` is drawn dashed. Other cells are text. A cell longer than 200 characters is cut with an ellipsis and carries the whole value as its tooltip. Open, the table shows every preview row and the line `<shown> of <row_count> rows`.

Open, a card adds a provenance block as a definition list: Source (the source's title from `ref.sources`, else its id), Query (the exact text, in `pre.query`), Why (prefixed `reasoning as stated by the agent:` when the query's actor is an agent), By (`<kind> <id>`), Marking (chip), When (`timeEl(..., "utc")` of the query's `issued_ts`), Job (the `job` of the `query.issued` entry, when it has one), Coverage (`full`, or `partial: <reason> — <detail>`), If empty (`proven negative` / `not seen`), and each quality note. Then an action row (`role="toolbar"`): `Pivot…`, `Verify`, `Cite`, then by place: in Incoming `Keep`, `Discard`, `Pin`/`Unpin`; in a lane `Move` (a select of the other lanes), `Back to Incoming`, `Discard`, `Pin`/`Unpin`. `Pivot…`, `Verify` and `Cite` call `nav.pivot(card.id, [])`, the Verify panel and the Narrative lens's cite (Tasks 13 and 10); until those tasks they are present and disabled.

Behaviour: a click opens the card and closes the others, unless a card was marked keep-open (`O`); a double-click keeps it. Cards are `tabindex="0"`, `data-card="<id>"`, and are patched in place with `syncList`, keyed by id.

**The shelf.** One button per entry of `LENSES`, reading its title and key letter (`Steps S`). The dock-side button reads `Dock right`/`Dock bottom`. `Esc` closes the lens. This task registers no lens; the shelf is empty until Task 8.

**Toasts.** Bottom-centre, in a container with `role="status"` and `aria-live="polite"`. A toast is its message and, when the action can be undone, an `Undo` button. It leaves after 6 seconds or when dismissed. `ui.act` is now real: it sends the command for the open case; `{ ok: false }` becomes a toast with the refusal joined by `; `; a failed request becomes `The server did not answer.` After `keep`, `move`, `discard` and `send_back` it shows `Kept in <lane>` / `Moved to <lane>` / `Discarded` / `Back in Incoming` with `Undo`, which sends `undo` with no target.

**Replay.** While `store.at` is not null, a banner across the stage reads `Replay · entry <at> of <n> · read-only`, every control that sends a command is disabled, and `ui.act` answers with the toast `Return to live to change the case` without calling the server.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/derive.test.ts  (states built with the fold from hand-made entries; tests/helpers/entries.ts)
test("partial coverage is never a proven negative", () => {
  expect(cardStatus(card({ row_count: 0, empty: "proven-negative", coverage: { kind: "partial", reason: "timeout" } }))).toBe("partial");
  expect(cardStatus(card({ row_count: 0, empty: "proven-negative", coverage: { kind: "full" } }))).toBe("proven negative");
  expect(cardStatus(card({ row_count: 0, empty: "not-seen", coverage: { kind: "full" } }))).toBe("nothing found");
  expect(cardStatus(card({ row_count: 3, empty: null, coverage: { kind: "full" } }))).toBe("answered");
});
test("pinned cards stay on top, and reverse flips the rest", ...);
test("grouping by source keeps groups in order of their first card", ...);
test("goals counts a proven negative as answered and a blocked sub-goal as not", ...);     // { done: 1, of: 2 }
test("a review stage that passed an older draft reads passed earlier draft", ...);
test.each([
  ["no run", null],
  ["plan gate, free steps only", { label: "Accept plan: run 3 steps", command: "accept_plan" }],
  ["plan gate, one costly step", { label: "Review plan: 1 steps need a budget", lens: "steps" }],
  ["publish gate, publishable", { label: "Approve: publish draft 2", command: "approve" }],
  ["publish gate, one blocker", { label: "Review draft: 1 blockers", lens: "narrative" }],
  ["paused", { label: "Resume the run", command: "resume" }],
  ["interrupted", { label: "Resume the run", command: "resume" }],
  ["running", null],
])("the next thing: %s", ...);
// tests/core/state-run.test.ts: subgoalAnswered for answered, partial, empty proven-negative full, empty not-seen, blocked; research.ts's own tests still pass

// tests/web/workarea.test.ts  (p = a page on a sample case at the publish gate)
test("Incoming, the brief, one lane per sub-goal and the shelf are on screen", ...);
test("the brief shows the case, its marking, what was asked, goals, plan and draft", () => {
  expect(p.q(".brief").textContent).toContain("Brief: CASE-1 · TLP:GREEN · Sample");
  expect(p.q(".brief").textContent).toContain("Asked for: Who is behind the traffic to 198.51.100.77?");
  expect(p.q("[data-status=goals]").textContent).toMatch(/^✔ \d\/2 goals$/);
  expect(p.q("[data-status=plan]").textContent).toBe("plan accepted");
});
test("the phase strip groups stages under phases and marks each in words", ...);          // "Direction", "Frame ✓ passed", "Publish ◌ waiting"
test("the custody chip reads chain intact with the entry count", async () => expect(p.q(".custody").textContent).toBe(`chain intact · ${p.s.entries("CASE-1").length} entries`));
test("a deleted blob turns the custody chip amber and names the entry", ...);
test("entries the fold skipped are shown as a warning", ...);                               // a hand-appended malformed entry → "1 entries not applied"
test("keeping a card moves it to the target lane and offers Undo, which puts it back", async () => {
  const card = p.q("[data-area=incoming] [data-card]").dataset.card!;
  p.click(`[data-card=${card}]`); p.click(`[data-card=${card}] [data-action=keep]`);
  await p.settle();
  expect(p.q(".lane.target").querySelector(`[data-card=${card}]`)).not.toBeNull();
  expect(p.toasts()[0]).toMatch(/^Kept in /);
  p.click(".toast [data-action=undo]");
  await p.settle();
  expect(p.q("[data-area=incoming]").querySelector(`[data-card=${card}]`)).not.toBeNull();
});
test("discard never deletes: the card is in state.discarded and Undo restores it", ...);
test("a refusal is a toast with the server's words and changes nothing", ...);              // keep sent for a card a second page already kept → "card c2 is already kept"
test("a double click on Approve publishes once and the second answer is a toast", ...);
test("lanes can be renamed in place, added, and removed only when empty", ...);
test("a paused run shows why, and Resume is the run button", ...);
test("an interrupted run says so and offers Resume", ...);                                  // reopen the page on a case whose ledger ends in run.interrupted
test("while replaying, controls are disabled and commands are not sent", ...);              // store.goTo(5); banner text; click Keep → toast "Return to live to change the case"; head unchanged
test("the dock side and the collapsed brief are remembered", ...);
test("five hundred cards arrive without rebuilding the list", async () => {
  // 500 card.created entries committed straight to the session; the first card's node is the same object before and after
  expect(p.all("[data-area=incoming] [data-card]").length).toBe(500);
  expect(p.q("[data-card=c1]")).toBe(firstNode);
});

// tests/web/card.test.ts
test("a closed card shows title, tags in words and its one-line body", ...);
test("an open card shows where it came from", () => {
  for (const label of ["Source", "Query", "Why", "By", "Marking", "When", "Coverage", "If empty"]) expect(labels).toContain(label);
  expect(p.q("[data-card=c1] pre.query").textContent).toBe(state.queries[state.cards.c1!.query!]!.text);
  expect(p.q("[data-card=c1] time").textContent).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
});
test("an agent's why is labelled as the agent's own account", ...);                        // "reasoning as stated by the agent:"
test("typed cells are chips, untyped cells are text, and a value not yet in the case is dashed", ...);
test("a column header offers every distinct value in the column", ...);                     // nav.pivot called with 3 values
test("hostile source text is shown as text and makes no link", async () => {
  // a hand-made card: title `<img src=x onerror=alert(1)>`, body "see javascript:alert(1) and http://example.net", a cell of 4,096 "A"s, a cell "‮gnp.exe", query error text with <script>
  expect(p.q("[data-card=c9]").querySelectorAll("img, script, a").length).toBe(0);
  expect(p.q("[data-card=c9] .title").textContent).toBe("<img src=x onerror=alert(1)>");
  expect(p.q("[data-card=c9] td.long").textContent!.length).toBeLessThanOrEqual(201);
  expect(p.q("[data-card=c9] td.long").getAttribute("title")!.length).toBe(4096);
});
test("the actions offered follow where the card is", ...);                                  // Incoming: Keep, Discard, Pin; lane: Move, Back to Incoming, Discard, Pin
test("a double click keeps the card", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/derive.test.ts tests/web/workarea.test.ts tests/web/card.test.ts`
Expected: FAIL (`src/web/derive` not found; the case screen is a placeholder).

- [ ] **Step 3: Implement** `subgoalAnswered` (and call it from `research.ts`), `derive.ts`, the views, real `ui.toast` and `ui.act`, and the case screen in `app.ts` (it makes the `CaseStore`, calls `follow`, builds the `Open`, and re-renders through each view's `update()` on every store change, once per animation frame).

- [ ] **Step 4: Run the tests**

Run: `timeout 600 bun test tests/web tests/core tests/pipeline && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web src/core/state src/pipeline/stages/research.ts tests/web tests/core/state-run.test.ts
git commit -m "feat(web): work area with Incoming, brief, phase strip, custody chip, lanes, cards with provenance, shelf and toasts with undo"
```

---

### Task 7: The keyboard map, the "?" card, dragging and motion

**Files:**
- Create: `src/web/keys.ts`, `src/web/views/help.ts`, `src/web/drag.ts`, `src/web/motion.ts`
- Modify: `src/web/views/workarea.ts`, `src/web/views/card.ts`, `src/web/views/lanes.ts`, `src/web/views/incoming.ts`, `src/web/app.ts`, `src/web/style.css`
- Test: `tests/web/keys.test.ts`, `tests/web/drag.test.ts`, `tests/web/motion.test.ts`

**Interfaces:**
- Consumes: Task 6's `WorkArea`, `LENSES`, `nextThing`; Task 5's `Nav`.
- Produces:

```ts
// src/web/keys.ts
export type Area = "anywhere" | "incoming" | "columns" | "lanes" | "lenses" | "replay";
export interface KeyBinding { area: Area; keys: readonly string[]; action: string; label: string }
export const KEYMAP: readonly KeyBinding[];
/** "j", "J" → "j"; with Shift held a letter is "Shift+H"; "?", "/", "[", "]", "0".."9" as typed; "ArrowDown", "Enter", "Shift+Enter", "Shift+Tab", "Escape", "Backspace", "F2", " " → "Space". */
export function keyOf(event: KeyboardEvent): string;
/** The area of the focused element: the nearest ancestor's data-area. Null when focus is in a button, input, textarea, select or link. */
export function areaOf(target: Element | null): Area | null;
/** Finds the binding for the key in the focused area (then "columns" for a column area, then "anywhere") and calls its action. Returns whether one ran; the caller prevents the default when it did. */
export function dispatchKey(event: KeyboardEvent, actions: Readonly<Record<string, () => void>>): boolean;

// src/web/drag.ts
export type DropTarget = { kind: "lane"; lane: string } | { kind: "card"; card: string; half: "upper" | "lower" } | { kind: "incoming" } | { kind: "cite"; section: string };
/** The half of `rect` that `y` falls in. */
export function half(y: number, rect: { top: number; height: number }): "upper" | "lower";
/** What a card dropped on `target` does: the command and its arguments, or null for a drop that does nothing (onto itself; onto Incoming from Incoming). */
export function dropCommand(state: CaseState, card: string, target: DropTarget): { command: string; args: Record<string, unknown> } | null;
/** Wires pointerdown/move/up on [data-card] under `root`. A press that moves less than 5 px is a click. While dragging, the element under the pointer with data-drop decides the target, and a line (class "drop-line") shows where a card would land. */
export function enableDrag(ui: Ui, root: HTMLElement, open: Open, onDrop: (card: string, target: DropTarget) => void): () => void;

// src/web/motion.ts
/** First-Last-Invert-Play for the elements whose keys are given: records their boxes, runs `change`, then slides each from its old box to its new one in 160 ms. With reduced motion it only runs `change`. */
export function flip(ui: Ui, elements: () => HTMLElement[], change: () => void): void;
```

**The keyboard map** (guide §5.2, for the parts in the slice, plus spec §10.2's keys). `KEYMAP` is exactly:

| Area | Keys | Action | Label |
|---|---|---|---|
| anywhere | `?` | `help` | Show keys |
| anywhere | `/` | `command_bar` | Command bar |
| anywhere | `Escape` | `up` | Close, then step up a level |
| anywhere | `Shift+Enter` | `next_thing` | Do what the run waits on |
| incoming | `j`, `ArrowDown` | `next_card` | Next card |
| incoming | `k`, `ArrowUp` | `prev_card` | Previous card |
| incoming | `Space`, `ArrowRight` | `keep` | Keep into the target lane |
| incoming | `x`, `ArrowLeft`, `Backspace` | `discard` | Discard |
| incoming | `p` | `pin` | Pin |
| incoming | `o` | `keep_open` | Keep open |
| incoming | `Enter` | `open_card` | Open |
| incoming | `u` | `undo` | Undo |
| incoming | `c` | `cite` | Cite |
| columns | `Tab`, `l`, `]` | `next_column` | Next column |
| columns | `Shift+Tab`, `h`, `[` | `prev_column` | Previous column |
| columns | `0` | `focus_incoming` | Incoming |
| columns | `1` … `9` (nine bindings, actions `target_1` … `target_9`) | | Set keep target |
| lanes | `j`, `ArrowDown` | `next_card` | Next card |
| lanes | `k`, `ArrowUp` | `prev_card` | Previous card |
| lanes | `Shift+H` | `card_left` | Move the card one lane left |
| lanes | `Shift+L` | `card_right` | Move the card one lane right |
| lanes | `F2` | `rename_lane` | Rename the lane |
| lanes | `Enter` | `open_card` | Open |
| lanes | `x`, `Backspace` | `discard` | Discard |
| lanes | `u` | `undo` | Undo |
| lanes | `c` | `cite` | Cite |
| lenses | `a` `s` `t` `r` `w` `d` `b` `q` `e` (one binding each, actions `lens_agent`, `lens_steps`, `lens_timeline`, `lens_narrative`, `lens_worklog`, `lens_discarded`, `lens_jobs`, `lens_pipeline`, `lens_replay`) | | the lens's title |
| lenses | `v` | `dock_side` | Dock side |
| replay | `j`, `ArrowDown` | `replay_next` | Next entry |
| replay | `k`, `ArrowUp` | `replay_prev` | Previous entry |

The `lenses` bindings apply in every area but `replay`'s `j`/`k` (they are looked up after the focused area and before `anywhere`). `Shift+H` on a card in the first lane sends it back to Incoming (`send_back`); `Shift+L` from the last lane does nothing. `next_thing` performs `nextThing(state)`: its command, or opening its lens. `Escape` closes, in this order: the help card, an open panel, the open lens, the open cards, then `nav.up()`; in Replay it first returns to live. `open_card` opens the card and moves focus to the first button of its action row. A lens key for a lens that is not in `LENSES` does nothing.

Single keys never fire while focus is in a button, input, textarea, select or link (`areaOf` is null there); `Escape` still does, and it first moves focus back to the enclosing card or column.

**The "?" card** is drawn from `KEYMAP` alone: a dialog (`role="dialog"`, `aria-modal="true"`, name `Keys`) with one section per area in the order Anywhere, Incoming, Columns, Lanes, Lenses, Replay, each row the keys as `kbd` elements and the label. It takes focus when it opens and gives it back when it closes.

**Dragging** (decision 5). A card dropped on a lane (its header or its empty space) is kept there (`keep` from Incoming, `move` to the end from another lane). Dropped on the upper or lower half of a card in a lane it goes above or below that card: `keep` or `move` with the index it should end up at, counted after the dragged card is taken out of its old place. Dropped on Incoming from a lane it is sent back (`send_back`). Dropped on a Narrative section it cites the card (Task 10 registers that target). The drop line is a 2px accent line at the landing position. `Esc` during a drag cancels it. After a drop, the moved cards slide with `flip`.

**Motion** (guide §3). Cards slide when they move, a discarded card slides out, the trail's pills shrink smoothly; nothing else animates. `flip` and every CSS transition are off when `ui.reducedMotion()` is true, and the stylesheet's reduced-motion block is the backstop.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/keys.test.ts
test("the map is the one in the plan", () => {
  expect(KEYMAP.map((b) => `${b.area}:${b.keys.join(",")}:${b.action}`)).toEqual(EXPECTED);     // the table above, row by row
});
test("no key is bound twice in one area", ...);
test("every action in the map has a handler, and every handler is in the map", () => {
  expect(Object.keys(actionsOf(p)).sort()).toEqual([...new Set(KEYMAP.map((b) => b.action))].sort());
});
test("the ? card lists every binding, grouped by area, and nothing else", () => {
  p.press("?");
  const rows = p.all("[role=dialog] tr").map((r) => r.textContent);
  expect(rows.length).toBe(KEYMAP.length);
  expect(p.all("[role=dialog] h3").map((e) => e.textContent)).toEqual(["Anywhere", "Incoming", "Columns", "Lanes", "Lenses", "Replay"]);
  p.press("Escape");
  expect(p.doc.querySelector("[role=dialog]")).toBeNull();
});
// One behaviour test per action. In Incoming, on a sample case at the publish gate:
test("J and K, and the arrows, move the selection", ...);
test("Space keeps the selected card into the target lane; ArrowRight does the same", ...);
test("X, ArrowLeft and Backspace discard", ...);
test("P pins and unpins; O keeps a card open while another opens; Enter opens and focuses the first action", ...);
test("U undoes the last keep", ...);
test("Tab, L and ] move to the next column; Shift+Tab, H and [ move back; 0 goes to Incoming", ...);
test("1 to 9 set the keep target to that lane, and a number past the last lane does nothing", ...);
test("in a lane, Shift+L moves the card one lane right and Shift+H one left; from the first lane Shift+H sends it back to Incoming", ...);
test("F2 renames the focused lane", ...);
test("each lens letter opens its lens and V flips the dock side", ...);                       // with stub entries pushed into LENSES for the test
test("/ focuses the command bar and Escape leaves it", ...);
test("Escape closes the lens, then the open cards, then steps up to which one?, then home", ...);
test("Shift+Enter accepts a plan of free steps, approves a publishable draft, and resumes a paused run", ...);   // three cases; the button it triggers reads the same label
test("Shift+Enter on a plan with a costly step opens Steps instead of accepting", ...);
test("typing in a field never triggers a shortcut", () => {
  p.q("[aria-label=Command]").focus();
  for (const k of ["j", "x", " ", "a", "?", "1"]) p.press(k);
  expect(p.s.entries("CASE-1").length).toBe(before);
  expect(p.doc.querySelector("[role=dialog]")).toBeNull();
});
test("a focused button is not a shortcut target, so Space activates the button", ...);

// tests/web/drag.test.ts
test("the upper half drops above and the lower half below", () => {
  expect(half(109, { top: 100, height: 20 })).toBe("upper");
  expect(half(110, { top: 100, height: 20 })).toBe("lower");
});
test.each([
  ["Incoming card onto a lane", "c1", { kind: "lane", lane: "l2" }, { command: "keep", args: { card: "c1", lane: "l2" } }],
  ["Incoming card onto the upper half of the second card of l1", "c1", { kind: "card", card: "c5", half: "upper" }, { command: "keep", args: { card: "c1", lane: "l1", index: 1 } }],
  ["lane card below a later card of its own lane", "c4", { kind: "card", card: "c6", half: "lower" }, { command: "move", args: { card: "c4", lane: "l1", index: 2 } }],
  ["lane card onto another lane", "c4", { kind: "lane", lane: "l2" }, { command: "move", args: { card: "c4", lane: "l2", index: 0 } }],
  ["lane card onto Incoming", "c4", { kind: "incoming" }, { command: "send_back", args: { card: "c4" } }],
  ["a card onto itself", "c4", { kind: "card", card: "c4", half: "upper" }, null],
  ["Incoming card onto Incoming", "c1", { kind: "incoming" }, null],
])("%s", (_name, card, target, expected) => expect(dropCommand(state, card, target as DropTarget)).toEqual(expected));   // l1 holds c4, c5, c6; l2 is empty
test("a press that does not move is a click, not a drag", ...);
test("dragging a card onto a lane keeps it there", async () => {
  // boxes are stubbed on the elements (happy-dom lays nothing out); pointerdown on the card, pointermove 40 px, pointerup over the lane
  expect(state().cards.c1).toMatchObject({ place: "lane", lane: "l2" });
});
test("a line shows where the card would land, and Escape cancels the drag", ...);

// tests/web/motion.test.ts
test("flip slides moved elements, and with reduced motion only makes the change", () => {
  const moving = page({ reducedMotion: false }); const still = page({ reducedMotion: true });
  // el.animate is stubbed to count calls
  expect(animateCalls(moving)).toBeGreaterThan(0);
  expect(animateCalls(still)).toBe(0);
});
test("the stylesheet turns every transition and animation off under prefers-reduced-motion", () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after\s*\{[^}]*transition: none !important;[^}]*animation: none !important;/);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/keys.test.ts tests/web/drag.test.ts tests/web/motion.test.ts`
Expected: FAIL, `Cannot find module "../../src/web/keys"`.

- [ ] **Step 3: Implement** `keys.ts`, the help card, `drag.ts`, `motion.ts`, and one `keydown` listener on the document in `app.ts` that calls `dispatchKey` with the actions of the screen in front.

- [ ] **Step 4: Run the tests**

Run: `timeout 600 bun test tests/web && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web tests/web
git commit -m "feat(web): keyboard map with its help card, pointer dragging to keep and move, and motion that respects reduced motion"
```

---

### Task 8: Lenses: Steps with the plan gate, Timeline, Worklog, Discarded, Jobs

**Files:**
- Create: `src/web/lenses/steps.ts`, `src/web/lenses/timeline.ts`, `src/web/lenses/worklog.ts`, `src/web/lenses/discarded.ts`, `src/web/lenses/jobs.ts`, `src/web/describe.ts`, `src/server/plan-commands.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/style.css`, `src/core/types.ts`, `src/core/state/types.ts`, `src/core/state/index.ts`, `src/core/state/run.ts`, `src/pipeline/plans.ts`, `src/server/app.ts`
- Test: `tests/web/steps.test.ts`, `tests/web/lenses-simple.test.ts`, `tests/web/describe.test.ts`, `tests/server/plan-commands.test.ts`, `tests/pipeline/plans.test.ts`, `tests/core/state-run.test.ts` (and the `HANDLED` lists in `tests/core/state-cards.test.ts` and `tests/core/state-analysis.test.ts`)

**Interfaces:**
- Consumes: Task 2's `defineCommand`; Task 6's `LENSES`, `View`, `Open`; `runPivot`, `runProposal`.
- Produces:
  - Entry type `"step.estimated": { step: string; estimate: Cost | null; query: string | null }` in `Payloads` and `ENTRY_TYPES`. `query` is the estimate query the source answered, when there was one.
  - `PlanState.estimates: Record<string, Cost | null>`, `{}` in `initial()` and after every `plan.proposed`. The reducer sets `estimates[step]` when the step is in the current plan; a malformed payload is recorded in `skipped`.
  - `estimateStep(session: CaseSession, deps: RunnerDeps, input: { step: string; actor: Actor }): Promise<Cost | null>` in `src/pipeline/plans.ts`. Throws `PlanRefused`.
  - Commands `estimate_step { step }`, `run_proposal { proposal, budget }`, `reject_proposal { proposal, reason }`; none advances.
  - `describe(entry: Entry, ref: Reference): { what: string; detail: string }` in `src/web/describe.ts`, used by the Worklog, the Timeline and Replay.
  - `LENSES` gains `steps` (`S`, "Steps"), `timeline` (`T`, "Timeline"), `worklog` (`W`, "Worklog"), `discarded` (`D`, "Discarded"), `jobs` (`B`, "Jobs").

**`estimateStep`.** Only a person; only while the plan is `proposed`; the step exists and is not free (`step <id> is free and needs no estimate`); its `from.value` is not empty (`step <id> starts from what an earlier step finds; it can be priced only after that step has run`). It calls `runPivot` with the step's pivot, value and window, `why: "estimate for plan step <id>"`, the person as actor, `step: <id>` and no budget. The runner prices the query (recording an estimate query when the source must be asked) and returns `needs_budget`; the function then commits `step.estimated` with that estimate and the id of the estimate query issued for this step since the call began, or null. A `refused` result throws `PlanRefused` with the runner's reasons. Nothing but an estimate ever runs.

**`run_proposal`** calls `runProposal(session, deps.runner, { proposal, budget, actor })` and waits for it. `refused` → a `Refused` with the reasons; `needs_budget` → a `Refused` reading `the estimate is <amount> <unit>; the budget does not cover it` (or `this query needs a budget`); `done` and `failed` are both a done command: the outcome is in the ledger. **`reject_proposal`** writes `proposal.rejected` for an open proposal, and is refused for any other.

**Steps** (guide §7, spec §9.3). With no plan: `No plan yet.` With one:

- A header: the goal line; the window; `<f> free steps · <c> costly steps`; and the sum of known estimates per unit (`estimate so far: 1 lookups`, or `no estimate yet`).
- Then each sub-goal: its title, its question, and `answered` (green) or `open` (amber) from `subgoalAnswered`. Under it each step as a row: at the gate a checkbox (checked by default); the pivot's title and the source's title; `from <type> <value>` or `from an earlier step`; `free`, or `costly` with the estimate (`1 lookups`), an `Estimate` button when there is none and the step can be priced, and at the gate a budget input (name `Budget for <step>, in <unit>`); `needs a window` when it does; `if empty: proven negative` or `if empty: not seen`; each warning as an amber tag; and, once accepted, the step's status in words with its cards as chips. A step left out of the accepted plan reads `not accepted`.
- While the run waits at the plan gate, the buttons: `Run the free steps now (<f>)` → `accept_plan` with the ids of every free step; `Accept: run <n> steps` → `accept_plan` with the checked steps and the budgets entered for checked costly steps, disabled while a checked costly step has no budget above zero (its tooltip names the steps); `Deny` → asks for a reason, then `deny_plan`; `Re-plan` → asks for a note, then `replan`. The whole plan is drawn dashed until accepted. At any other time there are no buttons, and the line under the header reads the plan's state (`accepted`, `denied`, `re-planning`).
- A section `Waiting for a budget` when there are open `costly_query` proposals not tied to a step with a plan budget: each with its title, who proposed it, why (labelled as the agent's own account), the estimate, a budget input, `Run: spend up to <n> <unit>` → `run_proposal`, and `Reject` → asks for a reason, then `reject_proposal`.

**Timeline.** One row per card, query, stage start and finish, gate, draft revision and published product, ordered by time (a card by its `event_time` when it has one, else when it was made), newest last; each row a local time (UTC as tooltip), an actor tag and the `describe` text. Rows for cards not kept are muted (`class="muted"`). Activating a card row calls `nav.focusCard`.

**Worklog.** One row per entry: UTC time with milliseconds, the actor tag in words (`human`, `agent`, `system`), the actor id, and `describe(entry).what`. A filter of three checkboxes (Human, Agent, System).

**Discarded.** Every card in `state.discarded`, newest first, each with its title, tags and a `Restore` button → `restore`. Empty: `Nothing discarded.`

**Jobs.** Every job, running first then newest first: title, kind, status in words, source title, and duration (`running for 12 s`, or `took 3.2 s`). Empty: `No jobs yet.`

**`describe`** gives, for every entry type in `ENTRY_TYPES`, a short plain sentence in `what` (for example `query issued`, `card created`, `plan accepted`, `stage sent back`) and the particulars in `detail` (for `query.issued`: `<source> · <text> · why: <why>`; for `query.result`: `<rows> rows · <full coverage | partial: reason> · sha256 <first 4 of blob>…`; for `card.created`: `<id> "<title>"`; for `stage.sent_back`: `<from> → <to>: <reason>`). Text from entries goes in as text.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/pipeline/plans.test.ts
test("a costly step with a starting value can be priced; the estimate is recorded and nothing else runs", async () => {
  // the sample at the plan gate; s3 is the reputation lookup
  const before = session.entries().length;
  const cost = await estimateStep(session, deps.runner, { step: "s3", actor: human });
  expect(cost).toMatchObject({ unit: "lookups" });
  expect(session.state.plan.estimates).toEqual({ s3: cost });
  expect(session.entries().slice(before).filter((e) => e.type === "query.result" && session.state.queries[e.payload.query]!.purpose === "result")).toEqual([]);
  expect(Object.keys(session.state.cards).length).toBe(cardsBefore);
});
test("a free step, a step fed by an earlier step, an agent and an accepted plan are each refused", ...);
// tests/core/state-run.test.ts: step.estimated sets plan.estimates; a new plan.proposed clears it; a malformed payload is skipped; an unknown step changes nothing

// tests/server/plan-commands.test.ts
test("estimate_step, run_proposal and reject_proposal never move the run", ...);
test("run_proposal with a budget below the estimate is refused and leaves the proposal open", ...);
test("reject_proposal closes an open proposal and is refused for one already closed", ...);

// tests/web/steps.test.ts  (the sample at the plan gate)
test("the plan is a dashed proposal with its goal, counts, sub-goals and steps", () => {
  p.press("s");
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(true);
  expect(p.q(".lens .counts").textContent).toBe("2 free steps · 1 costly steps");
  expect(p.all(".lens .subgoal h3").map((e) => e.textContent)).toEqual(["Who is behind the traffic", "Is the address known to be bad"]);
});
test("Accept is disabled until every checked costly step has a budget, and says which", ...);    // title "s3 needs a budget"
test("Estimate prices a costly step and the figure appears from the ledger", async () => {
  p.click("[data-step=s3] [data-action=estimate]");
  await p.settle();
  expect(p.q("[data-step=s3] .estimate").textContent).toMatch(/^\d+ lookups$/);
});
test("Run the free steps accepts only the free ones", ...);                // plan.accepted.steps is the two free ids; s3 reads "not accepted"
test("Accept sends the checked steps and their budgets, and the run goes on to the publish gate", async () => {
  p.fill("[aria-label='Budget for s3, in lookups']", "1");
  expect(p.q("[data-action=accept]").textContent).toBe("Accept: run 3 steps");
  p.click("[data-action=accept]");
  await p.settle();
  expect(state().run.waiting).toBe("publish");
  expect(p.q(".lens .plan").classList.contains("proposed")).toBe(false);
  expect(p.all(".lane").length).toBe(2);                                    // one lane per sub-goal
});
test("Deny needs a reason and ends the run; Re-plan needs a note and brings a new plan", ...);
test("nothing has run before acceptance", ...);                             // no step.started, and no query with purpose "result" that names a step, before plan.accepted
test("an open costly proposal can be run with a budget or rejected with a reason", ...);

// tests/web/lenses-simple.test.ts  (a published sample case)
test("the Worklog shows who did what in UTC with milliseconds and filters by kind of actor", ...);
test("the Timeline orders by time and mutes cards that are not kept", ...);
test("Discarded lists discarded cards and Restore brings one back to Incoming", ...);
test("Jobs lists every job with status, source and duration", ...);
test("each lens opens with its key and closes with Escape", ...);

// tests/web/describe.test.ts
test("every entry type has a description", () => {
  for (const type of ENTRY_TYPES) expect(describe(sampleOf(type), ref).what).not.toBe("");
});
test("a query result with partial coverage says partial and why", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/steps.test.ts tests/web/lenses-simple.test.ts tests/web/describe.test.ts tests/server/plan-commands.test.ts tests/pipeline/plans.test.ts`
Expected: FAIL (`estimateStep` not exported; the `s` key opens nothing).

- [ ] **Step 3: Implement** the entry type and its reducer, `estimateStep`, the three commands, `describe`, and the five lenses.

- [ ] **Step 4: Run the tests**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS (the whole suite: an entry type was added).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(web): Steps lens with the plan gate and asked-for estimates; Timeline, Worklog, Discarded and Jobs lenses"
```

---

### Task 9: The Pipeline lens: stages, model and effort, context, transcript, feedback

**Files:**
- Create: `src/web/lenses/pipeline.ts`, `src/web/stagerecord.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/style.css`
- Test: `tests/web/pipeline.test.ts`, `tests/web/stagerecord.test.ts`

**Interfaces:**
- Consumes: `api.models`, `api.blobText`; commands `set_model`, `set_budget`, `set_pack_limit`, `feedback`, `resume`; `runUsage` from `src/core/state/`.
- Produces:

```ts
// src/web/stagerecord.ts — pure; built from the entries the store holds
export interface TurnRecord {
  request: string; seq: number; ts: string; actor: string; model: string; effort: string | null; where: Where; marking: Marking;
  pack: PackItem[]; left_out: PackItem[]; chars: number; messages: BlobRef;
  /** "answered" with the response; "declined" with the reason; "blocked"; "failed" (stop "error"); "interrupted" when no answer came before the run was interrupted or the ledger ends; "pending" while the run is live. */
  outcome: "answered" | "declined" | "blocked" | "failed" | "interrupted" | "pending";
  response: BlobRef | null; reasoning: BlobRef | null; served_by: string | null; reason: string | null;
  calls: { call: string; tool: string; why: string; ok: boolean | null; summary: string | null }[];   // ok null: no tool.returned (shown as interrupted or pending, as above)
}
export interface StageRecord { stage: string; attempts: number; turns: TurnRecord[]; sendbacks: { from: string; to: string; reason: string; count: number; ts: string }[]; blocked: { marking: Marking; model: string; where: Where; ts: string }[] }
export function stageRecord(entries: readonly Entry[], stage: string, upTo?: number): StageRecord;
```

`LENSES` gains `pipeline` (`Q`, "Pipeline"). Opened with a stage id as its argument (from the phase strip), it scrolls to and expands that stage.

**The lens** (spec §10.2, §8.3). First a line for the run: its status in words; `model use: <input> in · <output> out · <reasoning> reasoning · <calls> calls` from `runUsage(state)`; and a budget control (`Run budget, in tokens`, a number input and `Set`, or `No budget` → `set_budget`). Then one row per stage of the run, in order, each a `details` element whose summary is the stage's title, its mark in words (`stageMark`), its attempt count and its `last_reason` when it has one. Expanded:

- **Model and effort.** For a stage that runs an agent: a model select listing every `ModelView` as `<model> · <this machine | your network | hosted>`, and an effort select of the chosen model's `efforts` (disabled, reading `no effort setting`, when it has none). A model that is not `allowed` is a disabled option whose text ends ` (not allowed: <reason>)`. Choosing sends `set_model`. The current choice is `state.run.stages[i].model`. Script and human stages read `runs a script` / `waits for you` instead.
- **When the stage is declined:** an amber line `The model declined: <reason>` and `Choose another model above, then resume` with a `Resume` button. **When blocked:** the pause reason, the model select, and a select `Strictest marking this stage may be given` (`No limit`, then `me.markings`) → `set_pack_limit`, with `Resume`.
- **Context.** The latest turn's pack as chips, each `<kind> <title>` (fixed items first and marked `fixed`), the size (`52k chars`), and, when anything was left out, `Left out: <kind> <id>, …` in amber.
- **Transcript.** Each turn, oldest first: the actor, model, where it ran, the marking that applied, and the outcome in words. `Show` fetches the messages and the response with `api.blobText` and shows each message as its role and its text in `pre`; a response's reasoning text is shown under the label `reasoning as stated by the agent`. Both have a `raw bytes` file link (`api.blobPath`).
- **Tool calls.** Under each turn: `<tool> — why: <why>` (the why labelled as the agent's own account), then `ok`/`failed` and the summary; a call with no return reads `interrupted` or `pending`.
- **Send-backs.** `<from> → <to> (<count> of 3): <reason>`, each with its time.
- **Feedback** (the stage whose role is feedback, spec §9.7): the measures of performance recorded for the run (`state.feedback` of kind `mop`: measure title, value, note), and for each measure of effectiveness of the case's objective (`ref.objectives`) a value input, a note input and `Record` → `feedback`. Recorded ones are listed with their values.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/stagerecord.test.ts
test("a stage's turns pair each request with its response, in order, with their tool calls", ...);     // from a published sample run: research has ≥ 2 turns, each call has ok true and a summary
test("a declined request, a blocked call and a failed response are each recorded as themselves", ...);
test("a request with no answer before run.interrupted reads interrupted; with a live run it reads pending", ...);
test("a tool call with no return before run.interrupted reads interrupted", ...);
test("upTo cuts the record at that entry", ...);

// tests/web/pipeline.test.ts
test("Q opens the lens with one row per stage and its state in words", ...);
test("clicking a stage in the phase strip opens the lens at that stage", ...);
test("the model list marks a model the case's marking may not go to as disabled, with the reason", async () => {
  // a TLP:RED case and a second model manifest with where: hosted
  const opt = p.q("[data-stage=frame] select[aria-label=Model] option[disabled]");
  expect(opt.textContent).toEndWith("(not allowed: TLP:RED may not go to a hosted model)");
});
test("choosing a model writes stage.model_set, and effort is disabled for a model without one", ...);
test("the context a stage was given is shown as chips with its size, and what was left out is named", ...);
test("Show fetches the transcript and renders it as text", async () => {
  // a response blob holding "<b>bold</b>" stays text
  expect(p.q("[data-stage=assemble] .transcript").querySelectorAll("b").length).toBe(0);
});
test("reasoning is labelled as stated by the agent", ...);
test("a send-back is listed with its reason and count", ...);                 // the sample script has one
test("a declined stage says so in amber and offers Resume", ...);
test("a blocked stage offers the pack limit and Resume", ...);
test("the run's model use is shown and a budget can be set", ...);
test("after publishing, measures of performance are listed and a measure of effectiveness can be recorded", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/stagerecord.test.ts tests/web/pipeline.test.ts`
Expected: FAIL, `Cannot find module "../../src/web/stagerecord"`.

- [ ] **Step 3: Implement `stagerecord.ts` and the lens**

- [ ] **Step 4: Run the tests**

Run: `timeout 600 bun test tests/web && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web tests/web
git commit -m "feat(web): Pipeline lens with per-stage model and effort, context, transcript, tool calls, send-backs and feedback"
```

---

### Task 10: The Narrative lens and the publish gate

**Files:**
- Create: `src/web/lenses/narrative.ts`, `src/web/markdown.ts`, `src/core/state/cites.ts`, `src/server/draft-commands.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/views/card.ts`, `src/web/drag.ts`, `src/web/app.ts`, `src/web/style.css`, `src/agents/draft.ts`, `src/core/state/index.ts`, `src/server/app.ts`, `sample/scripts/sample-run.yaml`
- Test: `tests/web/narrative.test.ts`, `tests/web/markdown.test.ts`, `tests/server/draft-commands.test.ts`, `tests/agents/draft.test.ts`

**Interfaces:**
- Consumes: commands `approve`, `reject`, `revise`, `answer_challenge`, `reject_proposal`; `api.preview`, `api.bundlePath`; `blockers`, `publishable`, `latestDraft`.
- Produces:
  - `src/core/state/cites.ts` (browser-safe): `CARD_REF` and `cardRefs(text): string[]`, moved from `src/agents/draft.ts`, which re-exports them. The existing test that holds check 6 to the same pattern now reads this file.
  - Command `accept_proposal { proposal, text?: string }` (decision 9), `then: "advance"`: refused unless the proposal is an open `narrative` one and the case has a draft (`there is no draft yet to put this in`); calls `engine.revise` with the latest product and that section replaced by `text ?? proposal.text`, reason `accepted proposal <id>`; then commits `proposal.accepted { proposal, budget: null }`. A refused revise leaves the proposal open.
  - `narrativeMarkdown(state: CaseState, ref: Reference): string` in `src/web/markdown.ts`.
  - `Nav` gains `cite(card: string): void`: opens the Narrative lens in edit mode and inserts `[<card>]` at the caret of the section last focused (Summary by default).
  - `LENSES` gains `narrative` (`R`, "Narrative").
  - `sample/scripts/sample-run.yaml` gains, after each one's existing turns, one more passing turn for the evaluator, the adversary and the publisher (no findings; no new challenge; the same title and note), so a person's edit can be reviewed again in the sample. The scripted provider answers by position, so turns added at the end change nothing in the existing run: `tests/sample/full-run.test.ts` must pass unchanged.

**The lens** (guide §5.3, spec §9.5). With no draft: `No draft yet.` and any open narrative proposals. With one, top to bottom:

- A head line: `Draft <n> · <first 8 of hash> · by <author>` and the marking chip. The whole draft is drawn dashed (`proposed`) unless its hash is the `draft_hash` of the newest published product, in which case it is solid and the line reads `Published as product <n>` with a file link per bundle file.
- The sections in order: Summary, Key findings, Gaps and limits, Alternatives, Assessment. Text sections are paragraphs in which each citation (`cardRefs`) is a card chip that calls `nav.focusCard`; a chip for a card that is not kept is dashed. Each key finding shows its statement, `Likelihood: <term>`, `Confidence: <level> — <basis>`, its cites as chips, `Assumptions` as a list apart from the evidence, and `Reasoning` labelled `judgment`.
- **Review of this revision**, from `state.reviews[hash]`: each check as `✓ <check>` or `✗ <check>` with its findings (`<where>: <message>`); the evaluation the same way; each challenge with its severity (`must address` amber, `consider` neutral), its text, and either its answer (`revised` / `rebutted`, with the text) or, for an open one, an answer form (a text area, a choice of `Revised` or `Rebutted`, `Answer`) → `answer_challenge`. Then `blockers(state, hash)` as an amber list under `Cannot be published yet`, or `Nothing blocks publishing` in green.
- **Bundle preview**, while the run waits at the publish gate: `api.preview`, one tab per file, the text in `pre`; `{ reasons }` is shown as a list.
- **The gate**, only while `run.waiting === "publish"`: `Approve: publish draft <n>` → `approve`, disabled with the blockers as its tooltip unless `publishable`; `Edit`; `Reject` → asks for a reason and offers a checkbox `and stop the run`, then `reject`.
- **Edit**, available whenever a run is in progress and there is a draft (spec §9.5: an edit before the gate is allowed too): a text area per text section; per finding, inputs for statement, likelihood, confidence (a select of low, moderate, high), basis, cites (card ids separated by commas), assumptions (one per line) and reasoning; a required `Reason for the edit`; `Save as draft <n+1>` → `revise` with the whole product (unedited fields as they were; `sources`, `objective`, `question`, `marking`, `change` and `assumptions` carried over), and `Cancel`. Typing `#` in a section opens a picker of kept cards (title and id); choosing one inserts `[<id>]`. Dropping a card on a section (drop target `{ kind: "cite", section }`) does the same. Under the form: `An edit goes back through checks, evaluation and challenge before it can be published.`
- **Proposals.** Each open `narrative` proposal as a dashed block: `Proposed <section> · by <who>`, its text, and `Accept` → `accept_proposal`, `Edit` (the text becomes editable; `Accept as edited` sends `text`), `Discard` → `reject_proposal` with reason `discarded`.
- `Copy as Markdown` copies `narrativeMarkdown(state, ref)` with `ui.win.navigator.clipboard.writeText`; when that is missing or refuses, the Markdown is shown in a read-only text area, selected.

**`narrativeMarkdown`**: the marking on the first and last line; `# <case title>`; the five sections under `##` headings; then `## Provenance`, with every cited card expanded: its id and title, source, the exact query text in a fenced block (the fence is made longer than any run of backticks in the text), why, by, when in UTC, marking, coverage and row count.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/server/draft-commands.test.ts
test("accepting a narrative proposal makes a new revision in the person's name and review starts again", async () => {
  // at the publish gate; a hand-made proposal.created { kind: "narrative", section: "summary", text: "A new summary [c1]." }
  await s.command(id, "accept_proposal", { proposal: "p9" });
  await s.app.hub.idle();
  const d = latestDraft(state())!;
  expect(d.product.summary).toBe("A new summary [c1].");
  expect(d.author).toEqual({ kind: "human", id: s.config.user });
  expect(state().proposals.p9!.status).toBe("accepted");
  expect(state().run.waiting).toBe("publish");                              // the scripted reviewers pass it again
  expect(blockers(state(), d.hash)).toEqual([]);
});
test("with no draft it is refused and the proposal stays open", ...);       // 409, refused: ["there is no draft yet to put this in"]
test("a costly_query proposal is not a narrative one", ...);

// tests/web/narrative.test.ts  (the sample at the publish gate)
test("the draft is dashed, numbered and hashed, with five sections and citations as chips", ...);
test("a cited card that is not kept is a dashed chip, and a chip opens the card", ...);
test("each finding shows its likelihood, confidence and basis, with assumptions apart from evidence", ...);
test("check results, the evaluation and challenges with their answers are shown for this revision", ...);   // eleven "✓" rows on the sample
test("Approve says what it will do, is enabled only when nothing blocks, and publishes", async () => {
  expect(p.q("[data-action=approve]").textContent).toBe(`Approve: publish draft ${latest.n}`);
  p.click("[data-action=approve]");
  await p.settle();
  expect(state().run.outcome).toBe("published");
  expect(p.q(".lens .draft").classList.contains("proposed")).toBe(false);
  expect(p.all(".lens a[href*='/published/1/']").map((a) => a.textContent)).toEqual(["product.md", "product.json", "provenance.md", "provenance.json", "manifest.json"]);
});
test("with a blocker, Approve is disabled and the blockers are listed", ...);     // a hand-raised must_address challenge → "Challenge x2 must be addressed"
test("answering the challenge removes the blocker", ...);
test("the bundle preview shows the files approve would write", ...);
test("an edit makes a new revision by the person and sends it back through review", async () => {
  p.click("[data-action=edit]");
  p.fill("[aria-label=Summary]", "Edited summary [c1].");
  p.fill("[aria-label='Reason for the edit']", "clearer");
  expect(p.q("[data-action=save]").textContent).toBe(`Save as draft ${latest.n + 1}`);
  p.click("[data-action=save]");
  await p.settle();
  expect(latestDraft(state())!.author.kind).toBe("human");
  expect(p.s.entries("CASE-1").filter((e) => e.type === "check.run" && e.payload.draft_hash === latestDraft(state())!.hash).length).toBe(11);
});
test("an edit with no reason is not sent", ...);
test("# opens a picker of kept cards and inserts the citation; dropping a card on a section does the same", ...);
test("Reject needs a reason; with stop ticked the run ends", ...);
test("a narrative proposal can be accepted, edited then accepted, or discarded", ...);
test("the lens edits nothing while replaying", ...);

// tests/web/markdown.test.ts
test("the Markdown has the marking first and last, the five sections, and each cited card's provenance", ...);
test("a query holding backticks cannot break out of its fence", ...);             // text "select ```; # heading" → the fence is four backticks
// tests/agents/draft.test.ts: CARD_REF is exported from src/core/state/cites.ts and from src/agents/draft.ts, and they are the same object
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/narrative.test.ts tests/web/markdown.test.ts tests/server/draft-commands.test.ts`
Expected: FAIL (unknown command `accept_proposal`; the `r` key opens nothing).

- [ ] **Step 3: Implement** the move of `CARD_REF`, the command, `narrativeMarkdown`, the lens, `nav.cite`, and enable the card's `Cite` action.

- [ ] **Step 4: Run the tests**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(web): Narrative lens with the publish gate, edits that go back through review, proposals and Markdown copy"
```

---

### Task 11: Your agent: the conversational agent and the Agent lens

**Files:**
- Create: `src/server/converse.ts`, `src/web/lenses/agent.ts`, `sample/context/personas/assistant.md`
- Modify: `src/agents/loop.ts`, `src/server/app.ts`, `src/server/roles.ts`, `src/core/wire.ts`, `src/web/api.ts`, `src/web/lenses/index.ts`, `src/web/app.ts`, `src/web/style.css`, `sample/context/profile.yaml`, `sample/scripts/sample-run.yaml`
- Test: `tests/server/converse.test.ts`, `tests/web/agent.test.ts`, `tests/agents/loop.test.ts`

**Interfaces:**
- Consumes: `runAgent`, `assemblePack`, `packBudget`, `stageParts`, `casePart`, `packPart`, `partOf`, `draftPart` (`src/pipeline/stages/agent.ts`), `cardRefs`; Task 2's `defineCommand` and `CaseHub.background`.
- Produces:
  - `AgentSpec.outside_run?: boolean` in `src/agents/loop.ts`: when true, the loop does not stop because the run is paused or finished and does not apply the run's token budget. Everything else (the marking check before every call, the entries written) is unchanged.
  - `src/server/converse.ts`:

```ts
export class AskRefused extends Refused {}
/** The parts your agent would be given now, in priority order, before anything is left out. */
export function agentParts(session: CaseSession, deps: EngineDeps, added: readonly string[]): PackPart[];
export function agentView(session: CaseSession, deps: EngineDeps): Promise<AgentView>;
/** Writes agent.asked and returns; the model turn goes on in the background and ends in agent.answered, or in the loop's own record of a decline, a block or an error. */
export function ask(ctx: CommandContext, input: { text: string; left_out: string[]; added: string[] }): Promise<void>;
```

  - In `src/core/wire.ts`: `export interface PartView { key: string; kind: string; id: string; title: string; chars: number; fixed: boolean; marking: Marking | null; excerpt: string }` (`key` is `<kind>:<id>`; `excerpt` is the first 600 characters) and `export interface AgentView { agent: string; profile: string; objective: string | null; model: ModelChoice | null; budget_chars: number | null; parts: PartView[]; addable: { key: string; title: string }[] }`.
  - Route `GET /api/cases/<id>/agent` → `agentView` (a `Reading` named `agent`); `Api.agent(caseId): Promise<AgentView>`.
  - Commands, none advancing: `ask { text, left_out: string[], added: string[] }`; `propose_answer { turn, section }` (section one of `summary`, `gaps_and_limits`, `alternatives`, `assessment`); `keep_answer { turn }`.
  - `LENSES` gains `agent` (`A`, "Agent"); `nav.ask(text)` opens it and sends the text.

**The agent** (decision 8; spec §8.5; guide §6).

- The sample profile gains a stage `agent`: `{ agent: assistant, persona: assistant, goal: "Answer the analyst's questions from the case as it stands. Cite cards as [c1]. Say what is not known. You propose; the analyst decides." }`, and `sample/context/personas/assistant.md` (six lines, in the style of the other personas). The sample script gains two turns for actor `assistant`, each a plain `content` answer that cites `[c1]`.
- The model is `state.stage_models.agent`, else the model of the pipeline's stage whose role is `assemble`. With neither, or a provider that does not list it, `ask` is refused before anything is written: `Your agent has no model. Choose one in the Agent lens.`
- The parts, in priority order: `stageParts(registry, profile, "agent", { schema: null, objective })`; `casePart(state)`; the latest draft (`draftPart`), when there is one; each kept card, newest first (`packPart({ card, registry })`); each earlier answered turn of the conversation, newest first, as `packPart({ kind: "turn", id: <turn>, title: "Earlier: <first 60 characters of the question>", text: "Asked: <question>\nAnswered: <answer>", fixed: false, entries, written_by: [<its agent.answered entry>], floor: null })`; then each `added` key (`skill`, `procedure`, `reference` or `lesson` only) through `partOf`. A key in `left_out` removes that part; a fixed part's key in `left_out`, an unknown key, or an `added` key of another kind is refused (`the base rules and the case cannot be left out`; `unknown context item <key>`).
- `ask`: `text`, trimmed, is 1 to 4,000 characters. One commit writes `agent.asked { turn, text, left_out, added }` in the person's name. Then, through `hub.background`: the pack is assembled (`assemblePack` with `packBudget(<the model's context>)`, the case's marking, and `state.pack_limits.agent ?? null`), and `runAgent` is called with the actor `{ kind: "agent", id: "assistant", stage: "agent", profile, model, effort, where }`, `task: text`, `tools: []`, `schema: null`, `outside_run: true`, and a tool context with no run, stage, job, draft or sub-goal. On `done`, one commit in the agent's name writes `agent.answered { turn, request: <the id of that actor's newest model.request>, text: <content>, cites: <cardRefs(content) that are cards of the case> }`. Any other end writes nothing more: the loop has already recorded the decline, the block or the error.
- `propose_answer` (the person's button): for an answered turn, one commit writes `proposal.created` with `{ id, kind: "narrative", title: "Your agent's answer as <Section title>", by: "assistant", section, text: <the answer>, cites: <its cites> }`. Nothing is put in the draft until the person accepts it in the Narrative lens (Task 10).
- `keep_answer`: for an answered turn, one commit writes `card.created` with a card of kind `note`, `made_by: "agent"`, title `Note: <first 60 characters of the question>`, body the answer (cut at 4,000 characters), `why` the question, no query, no rows, and `marking` the marking of the `model.request` that produced the answer.

**The lens** (guide §6).

- A head line: `agent: assistant · Profile: <profile title> · serves <objective title | no objective> · tools: none`, with the model and effort selects for stage `agent` (as in the Pipeline lens).
- `Loaded for this turn (<n>k chars):` and the parts as chips, each reading its title; a chip that is not fixed has a `×` button (name `Leave out <title>`) that leaves it out of the next turn; fixed chips have none. `Restore <n> left out` appears when any is left out. A select `+ Add a skill, SOP or lesson…` lists `addable`. Selecting a chip shows its excerpt under the row. What was left out and added is sent with the next `ask` and kept until changed.
- `Quick asks:` four buttons that send fixed questions: `Synopsis` → `Give a synopsis of this case.`; `What next?` → `What should be done next, and why?`; `Draft the response` → `Draft the response to what was asked.`; `What's weak?` → `What is weak in the evidence or the draft?`
- The conversation, oldest first. Each turn: the question; then the answer as text with its citations as card chips, the line `your agent · <profile title> profile · <local time>`, a `context` disclosure listing the pack items of the request that produced it, and the buttons `Propose as Summary`, `Propose as Assessment`, `Keep as note`. A turn with no answer reads, from the entries after it: `thinking…` while pending, `declined: <reason>`, `blocked: the model may not receive <marking>`, `failed: the model call failed`, or `interrupted`.
- An input (name `Ask your agent`, placeholder `ask your agent …`): `Enter` sends, `Shift+Enter` is a new line.

Answers arrive whole, as an entry. Streaming an answer word by word is not built: the ledger records whole responses, and the screen shows what the ledger holds.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/agents/loop.test.ts
test("with outside_run the loop answers while the run is paused or finished, and still checks the marking", ...);

// tests/server/converse.test.ts  (the sample at the publish gate)
test("a question is recorded, answered by a model with no tools, and the answer cites cards of the case", async () => {
  await s.command(id, "ask", { text: "What do we know?", left_out: [], added: [] });
  await s.app.hub.idle();
  const st = state();
  expect(st.conversation.at(-1)).toMatchObject({ asked: "What do we know?", answer: expect.stringContaining("[c1]"), cites: ["c1"] });
  const req = s.entries(id).findLast((e) => e.type === "model.request")!;
  expect(req.payload.tools).toEqual([]);
  expect(req.actor).toMatchObject({ kind: "agent", id: "assistant", stage: "agent" });
  expect(s.entries(id).filter((e) => e.seq > req.seq && e.type === "tool.called")).toEqual([]);
});
test("ask returns before the model has answered", ...);
test("the answer is the same whether the run is waiting, paused or finished", ...);
test("left-out items are not in the pack, and are recorded on the question and the request", ...);     // agent.asked.left_out and model.request.left_out
test("the base rules and the case cannot be left out", ...);                    // 409, nothing written
test("a model the case's marking may not go to is not called: model.blocked is written and the turn has no answer", ...);
test("an earlier answer made under a stricter marking makes the next pack as strict", ...);
test("propose_answer makes a narrative proposal and changes no draft", ...);
test("keep_answer makes a note card in Incoming carrying the request's marking", ...);
test("the agent view lists the parts with the fixed ones marked, and writes nothing", ...);
test("ask keeps, moves and discards nothing", ...);                              // no card.kept, card.moved, card.discarded, plan.accepted or product.published follows an ask

// tests/web/agent.test.ts
test("A opens the lens with the agent, the profile, tools: none and the loaded context as chips", ...);
test("the base rules and the case have no remove button; other chips do, and Restore brings them back", ...);
test("a quick ask sends its question and the answer appears with citation chips", async () => {
  p.click("[data-quick=synopsis]");
  await p.settle();
  expect(p.q(".turn:last-child .question").textContent).toBe("Give a synopsis of this case.");
  expect(p.q(".turn:last-child .answer [data-card-chip=c1]")).not.toBeNull();
});
test("Propose as Summary puts a dashed proposal in the Narrative lens and leaves the draft alone", ...);
test("Keep as note makes a card in Incoming", ...);
test("free text in the command bar goes to the agent and does not leave the case", ...);
test("an answer holding markup is shown as text", ...);                          // a scripted answer "<script>alert(1)</script>"
test("a declined or blocked turn says so", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/server/converse.test.ts tests/web/agent.test.ts tests/agents/loop.test.ts`
Expected: FAIL (unknown command `ask`).

- [ ] **Step 3: Implement** the loop option, `converse.ts`, the route and commands, the sample additions and the lens.

- [ ] **Step 4: Run the tests**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS, including `tests/sample/full-run.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add src sample tests
git commit -m "feat(agent): your agent answers from the case with no tools; the Agent lens shows its context and only proposes"
```

---

### Task 12: The Replay lens

**Files:**
- Create: `src/web/lenses/replay.ts`, `src/web/replay.ts`
- Modify: `src/web/lenses/index.ts`, `src/web/views/workarea.ts`, `src/web/views/card.ts`, `src/web/views/lanes.ts`, `src/web/views/brief.ts`, `src/web/style.css`
- Test: `tests/web/replay.test.ts`

**Interfaces:**
- Consumes: `CaseStore.goTo`, `stateAt`, `entries`; Task 8's `describe`; Task 6's replay banner and read-only rule; `BLOB_FIELDS` from `src/core/types.ts`; `fileLink`.
- Produces:

```ts
// src/web/replay.ts — pure
export interface Changed { cards: string[]; lanes: string[]; stages: string[] }
/** What an entry touched, for the highlight: the card and lane ids its payload names, and its stage. */
export function changedBy(entry: Entry): Changed;
export interface ReplayFilter { actor: string | null; type: string | null; stage: string | null }
export function matches(entry: Entry, filter: ReplayFilter): boolean;
/** The seq of the next (dir 1) or previous (dir -1) entry that passes the filter, or null at the end. */
export function step(entries: readonly Entry[], from: number, dir: 1 | -1, filter: ReplayFilter): number | null;
```

`LENSES` gains `replay` (`E`, "Replay"). Opened with a number as its argument it starts at that entry; otherwise at the newest.

**The lens** (spec §10.2). The lens root has `data-area="replay"`.

- A head line: `Replay · entry <n> of <total> · <UTC time with milliseconds> · <actor kind>: <actor id>`, and the buttons `◂` (name `Previous entry`), `▸` (name `Next entry`), `Play`/`Stop`, and `Live`.
- Filters: selects for actor (the actor ids seen), type (the entry types seen) and stage (the stages seen), each starting at `All`.
- The list: the thirty entries before and after the position that pass the filter, each row `<seq>  <HH:MM:SS UTC>  <actor id>  <describe.what>  <describe.detail>`; the current row is marked `▸` and has `aria-current="true"`. Activating a row goes to it.
- The selected entry, as a definition list: Who (kind and id; for an agent also stage, profile, model, effort and where it ran); What (the type and `describe.what`); Why (`payload.why` when it has one, labelled `reasoning as stated by the agent` for an agent); for a `query.issued` the exact query text in `pre.query`, its bound values and its window; Source (its title); Hashes (the entry's `hash` and `prev_hash`, and the hash of each blob the entry references at a `BLOB_FIELDS` position); Caused by (`entry <cause>`, a button that goes there); Run, stage and job; and one `raw bytes` file link per referenced blob.
- Stepping with `◂`/`▸`, or `J`/`K` while focus is in the lens, calls `store.goTo(step(...))`. The whole work area then shows the case as it was at that entry, read-only, under the banner (Task 6). The cards, lanes and phase-strip stages in `changedBy(entry)` get the class `changed` (an accent outline) until the position moves.
- `Play` steps forward one entry every 600 ms and stops at the end. `Live`, or `Esc`, calls `store.goTo(null)`. Entries that arrive while replaying raise `total` and do not move the position.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/web/replay.test.ts
test("changedBy names the card, lane and stage an entry touched", ...);         // card.kept → { cards: [card], lanes: [lane], stages: [] }; stage.started → stages: [stage]; card.created → cards: [card.id]
test("step skips entries the filter leaves out and stops at the ends", ...);
/** The facts of the work area that must be the same live and replayed. */
const screen = (p: Page) => ({
  incoming: p.all("[data-area=incoming] [data-card]").map((e) => e.dataset.card),
  lanes: p.all(".lane").map((l) => [l.dataset.lane, [...l.querySelectorAll<HTMLElement>("[data-card]")].map((e) => e.dataset.card)]),
  strip: p.q(".phase-strip").textContent, status: p.all("[data-status]").map((e) => e.textContent),
  tags: p.all("[data-card] .tag").map((e) => e.textContent).filter((t) => t !== "new"),
});
test("replay shows at entry N exactly what the live screen showed at entry N", async () => {
  // a whole sample run through the page; after every settle() record [store.live.seq, screen(p)]
  for (const [seq, was] of recorded) {
    p.press("e"); store.goTo(seq); await p.settle();
    expect(screen(p)).toEqual(was);
  }
});
test("the head line names the entry, its UTC time with milliseconds and who wrote it", ...);   // /^Replay · entry 137 of \d+ · \d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z · agent: researcher-/
test("a query issued shows its exact text, source, why and hashes, and links its result's raw bytes", ...);
test("J and K step one entry, and the cards an entry changed are highlighted", ...);
test("filtering by actor steps only through that actor's entries", ...);
test("Play advances on a timer and stops at the end; Live and Escape return to the present", ...);
test("the work area is read-only while replaying and commands are not sent", ...);
test("entries that arrive while replaying do not move the position", ...);
test("replay 137 in the command bar opens Replay at entry 137", ...);
test("stepping through a long case stays fast", async () => {
  // 5,000 entries, 500 cards; 100 presses of K
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) { p.press("k"); }
  await p.settle();
  expect(performance.now() - t0).toBeLessThan(5000);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/web/replay.test.ts`
Expected: FAIL, `Cannot find module "../../src/web/replay"`.

- [ ] **Step 3: Implement `replay.ts`, the lens and the `changed` highlight**

- [ ] **Step 4: Run the tests**

Run: `timeout 600 bun test tests/web && timeout 300 bun run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web tests/web
git commit -m "feat(web): Replay lens: step through the ledger with the work area as it was, filters, and each entry's who, what, why and hashes"
```

---

### Task 13: The Pivot panel and Verify on a card

**Files:**
- Create: `src/server/seek.ts`, `src/modules/connectors/rows.ts`, `src/web/panels/pivot.ts`, `src/web/panels/verify.ts`, `src/web/trail.ts`
- Modify: `src/modules/revalidate.ts`, `src/modules/connectors/http.ts`, `src/modules/connectors/trino.ts`, `src/modules/connectors/sqlite.ts`, `src/core/types.ts`, `src/core/state/run.ts`, `src/core/wire.ts`, `src/server/app.ts`, `src/server/roles.ts`, `src/web/api.ts`, `src/web/views/card.ts`, `src/web/describe.ts`, `src/web/style.css`
- Test: `tests/modules/rows.test.ts`, `tests/modules/revalidate.test.ts`, `tests/server/seek.test.ts`, `tests/web/pivot.test.ts`, `tests/web/verify.test.ts`, `tests/core/state-run.test.ts`

**Interfaces:**
- Consumes: `runRoute`, `runPivot`, `revalidateCard`, `Seeker.routes`, `rowsHash`; Task 2's `defineCommand`, `CaseHub.background`.
- Produces:
  - `src/modules/connectors/rows.ts`: `rowsOfBlob(source: SourceManifest, issued: Payloads["query.issued"], bytes: Uint8Array): { columns: string[]; rows: Json[][] } | null`. Each connector module exports the pure function that turns its `raw` bytes into columns and rows, and its own `run` uses that same function, so what is read back is what was read first. Null when the bytes cannot be read back (the source's endpoint or table is gone).
  - `src/modules/revalidate.ts`: `difference(session: CaseSession, deps: RunnerDeps, card: string): Difference | { reason: string }`.
  - In `src/core/wire.ts`: `export interface Difference { original: string; rerun: string; columns: string[]; removed: Json[][]; added: Json[][]; same: number; cut: boolean }` (`removed`: rows only in the original; `added`: rows only in the re-run; each list cut at 200, `cut` saying so) and `export interface RouteView { weight: number; hops: { pivot: string; title: string; source: string; source_title: string; from: string; to: string; free: boolean; weight: number; unit: string; needs_window: boolean; empty_means: EmptyMeans; confirmed: boolean }[] }`.
  - Entry type `"route.finished": { job: string; want: string; outcome: "answered" | "blocked"; reached: Observable[]; blocked: string[]; caveats: string[]; cards: string[] }`. Its reducer only checks the shape (a malformed one is recorded in `skipped`); the trail is read from the entries.
  - Routes: `GET /api/routes?have=<type>&want=<type>&max_weight=<number>&unconfirmed=<0|1>` (`have` may repeat) → `RouteView[]`; `GET /api/cases/<id>/cards/<card>/difference` → `Difference | { reason }` (a `Reading` named `difference`). `Api.routes(q)`, `Api.difference(caseId, card)`.
  - Commands, none advancing: `run_route { have: Observable[], want, window, why, max_weight: number | null, allow_unconfirmed: boolean, subgoal?: string }`; `run_pivot { pivot, value, window, why, budget?: number, subgoal?: string }`; `verify_card { card, budget?: number }`.
  - `src/web/trail.ts`: `routeTrail(entries: readonly Entry[], job: string): { lookups: { query: string; pivot: string | null; value: string; status: "running" | "answered" | "empty" | "partial" | "failed"; rows: number | null; detail: string; card: string | null }[]; finished: Payloads["route.finished"] | null }`.
  - `nav.pivot(card, values)` opens the panel inside the card; the card's `Pivot…` and `Verify` actions are enabled.

**Server.**

- `run_route`: `why`, trimmed, must not be empty, and every `have` value must be of its type. One commit writes `job.started { job, title: "Route to <want title> from <first value>", kind: "query", source: null }`. Then, through `hub.background`: `runRoute(session, deps.runner, deps.seeker, { have, want, window, why, actor, limits: { max_weight, allow_unconfirmed, max_hops: 4 }, subgoal, job })`, and one commit writes `route.finished` (with `job` set on the entry too) and `job.finished`. If `runRoute` throws, `job.finished` is written with outcome `failed`.
- `run_pivot`: `runPivot` with the person as actor and their budget, waited for. `refused` → a `Refused` with the reasons; `needs_budget` → a `Refused` reading `this lookup is costly: the estimate is <amount> <unit>; give a budget` (or `this lookup is costly; give a budget`); `done` and `failed` are a done command.
- `verify_card`: `revalidateCard(session, deps.runner, { card, actor, why: "verify card <card>", budget })`, waited for. `refused` → a `Refused`; every verdict is a done command, since `verify.run` records it.
- `difference`: the newest `verify.run` for the card must have outcome `differs` and a re-run (otherwise `{ reason: "this card has no difference to show" }`). Both result blobs are read from the case's blob store and turned into rows with `rowsOfBlob`; if either cannot be read back, `{ reason: "the stored result cannot be read back row by row" }`. Rows are compared as canonical JSON, as multisets.
- `GET /api/routes` answers from `deps.seeker.routes(have, want, limits)` and the registry; it contacts no source and writes nothing.

**The Pivot panel** (guide §5.4), inside the open card.

- `Starting from:` the values passed in, as chips.
- `What do you want?` a select of `ref.types` by title. Choosing one loads the routes.
- The routes, cheapest first, each a block: `<n> hops · weight <w>`, then per hop a row with the source's title, the pivot's title, `free` or `costly (<weight> per <unit>)`, `needs a window` when it does, `if empty: proven negative` / `if empty: not seen`, and an amber `unconfirmed source` tag when it is. `No route from these values to <type>.` when there is none.
- `Window:` a select: `The case's window`; `Last 1 day`, `Last 7 days`, `Last 30 days` (ending at the case window's end, or now when it is open); `Custom` (two UTC inputs); `All time`. With `All time`, a route with a hop that needs a window is marked `needs a window` and cannot be run.
- `Limits:` `Max cost` (a number; blank is none) and a checkbox `Allow unconfirmed sources`; changing either reloads the routes.
- `Why` (required; pre-filled `Pivot from <card> to <type title>`).
- Per route a button `Run: <n> hops to <type title>` → `run_route`.
- The trail of the newest route started from this panel, from `routeTrail`: each lookup as `<pivot title> · <value>` and its status in words (`running`, `answered: <n> rows`, `empty: proven negative` / `empty: not seen`, `partial: <reason>`, `failed: <error>`) with its card as a chip; a hop that needs a budget shows the estimate, a budget input and `Run this lookup: spend up to <n> <unit>` → `run_pivot`. When the route has finished: `answered: <values>` in green or `blocked` in amber, the pivots that ran dry, and each caveat as a line. A partial result is never worded as a negative.

**Verify** (spec §6.7). The card's `Verify` action sends `verify_card`. The result is on the card from the fold (`card.validated`, Task 6's tags) and in a block under the provenance:

- `matches`: `Validated <UTC time>: <detail>` in green.
- `differs`: in amber, `<detail>`, then exactly: `The source may have changed since. A difference does not prove the original was wrong.` Then the row-level difference from `api.difference`: `<same> rows the same`, a table of removed rows (`only in the original`) and one of added rows (`only in the re-run`), `showing the first 200` when cut; or the reason when there is none to show. The original result stays on the card.
- `could_not_run`: `Could not verify: <detail>` in amber; when the detail says a budget is needed, a budget input and `Verify: spend up to <n> <unit>`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/modules/rows.test.ts
test.each(["sql", "files", "http", "trino"])("a stored %s result reads back to the rows it was recorded with", async (kind) => {
  // run one query through the runner against the sample (or the trino stand-in), then read its blob back
  const back = rowsOfBlob(source, issued.payload, session.blobs.get(result.payload.result.blob))!;
  expect(rowsHash(back.columns, back.rows)).toBe(result.payload.rows_hash);
});
test("bytes that are not a result read back as null", ...);

// tests/modules/revalidate.test.ts
test("a changed source gives the rows that left and the rows that came", async () => {
  // run a pivot on a copy of flows.sqlite, delete one row and add one, verify
  expect(difference(session, deps, card)).toMatchObject({ removed: [[...]], added: [[...]], same: expect.any(Number), cut: false });
});
test("a card that matches, or was never verified, has no difference to show", ...);

// tests/server/seek.test.ts
test("routes are listed cheapest first without contacting a source or writing an entry", ...);
test("unconfirmed sources and the cost limit change which routes are offered", ...);
test("a route runs as a job in the person's name; its lookups carry the job and it ends in route.finished", async () => {
  await s.command(id, "run_route", { have: [SAMPLE_START], want: "account", window: SAMPLE_WINDOW, why: "who is behind it", max_weight: null, allow_unconfirmed: false });
  await s.app.hub.idle();
  const done = s.entries(id).findLast((e) => e.type === "route.finished")!;
  expect(done.payload.outcome).toBe("answered");
  expect(s.entries(id).filter((e) => e.type === "query.issued" && e.job === done.payload.job).every((e) => e.actor.kind === "human")).toBe(true);
  expect(state().jobs[done.payload.job]!.status).toBe("done");
});
test("a route re-routes around a dead end, and the lookups that ran show it", ...);          // the sample's planted dead end
test("a costly lookup with no budget is refused with its estimate; with a budget it runs", ...);
test("run_route with no why is refused and writes nothing", ...);
test("verify_card records verify.run and returns", ...);
test("the difference route gives rows for a card that differs and a reason otherwise", ...);

// tests/web/pivot.test.ts
test("a value chip opens the panel with that value; choosing an answer lists routes cheapest first", ...);
test("each hop shows its source, cost class, window need and what an empty result means", ...);
test("running a route shows the trail as it happens and ends in the answer", async () => {
  p.click("[data-route='0'] [data-action=run]");
  await p.settle();
  expect(p.q(".trail .finished").textContent).toStartWith("answered: ");
  expect(p.all(".trail .lookup").length).toBeGreaterThan(1);
});
test("a partial lookup reads partial with its reason, never as a negative", ...);
test("a costly hop waits for a budget and shows its estimate first", ...);
test("All time disables a route that needs a window, and says why", ...);

// tests/web/verify.test.ts
test("Verify on an unchanged source tags the card validated with the time", ...);
test("a changed source tags the card differs, says the source may have changed, and shows the rows", async () => {
  expect(p.q("[data-card=c1] .verify").textContent).toContain("The source may have changed since. A difference does not prove the original was wrong.");
  expect(p.all("[data-card=c1] .verify table.removed tr").length).toBeGreaterThan(0);
  expect(state().cards.c1!.rows).toEqual(rowsBefore);                               // the original is not replaced
});
test("a source that cannot be reached tags the card could not verify, with the reason", ...);
test("verify c1 in the command bar does the same", ...);
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 300 bun test tests/modules/rows.test.ts tests/modules/revalidate.test.ts tests/server/seek.test.ts tests/web/pivot.test.ts tests/web/verify.test.ts`
Expected: FAIL, `Cannot find module "../../src/modules/connectors/rows"`.

- [ ] **Step 3: Implement** the readers, `difference`, the entry type, `seek.ts` with its routes and commands, `routeTrail`, and the two panels. `describe` gains `route.finished`.

- [ ] **Step 4: Run the tests**

Run: `timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS, including `tests/modules/custody.test.ts` (nothing under `src/server/` imports a connector).

- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "feat(web): Pivot panel over the route finder with a recorded trail; Verify on a card with a row-level difference"
```

---

### Task 14: The serve command, the whole run in the DOM and in a browser, and the security notes

**Files:**
- Create: `src/cli/serve.ts`, `tests/helpers/chrome.ts`, `tests/web/whole-run.test.ts`, `tests/web/browser-run.test.ts`, `tests/cli/serve.test.ts`, `tests/server/boundaries.test.ts`, `docs/security-notes.md`
- Modify: `package.json` (script `"serve": "bun run src/cli/serve.ts"`), `docs/superpowers/plans/2026-11-23-slice-roadmap.md` (plan 4's task list as built)

**Interfaces:**
- Consumes: everything above.
- Produces:

```ts
// src/cli/serve.ts
/** `bun run src/cli/serve.ts [--config <file>] [--port <n>] [--sample-fixture [port]]`. Resolves once the server is listening. */
export function serve(argv: string[], out: { log(line: string): void; error(line: string): void }): Promise<{ origin: string; stop(): Promise<void> }>;

// tests/helpers/chrome.ts
/** WORKBENCH_CHROME; else the newest chrome-headless-shell or chrome under ~/.cache/ms-playwright; else chromium, chromium-browser or google-chrome on the path. */
export function findChrome(): string | null;
export interface Tab {
  evaluate<T>(expression: string): Promise<T>;                       // Runtime.evaluate, awaiting a promise, by value
  waitFor(expression: string, ms?: number): Promise<void>;           // polls until truthy; throws with the expression after ms (default 10,000)
  click(selector: string): Promise<void>;                            // real mouse events at the element's centre
  drag(from: string, to: string, at?: "upper" | "lower" | "centre"): Promise<void>;   // mouse down, three moves, up
  press(key: string, mods?: { shift?: boolean }): Promise<void>;     // real key events
  type(text: string): Promise<void>;                                 // Input.insertText into the focused element
  reducedMotion(on: boolean): Promise<void>;                         // Emulation.setEmulatedMedia
  problems(): string[];                                              // uncaught exceptions, console errors and security-policy violations so far
  requests(): string[];                                              // every URL the page asked for
}
export interface Browser { tab(url: string): Promise<Tab>; close(): Promise<void> }
/** Starts the browser with --headless --no-sandbox --disable-gpu --remote-debugging-port=0, a fresh --user-data-dir, and --host-resolver-rules="MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"; reads the debugging address from its stderr; talks over WebSocket. */
export function launch(path: string): Promise<Browser>;
```

**`serve`.** Loads the configuration (`loadConfig`), starts the sample fixture when asked (as `src/cli/run.ts` does), opens the workbench, calls `compose(config, wb, { refuse_hosts: () => [<the server's host>] })`, builds the interface, and calls `startServer` on `--port`, else `config.server.port`. It prints `Workbench: http://127.0.0.1:<port>/` and, to the error stream, each manifest problem as `problem: <text>`. On `SIGINT` or `SIGTERM`, and from `stop()`, it stops the server, closes the composed pool and the workbench, and stops the fixture, in that order, each even if the one before failed. A locked data directory prints the `WorkbenchLockedError` message and exits 1; a configuration error exits 2.

**The whole run in the DOM** (`tests/web/whole-run.test.ts`, `happy-dom`, runs everywhere). One test drives the sample investigation through the interface only, never calling the server or the engine directly:

1. Home → Investigate → `+ New investigation`; fill the form with the sample's question, starting value `198.51.100.77` and window; `Create and frame the run`.
2. The brief reaches `◌ waiting` on Plan. `Shift+Enter` opens Steps (one step is costly). Press `Estimate` on `s3`; enter budget `1`; `Accept: run 3 steps`.
3. While research runs, the jobs indicator shows a count above zero at least once.
4. At the publish gate: in Incoming, `J`, `Space` keeps a card; `U` puts it back; `Space` keeps it again; `X` discards another; `D` shows it; Restore.
5. Open a card: its provenance shows the exact query; press `Verify`; the card is tagged `validated`.
6. `Q`: the Research row lists its turns and tool calls; one send-back is listed with its reason.
7. `A`: the quick ask `Synopsis` is answered with a citation chip; `Propose as Summary` appears dashed in Narrative; discard it.
8. `R`: eleven checks pass; the preview lists five files; `Shift+Enter` reads `Approve: publish draft <n>` and publishes.
9. The Pipeline lens's feedback row: record `answered_the_question` as `true`.
10. `E`: step back to the entry where the plan was proposed; the banner shows; Incoming is empty and the lanes are gone; `Live` returns.
11. At steps 1, 4 and 8, every `button`, `input`, `select` and `textarea` on screen has an accessible name (its text, an `aria-label`, or a `label` that points at it), and no two elements share an `id`.
12. The custody chip reads `chain intact · <n> entries`; `verifyCase(<case dir>)` is ok with its published bundle `ok`; `session.state.skipped` is `[]`; the store's `live` state equals the session's, as canonical JSON.

**The browser run** (`tests/web/browser-run.test.ts`; decision 4). `const chrome = findChrome()`. With a browser: the test starts `serve` on port 0 against a fresh sample root and data directory, opens a tab on its origin, and drives steps 1, 2, 4 (with a real drag of a card onto the second lane instead of one `Space`), 8 and 12 with real mouse and key events. It also asserts:

- `tab.problems()` is `[]` at the end (no exception, no console error, no content-security-policy violation);
- every URL in `tab.requests()` starts with the server's origin;
- `document.querySelectorAll("script:not([src]), style, [style], [onclick]").length` is `0`;
- `(() => { try { document.body.innerHTML = "<b>x</b>"; return "set"; } catch (e) { return e.name; } })()` evaluates to `TypeError` (trusted types are enforced);
- after `Tab`, the focused element's computed `outline-style` is not `none`;
- with `tab.reducedMotion(true)`, a card's computed `transition-duration` is `0s`, and a keep still lands in the lane;
- entries written by a second tab on the same case appear in the first without a reload (the stream is live).

With no browser: `test.skip`, after printing `browser run skipped: no Chromium found (set WORKBENCH_CHROME)`. With `WORKBENCH_REQUIRE_BROWSER=1` and no browser: the test fails with that sentence.

**Boundaries** (`tests/server/boundaries.test.ts`), in the style of `tests/agents/boundaries.test.ts`: no file under `src/server/` or `src/web/` imports from `src/modules/connectors/`; no file under `src/web/` except `build.ts` imports from `src/server/`, `src/modules/`, `src/agents/`, `src/pipeline/` or `src/cli/`; only `src/cli/` constructs a `ConnectorPool`; `Bun.serve` appears only in `src/server/app.ts` (and test helpers), always with `hostname: "127.0.0.1"`.

**`docs/security-notes.md`** says, in plain sentences, what this slice relies on and what it does not do: the server answers only on `127.0.0.1` and only to its own origin, and has no sign-in (one person, one machine); roles are checked on the server but there is one configured role; the page runs under a content security policy with trusted types and builds no HTML from data; the browser receives entries as recorded, which hold no secret values but may name where a source is; source descriptions and error text are views with locations and credential names removed; blobs and bundles are served from the record as attachments, never as pages; check programs run from trusted roots with a stripped environment and a time limit but are not confined to a folder; the `http` connector refuses the server's own address; `localhost` is still trusted by name for a model on this machine (plan 5).

- [ ] **Step 1: Write the failing tests**

```ts
// tests/cli/serve.test.ts
test("serve listens on 127.0.0.1, prints its address, serves the page and stops cleanly", async () => {
  const lines: string[] = [];
  const running = await serve(["--config", configFile, "--port", "0"], { log: (l) => lines.push(l), error: () => {} });
  expect(lines[0]).toMatch(/^Workbench: http:\/\/127\.0\.0\.1:\d+\/$/);
  expect((await fetch(`${running.origin}/`)).status).toBe(200);
  await running.stop();
  Workbench.open(dataDir, { onError: () => {} }).close();                    // the lock was released
});
test("a second serve on the same data directory is refused", ...);
test("a source that points at the server is refused", ...);
// tests/web/whole-run.test.ts and tests/web/browser-run.test.ts: the steps above, each step's assertions inline
// tests/server/boundaries.test.ts: the four rules above; each also proved to catch a planted violation in a string
```

- [ ] **Step 2: Run them and see them fail**

Run: `timeout 600 bun test tests/cli/serve.test.ts tests/web/whole-run.test.ts tests/web/browser-run.test.ts tests/server/boundaries.test.ts`
Expected: FAIL, `Cannot find module "../../src/cli/serve"`.

- [ ] **Step 3: Implement** `serve.ts` and `chrome.ts`, write the notes, and update the roadmap's plan 4 list to this plan's fifteen tasks.

- [ ] **Step 4: Run everything, with the browser required**

Run: `WORKBENCH_REQUIRE_BROWSER=1 timeout 900 bun test && timeout 300 bun run typecheck`
Expected: PASS, 0 skipped. If no Chromium is on the machine, run without the variable, and say in the report that the browser run was skipped and why.

- [ ] **Step 5: Start it once by hand**

Run: `timeout 20 bun run serve --sample-fixture --port 4747; true`
Expected: the line `Workbench: http://127.0.0.1:4747/`, no stack trace, and a clean stop when the time limit ends it.

- [ ] **Step 6: Commit**

```bash
git add src/cli/serve.ts package.json tests docs/security-notes.md docs/superpowers/plans/2026-11-23-slice-roadmap.md
git commit -m "feat(cli): serve command; the whole sample investigation driven through the interface, in the DOM and in a headless browser"
```

---

## Hand-back

When all fifteen tasks are done, report to the owner:

- **The decisions this plan made** (the twelve above), each as one line, so they can be reversed while it is cheap. The ones most worth a look: entries reach the browser as recorded and only derived text is scrubbed (1); plan-time estimates are asked for per step and recorded as `step.estimated` (7); accepting a narrative proposal is an edit that goes back through review (9); answers arrive whole, not word by word (12).
- **Two entry types were added:** `step.estimated` and `route.finished`. A ledger written by plan 3 still folds and verifies unchanged.
- **Not built, by design (spec §15, item 1):** the Graph, Notes and Ticket lenses; linking two cards by dragging onto the middle of one; the two-finger swipe; Combine; My folders and the file tree. **Not built in the Agent lens:** changing the objective the agent serves, and adding parts other than skills, procedures, references and lessons (both belong with the Resources design, spec §15 item 3).
- **Carried to plan 5's close-out:** `runQuery`'s `accept` is not checked against the proposal's text, source and window; a reused open proposal keeps its old step id; research done-ness is matched by job title; a card cited by an old finding and a carried section can drop out of provenance on a rewrite; `localhost` is trusted by name for a model on this machine; lake guardrail soundness; the prompt-injection surface of source titles and quality text.
- **How to see it:** `bun run serve --sample-fixture`, then open the printed address.
