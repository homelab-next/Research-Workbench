# The Person Can Always Overrule, and Can Be Asked (slice 8) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The person adds what they know as a card agents can cite, overrules any finding at any time, revises a ruling, and answers questions a stage puts to them. Each of these is a ledger entry, held by code, and labelled as the person's in the published product.

**Architecture:** Three new entry types (`question.asked`, `question.answered`, `finding.overruled`), one optional card field (`person`) and one new pause hold (`question`) are folded by a new reducer, `applyPerson`, into two new state fields (`questions`, `overrules`). A person's statement is an ordinary card with no rows and a `person` field. Overrules are applied by code to every draft Assemble builds, and an unheld ruling or overrule blocks publishing. A blocking question holds the asking stage's pass the way a stall does: the run pauses with the stage still running, and a resume runs it again.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun test`, happy-dom and headless Chromium for interface tests. No new dependency.

**Spec:** [`docs/superpowers/specs/2026-11-26-slice-8-person-design.md`](../specs/2026-11-26-slice-8-person-design.md) ("the design"). Branch `slice-8-person`, stacked on `slice-7-pivot` `fb46497`. Decisions the design left open are the "Ruling:" lines in `.superpowers/sdd/2026-11-26-slice-8-person/progress.md`; where a task states one, it is the requirement.

## Global Constraints

- **The record decides.** What a lens, a check, a pack or the product says about a statement, a question, an overrule or a ruling comes from the folded entries.
- **Nothing in this plan reaches a source.** No code calls a connector; `runQuery` is not touched. A statement, a question and an overrule send no query.
- **The fold never throws and never mutates its input.** Every new payload field is optional or belongs to a new entry type. An entry without it folds as it did. A malformed payload is recorded in `skipped`; a well-formed entry that names something missing leaves the state unchanged.
- **Only a person's entries carry a person's authority.** The fold accepts `finding.overruled`, `question.answered`, `review.ruled` and a card with `person` only from an actor of kind `human`, and `question.asked` only from an agent. The server names the actor; no command takes one.
- **No gate is passed here.** No command or tool in this plan writes `gate.passed`. Only `accept_plan` and `approve` do, as before.
- **Browser-safe core.** `src/core/state/**` imports nothing outside `src/core/`; no `Bun`, `process`, `Buffer`, `node:*`. `src/web/**` imports only `src/web`, `src/core/state`, `src/core/wire.ts`, `src/core/types.ts`, `src/core/canonical.ts`. `src/agents/**` does not import `src/pipeline/**` or `src/server/**` (the pipeline imports the agents); what both need lives in `src/modules` or `src/core`.
- **No HTML sink, no inline style.** Elements are made only by `h` and `s`. Text from the record (a question a model wrote, a statement a person typed) is a text node or the value of a fixed attribute.
- **Text a model wrote carries its request's marking.** A question's text enters a pack only through `packPart` with its `question.asked` entry in `written_by`. An answer card is at least as strict as that request.
- **Exact values:** question ids are `ask-1`, `ask-2`, …; at most `questions.max_open` (default 3) unanswered questions per run; `PERSON_SOURCE` is `"the person"`; a statement is at most 4000 characters, its detail 500, its `about` list 20 values.
- **Deterministic.** No `Math.random`, no `Date.now` in a model, a fold or a builder; `<` on strings, not `localeCompare`, in new code.
- **The real environment stays out of the repository.** Tests and the sample use the sample's names, loopback and RFC 5737 addresses, `example.*` domains, and invented device names. Task 9 uses placeholders in angle brackets.
- **Tests:** `timeout 120 bun test <file>` while iterating; `timeout 900 bun test && timeout 300 bun run typecheck` before each commit, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. No test asserts an absolute duration. Every test makes its files under a fresh `mkdtempSync` directory and removes it, closes what it opens, and asserts `state.skipped` is `[]` when it drives a session. Report real RED: the failing run of the new tests, made before the implementation exists.
- **Commits:** on `slice-8-person`, never pushed; `git add` by explicit path (other tasks may have uncommitted work in the tree). Never `git checkout`, `switch`, `stash` or `reset`. End every commit message with the attribution lines your own harness reminder gives you.
- **A test outside your task's Files that your change breaks:** fix it if no task running beside yours lists that file; otherwise report it and leave it.

## The ledger: what is added, and why old ledgers and replay are unchanged

| Addition | Shape | Folded into |
|---|---|---|
| Entry `question.asked` | `{ question: Question }`, by an agent; counted (`question` ids, prefix `ask-`) | `state.questions[id]` |
| Entry `question.answered` | `{ question: string; card: string }`, by a person | `state.questions[id].answer` |
| Entry `finding.overruled` | `{ finding; draft_hash; likelihood \| null; confidence \| null; stays \| null; note }`, by a person | `state.overrules[finding]` (latest, with `earlier`) |
| Card field `person?` | `{ basis; detail; about; answers }` on `card.created` | the card, as written |
| Hold `{ kind: "question"; stage }` | on `run.paused` | `state.run.hold`; a person's `run.resumed` of it sets `waived` on that stage's open blocking questions |
| `review.ruled`, a second one on a conflict | payload unchanged | replaces `ruling`; the replaced one goes to `earlier_rulings` |

- **Old ledgers fold unchanged.** No existing payload gains a required field. An old ledger holds none of the new types, no card with `person` and no `question` hold, so `questions` and `overrules` stay `{}` and `counters.question` stays 0. Its conflicts were each ruled at most once (the fold ignored a second ruling, and the engine refused to write one), so `ruling` is what it was and `earlier_rulings` is absent. A ledger that somehow holds two rulings on one conflict now folds to the later one; `Engine.rule` never wrote such a ledger.
- **Replay stays exact.** Everything new is state derived by `apply` from entries in the hash chain, so `fold(entries, n)` is the state the live session had after entry `n`. The engine's hold of a pass writes one `run.paused` entry and nothing else; what happens on resume is decided from the state. Nothing reads a clock, and nothing is kept outside the ledger.
- **`verify` passes.** The three types are in `ENTRY_TYPES`; none has a blob field, so `BLOB_FIELDS` and `BLOB_NULLABLE` are untouched.
- **Derived reads that change:** `blockers()` gains a line for a draft that does not hold a ruling or an overrule. It is computed, never stored.

## What can run in parallel

Tasks in one wave touch disjoint files. A wave starts when the one before it is committed.

| Wave | Tasks |
|---|---|
| 1 | **Task 1** (vocabulary and fold) |
| 2 | **Task 2** (statements: command, pack, citing, checks, product) |
| 3 | **Task 3** (overrules and revised rulings) ∥ **Task 4** (ask and answer) ∥ **Task 6** (statements on screen) |
| 4 | **Task 5** (the blocking hold and the named gap) ∥ **Task 7** (Narrative lens, brief, command bar) |
| 5 | **Task 8** (sample, acceptance, documents) |
| after | **Task 9** (the dev root and the driver; the controller, outside the repository) |

Task 2 creates the three command files and imports them from `src/server/app.ts`, so Tasks 3 and 4 never edit `app.ts`. `src/pipeline/engine.ts`, `src/pipeline/stages/assemble.ts`, `src/pipeline/checks.ts` and `src/pipeline/questions.ts` are changed by Tasks 2 to 4 and then by Task 5; `src/web/commands.ts` and `src/web/style.css` by Task 6 and then Task 7. The sample's stage manifests and profile are changed only by Task 8, alone, because most tests read them.

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `src/core/types.ts` | `PersonBasis`, `PersonStatement`, `Card.person`, `Question`, the three payloads, the `question` hold, `PERSON_BASES` | 1 |
| `src/core/state/person.ts` (new) | `applyPerson`; `isPersonCard`, `runQuestions`, `openQuestions`, `waitingOn`, `activeOverrules`, `overruleSays`, `overruleText`, `holdsOverrule`, `reopensOverrule`, `unheld`; `PERSON_SOURCE`, `BASIS_TEXT` | 1 |
| `src/core/state/types.ts`, `shapes.ts`, `cards.ts`, `run.ts`, `apply.ts`, `index.ts` | `QuestionState`, `OverruleState`, `Ruling`, the id kind, the card rule, the hold, the reducer order | 1 |
| `src/core/state/conflicts.ts`, `analysis.ts`, `src/pipeline/conflict.ts` | A later ruling replaces; `holds` moves to the core; `blockers` reads `unheld` | 1 |
| `src/web/describe.ts` | The three entry types in words | 1 |
| `src/pipeline/person.ts` (new), `src/modules/about.ts` (new) | `personCard`, `addStatement`; `aboutProblem` | 2 |
| `src/server/statement-commands.ts` (new), `overrule-commands.ts` (new), `question-commands.ts` (new), `src/server/app.ts` | `add_statement`; the other two files as headers only, all three imported | 2 |
| `src/agents/context.ts`, `tools/analysis.ts`, `tools/cards.ts`, `draft.ts`, `src/pipeline/conflict.ts`, `checks.ts`, `publish.ts`, `sample/checks/05-source-quality.ts`, `08-gaps-and-negatives.ts` | A statement in a pack, cited, exempt from the empty-card rule, named in the sources, checked and labelled in the product | 2 |
| `src/pipeline/overrule.ts` (new) | `overruledFindings`, `overrule` | 3 |
| `src/pipeline/engine.ts`, `revise.ts`, `conflict.ts`, `review-points.ts`, `contract.ts`, `stages/assemble.ts`, `src/agents/tools/analysis.ts`, `src/server/overrule-commands.ts` | The overrule held by Assemble, by edits and by reviewers; a ruling revised; `overrule_finding` | 3 |
| `src/agents/tools/person.ts` (new), `tools/index.ts` | `ask_person` | 4 |
| `src/pipeline/questions.ts` (new), `stages/agent.ts`, `src/modules/config.ts`, `src/server/question-commands.ts` | `questionsPart`, `answerQuestion`, `questions.max_open`, `answer_question` | 4 |
| `src/pipeline/engine.ts`, `questions.ts`, `stages/assemble.ts`, `checks.ts`, `sample/checks/08-gaps-and-negatives.ts` | The pass held for an answer; the open questions named in the draft and checked | 5 |
| `src/web/panels/statement.ts` (new), `views/incoming.ts`, `views/card.ts`, `derive.ts`, `markdown.ts`, `commands.ts`, `views/help.ts`, `style.css` | The statement form, a statement card, `state <text>` | 6 |
| `src/web/lenses/narrative.ts`, `views/brief.ts`, `commands.ts`, `views/help.ts`, `style.css`, `src/core/wire.ts`, `src/server/views.ts` | Questions, overrules and ruling history in the Narrative lens; the brief; `answer`, `overrule` | 7 |
| `sample/context/skills/ask-the-person.md` (new), `sample/context/profile.yaml`, `sample/stages/{plan,research,assemble}.yaml`, `scripts/new-root.ts`, `tests/sample/person-acceptance.test.ts` (new), `README.md`, `docs/gui-guide.md`, `docs/security-notes.md` | The sample's skill and tool lists, acceptance, documents | 8 |

## Review Focus

Inputs the design implies and a person will meet, most likely first. Each has its test in the task named.

1. **A reviewer keeps asking to move an overruled finding back.** The point is not sent back; when it is all the reviewer raised the run pauses and says so; a different point on the same finding (a citation, the wording) goes back as usual. *Task 3 Step 5.*
2. **The person resumes without answering.** The run goes on, the stage is not held a second time for that question, a later question from that stage is recorded as not blocking, and the draft's gaps name the question. *Task 5 Steps 1 and 4.*
3. **A question or a statement that looks like markup, or names a card** (`<img src=x onerror=1>`, "see c3"). It is drawn as text, and a card id in a question does not make the draft cite that card. *Task 5 Step 4, Task 7 Step 1.*
4. **The person's own edit contradicts their overrule, or they overrule twice.** The edit is refused with the way out; the later overrule replaces the earlier and the lens shows both. *Task 3 Steps 1 and 3.*
5. **A finding rests only on the person's word.** It may be cited and published, and the product says so in the finding, the sources and the provenance; a statement is never shown as "nothing found" or as a proven negative. *Task 2 Steps 5 and 7, Task 6 Step 1.*
6. **Replay moved to before the first question, or to entry 0.** The Narrative lens shows no question box and throws nothing; every control is off while replaying. *Task 7 Step 1.*

---

### Task 1: The vocabulary and the fold

**Files:**
- Create: `src/core/state/person.ts`
- Modify: `src/core/types.ts`, `src/core/state/types.ts`, `src/core/state/shapes.ts`, `src/core/state/cards.ts`, `src/core/state/run.ts`, `src/core/state/apply.ts`, `src/core/state/index.ts`, `src/core/state/conflicts.ts`, `src/core/state/analysis.ts`, `src/pipeline/conflict.ts`, `src/web/describe.ts`
- Test: `tests/core/state-person.test.ts` (new), `tests/core/state-analysis.test.ts`, `tests/core/state-cards.test.ts`, `tests/core/state-run.test.ts`, `tests/core/whole-run.test.ts`, `tests/web/describe.test.ts`; and any test a new counter key or a moved export breaks

**Interfaces (Produces):**
```ts
// src/core/types.ts
export type PersonBasis = "saw" | "did" | "told" | "unstated";
/** What makes a card a person's statement: how they know it, what it is about, and the question it answers (null when they volunteered it). */
export interface PersonStatement { basis: PersonBasis; detail: string; about: Observable[]; answers: string | null }
Card.person?: PersonStatement;                       // only on a statement by the person; such a card has no query, no source and no rows
/** A question a stage puts to the person: `why` is why the answer matters; `cards` and `about` are what it is about. */
export interface Question { id: string; text: string; why: string; cards: string[]; about: Observable[]; blocking: boolean }
export type RunHold = … | { kind: "question"; stage: string };
Payloads["question.asked"]: { question: Question };
Payloads["question.answered"]: { question: string; card: string };
/** A person sets a finding's likelihood, its confidence, or whether it stays. Null leaves that alone; all three null withdraws the overrule. */
Payloads["finding.overruled"]: { finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string };
export const PERSON_BASES: readonly PersonBasis[];   // listOf, as the other runtime lists
// ENTRY_TYPES gains the three types. The comment on "review.ruled" loses "Fixed for the rest of the run": "The latest ruling on a conflict is the one that holds."
// src/core/state/types.ts
IdKind += "question"; ID_PREFIX.question = "ask-";
export type QuestionState = Question & { run: string | null; stage: string | null; by: string; seq: number; ts: string;
  answer: { card: string; by: string; seq: number; ts: string } | null;
  /** The person resumed the run without answering: the stage went on. */
  waived: { by: string; seq: number; ts: string } | null };
