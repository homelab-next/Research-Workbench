# Research Workbench: playbooks, "does it belong?", and what CASE-1 taught (6a)

Design, 2026-11-26. Status: written for the owner, who has opted out of design questions for this round. Every decision below is a ruling by the designer with its reason; section 12 lists them again so they can be checked in one pass.

This design builds on [`2026-11-23-investigation-slice-design.md`](2026-11-23-investigation-slice-design.md) ("the slice design"). Where it says "slice §7.3" it means that section. Nothing in the slice design is withdrawn except where section 12 says so. The plan that implements this design is [`../plans/2026-11-26-slice-6a-playbooks.md`](../plans/2026-11-26-slice-6a-playbooks.md).

The evidence is the first real investigation, CASE-1: 2742 entries, 30 lake queries, 478 model requests, 23 send-backs, and eleven fixes made while it ran (the plan 5 ledger, Tasks 7 to 17).

---

## 1. Intent

CASE-1 reached the publish gate, and its custody checks pass. It also showed three things the owner wants changed before the next case.

1. **A lookup should not cost a model turn.** Thirty lake queries took most of 478 model requests. The lookups an analyst runs first on a device are the same every time. They should be written down once, run in the background with no model in the loop, and arrive as cards with the same chain of custody as any other lookup.
2. **"Does it belong here?" had no honest answer.** The one finding still weak at the gate said a device was unlikely to be an authorised asset, and it rested on not having seen the device anywhere. The workbench needs a list of known assets it can ask, and it must say plainly whether "not on the list" proves anything.
3. **The run stopped for reasons a person could not read.** A reply cut at 300 seconds, an "endpoint answered 400" that meant the context was shared between two slots, a green tick on a stage whose draft had just been sent back.

6a does these three, and renames one lens: the current Timeline shows what the system did, which is a worklog. The name Timeline is kept free for 6b, which will show observed activity on the data's own time axis.

## 2. Goals, non-goals, anti-goals

### Goals

1. **Playbooks.** A playbook is a manifest: named, typed inputs; a short ordered list of pivot steps, each starting from an input or from what an earlier step found; an optional "only when an earlier step returned rows / was empty"; and an end. It runs as a background job with no model call. Each lookup goes through the runner, is recorded with purpose `playbook`, reuses an identical answered lookup instead of asking again, and makes a card.
2. **Two ways to start one.** The person starts a playbook from the Pivot panel or the command bar (`run playbook <id> on <value>`). The planner may offer one as a single plan step; after the person accepts the plan, Research runs that step in code, with no researcher agent.
3. **Inventories.** An inventory is a declared list of known assets. A pivot that asks one says so. An empty answer from an inventory is a proven negative only if the inventory declares itself complete; otherwise it is "not seen". "Does it belong?" on a value asks every inventory that takes that kind of value and says, per inventory, what the answer proves.
4. **Hardening from CASE-1** (section 9): stage defaults in `new-root`, a context-fit check in `preflight` and before each stage's first call, a plain pause reason for an over-context request, "draft N sent back by …" in the phase strip, no 300-second cut in the `http` and `trino` connectors, one button per action in the brief, the change terms read from the standard in one place, jobs matched to sub-goals by id.
5. **Timeline becomes Worklog.** One Worklog lens shows the system's activity, with every entry one toggle away. Timeline stays on the shelf, marked "soon".
6. **A fast decision model, optional and off.** A stage may name a second, smaller model for the turns in which the agent only chooses its next tool call. Nothing uses it unless a stage manifest names one.

### Non-goals (6a)

- The observed-activity Timeline and the Graph lens (6b).
- Loops, variables, expressions, parallel branches, or calling one playbook from another. The grammar is the one in section 5 and no more.
- A playbook that spends a budget. A costly lookup inside a playbook waits, as it does everywhere else.
- A playbook editor in the interface. A playbook is a file in a module root.
- Inventory sources beyond what a pivot can already reach. For the owner the first inventory is the Wazuh agent list as the lake sees it. UniFi's client list and DHCP reservations are named as later sources (section 7.4), not built.
- A dropdown for the fast model. It is set in the stage manifest only.
- Per-source cost policy as configuration (noted in the plan 5 ledger). The owner has set every lake pivot free; this stays a weight for now.

### Anti-goals (these make it a failure even if it runs)

- A playbook lookup that reaches a source by any path except the runner, or that leaves no `query.issued` entry.
- A reused answer shown as if the source had been asked again, or a lookup repeated when an identical full answer is already in the case.
- "Not in the inventory" shown or cited as a proven negative when the inventory is not declared complete, when coverage was partial, or when the lookup failed.
- A playbook that passes a gate, keeps a card, accepts a proposal, or spends a budget.
- Slow work inside a case's command queue.
- A real host, address, account, schema or table name in the repository, in a test, or in a commit message.

## 3. Constraints

These are the slice design's, restated where 6a leans on them.

- **One custody point.** `runQuery` (`src/modules/runner.ts`) is the only way a query reaches a source. It writes `query.issued` before the source is contacted, then `query.result` and a card, or `query.failed`. A playbook calls it; it does not copy it.
- **The guard.** The lake connector checks every rendered statement against the guarded shape. A playbook adds no statement of its own: it runs pivots, and a pivot's text is what the guard already checks in `preflight`.
- **Markings.** A card carries its source's marking. A playbook makes no model call, so nothing leaves the machine when one runs; the cards it makes meet the marking check later, like any card, when a stage puts them in a pack.
- **Gates are the person's.** A plan step that is a playbook runs only after the person accepts the plan. Nothing in 6a adds a way past a gate.
- **Agents run free things only; so do playbooks.** A playbook is not a person. A costly lookup in it stops with "needs a budget", and the playbook carries on with its other steps.
- **Nothing slow in the case queue.** A command checks what it can from the record and the registry, writes the job's first entries, and returns. The lookups run under `hub.background`.
- **The ledger is the only source of truth.** A playbook run can be rebuilt from its entries: which playbook and which version of it, which steps ran or were skipped and why, which lookups were sent and which were reused.
- **The real environment stays out of the repository.** The owner's playbook and inventory are written as a checklist with placeholders (plan Task 10) and typed only into `~/workbench-lake/root/`.
- **Trusted roots only.** A playbook decides what a run does, and its title and description are shown to the planner. An inventory's words appear on cards. Both kinds are accepted only from a trusted root, like stages and personas (slice §7.1).

## 4. Approaches considered

### 4.1 How a lookup stops costing a model turn

| | Approach | Trade-off |
|---|---|---|
| **A** | **Playbooks as manifests, run by code.** A file lists pivot steps; a small runner walks it. | The owner writes the sequence once. No model is involved, so there is nothing to go wrong in a tool call. It cannot react to what it finds beyond "rows or empty". |
| B | Run every accepted plan route in code (extend `runRoute`), and keep the researcher only for blocked routes. | No new manifest kind. But a route is "get to a type by any path"; it stops at the first arrival and follows one route. The owner's triage is "do all of these", which a route cannot say. |
| C | "Code mode": the model writes a short script of lookups, and code runs it. | Flexible. But it is agent-written query logic on a lake source that forbids agent-written queries, and local models mangle structured text; CASE-1 showed both. |
| D | Only a smaller model for lookup turns. | Cuts tokens per turn, not the number of turns. It keeps a model where none is needed. |

**Ruling: A.** It is the only one that removes the model from the lookup, and it adds no new way to reach a source. D is added as an option (section 8) for the routing turns that remain. B is not built: after A, a plan made of playbook steps runs with no researcher at all, and a plan made of routes still has one.

### 4.2 Where a playbook's steps come from

Steps name pivots. A step could instead carry its own query text. **Ruling: steps name pivots only.** A pivot is already the unit the guard checks, the seeker ranks, the registry hashes and Verify re-runs. A playbook with its own SQL would be a second place for all four.

### 4.3 What an inventory is