export interface Overrule { finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string; by: string; seq: number; ts: string }
/** The latest overrule of a finding, and those it replaced, oldest first. */
export type OverruleState = Overrule & { earlier: Overrule[] };
export interface Ruling { follow: string | null; note: string; by: string; seq: number; ts: string }
ConflictState.ruling: Ruling | null;
ConflictState.earlier_rulings?: Ruling[];            // present only once a ruling was replaced; oldest first
CaseState.questions: Record<string, QuestionState>;  // initial {}
CaseState.overrules: Record<string, OverruleState>;  // keyed by finding id; initial {}
// src/core/state/shapes.ts
export const isPersonStatement: (x: unknown) => x is PersonStatement;
// isCard accepts person absent or isPersonStatement; cardFields copies it (a fresh object, a fresh about list) only when present
// src/core/state/person.ts
export const PERSON_SOURCE = "the person";
export const BASIS_TEXT: Record<PersonBasis, string>;   // saw: "saw it myself", did: "did it myself", told: "was told", unstated: "did not say how"
export const isPersonCard: (c: Pick<Card, "person">) => boolean;
export function applyPerson(s: CaseState, entry: Entry): CaseState;
/** The questions of the current run, in the order asked. */
export function runQuestions(state: Readonly<CaseState>): QuestionState[];
/** runQuestions without an answer (waived ones included). */
export function openQuestions(state: Readonly<CaseState>): QuestionState[];
/** The open, blocking, not waived questions the stage asked in the current run. */
export function waitingOn(state: Readonly<CaseState>, stage: string): QuestionState[];
/** The overrules that set something (not withdrawn), in the order they were last made. */
export function activeOverrules(state: Readonly<CaseState>): OverruleState[];
/** "likelihood almost certain, confidence high" | "must stay" | "dropped" | "overrule withdrawn". */
export function overruleSays(o: Overrule): string;
/** `${o.finding}: ${overruleSays(o)}. Note: ${o.note.trim()}`. */
export function overruleText(o: Overrule): string;
/** Whether the product holds the overrule: absent when stays is false; otherwise present with each value that is set. Null for a withdrawn one. */
export function holdsOverrule(product: Product, o: Overrule): boolean | null;
/** Whether a reviewer's point would move the overruled finding back: it names the finding and speaks to what was set. */
export function reopensOverrule(point: string, o: Overrule): boolean;
/** One line per ruling of the current run and per active overrule the product does not hold. */
export function unheld(state: Readonly<CaseState>, product: Product): string[];
// src/core/state/conflicts.ts
export function holds(product: Product, c: ConflictState): boolean | null;   // moved from src/pipeline/conflict.ts, unchanged; that file re-exports it
// ruledFindings leaves out a ruling that an overrule of the same finding, made after it and not withdrawn, has replaced
```

- [ ] **Step 1: failing tests for the questions** (`tests/core/state-person.test.ts`, with `EntryBuilder` and `card` from `tests/helpers/entries.ts`; `person` is `{ kind: "human", id: "analyst" }`, `researcher` an agent actor of stage `research`).

```ts
test("question.asked by an agent is recorded with its run and stage, and takes the next ask- id", () => {
  // run.started run-1; question.asked { question: { id: "ask-1", text: "Where is the access point AP-7?", why: "a TV there would explain the name", cards: ["c2"], about: [{ type: "address", value: "192.0.2.17" }], blocking: true } } with stage "research"
  expect(s.questions["ask-1"]).toMatchObject({ run: "run-1", stage: "research", by: "researcher-g1", blocking: true, answer: null, waived: null });
  expect(s.counters.question).toBe(1);
});
test("a question from a person, a second one with the same id, and a malformed one change nothing but skipped", () => {
  // by a person: skipped with "a question to the person is an agent's"; same id again: state unchanged, nothing skipped; cards: "c2" (not a list): "malformed question.asked"
});
test("question.answered by a person names the statement card that answers it; a second answer changes nothing", () => {
  // card.created (a person card with person.answers "ask-1") then question.answered { question: "ask-1", card: "c3" }
  expect(s.questions["ask-1"]!.answer).toEqual({ card: "c3", by: "analyst", seq: answered.seq, ts: answered.ts });
});
test("an answer not by a person, or naming a card that is not the person's answer to that question, is skipped with its reason", () => {
  // by an agent: "an answer is a person's"; card c1 (a result card), and a person card whose answers is "ask-2": "an answer names the person's card that answers the question"; an unknown question: unchanged, nothing skipped
});
test("a person's resume of a pause held for a question waives that stage's open blocking questions, and no others", () => {
  // ask-1 (research, blocking), ask-2 (research, not blocking), ask-3 (assemble, blocking); run.paused { reason, hold: { kind: "question", stage: "research" } }; run.resumed by the person
  expect([s.questions["ask-1"]!.waived, s.questions["ask-2"]!.waived, s.questions["ask-3"]!.waived]).toEqual([{ by: "analyst", seq: resumed.seq, ts: resumed.ts }, null, null]);
  expect(waitingOn(s, "research")).toEqual([]); expect(openQuestions(s).map((q) => q.id)).toEqual(["ask-1", "ask-2", "ask-3"]);
  expect(s.run).toMatchObject({ status: "running", hold: null });
});
test("a resume by the engine, or of a pause with another hold, waives nothing", () => {});
test("runQuestions holds only the current run's questions", () => { /* ask-1 in run-1, run.finished, run.started run-2, ask-2: ["ask-2"] */ });
```
- [ ] **Step 2: run, expect FAIL** (`person.ts` does not exist; the types do not compile). **Step 3: implement.** Add the types. `COUNTED["question.asked"] = "question"`; `initial()` adds the counter and the two fields. `REDUCERS` becomes `[applyCase, applyCards, applyPerson, applyRun, applyAnalysis, applyPlaybooks]`: `applyPerson` reads `s.run.hold` on `run.resumed` before `applyRun` clears it. `isHold` (`run.ts:35`) accepts `{ kind: "question", stage }`; `applyRun`'s `run.resumed` does nothing more for it (the stage stays as it was). **Step 4: PASS.**

- [ ] **Step 5: failing tests for a person's card** (`tests/core/state-cards.test.ts`).

```ts
test("a card with person is kept as written when a person made it as a note with no query, source or rows", () => {
  expect(s.cards.c1!.person).toEqual({ basis: "saw", detail: "in the lobby on Tuesday", about: [{ type: "address", value: "192.0.2.17" }], answers: null });
  expect(s.cards.c1!.person).not.toBe(payload.card.person);           // the state shares nothing with the payload
});
test("a card with person that an agent made, or that has rows, a query or a source, is skipped: a person's statement is a person's", () => {
  // four entries; each: state.cards unchanged, skipped reason "a person's statement is a person's"
});
test("a malformed person field is a malformed card; a card without person folds as before", () => { /* basis "guess"; about: [{ type: 1 }] */ });
```
- [ ] **Step 6: FAIL. Step 7: implement** in `isCard`, `cardFields` and `applyCards` (`cards.ts:69`): after `isCard`, a card with `person` needs `entry.actor.kind === "human"`, `made_by === "human"`, `kind === "note"`, `query === null`, `source === null`, `row_count === 0`, `rows.length === 0`; otherwise `recordSkip(s, entry, "a person's statement is a person's")`. **Step 8: PASS.**

- [ ] **Step 9: failing tests for overrules** (`tests/core/state-person.test.ts`; drafts made with the file's own `draft(n, findings)` helper, findings `f1` "likely"/"moderate" and `f2`).

```ts
test("finding.overruled by a person is the overrule of that finding; a later one replaces it and keeps the earlier", () => {
  // { finding: "f1", draft_hash, likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." } then { …, likelihood: null, confidence: "high", … }
  expect(s.overrules.f1).toMatchObject({ likelihood: null, confidence: "high", earlier: [{ likelihood: "almost certain", seq: first.seq }] });
});
test("an overrule not by a person, without a note, or dropping a finding while setting a value, is skipped with its reason", () => {
  // "an overrule is a person's"; "an overrule gives a note"; "a dropped finding has no likelihood or confidence to set"
});
test("an overrule of a finding no draft has ever held changes nothing", () => { /* state unchanged, nothing skipped */ });
test("an overrule with nothing set withdraws: it is the latest, and it is not active", () => {
  expect(activeOverrules(s)).toEqual([]); expect(s.overrules.f1!.earlier.length).toBe(1); expect(overruleText(s.overrules.f1!)).toBe("f1: overrule withdrawn. Note: I was wrong about the room.");
});
test("overruleSays and overruleText", () => {
  // "likelihood almost certain, confidence high" · "must stay" · "dropped" · "f1: likelihood almost certain. Note: It is the TV I installed."
});
test("holdsOverrule: a set value must be there, a kept finding must be present, a dropped one absent", () => {
  // likelihood set and equal: true; finding gone: false; stays true and present: true; stays false and present: false; withdrawn: null
});
test("reopensOverrule: a point that names the finding and speaks to what was set", () => {
  const o = overrule({ likelihood: "almost certain" });
  expect(reopensOverrule("f1 overstates the likelihood: one event", o)).toBe(true);
  expect(reopensOverrule("f1 should be dropped: it rests on one card", o)).toBe(true);        // a set value keeps the finding
  expect(reopensOverrule("f1 cites c2, which is empty", o)).toBe(false);
  expect(reopensOverrule("f2 overstates the likelihood", o)).toBe(false);
  expect(reopensOverrule("f1 is overconfident", o)).toBe(false);                              // confidence was not set
  expect(reopensOverrule("f1 is missing and should be restored", overrule({ stays: false }))).toBe(true);
});
```
- [ ] **Step 10: FAIL. Step 11: implement.** `reopensOverrule` requires `namesFinding(point, o.finding)` and one of: `o.likelihood !== null` and `/likel|probab|chance|certain|overclaim|overstat|understat/i`; `o.confidence !== null` and `/\b(?:over|under|un)?confiden(?:ce|t)\b/i`; `o.stays === false` and `/restor|reinstat|missing|bring back/i`; `o.stays !== false` and not withdrawn and `/\b(?:drop|remov|delet|omit|withdraw)\w*/i`. **Step 12: PASS.**

- [ ] **Step 13: failing tests for rulings and blockers** (`tests/core/state-analysis.test.ts`). Replace the test at line 553 ("…records the person's ruling once") with:

```ts
test("review.conflict records the conflict in the run; a later review.ruled replaces the ruling and keeps the earlier one", () => {
  // ruled follow challenge "one event", then follow evaluate ""
  expect(s.conflicts.k1!.ruling).toEqual({ follow: "evaluate", note: "", by: "analyst", seq: second.seq, ts: second.ts });
  expect(s.conflicts.k1!.earlier_rulings).toEqual([{ follow: "challenge", note: "one event", by: "analyst", seq: first.seq, ts: first.ts }]);
});
test("a conflict ruled once has no earlier_rulings", () => { expect("earlier_rulings" in s.conflicts.k1!).toBe(false); });
test("an overrule of a ruled finding, made after the ruling, takes its place: ruledFindings leaves the ruling out", () => {});
test("a draft that does not hold a ruling of this run, or an overrule, cannot be published, and says which", () => {
  expect(blockers(s, d.hash)).toContain("The draft does not hold your ruling on f1 (follow Challenge: keep likely)");
  expect(blockers(s2, d.hash)).toContain("The draft does not hold your overrule of f1 (likelihood almost certain)");
  // a draft that holds them: neither line; a withdrawn overrule: no line
});
```
and in `tests/core/whole-run.test.ts`:
```ts
test("a ledger with none of slice 8's entries folds with no question, no overrule and no replaced ruling", () => {
  // the file's whole run: state.questions {}, state.overrules {}, counters.question 0, no conflict has earlier_rulings, skipped []
});
test("a ledger holding a statement, a question, its answer, an overrule and a revised ruling folds the same at every entry as the live session saw it", () => {
  // append them to the whole run through the session, capturing session.state after each commit; fold(entries, seq) toEqual the captured state for every seq
});
```
- [ ] **Step 14: FAIL. Step 15: implement.** In `applyConflicts`, `review.ruled` no longer returns early for a ruled conflict: the new ruling replaces, and the replaced one is appended to `earlier_rulings`. Move `ruledValue` and `holds` from `src/pipeline/conflict.ts` to `conflicts.ts`; the pipeline file keeps `export { holds } from "../core/state"`. `unheld` reads `ruledFindings` (so a ruling an overrule replaced gives no line) and `activeOverrules`; `blockers` appends `unheld(state, draft.product)` after the challenge lines. `describe.ts` rows: `"question.asked": ["question put to the person", id · text]`, `"question.answered": ["question answered", question · card]`, `"finding.overruled": ["finding overruled", finding · what was set · note]` (read loosely, as the other rows do); add their tests beside the `review.ruled` row's test. **Step 16: PASS; full suite with the browser; typecheck; commit** `feat(core): questions, the person's statements, overrules and revised rulings in the fold`.