| | Approach | Trade-off |
|---|---|---|
| A | The inventory manifest names a source, a table and identifier columns; the workbench writes the lookups. | Nothing to hand-write. But the workbench would be generating SQL for four connector kinds and for a guarded lake table, where the shape of the statement is exactly what the owner must control. |
| **B** | **The inventory manifest declares what the list is and whether it is complete; hand-written pivots say `inventory: <id>`.** | One more line on a pivot. The statement stays the owner's, and the guard checks it as it checks any pivot. |
| C | No new kind: keep `empty_means: proven-negative` on a pivot as the only claim. | Nothing to build. But the claim "this list is complete" is then repeated, pivot by pivot, with nowhere to say why, and nothing ties three pivots on one list to one answer. |

**Ruling: B.** Completeness is a property of the list, stated once with its reason, and every pivot on that list inherits what an empty answer means.

## 5. Playbooks

### 5.1 The manifest

One file per playbook, anywhere under a trusted module root (the sample keeps them in `playbooks/`).

```yaml
kind: playbook
id: address-triage
title: Triage an address
about: Is the address a known asset, what names resolved to it, and who looked those names up.
inputs:
  - { name: address, type: address }
steps:
  - { id: asset,   pivot: address_to_asset,          from: input.address }
  - { id: lease,   pivot: address_to_asset_by_lease, from: input.address, when: asset.empty }
  - { id: names,   pivot: address_to_domains,        from: input.address }
  - { id: clients, pivot: domain_to_clients,         from: names, when: names.rows, max_values: 5 }
end: [asset]
```

The whole grammar:

- **`inputs`**: one or more, each a name and an observable type. No two inputs share a type, so "run this on a value" is never ambiguous.
- **`steps`**: one to twelve, run in the order written, one at a time.
  - `pivot`: a loaded pivot.
  - `from`: `input.<name>`, or the id of an earlier step. A step that starts from an earlier step runs once for each value that step found (the values its pivot yields, slice §7.4), in the order found, up to `max_values` (default 5, at most 20).
  - `when` (optional): `<earlier step>.rows` or `<earlier step>.empty`.
- **`end`** (optional): a list of step ids. The playbook's outcome is the outcome of the first listed step that ran. Default: the last step. The sample ends on `asset`: the complete asset list decides whether the address is a known asset, and the lease lookup is extra detail when it is not.

That is all of it. There is no `else`, no `and`, no loop.

**What `rows` and `empty` mean.** A step has *rows* if any of its lookups returned at least one row. A step is *empty* only if it ran and every lookup came back with no rows and full coverage. A step whose lookups were partial, failed, refused or waiting for a budget is neither: a step that depends on it is skipped, and the record says "could not tell". This is the honest-negative rule (slice §2) applied to branching: a branch never treats "we could not look" as "there was nothing".

**Checked at load** (a playbook that fails is rejected with the reason; the server still starts): every pivot is loaded; a step's `from` gives the type its pivot takes; `from`, `when` and `end` name inputs or earlier steps; ids are unique lower-case words; no step is named `input`.

### 5.2 Running one

A run is one job of kind `playbook`. Its entries:

| Entry | Says |
|---|---|
| `job.started` | kind `playbook`, title "Playbook: <title> on <value>" |
| `playbook.started` | which playbook, its manifest hash, the inputs, the window, why, the plan step it carries out (if any), and every step's pivot id and pivot hash |
| `query.issued` … `query.result` / `query.failed`, `card.created` | one group per lookup actually sent, by the runner, purpose `playbook`, linked to the job |
| `playbook.step` | one per step: ran or skipped and why; each lookup's value, outcome, query and card; whether it was reused; the values found; how many values were left unfollowed |
| `playbook.finished` | the outcome, the step it came from, the cards, the caveats, how many lookups were sent and how many reused |
| `job.finished` | done, or failed |

`playbook.started` lists the steps with their pivot hashes so the run can be read from the case alone, without the module root it came from.

**Limits.** At most 50 lookups per run (the same ceiling as a route). Values past `max_values` are not followed, and the step's entry and the run's caveats say how many.

**Reuse.** Before a lookup is sent, the runner's own reuse check (`answeredBefore`, plan 5 Task 9) looks for the newest query in the case with the same pivot and pivot hash, source hash, bound value and window, done with full coverage, whose card still exists and is not discarded, and whose stored rows read back to the hash they were recorded with. If there is one, nothing is sent: the step's entry names that query and card and marks the lookup `reused`. A lookup answered by a researcher is reused by a playbook, and the other way round. A partial, failed or discarded answer is never reused.