---

### Task 2: A statement by the person: recorded, packed, cited, checked, published

**Files:**
- Create: `src/pipeline/person.ts`, `src/modules/about.ts`, `src/server/statement-commands.ts`, `src/server/overrule-commands.ts`, `src/server/question-commands.ts`
- Modify: `src/server/app.ts`, `src/agents/context.ts`, `src/agents/tools/analysis.ts`, `src/agents/tools/cards.ts`, `src/agents/draft.ts`, `src/pipeline/conflict.ts`, `src/pipeline/checks.ts`, `src/pipeline/publish.ts`, `sample/checks/05-source-quality.ts`, `sample/checks/08-gaps-and-negatives.ts`
- Test: `tests/pipeline/person.test.ts` (new), `tests/server/statement-commands.test.ts` (new), `tests/agents/context.test.ts`, `tests/agents/tools-analysis.test.ts`, `tests/agents/tools-cards.test.ts`, `tests/agents/draft.test.ts`, `tests/pipeline/next.test.ts`, `tests/pipeline/checks.test.ts`, `tests/sample/form-checks.test.ts`, `tests/pipeline/publish.test.ts`

**Interfaces:**
- Consumes: `Card.person`, `isPersonCard`, `PERSON_SOURCE`, `BASIS_TEXT`, `PERSON_BASES` (Task 1).
- Produces:
```ts
// src/pipeline/person.ts
export class PersonRefused extends Refused {}
export const MAX_STATEMENT = 4000; export const MAX_DETAIL = 500; export const MAX_ABOUT = 20;
/** The card a statement becomes. Pure; the id is the caller's. why is BASIS_TEXT[basis], with ": <detail>" when there is one. */
export function personCard(id: string, input: { title: string; statement: string; basis: PersonBasis; detail: string; about: Observable[]; answers: string | null; marking: Marking }): Card;
// src/modules/about.ts (in modules, so both src/pipeline and src/agents/tools may import it)
/** Why the values are not ones this root knows: "there is no type <t>", "<value> is not of the type <type>" or "at most 20 values"; null when they are fine. */
export function aboutProblem(registry: Registry, observables: Observables, about: Observable[]): string | null;
// src/pipeline/person.ts
/** Records what the person knows as a card in Incoming and returns its id. Throws PersonRefused. */
export function addStatement(session: CaseSession, deps: RunnerDeps, input: { actor: Actor; statement: string; basis: PersonBasis; detail: string; about: Observable[]; marking: Marking | null }): string;
// command add_statement: args { statement: string; basis: PersonBasis; detail?: string; about?: { type: string; value: string }[]; marking?: Marking | null }; then "nothing"
// src/pipeline/checks.ts
CheckInput.cards[id].person?: { basis: PersonBasis; answers: string | null };     // only on a statement card
// src/agents/draft.ts: buildProduct adds { source: PERSON_SOURCE, quality } when a cited card is a statement
```

- [ ] **Step 1: failing tests for the command** (`tests/pipeline/person.test.ts` with `fixture()` from `tests/helpers/tools-fixture.ts`; `tests/server/statement-commands.test.ts` with `served()`).

```ts
test("addStatement records one card.created in the person's name: a note with no rows, the case's marking, and how they know", () => {
  const id = addStatement(f.s, f.sample.deps, { actor: person, statement: "The device at 192.0.2.17 is the meeting-room TV.", basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], marking: null });
  expect(f.s.state.cards[id]).toMatchObject({ kind: "note", made_by: "human", title: "Statement: The device at 192.0.2.17 is the meeting-room TV.", body: "The device at 192.0.2.17 is the meeting-room TV.", row_count: 0, query: null, source: null, marking: "TLP:GREEN", why: "did it myself: I installed it", place: "incoming", person: { basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], answers: null } });
});
test("a title is the statement's first 80 characters on one line", () => {});
test("a stricter marking is taken; one below the case's is refused", () => { /* "a statement cannot be marked below the case's TLP:GREEN" */ });
test("an empty statement, one past 4000 characters, an unknown type and a value that is not of its type are refused, and nothing is written", () => {
  // "a statement needs text" · "a statement is at most 4000 characters" · "there is no type colour" · "not-an-address is not of the type address"
});
test("only a person may add a statement", () => { /* an agent actor: "only a person may add a statement" */ });
// tests/server/statement-commands.test.ts
test("add_statement writes the card in the server's name and moves nothing; a requester may not", async () => {});
test("the three person command files are loaded: add_statement is defined, and app.ts imports each file once", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement.** `overrule-commands.ts` and `question-commands.ts` hold one comment line each ("// Task 3 defines overrule_finding here." / "// Task 4 defines answer_question here.") and `export {};`; `app.ts` imports all three beside `./playbook-commands`. **Step 4: PASS; commit** `feat(server): the person adds what they know as a card`.

- [ ] **Step 5: failing tests for packs and tools.**

```ts
// tests/agents/context.test.ts
test("a statement card's part says it is the person's word, not data, and has no coverage, columns or rows lines", () => {
  expect(part.text).toBe(["Card c1: Statement: The device at 192.0.2.17 is the meeting-room TV.", "The device at 192.0.2.17 is the meeting-room TV.",
    "Source: the person (did it myself: I installed it). A statement by the person running the investigation, not data from a source.", "About: address 192.0.2.17"].join("\n"));
  // with answers "ask-1": a last line "Answers: ask-1"; with no about: no About line
});
// tests/agents/tools-analysis.test.ts
test("a finding may cite a statement by the person, though it has no rows", async () => { /* propose_assessment cites the statement card: ok */ });
test("a narrative section may name a statement card", async () => {});
// tests/agents/tools-cards.test.ts
test("list_cards marks a statement and read_card says how the person knows; other cards' views are as before", async () => {
  expect(brief.person).toBe(true); expect("person" in otherBrief).toBe(false);
  expect(view.person).toEqual({ basis: "did", how: "did it myself: I installed it", about: [{ type: "address", value: "192.0.2.17" }], answers: null });
});
// tests/pipeline/next.test.ts, beside the uncitableNote tests
test("a send-back that names a statement card gets no cannot-be-cited note", () => { expect(uncitableNote(s, ["f1 should cite c5"])).toBeNull(); });
```
- [ ] **Step 6: FAIL, then implement.** `packPart` (`context.ts:141`): for `isPersonCard(card)` the text is the four kinds of line above (title and body scrubbed as now). `notSeen` (`analysis.ts:30`) is false for a statement. `uncitableNote` (`conflict.ts`) skips one. `cardBrief` and `readCard` add `person` only for a statement. Add to `propose_assessment`'s description: "A statement by the person may be cited; say in confidence_basis that the finding rests on the person's word." **PASS; commit** `feat(agents): a statement by the person is packed and cited as the person's word`.

- [ ] **Step 7: failing tests for the sources, the checks and the product.**

```ts
// tests/agents/draft.test.ts
test("a product that cites a statement names the person in its sources, with each statement and what cites it", () => {
  // f1 cites c1 (a result) and c5 (did); the summary cites c6 (told) by tool
  expect(product.sources.find((x) => x.source === "the person")!.quality).toBe(
    "Statements by the person running the investigation, not data from a source and not checked by the workbench: c5 (did it myself; cited by f1), c6 (was told; cited in the narrative).");
});
test("the person's line is rebuilt each time: a draft that no longer cites a statement drops it, though other sources are kept", () => {});
test("a product citing no statement has the sources it had before this change", () => {});
// tests/pipeline/checks.test.ts
test("a check is told which cited cards are the person's statements; an input with none is byte for byte what it was", () => {
  expect(input.cards.c5!.person).toEqual({ basis: "did", answers: null }); expect("person" in input.cards.c1!).toBe(false);
});
// tests/sample/form-checks.test.ts
test("source-quality fails a finding that rests on a statement the sources do not name", async () => {
  // no "the person" entry: "f1 rests on the person's statement c5, and the sources do not say so"; an entry that does not name c5: the same; an entry naming it: pass
});
test("gaps-and-negatives does not treat a statement as an empty result", async () => { /* f1 cites c5 (row_count 0, person): pass */ });
test("the checks and the workbench spell the person's source the same", () => { /* the text of 05-source-quality.ts holds JSON.stringify(PERSON_SOURCE) */ });
// tests/pipeline/publish.test.ts
test("the product says which findings rest on the person's word, and the provenance says how the person knows", () => {
  expect(files["product.md"]).toContain("Rests on the person's statement: [c5] (did it myself). A statement, not data from a source.");
  expect(files["provenance.md"]).toContain("- Source: the person (a statement, not data from a source)");
  expect(files["provenance.md"]).toContain("- How they know: did it myself: I installed it");
  expect(JSON.parse(files["provenance.json"]!).find((r) => r.card === "c5")).toMatchObject({ by: "human:analyst", person: { basis: "did", detail: "I installed it", answers: null } });
});
test("a bundle of a draft that cites no statement is byte for byte what it was", () => { /* no "person" key in any provenance row; product.md has no "Rests on" line */ });
```
- [ ] **Step 8: FAIL. Step 9: implement.** `buildProduct`: remove `PERSON_SOURCE` from `kept` before the new entries are set, then add the line when a cited card is a statement, cards in id order (`<`, by the number after `c`), each `"<id> (<BASIS_TEXT>; cited by f1, f2)"`, `"… cited in the narrative)"`, or `"… cited by f1 and in the narrative)"`. `checkInput` adds `person` only for a statement. Check 5 reads `card.person` before its `card.source === null` skip; check 8 skips a card with `person` in its empty-result rule. `provenanceOf` adds `person` (with `question`, the text of the question it answers, or null) only for a statement, and `by` is `who()` of the actor of the card's `card.created` entry; `productMarkdown` takes the statement cards and adds the line after `Citations:`; `provenanceMarkdown` writes Source, How they know, About (when any) and Answers (when any) in place of the query lines. **Step 10: PASS; full suite with the browser; typecheck; commit** `feat(pipeline): a finding that rests on the person's word is checked and labelled in the product`.

---

### Task 3: Overrules, and a ruling that can be revised

**Files:**
- Create: `src/pipeline/overrule.ts`
- Modify: `src/pipeline/engine.ts`, `src/pipeline/revise.ts`, `src/pipeline/conflict.ts`, `src/pipeline/review-points.ts`, `src/pipeline/contract.ts`, `src/pipeline/stages/assemble.ts`, `src/agents/tools/analysis.ts`, `src/server/overrule-commands.ts`
- Test: `tests/pipeline/overrule.test.ts` (new), `tests/pipeline/revise.test.ts`, `tests/pipeline/next.test.ts`, `tests/pipeline/engine.test.ts`, `tests/pipeline/stages-analysis.test.ts`, `tests/agents/tools-analysis.test.ts`, `tests/server/overrule-commands.test.ts` (new), `tests/server/commands.test.ts`

**Interfaces:**
- Consumes: `activeOverrules`, `overruleSays`, `overruleText`, `holdsOverrule`, `reopensOverrule`, `ruledFindings`, `holds`, `unheld` (Task 1); `composeStatement`, `termsOf` (`src/agents/draft.ts`).
- Produces:
```ts
// src/pipeline/overrule.ts
export class OverruleRefused extends Refused {}
/**
 * The findings as the overrules leave them: a dropped one removed; a set likelihood (its statement worded again by composeStatement, when the
 * standard has terms) and a set confidence put in place; a finding that must be there and is not, restored from the latest draft that held it
 * (less its cites to cards `live` refuses), after the others, in overrule order. Pure.
 */