**Outcome.** From the end step's lookups: `answered` (rows, nothing partial), `partial` (any lookup partial), `empty` (every lookup empty with full coverage), `failed`, or `blocked` (nothing could be decided: refused, waiting for a budget, or no end step ran).

**Costly lookups.** A lookup whose pivot is costly is not sent. The step records "needs a budget", the run adds a caveat, and the playbook goes on. The person can run that pivot by hand with a budget; running the playbook again then reuses the answer.

**Stopping.** A playbook checks before each lookup whether it should stop (the run was paused or stopped, when it runs inside Research). A lookup already sent finishes and is recorded. If the server stops mid-playbook, recovery marks the job failed, the playbook reads "interrupted", and running it again reuses what was answered.

**Who the actor is.** Started by the person: the person. Run by Research for a plan step: `system: playbook`. Never an agent.

### 5.3 Started by the person

- **Pivot panel.** Under the routes, the panel lists the playbooks whose inputs the card's starting values can fill, each with a button that says what will happen: "Run Triage an address on 198.51.100.77 · up to 8 lookups, no model". It uses the panel's window and reason. The trail of the run appears in the panel, step by step, with card chips; a reused lookup reads "reused, no query sent".
- **Command bar.** `run playbook <id> on <value>` runs a one-input playbook over the case's window. Anything else about a playbook (several inputs, another window) is done from the panel.
- **A second press.** While a playbook is running on the same inputs and window, a second start is refused: "this playbook is already running on this value".

Starting a playbook is not a gate and needs no confirmation: it runs free lookups only, as a person's own `run_route` does.

### 5.4 Offered to the planner

- The planner gets one more tool from the fixed list, `list_playbooks`: each playbook's id, title, description, inputs, the type its end step finds, and whether it may be planned (every lookup free).
- In the planner's output a sub-goal carries either a `route` (as now) or a `playbook` id with an empty route. Code checks it, as it checks a route: the playbook is loaded, every lookup in it is free, the sub-goal's `have` fills each input, and `want` is the type the end step finds. A plan with a costly playbook is refused with the reason, and the planner is asked again, as for a route the finder does not offer.
- The plan shows it as one step: "Playbook: Triage an address · up to 8 lookups · no model". It is free, so it needs no budget. Accepting the plan accepts it like any step.
- **Research runs it in code.** A sub-goal whose step is a playbook gets no researcher. Research starts the job, runs the playbook, and finishes the plan step with the playbook's outcome and the end step's cards. Whether the sub-goal is answered is decided as it always is: by what the step finished as (slice §9.2; a full-coverage proven negative answers it, a "not seen" does not).
- If the playbook's manifest changed between the plan's acceptance and Research (its hash differs from the one in the plan), the step is not run: it finishes `blocked` with that reason, and Research's ordinary rules decide what follows.

A plan may mix route sub-goals and playbook sub-goals. A plan made only of playbooks makes no model call in Research.

### 5.5 The sample