export function overruledFindings(findings: readonly Finding[], overrules: readonly Overrule[], drafts: readonly Draft[], terms: StandardTerms | null, live: (card: string) => boolean): Finding[];
/** Records the overrule; when a run is in progress and the latest draft does not hold it, the same commit makes the person's revision that does. Throws OverruleRefused. */
export function overrule(session: CaseSession, deps: Pick<EngineDeps, "pipeline" | "profile" | "registry">, input: { actor: Actor; finding: string; draft_hash: string; likelihood: string | null; confidence: Finding["confidence"] | null; stays: boolean | null; note: string }): void;
// src/pipeline/revise.ts
/** What reviseDraft commits, built from one state: the revision and, at the gate or on a stopped stage, the review stage it starts. Throws ReviseRefused. */
export function revisionEntries(state: Readonly<CaseState>, pipeline: Pipeline, input: { product: Product; reason: string; actor: Actor }, overrules?: readonly Overrule[]): { draft: Draft; entries: EntryInput[] };
// src/pipeline/engine.ts
Engine.overrule(input: Parameters<typeof overrule>[2]): void;
// src/pipeline/contract.ts: EngineCommand += "overrule"; THEN_ADVANCE.overrule = true
// command overrule_finding: args { finding: string; draft_hash: string; likelihood: string | null; confidence: "low" | "moderate" | "high" | null; stays: boolean | null; note: string }; then thenAfter("overrule")
```

- [ ] **Step 1: failing tests for `overruledFindings`** (`tests/pipeline/overrule.test.ts`; `terms` from `termsOf` of the sample's `icd203` body).

```ts
test("a set likelihood replaces the term in the field and in the statement", () => {
  // f1 "We assess it is roughly even chance that the device is idle." overruled to almost certain
  expect(out[0]).toMatchObject({ id: "f1", likelihood: "almost certain", statement: "We assess it is almost certain that the device is idle." });
});
test("a set confidence replaces the confidence and leaves the rest", () => {});
test("a dropped finding is removed; a finding that must stay and is gone comes back from the latest draft that held it, after the others", () => {});
test("a restored finding loses its cites to cards that are discarded or gone", () => {});
test("with no standard terms the statement is left as written and the likelihood field is set", () => {});
test("no overrule, a withdrawn one, and an overrule of a finding no draft held leave the findings as given", () => { expect(overruledFindings(fs, [], drafts, terms, () => true)).toEqual(fs); });
test("the input is not changed, and the same input gives the same output", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement** `overruledFindings`. **Step 4: PASS.**

- [ ] **Step 5: failing tests for the command, the edit rule and Assemble** (`tests/pipeline/overrule.test.ts`, `revise.test.ts`, `stages-analysis.test.ts`; use each file's own rig for a run with a draft).

```ts
test("an overrule at the publish gate writes finding.overruled and the person's revision in one commit, and review starts again", () => {
  // types of the commit: ["finding.overruled", "draft.revised", "stage.started"]; the new draft's f1.likelihood is "almost certain", its author the person,
  // its reason "overruled f1: likelihood almost certain. Note: It is the TV I installed."
});
test("an overrule while Assemble is working writes only finding.overruled; the draft Assemble then builds holds it", async () => {});
test("an overrule with no run in progress writes only finding.overruled, and the next run's first Assemble draft holds it", async () => {});
test("an overrule the latest draft already holds writes only finding.overruled", () => {});
test("an overrule is refused: not by a person; no note; a draft that is not the latest; a finding no draft held; a term the standard does not have; a dropped finding with a value; nothing to withdraw; the same overrule again", () => {
  // "only a person may overrule a finding" · "an overrule needs a note" · "a newer draft arrived; look at it before overruling" · "there is no finding f9" ·
  // '"sure" is not a likelihood term of the standard: give one of almost no chance, …' · "a dropped finding has no likelihood or confidence to set" ·
  // "there is no overrule of f1 to withdraw" · "that is already the overrule of f1"
});
test("withdrawing an overrule writes finding.overruled with nothing set and no revision", () => {});
// tests/pipeline/revise.test.ts
test("a person's edit that does not hold their overrule is refused with the way out", () => {
  // "f1 is overruled (likelihood almost certain); overrule it again, or withdraw the overrule, to change it"
});
test("reviseDraft writes what it wrote before", () => { /* the existing tests pass unchanged over revisionEntries */ });
// tests/pipeline/stages-analysis.test.ts
test("Assemble proposes an overruled finding at another likelihood: the draft it records holds the overrule", async () => {});
test("Assemble leaves out a finding that must stay: the draft has it, restored", async () => {});
test("the analyst's and both reviewers' packs list the overrules as fixed", async () => {
  expect(partText).toContain("Overrules by the person (fixed: code holds every draft to them, and neither reviewer may reopen them):\n- f1: likelihood almost certain. Note: It is the TV I installed.");
});
```
- [ ] **Step 6: FAIL. Step 7: implement.** `overrule` runs in one `session.commit`: refuse as listed; build the `finding.overruled` entry; when `run.status` is not `none` or `finished`, and the current stage is not an `assemble`-role stage with status `running`, and the latest product with `overruledFindings` applied differs from it, append `revisionEntries(state, pipeline, { product, reason: \`overruled ${overruleText(o)}\`, actor }, overrulesNow).entries`, where `overrulesNow` is the active overrules with this one in place. `revisionEntries` is `reviseDraft`'s builder moved out unchanged, plus the refusal for a product that does not hold `overrules` (default `activeOverrules(state)`). `assembleRunner`, just before `buildProduct`: replace `work.findings` in place with `overruledFindings(work.findings, activeOverrules(now), now.drafts, terms, (id) => Object.hasOwn(now.cards, id) && now.cards[id]!.place !== "discarded")`. `reviewPointsPart` adds the overrules section beside the rulings section in all three views. **Step 8: PASS; commit** `feat(pipeline): the person overrules a finding, and code holds every draft to it`.

- [ ] **Step 9: failing tests for the reviewers** (`tests/pipeline/next.test.ts`, beside the ruling tests; `tests/agents/tools-analysis.test.ts`).

```ts
test("a failed review whose only point would move an overruled finding back pauses instead of sending back", () => {
  expect(step).toMatchObject({ kind: "pause", hold: { kind: "ruled", stage: "evaluate" } });
  expect(step.reason).toBe("Evaluate objects only to f1, which the person has ruled on or overruled; a settled point is not sent back. Edit the draft, or resume for Evaluate to review it again.");
});
test("another point on an overruled finding goes back to the analyst as usual", () => { /* "f1 cites c2, which is empty": kind "start", stage "assemble" */ });
test("an overruled finding is not made a conflict between the reviewers again", () => {});
test("a draft that does not hold an overrule goes back with the overrule, beside the reviewer's other points", () => {
  expect(step.sent_back!.reason).toStartWith("the draft does not hold the person's overrule of f1: likelihood almost certain. Note: It is the TV I installed.");
});
test("with rulings only, the pause says what it said before", () => { /* the existing "objects only to … which the person has ruled on; a ruled point is not sent back" text */ });
// tests/agents/tools-analysis.test.ts
test("raise_challenge refuses a challenge that would move an overruled finding back, and takes another point on it", async () => {
  // "the person has overruled f1 (likelihood almost certain): that may not be reopened; any other point on f1 may be raised"
});
```
- [ ] **Step 10: FAIL. Step 11: implement** in `reviewConflict`: the set of findings no fresh conflict is made on is `ruledFindings` keys and the active overrules' findings; the unheld list and the "every point reopens something settled" test read rulings (`holds`, `reopens`) and overrules (`holdsOverrule`, `reopensOverrule`) alike; the pause sentence is the existing one when only rulings are involved. `raiseChallenge` adds the refusal after its ruling loop. **Step 12: PASS; commit** `feat(pipeline): a reviewer cannot move an overruled finding back`.

- [ ] **Step 13: failing tests for a revised ruling** (`tests/pipeline/engine.test.ts`, `tests/server/commands.test.ts`).

```ts
test("a conflict may be ruled again while its run is in progress; the same ruling again is refused", () => {
  // second ruling written; then "that is already the ruling on k1"; after run.finished: "conflict k1 is from a run that is over"
});
test("a ruling revised after the draft was made to the earlier one sends the work back at the next review with the new ruling", async () => {});
test("rule_conflict on a ruled conflict records the new ruling in the server's name", async () => {});
// tests/server/overrule-commands.test.ts
test("overrule_finding overrules in the server's name and the run reviews the new draft; a requester may not", async () => {});
test("overrule_finding on a draft that is no longer the latest is 409 and writes nothing", async () => {});
```
- [ ] **Step 14: FAIL. Step 15: implement.** `Engine.rule` drops its "has already been ruled on" refusal and refuses a ruling equal to the current one; its doc comment and `contract.ts`'s say a ruling holds until it is replaced. `overrule_finding` is defined in `src/server/overrule-commands.ts` and calls `engine.overrule`. **Step 16: PASS; full suite with the browser; typecheck; commit** `feat(pipeline): a ruling can be revised; overrule_finding`.

---

### Task 4: A stage asks the person, and the person answers

**Files:**
- Create: `src/agents/tools/person.ts`, `src/pipeline/questions.ts`
- Modify: `src/agents/tools/index.ts`, `src/modules/config.ts`, `src/pipeline/stages/agent.ts`, `src/server/question-commands.ts`
- Test: `tests/agents/tools-person.test.ts` (new), `tests/pipeline/questions.test.ts` (new), `tests/modules/config.test.ts`, `tests/pipeline/stage-agent.test.ts`, `tests/server/question-commands.test.ts` (new)

**Interfaces:**
- Consumes: `Question`, `QuestionState`, `runQuestions`, `openQuestions`, `waitingOn` (Task 1); `personCard`, `PersonRefused`, `MAX_STATEMENT` (`src/pipeline/person.ts`) and `aboutProblem` (`src/modules/about.ts`) (Task 2). The tool file imports `aboutProblem` only; it imports nothing from `src/pipeline`.
- Produces:
```ts
// src/agents/tools/index.ts
TOOL_NAMES += "ask_person";
ToolContext.max_open_questions?: number;              // DEFAULT_MAX_OPEN when absent
// src/agents/tools/person.ts
export const DEFAULT_MAX_OPEN = 3;
export const PERSON_TOOLS: ToolDef[];                 // ask_person: { why, question, cards?, about?, blocking }
// src/modules/config.ts
Config.questions: { max_open: number };               // file key questions.max_open, integer >= 0, default 3
// src/pipeline/questions.ts
/** The run's questions as one pack part: who asked, the text, and the answer or that there is none. Null when the run has none. Throws ContextError as packPart does. */
export function questionsPart(session: CaseSession, registry: Registry): PackPart | null;
/** The marking of the request that wrote the question; null when it cannot be known. */
export function questionMarking(session: CaseSession, q: QuestionState): Marking | null;
/** Records the person's answer: a statement card that answers the question, and question.answered naming it, in one commit. Returns the card id. Throws PersonRefused. */
export function answerQuestion(session: CaseSession, deps: RunnerDeps, input: { actor: Actor; question: string; answer: string; basis: PersonBasis; detail: string; about: Observable[] | null; marking: Marking | null }): string;
// command answer_question: args { question: string; answer: string; basis?: PersonBasis; detail?: string; about?: { type: string; value: string }[]; marking?: Marking | null }; then "nothing"
```

- [ ] **Step 1: failing tests for the tool** (`tests/agents/tools-person.test.ts`, with `fixture()`; start a run by hand so the questions have one).

```ts
test("ask_person records the question with why it matters and what it is about, and tells the agent to carry on", async () => {
  const r = await f.call("ask_person", { why: "A TV there would explain the name.", question: "Where is the access point AP-7, and is a TV expected there?", cards: ["c1"], about: [{ type: "address", value: "192.0.2.17" }], blocking: true });
  expect(r).toMatchObject({ ok: true, summary: "asked ask-1", view: { question: "ask-1", blocking: true, status: "asked; carry on with what does not depend on the answer" }, marking: null });
  expect(f.s.state.questions["ask-1"]).toMatchObject({ text: "Where is the access point AP-7, and is a TV expected there?", why: "A TV there would explain the name.", cards: ["c1"], blocking: true, by: "researcher-g1" });
});
test("the entry carries the stage and job the agent works in", async () => {});
test("with three questions open a fourth is refused, and names them", async () => {
  // "3 questions to the person are already open (ask-1, ask-2, ask-3); go on without asking another"
});
test("an answered question frees a place; the cap is the context's when it gives one, and 0 turns asking off", async () => { /* "this root does not let a stage ask the person" */ });
test("the same question, in other spacing or case, is refused while the first is open", async () => { /* "that question is already open as ask-1" */ });
test("an unknown or discarded card, an unknown type and a value that is not of its type are refused", async () => {});
test("after the person went on without answering a stage's blocking question, that stage's next one is recorded as not blocking, and the agent is told", async () => {
  // view.blocking false; status "asked, not blocking: the person went on without answering ask-1; carry on with what does not depend on the answer"
});
test("every tool has a definition: none is 'Not available yet'", () => { for (const n of TOOL_NAMES) expect(TOOLS[n].description).not.toBe("Not available yet."); });
```
- [ ] **Step 2: FAIL. Step 3: implement.** The count, the duplicate test and the append are in one `session.commit` builder, so two researchers asking at once cannot pass the cap. Description: "Ask the person running the investigation something no source holds: what a device is, where it is, who installed it, whether it is expected. They can go and look. Asking does not stop your work: carry on with what does not depend on the answer. Set blocking only when this stage's result would be wrong without the answer." `why` (every tool has it) is why the answer matters. **Step 4: PASS; commit** `feat(agents): ask_person puts a question to the person`.

- [ ] **Step 5: failing tests for the answer, the part and the config.**

```ts
// tests/pipeline/questions.test.ts
test("answerQuestion writes the person's statement card and question.answered in one commit, the card caused by the question", () => {
  // types ["card.created", "question.answered"]; card: title "Answer to ask-1: Where is the access point AP-7, and is a TV expected there?" (question cut at 60 characters with "…"),
  // body the answer, person.answers "ask-1", person.about the question's when the person gave none; cause === the question's seq
});
test("the answer card is at least as strict as the case, the person's choice and the request that wrote the question", () => { /* question written under TLP:AMBER in a TLP:GREEN case: card TLP:AMBER */ });
test("an answer is refused: an unknown question, one already answered, no text, a marking below the case's, not by a person", () => {
  // "there is no question ask-9" · "ask-1 is already answered (card c3); add a statement to correct it" · "an answer needs text"
});
test("a question from an earlier run can still be answered", () => {});
test("questionsPart lists the run's questions with who asked and what came of each, and carries the questions' and answers' markings", () => {
  expect(part!.text).toBe([
    "Questions put to the person in this run. An answer is a card: cite it like any card, and say the finding rests on the person's word.",
    "- ask-1 (asked by Research; blocking): Where is the access point AP-7? Answered in card c3: In the lobby. A TV is expected there.",
    "- ask-2 (asked by Assemble): Who owns the laptop? Not answered yet.",
    "- ask-3 (asked by Research; blocking): Is the printer new? Not answered; the person went on without answering: name this under gaps_and_limits.",
  ].join("\n"));
  expect(part).toMatchObject({ kind: "note", id: "questions", fixed: true, marking: "TLP:AMBER" });
});
test("questionsPart is null for a run with no question", () => {});
// tests/pipeline/stage-agent.test.ts
test("every agent stage's pack holds the questions part once a question is asked, and its tools take the cap from the config", async () => {});
// tests/modules/config.test.ts
test("questions.max_open defaults to 3, is read from the file, and a negative or fractional one is refused", () => {});
// tests/server/question-commands.test.ts
test("answer_question answers in the server's name with basis 'unstated' when none is given; a requester may not", async () => {});
test("answering the question a run is held for resumes the run; answering another leaves it paused", async () => {
  // commit run.paused { reason, hold: { kind: "question", stage: "research" } } by hand on a run whose research stage is running, with ask-1 and ask-2 blocking
});
```
- [ ] **Step 6: FAIL. Step 7: implement.** `stageAgent` puts `questionsPart` after `casePart` when it is not null, inside the existing `try` (a `ContextError` stalls the stage as the others do), and sets `max_open_questions: deps.config.questions.max_open` on the tool context. `answer_question`: after `answerQuestion`, when `state.run.status === "paused"`, `state.run.hold?.kind === "question"` and `waitingOn(state, hold.stage)` is empty, `hub.background(engine.resume(actor))`. Any test that builds a `Config` by hand gains `questions: { max_open: 3 }`. **Step 8: PASS; full suite with the browser; typecheck; commit** `feat(pipeline): the person answers a question with a card; stages see what was asked`.

---

### Task 5: The pass held for an answer, and the gap named

**Files:**
- Modify: `src/pipeline/engine.ts`, `src/pipeline/questions.ts`, `src/pipeline/stages/assemble.ts`, `src/pipeline/checks.ts`, `sample/checks/08-gaps-and-negatives.ts`
- Test: `tests/pipeline/engine.test.ts`, `tests/pipeline/questions.test.ts`, `tests/pipeline/stages-analysis.test.ts`, `tests/pipeline/checks.test.ts`, `tests/sample/form-checks.test.ts`

**Interfaces:**
- Consumes: `waitingOn`, `openQuestions`, `runQuestions` (Task 1); `questionMarking` (Task 4); `FORM_EXCEPTIONS`, `CARD_REF` (`src/agents/draft.ts`).
- Produces:
```ts
// src/pipeline/questions.ts
/** "waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it." ("ask-1 and ask-2" for two.) */
export function waitingReason(waiting: readonly QuestionState[]): string;
export const OPEN_QUESTIONS = "Questions the person has not answered:";
/**
 * gaps_and_limits with the note of open questions: any earlier note (from OPEN_QUESTIONS to FORM_EXCEPTIONS, or to the end) is replaced, it sits
 * before the form exceptions note, and with no open question none is left. A card id in a question is written "card <n>", so the note cites no card.
 */
export function withOpenQuestions(gaps: string, open: readonly { id: string; text: string }[]): string;
// src/pipeline/checks.ts
CheckInput.questions?: { id: string; text: string }[];       // the run's unanswered questions; absent when there is none
```

- [ ] **Step 1: failing tests for the hold** (`tests/pipeline/engine.test.ts`; stage runners given through `opts.runners`, each committing its `question.asked` by hand as an agent of that stage).

```ts
test("a stage that passes with a blocking question unanswered is not finished: the run pauses, waiting for the answer", async () => {
  expect(ofType("stage.finished").filter((e) => e.payload.stage === "research")).toEqual([]);
  expect(state.run).toMatchObject({ status: "paused", pause_reason: "waiting for the person's answer to ask-1. Answer it in the Narrative lens, or resume to go on without it.", hold: { kind: "question", stage: "research" } });
  expect(stageOf("research").status).toBe("running");
});
test("resumed without an answer, the stage runs again, passes, and the run goes on; the question is waived and still open", async () => {
  expect(runs.research).toBe(2); expect(state.questions["ask-1"]).toMatchObject({ answer: null, waived: { by: "analyst" } }); expect(stageOf("research").status).toBe("passed");
});
test("answered and resumed, the stage runs again and passes, with nothing waived", async () => {});
test("a question that is not blocking, one another stage asked, one of an earlier run, and a waived one do not hold a pass", async () => {});
test("a stage that fails is not held: it goes where a failure goes", async () => {});
test("a blocking question answered while its stage was still working runs the stage once more, with no pause", async () => {
  // the runner asks, the test answers before the runner returns: runs.assemble === 2, no run.paused entry
});
test("a held Plan runs again on resume, and the plan gate waits on the plan it proposed last", async () => {});
test("stopping a run that waits for an answer finishes it", async () => {});
test("a restart finds the held run paused, and a resume runs the stage", async () => { /* a second Engine.open on the same ledger */ });
```
- [ ] **Step 2: FAIL. Step 3: implement** in `Engine.exec`. Read `const startedAt = this.session.head().seq` before the runner is called. After the runner returns, when `end` is a finished pass: (a) `waitingOn(state, stageId)` not empty → commit `this.paused(ENGINE, waitingReason(waiting), { kind: "question", stage: stageId })` under the same `gone` guard as a stall, write no `stage.finished`, and return whether it was written; (b) else, when a blocking question this stage asked in this run has `answer.seq > startedAt` → return `true` and write nothing, so the drive executes the stage again. Otherwise go on as now. **Step 4: PASS; commit** `feat(pipeline): a blocking question holds its stage's pass until the person answers or goes on`.

- [ ] **Step 5: failing tests for the named gap.**

```ts
// tests/pipeline/questions.test.ts
test("withOpenQuestions appends the note, replaces an earlier one, and removes it when nothing is open", () => {
  expect(withOpenQuestions("No flow logs before the 17th.", [{ id: "ask-2", text: "Who owns\nthe laptop?" }])).toBe("No flow logs before the 17th.\n\nQuestions the person has not answered:\n- ask-2: Who owns the laptop?");
  expect(withOpenQuestions(that, [])).toBe("No flow logs before the 17th.");
});
test("the note sits before the form exceptions note and leaves it whole", () => {});
test("a card id in a question is written so that it cites no card", () => { expect(withOpenQuestions("", [{ id: "ask-1", text: "is c3 the TV?" }])).toBe("Questions the person has not answered:\n- ask-1: is card 3 the TV?"); });
// tests/pipeline/stages-analysis.test.ts
test("a draft assembled while a question is open names it in gaps_and_limits, and one assembled after the answer does not", async () => {});
test("the draft is at least as strict as the request that wrote a question it names", async () => {});
// tests/pipeline/checks.test.ts
test("a check is told the run's unanswered questions; with none the input is what it was", () => {});
// tests/sample/form-checks.test.ts
test("gaps-and-negatives fails a draft whose gaps do not name an unanswered question", async () => {
  // "ask-1 was put to the person and is not answered, and the gaps and limits do not name it"
});
```
- [ ] **Step 6: FAIL. Step 7: implement.** `assembleRunner`, after the overrules are applied and before `buildProduct`: `work.setSection("gaps_and_limits", withOpenQuestions(work.sections.gaps_and_limits, openQuestions(now)), work.narrativeCites.gaps_and_limits)`, and `written_at` gains `questionMarking` of each open question (when not null). `checkInput` adds `questions` from `openQuestions(state)` only when there is one. Check 8 requires each id, as a whole word, in `gaps_and_limits`. **Step 8: PASS; full suite with the browser; typecheck; commit** `feat(pipeline): a draft names the questions the person has not answered`.

---

### Task 6: Statements on screen

**Files:**
- Create: `src/web/panels/statement.ts`
- Modify: `src/web/views/incoming.ts`, `src/web/views/card.ts`, `src/web/derive.ts`, `src/web/markdown.ts`, `src/web/commands.ts`, `src/web/views/help.ts`, `src/web/style.css`
- Test: `tests/web/statement.test.ts` (new), `tests/web/card.test.ts`, `tests/web/derive.test.ts`, `tests/web/markdown.test.ts`, `tests/web/commands.test.ts`, `tests/web/workarea.test.ts`

**Interfaces:**
- Consumes: `isPersonCard`, `BASIS_TEXT`, `PERSON_BASES` (Task 1); command `add_statement` (Task 2).
- Produces:
```ts
// src/web/derive.ts
export type CardStatus = "statement" | "answered" | "partial" | "proven negative" | "nothing found";     // cardStatus is "statement" for a person's card, before any other test
// src/web/panels/statement.ts
/** The form "Add what you know": the statement, how you know it, what it is about, and a marking no lower than the case's. */
export function makeStatementForm(ui: Ui, store: CaseStore): View;
// src/web/commands.ts
Intent += { kind: "state"; text: string };            // "state <text>": add_statement with basis "unstated"
```

- [ ] **Step 1: failing tests** (use `page()` from `tests/helpers/dom.ts` as the neighbouring tests do; statements are added with `p.s.command(id, "add_statement", …)`).

```ts
// tests/web/derive.test.ts
test("a statement by the person is a statement, never 'nothing found'", () => { expect(cardStatus(statementCard)).toBe("statement"); });
// tests/web/card.test.ts
test("a statement card is tagged as the person's statement, and its record says how they know and what it is about", async () => {
  expect(tagTexts).toContain("your statement"); expect(tagTexts).not.toContain("nothing found");
  expect(dl("Source")).toBe("the person: a statement, not data from a source"); expect(dl("How they know")).toBe("did it myself: I installed it");
  expect(dl("About")).toBe("address 192.0.2.17"); expect(dlKeys).not.toContain("Query"); expect(dlKeys).not.toContain("Coverage"); expect(dlKeys).not.toContain("If empty");
});
test("an answer card names the question it answers", async () => { expect(dl("Answers")).toBe("ask-1"); });
test("a statement that looks like markup is drawn as text", async () => { /* body "<img src=x onerror=1>": no img element under the card; its text is the body */ });
test("a statement card has no Verify and no Pivot from rows; Keep and Discard work as for any card", async () => {});
// tests/web/statement.test.ts
test("Add what you know opens the form; Add is off until there is text", async () => {});
test("the form sends add_statement with the statement, the basis, the detail, each value it is about and the marking, then clears and closes", async () => {
  expect(sent).toEqual(["add_statement", { statement: "The device at 192.0.2.17 is the meeting-room TV.", basis: "did", detail: "I installed it", about: [{ type: "address", value: "192.0.2.17" }], marking: null }]);
});
test("the marking list offers the case's marking and stricter ones only; the types are the root's", async () => {});
test("a refusal leaves the form as typed; while replaying the form's controls are off", async () => {});
// tests/web/commands.test.ts
test("state <text> adds a statement, keeping the text's case; outside a case it says to open one", () => {
  expect(parseCommand("state The TV is in the lobby", inCase)).toEqual({ kind: "state", text: "The TV is in the lobby" });
});
// tests/web/markdown.test.ts
test("the copied provenance of a statement says it is the person's word and how they know", () => {});
```
- [ ] **Step 2: run, expect FAIL. Step 3: implement.** The form is a `details.statement-form` in the Incoming column's bar (`incoming.ts:35`), its summary "Add what you know"; a `textarea` (name "What you know"), a `select` of the four bases by `BASIS_TEXT`, an `input` for the detail, rows of a type `select` (from `ui.ref.types`) and a value `input` with "Add another value" (at most 20), a marking `select` whose first option is "the case's marking" (`null`), and the button `[data-action=add-statement]`. It sends through `ui.send`. In `card.ts`: the status tag is `tag(ui, "human", "your statement", "What the person stated; not data from a source")`; `dl` writes Source, How they know, About, Answers, Marking, When for a statement; the Verify action and the pivot chips are not built for it. `markdown.ts` writes the same four lines in place of Source and Query. `help.ts` lists `state <what you know>`. Colour is a class in `style.css`. **Step 4: PASS; full suite with the browser; typecheck; commit** `feat(web): the person adds what they know, and a statement card reads as theirs`.

---

### Task 7: Questions, overrules and ruling history in the Narrative lens

**Files:**
- Modify: `src/web/lenses/narrative.ts`, `src/web/views/brief.ts`, `src/web/commands.ts`, `src/web/views/help.ts`, `src/web/style.css`, `src/core/wire.ts`, `src/server/views.ts`
- Test: `tests/web/narrative.test.ts`, `tests/web/commands.test.ts`, `tests/server/reads.test.ts`, and the file that tests the brief (`grep -ln makeBrief tests/web`)

**Interfaces:**
- Consumes: `runQuestions`, `openQuestions`, `activeOverrules`, `overruleSays`, `overruleText`, `BASIS_TEXT`, `PERSON_BASES`, `rulingText`, `earlier_rulings` (Task 1); commands `answer_question` (Task 4), `overrule_finding`, `rule_conflict` (Task 3).
- Produces:
```ts
// src/core/wire.ts
Reference.likelihood: string[];                        // the profile standard's likelihood terms, least likely first; [] when it names none
// src/web/commands.ts
Intent += { kind: "answer"; question: string; text: string } | { kind: "overrule"; finding: string };
// the Narrative lens takes the argument `overrule:<finding>`: it opens that finding's overrule form and puts focus in it, once
```

- [ ] **Step 1: failing tests for the questions** (`tests/web/narrative.test.ts`; questions are committed by hand as an agent, after a `model.request` of that agent, as the file's `propose` does for proposals).

```ts
test("an open question is shown above the draft with why it matters, what it is about and who asked; a blocking one says the run waits on it", async () => {
  expect(p.q('[data-question="ask-1"] .text').textContent).toBe("Where is the access point AP-7, and is a TV expected there?");
  expect(p.q('[data-question="ask-1"] .why').textContent).toBe("Why it matters: A TV there would explain the name.");
});
test("the question box is there before any draft exists", async () => { /* a case paused in Research with ask-1 open: the lens shows the box and its 'no draft yet' line */ });
test("Answer sends answer_question with the text and how you know, once, and the answer's card replaces the form", async () => {
  expect(sent).toEqual(["answer_question", { question: "ask-1", answer: "In the lobby. A TV is expected there.", basis: "saw", detail: "" }]);
  expect(p.q('[data-question="ask-1"] .card-chip').textContent).toContain("c");
});
test("a question the person went on without answering says so and can still be answered", async () => { /* tag "went on without your answer"; the form is there */ });
test("a question written as markup is drawn as text; replay to before it shows no box; while replaying every control is off", async () => {});
test("an answer given after the latest draft was made is noted at the gate", async () => {
  expect(p.q(".gate-box .answered-since").textContent).toBe("ask-1 was answered after draft 3 was made (card c9). Send the draft back if the answer changes it.");
});
```
- [ ] **Step 2: run, expect FAIL. Step 3: implement.** A `questionsBox` (`div.questions-box`) is the lens's first child, painted from `[s.questions, s.run.id, s.cards, ro(), inflightVersion]` and independent of whether a draft exists. Each question is `div.question[data-question]`: a tag (`attention` "the run waits on this" for a blocking, unanswered, unwaived one; `human` "question"; `done` "answered"), the text, the why, card chips, the values, "asked by <stage title>", then the answer's card chip or the form: `textarea` (name `Answer to ask-1`), basis `select`, detail `input`, `[data-action=answer-question]` through `guarded`. Extend `keyOf` with `data-question` and `data-finding`. **Step 4: PASS.**

- [ ] **Step 5: failing tests for overrules and rulings.**

```ts
test("each finding has Overrule: the likelihood terms of the standard, the three confidences, whether it stays, and a note", async () => {
  expect([...p.qa('[data-finding="f1"] select[name="Likelihood of f1"] option')].map((o) => o.textContent)).toEqual(["leave as it is", ...ref.likelihood]);
});
test("Overrule is off without a note, and sends overrule_finding for the draft on screen, once", async () => {
  expect(sent).toEqual(["overrule_finding", { finding: "f1", draft_hash: latest().hash, likelihood: "almost certain", confidence: null, stays: null, note: "It is the TV I installed." }]);
});
test("an overruled finding says what you set and why, with the earlier overrules under it, and offers Withdraw", async () => {
  expect(p.q('[data-finding="f1"] .overrule-now').textContent).toBe("You overruled: likelihood almost certain. Note: It is the TV I installed.");
  // Withdraw sends { finding: "f1", draft_hash, likelihood: null, confidence: null, stays: null, note } and is off without a note
});
test("a finding you dropped is listed under the findings with its overrule, so that it can be withdrawn", async () => {});
test("opened with overrule:f1, the lens opens that finding's form and puts focus in its note, once", async () => {});
test("a ruled conflict shows the ruling, the rulings it replaced, and Change the ruling while its run is in progress", async () => {
  expect(p.q('[data-conflict="k1"] .ruling').textContent).toBe("Ruled: follow Evaluate: moderate confidence");
  expect(p.q('[data-conflict="k1"] .ruling-earlier').textContent).toBe("Earlier: follow Challenge: keep high confidence (replaced)");
});
test("no ruling control says a ruling is fixed for the rest of the run", async () => {});
```
and in `tests/server/reads.test.ts`: `test("the reference lists the standard's likelihood terms, least likely first", …)`; in `tests/web/commands.test.ts`:
```ts
test("answer ask-1 <text> answers that question; overrule f1 opens the Narrative lens on that finding", () => {
  expect(parseCommand("answer ask-1 In the lobby", inCase)).toEqual({ kind: "answer", question: "ask-1", text: "In the lobby" });
  expect(parseCommand("overrule f1", inCase)).toEqual({ kind: "overrule", finding: "f1" });
});
```
and for the brief: `test("the brief says how many questions wait for you, and the count opens the Narrative lens", …)` (`[data-status=questions]`, text "1 question for you").
- [ ] **Step 6: FAIL. Step 7: implement.** Each finding in the draft body is wrapped with `data-finding`; under it a `details.overrule-form` (summary "Overrule") with `select[name="Likelihood of <id>"]`, `select[name="Confidence of <id>"]`, `select[name="Whether <id> stays"]` ("leave as it is", "must stay", "drop it"), `textarea[name="Note on overruling <id>"]` and `[data-action=overrule]`, off while replaying, while nothing is set, or while the note is blank. Choosing "drop it" clears and disables the two value selects. `conflictView` shows `.ruling`, one `.ruling-earlier` per replaced ruling (the text of `rulingText` over a copy of the conflict with that ruling), and, while `c.run === s.run.id` and the run is not finished, the rule form under a `details` whose summary is "Change the ruling"; every title that said "fixed for the rest of the run" says "you can change it while the run is in progress". `perform` for `answer` sends `answer_question` with basis `unstated`; for `overrule` it calls `nav.openLens("narrative", \`overrule:${finding}\`)` and says "Overrule f1 from the Narrative lens". `help.ts` lists both. `referenceOf` fills `likelihood` from `termsOf` of the profile's standard. **Step 8: PASS; full suite with the browser; typecheck; commit** `feat(web): answer questions, overrule findings and revise rulings in the Narrative lens`.

---

### Task 8: The sample, acceptance and documents

**Files:**
- Create: `sample/context/skills/ask-the-person.md`, `tests/sample/person-acceptance.test.ts`
- Modify: `sample/context/profile.yaml`, `sample/stages/plan.yaml`, `sample/stages/research.yaml`, `sample/stages/assemble.yaml`, `sample/README.md`, `scripts/new-root.ts` (only if it writes stage tool lists or profile stages), `README.md`, `docs/gui-guide.md`, `docs/security-notes.md`
- Test: `tests/sample/person-acceptance.test.ts` (new), `tests/sample/sample.test.ts`, `tests/cli/new-root.test.ts`; and every test the sample's new tool lists and pack part break

- [ ] **Step 1: failing tests.**

```ts
// tests/sample/sample.test.ts
test("Plan, Research and Assemble may ask the person, the reviewers may not, and those three are given the skill", () => {
  for (const id of ["plan", "research", "assemble"]) { expect(stage(id).tools).toContain("ask_person"); expect(profile.stages[id]!.skills).toEqual(["ask-the-person"]); }
  for (const id of ["frame", "evaluate", "challenge", "publish"]) expect(stage(id).tools).not.toContain("ask_person");
});
// tests/sample/person-acceptance.test.ts — served({ before }) writes the sample's script with one turn added: researcher-g1's first reply also calls
// ask_person { blocking: true, question: "Is 192.0.2.17 the meeting-room display?", why: "It would explain the connections." }
test("a run is held for the person's answer, goes on when they answer, and the product says what rests on their word", async () => {
  // start_run, accept the plan; the run pauses "waiting for the person's answer to ask-1…"; no stage.finished for research yet
  // answer_question { question: "ask-1", answer: "Yes. I mounted it in March.", basis: "did" }: the run resumes by itself and reaches the publish gate
  // overrule_finding on the first finding (likelihood "almost certain", a note): a new draft by the person, reviewed again, back at the gate
  // add_statement, then approve: product.published; verify (src/core/verify.ts) reports no problem; state.skipped is []
  // fold(entries) toEqual the live state; fold(entries, n) for the seq of the answer toEqual the state captured then
});
test("resumed without an answer, the run reaches the gate and the draft's gaps name the question", async () => {
  expect(latest().product.gaps_and_limits).toContain("Questions the person has not answered:\n- ask-1: Is 192.0.2.17 the meeting-room display?");
});
test("the unchanged sample script asks nothing and publishes as before", async () => { /* questions {}, overrules {}, published.length 1 */ });
```
- [ ] **Step 2: FAIL. Step 3: implement.** The skill (front matter `kind: skill`, `id: ask-the-person`, `title: Ask the person`), in the sample's plain style and with nothing from a real environment:

> The person running the investigation knows things no source holds, and can go and look. When a judgment turns on what something is, where it is, who installed it or whether it is expected there, put that to the person with ask_person. Say why the answer matters and name the cards or values it is about. Ask one thing at a time, and ask early.
> Never conclude that something does not belong because the sources are silent about it. Silence is a gap; the person may know.
> Set blocking only when your result would be wrong without the answer. Otherwise carry on with what does not depend on it.
> An answer comes back as a card. Cite it like any card, and say in the confidence basis that the finding rests on the person's word.

Add `ask_person` to the three stage manifests' `tools`, and `skills: [ask-the-person]` to those three stages in the profile. Fix the tests the new tool list and skill part break (expected tool lists and pack item lists), changing expectations only. **Step 4: PASS.**

- [ ] **Step 5: documents.** `README.md`: a section "The person" before "Before a run" (keep `tests/repo/readme.test.ts`'s section order test in step): what a statement is and how it is labelled; overruling and what holds it; revising a ruling; questions, `questions.max_open`, the blocking hold and going on without an answer. `docs/gui-guide.md`: the statement form and card (§5.1), the question box, overrule form and ruling history (§5.3), the bar words `state`, `answer`, `overrule` (§5.2 or where the bar is listed). `docs/security-notes.md`: only a person's entries carry authority (the fold's actor rule); a question's text is model text and carries its request's marking; an answer cannot be marked below the case. Under "Known limits" in `README.md`: a statement is not drawn in the Timeline or the Graph; an overrule leaves the analyst's confidence basis and reasoning as written; a held stage runs again on resume. **Step 6: full suite with the browser; typecheck; commit** `feat(sample): stages may ask the person; acceptance and documents for slice 8`.

---

### Task 9: The dev root and the driver (the controller, outside the repository)

Not for an implementer subagent. Nothing here is committed to this repository, and no real name is written into any file under it.

- [ ] In the dev root (`<dev-root>`), back up each file first (`*.bak-slice8`): add `ask_person` to the `tools` of the plan, research and assemble stage manifests; check that the device-identification skill's "put 'is it expected on that access point?' to the person" names the tool `ask_person`; add the skill to those stages in the profile if it is not there. Set `questions: { max_open: 3 }` in `<dev-config>` only if another value is wanted.
- [ ] Run `preflight` against `<dev-config>`; expect the three stages to load with the tool.
- [ ] The driver script (`<driver>`): it sends none of `answer_question`, `add_statement`, `overrule_finding`. On a pause whose reason starts with "waiting for the person's answer to", it prints the question (id, text, why) and stops; it resumes such a pause only when started with an explicit flag for going on unanswered. Record in `progress.md` which was used for each dev case.
- [ ] Restart the dev server on the branch head and run one dev case on the CASE-6 question; record whether a stage asked, what it asked, and what the product said rested on the person's word.