`sample/playbooks/address-triage.yaml` is the manifest in §5.1, over the sample's existing pivots. It exercises a proven negative that is also the playbook's answer (`asset` on the complete asset list), a branch taken and a branch skipped, a fan-out (`clients` over the names found), and reuse (the sample's scripted run already asks two of these lookups).

## 6. The planner step and the engine

Nothing in the engine changes. Research is still one stage; it now has two kinds of unit (a researcher, or a playbook) sharing the same worker pool and the same `research.parallel` limit. The stage's output has the same shape.

## 7. "Does it belong?"

### 7.1 The inventory manifest

```yaml
kind: inventory
id: assets
title: Asset list
holds: asset                 # the observable type of an entry
scope: internal hosts        # what the list covers, in a few words
complete: true               # the list holds every asset in its scope
basis: Every internal host is entered by hand before it is given an address.
derived: false               # true when the list is worked out from observed events
```

- `complete: true` needs a `basis`: one sentence saying why the list can be relied on to be complete. It is shown on the card and carried into the product's account of its sources.
- `derived: true` and `complete: true` together are refused. A list worked out from events only holds what was seen; it cannot prove absence.

### 7.2 Pivots that ask an inventory

A pivot gains one optional line, `inventory: <id>`. Checked at load:

- the inventory is loaded, and the pivot comes from a trusted root;
- the pivot's `to` is the inventory's `holds`;
- the pivot's `empty_means` is what the inventory implies: `proven-negative` if the inventory is complete, `not-seen` if not. A pivot that states the other is rejected with the reason. A pivot that leaves it out gets the right one.

So the claim is made once, on the inventory. Everything downstream already reads the card's `empty` field: the card's tag, whether a sub-goal counts as answered, and form check 8 (no partial or not-seen card cited as a proven negative). None of that changes.

The card's body says what the answer is and what it proves:

- `2 rows · in Asset list`
- `No rows · proven negative · not in Asset list, which is complete for internal hosts`
- `No rows · not seen (not proof of absence) · Asset list is not declared complete`
- a partial result keeps its "partial: …" and is never either.

The `query.issued` entry names the inventory, its manifest hash and whether it was complete, so "which claim of completeness was in force" is in the case record.

### 7.3 Asking

"Does it belong?" is a button on the Pivot panel, shown when some inventory pivot takes one of the card's starting values. It runs every such pivot on the value as one background job, through the playbook runner (a playbook made on the spot, named `does-it-belong`, one step per inventory pivot), so it has the same entries, reuse and limits. The panel then shows one line per inventory and one verdict:

- **Known asset** if any inventory returned it.
- **Not a known asset: proven for <scope>** if none returned it and a complete inventory came back empty with full coverage.
- **Not seen in any inventory; none is complete, so this proves nothing** otherwise.
- **Could not tell** if a lookup failed or was partial and nothing returned the value.

Agents need nothing new. An inventory pivot is a pivot: the planner finds it with `find_routes`, a researcher runs it with `run_pivot`, a playbook names it as a step.

### 7.4 The owner's first inventory, and later ones

The owner's Wazuh agents appear in the lake as the agent name and agent address on archived events and on the normalised tables. That is a list worked out from events: an agent that sent nothing in the window is not in it. So the first inventory is declared `derived: true`, `complete: false`, and "not a Wazuh agent in this window" is shown as *not seen*, never as proof. A hit is still a positive: the address or host name is a Wazuh agent.

This is the honest position for the finding that was weak in CASE-1. It turns "we did not see it" into a recorded lookup with a stated meaning, and it does not let the product claim more.

Later sources, each a manifest and one or two pivots, no new code: the UniFi controller's client list (by MAC), DHCP reservations (by MAC and address), and a Wazuh agent list read from the manager itself once a read account with enough scope exists (slice §12). The last two can honestly be `complete: true`.

## 8. The fast decision model (optional, off by default)

A stage manifest may add:

```yaml
fast_model: { provider: local-small, model: "example/small-model", effort: null }
```

With nothing there, nothing changes. With it:

- **Which turns.** A turn in which the agent is offered tools and has not yet been asked for its answer is a routing turn, and goes to the fast model. When the fast model replies with no tool call, it is saying it is done; that reply is not used as the answer. The stage's own model is then asked once, with no tools on offer, for the answer, and sees the whole transcript. Re-asks, the forced last turn and structured output always go to the stage's own model.
- **Markings.** The marking check is made per call against the model that call goes to. A pack the fast model may not receive stops the stage as "blocked", as it does for any model.
- **Context.** The pack is assembled to fit the smaller of the two models.
- **The record.** Each `model.request` already names its provider and model; a fast turn names the fast one. Nothing is inferred.
- **If the fast model is not there** (not listed, not loaded): the stage's own model takes the routing turns. `preflight` reports a named fast model that is missing as a failure, so this is noticed before a run, not during one.

Why this shape: the fast model never writes an answer a reviewer will read, so a weaker model cannot lower the product's quality; the worst it can do is choose a poor next lookup, which the ledger shows. Why off by default: the owner runs one model in one slot, and after playbooks the routing turns that remain are few. The owner should measure CASE-2 before loading a second model.

## 9. Hardening from CASE-1

| # | What happened | Ruling |
|---|---|---|
| 1 | Output caps and turn limits were found by pausing: 8192 tokens too small for Plan, 16 turns too few for Assemble, 300 s too short for a long thought. | `new-root` writes per-stage settings: `max_output_tokens` Frame 8192, Plan 32768, Research 16384, Assemble 32768, Evaluate 16384, Challenge 16384, Publish 16384; `max_turns` Frame 8, Plan 16, Research 24, Assemble 30, Evaluate 16, Challenge 16, Publish 8. The model manifest it writes gets `max_output_tokens: 16384`, `timeout_ms: 600000`, `parallel: 1`, and the sampling it already writes. These fit a model loaded at 65536 tokens in one slot. The sample's own stages are not changed. |
| 2 | The model was loaded with two slots, so each request had half the context; the pack was sized for the whole. | A model manifest declares `parallel` (default 1). The context a request has is the loaded context divided by it; the pack is sized from that. The fit rule is one line: a stage's `max_output_tokens` plus the pack budget must not exceed that per-request context. `preflight` fails a stage that breaks it, naming the largest cap that fits. The same rule is checked before a stage's first call, and stalls it with the same words. |
| 3 | The slot count is not something every endpoint reports. | It is declared, not discovered, and `preflight` proves the declaration: its one question is sent with an output cap sized to the per-request context the manifest claims. An endpoint with less refuses it, and `preflight` says so. |
| 4 | "the endpoint answered 400" | The provider reads the endpoint's own error text (one line, scrubbed). When it is about context size the stage pauses with: "the request did not fit the model's context", what the endpoint said, and what to change. Any other refusal shows its status and the endpoint's line. Neither is retried. |
| 5 | Assemble stayed green after Checks sent its draft back and the run paused at a cap. | The phase strip shows "draft N sent back by <stage>" on the stage that wrote the latest draft, whenever a review stage has failed that draft or sent it back and the author has not started again. |
| 6 | Bun cuts an idle `fetch` at 300 s. The model provider turned that off (`ce27915`); the connectors did not. | `http` and `trino` pass `timeout: false` on every `fetch`; each connector's own timeout stays the only deadline. |
| 7 | Two buttons with the same job in the brief. | The brief's buttons come from one function that returns a list with no two entries sharing a label or a command. A test walks every run state. |
| 8 | Recovery at server start. | Done in `7db2b74`. 6a adds only the test that pins it, if none names it. |
| 9 | The change terms were listed in the standard and again in the output schema and in code. | The standard's `change_terms` is the one list; its first entry is the term for a first judgment. The Assemble stage fills the schema's `change_kind` choices from it; the schema file no longer lists them. |
| 10 | A finished researcher was matched to its sub-goal by the job's title. Two sub-goals with one title would collide. | `job.started` carries the sub-goal id (and, for a sent-back question, the seq of the request it answers). Matching uses those. A job recorded before this, with neither, is still matched by title, so a case in progress resumes as it did. |

## 10. Timeline becomes Worklog

- **Worklog (`W`)** opens on **Activity**: the rows the Timeline lens shows today (cards, queries, stages, gates, drafts, publications, reused steps), plus playbook starts and ends, in the order of record. A toggle, **Every entry**, shows what the Worklog shows today: every entry with its actor. The three actor filters apply to both. Times are UTC with milliseconds (slice §10.2). A card's row still takes you to the card.
- One thing is dropped on purpose: the old Timeline placed a card at its event time when it had one. The Worklog is about what the system did, so it orders by the record. Event time belongs to 6b's Timeline.
- **Timeline (`T`)** stays on the shelf, dimmed and marked "soon" (slice §2: parts not built yet still appear, marked). It opens a short explanation: this will show observed activity on the data's own time axis. Its key, id and command-bar word are unchanged, so 6b replaces a placeholder and moves nothing.

Ruling on keep-or-remove: keep. Removing the button would free a key that 6b takes straight back, and the owner would lose the place they already look.

## 11. Testing

- **Playbook manifest:** each load-time refusal, with its reason; the sample playbook loads.
- **Playbook runner:** every lookup has a `query.issued` with purpose `playbook` and the job's link; a reused lookup sends nothing; a branch on `rows` and on `empty`; a branch over a partial step is skipped as "could not tell"; the fan-out cap and the 50-lookup ceiling leave caveats; a costly step waits and the rest run; an interrupted run reads interrupted and its re-run reuses.
- **State:** the playbook entries fold deterministically; replay at entry N equals live at entry N; a malformed playbook entry is skipped, not thrown.
- **Person start:** the command returns before any source is asked; a second press is refused; a bad input is refused with nothing written.
- **Planner step:** a playbook sub-goal builds one plan step; a costly or unknown playbook is refused with the reason; Research runs it with no `model.request`; pause stops it; a changed manifest blocks it.
- **Inventory:** each load-time refusal; the three card bodies; an incomplete inventory's empty answer is `not-seen` in the card, in the sub-goal rule and in the panel's verdict.
- **Hardening:** each row of section 9 has a test that fails before its fix.
- **Custody acceptance:** after a person-started playbook and a "does it belong?" on the sample, every card traces to a query issued, a query result and a blob; `verify` passes; replay ends in the same state as live.
- **No real names:** the hygiene scan (plan 5 Task 1) runs with the owner's private terms before the branch is called done.
- **By hand, by the owner:** the device-triage playbook and the Wazuh-agent inventory on the live lake (plan Task 10). Not part of the test suite.

## 12. Rulings

Each is the designer's. Each is easy to change now and harder later.

1. **A playbook is a manifest of pivot steps run by code** (approach A). Routes are not turned into code-run plans.
2. **Steps name pivots; a playbook has no query text of its own.**
3. **The grammar is: inputs, ordered steps, `from` an input or an earlier step, `when` rows or empty, `max_values`, `end`.** Nothing else in 6a.
4. **`empty` requires full coverage on every lookup; a step that could not be decided skips what depends on it.**
5. **Playbooks are accepted only from a trusted root.** So are inventories.
6. **A playbook never spends a budget.** A costly lookup in it waits; a playbook with a costly lookup cannot be a plan step and can still be started by the person.
7. **Query purpose gains `playbook`.** The record then says, on the query itself, that no model chose this lookup. Wherever the code asked "is this a result query" it now asks "is this an answer query" (`result` or `playbook`): reuse, and the Pivot panel's trail.
8. **Reuse crosses purposes.** A playbook reuses a researcher's answer and the other way round, under plan 5's rule unchanged.
9. **A playbook run has its own three entry types** (`playbook.started`, `playbook.step`, `playbook.finished`), and `playbook.started` records every step's pivot hash.
10. **The actor is the person who started it, or `system: playbook` inside Research.** Never an agent.
11. **A playbook sub-goal is `playbook: <id>` with an empty `route`** in the planner's output, one plan step in the plan, and no researcher in Research.
12. **`list_playbooks` joins the fixed tool list**, for the planner.
13. **A changed playbook is not run under an older acceptance.** The step blocks.
14. **An inventory is a declaration; pivots point at it** (approach B). The workbench generates no query for it.
15. **An inventory decides what an empty answer means for every pivot on it**, and a derived list can never be complete.
16. **"Does it belong?" is a playbook made on the spot**, so it shares the runner, the record and the limits.
17. **The owner's Wazuh agent list, as seen in lake events, is a derived, incomplete inventory.** Absence from it is "not seen".
18. **The fast model takes routing turns only and never writes the answer.** It is manifest-only, off by default, and may be left for 6b without touching any other task.
19. **The slot count is declared in the model manifest and proved by `preflight`'s question**, not read from the endpoint.
20. **The fit rule:** `max_output_tokens` + pack budget ≤ loaded context ÷ `parallel`.
21. **`new-root`'s stage defaults** are the table in section 9 row 1.
22. **The Worklog orders by the record and opens on Activity; Timeline stays as a "soon" placeholder with its key.**
23. **A job names its sub-goal by id**; title matching remains only for jobs recorded before this.
24. **The first change term in the standard is the first-judgment term.** The standard's note says so.

## 13. What comes after

6b: the observed-activity Timeline and the Graph lens. Then, if CASE-2 shows the need: a budget a person can give a playbook, a playbook step that takes a named column rather than the pivot's yielded type, per-source cost policy as configuration, and the inventory sources named in §7.4.
