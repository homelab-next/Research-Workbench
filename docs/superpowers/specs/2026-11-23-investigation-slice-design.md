# Research Workbench: the investigation slice

Design, 2026-11-23. Status: approved by the owner on 2026-11-23.

Companion document: [`docs/gui-guide.md`](../../gui-guide.md) (the owner's GUI guide). Where this design says "guide §5.1" it means that section. The guide decides how things look and behave; this document decides what gets built first and how the parts underneath work.

Items marked **(my call)** were decided by the designer, not the owner. They are listed again at the end so they can be checked in one pass.

---

## 1. Intent

An analyst is running an investigation on their own network. They have objectives and guidance, a strategy-to-task chain, and a methodology framework. Data sits in a lake, a database, or both. The work has many steps: frame the question, plan, collect, process, analyse, assemble a product, check it, challenge it, publish it, and score it against measures of performance and effectiveness.

They want two things from this tool:

1. **Speed.** Move between phases and fire actions fast, with agents doing the legwork: an orchestrator frames the run, a planner finds the best paths to the goals over the pivots available, researchers follow those paths (and re-route when blocked), a senior analyst pieces it together, scripts and an evaluator check it, an adversary attacks it, a publisher packages it.
2. **Accountability.** Everything is timestamped. Every agent keeps its exact queries, its data sources and its reasoning. The record is a chain of custody that must withstand extreme scrutiny: any finding can be traced to the bytes that support it and re-validated, and the whole investigation can be replayed one action at a time.

The data layer is deliberately generic, because the tool will be used for many purposes. Sources, pivots and goal seeking must each be something the owner can point at: on this machine, on the network, or on the web.

This document covers the **first vertical slice**: one investigation, end to end, thin at every stage.

## 2. Goals, non-goals, anti-goals

### Goals

1. One investigation runs from objective to published product and feedback, through every pipeline stage. It runs two ways: on bundled sample data with no real environment needed (this is what the tests use), and against the owner's real data lake (this is what proves it).
2. Every action by a person, an agent or the system is an entry in an append-only, hash-chained ledger. The chain can be verified. Any result can be re-run and compared. The case can be replayed entry by entry.
3. Sources, pivots, the route finder, models, pipeline stages and checks are modules: files with manifests, loaded from locations named in configuration.
4. Each pipeline stage has a model and an effort setting, chosen from a dropdown.
5. The interface follows the guide for every part included in the slice.

### Non-goals (this slice)

- Requester and leader views. Resources panels (Strategy, Requirements, Gaps, Priorities, Agent inventory). Learn. Self-help. Feedback panel. Hunts. Work tickets. Actors. My folders and the file tree.
- Lenses: Graph, Notes, Ticket. The Combine panel. Linking cards by drag. Swipe gestures.
- Modules that run as separate services (MCP or similar). Module locations fetched over https or git.
- More than one user. Sign-in. Anything beyond loopback.
- Writing to other systems. Publishing produces a local bundle.
- Cryptographic signing and trusted third-party timestamps.
- Reading lake file formats (Parquet) directly. The lake is reached through its query engine (§7.3).
- A connector for the Wazuh API and indexer. Wazuh events and alerts are already in the lake, and the existing read-only Wazuh accounts are too narrow to be useful yet (§12).

Tiles and lens buttons for excluded parts still appear, dimmed and marked "soon", and open an explanatory empty stage (guide §4.1).

### Anti-goals (these make it a failure even if it runs)

- An agent action, query or model call that is not in the ledger.
- A card that cannot be traced to its exact query, its source and the raw bytes returned.
- "Nothing found" shown when coverage was partial, when the query failed, or when a model declined to answer.
- Anything accepted, moved, published or written without a person's explicit action.
- Screen state that cannot be rebuilt from the ledger alone.
- A secret (key, password, token) in the ledger, in a stored blob, or in the repository.
- Real names, addresses, sources or configuration in the bundled samples.

## 3. Constraints

- **Local-first.** The server binds to loopback only. It rejects requests whose `Host` or `Origin` is not its own loopback origin.
- **Read-only sources.** Connectors cannot write. This is enforced in the connector, not by trusting the query.
- **Agents start with no tools.** Tools come from a fixed list in code (§8.2). A profile or stage manifest can only choose from that list.
- **Propose, never write.** Agents and scripts produce proposals. Only a person's command accepts one.
- **No HTML injection.** The interface is built from DOM nodes only. Links are https-only and open with `noopener`.
- **Source data is untrusted text.** Log lines and API responses reach agents as data. Because agents are read-only and propose-only, the worst outcome of hostile data is a wasted query or a bad proposal, and both are visible in the ledger.
- **Few dependencies.** The tool may need to run on an isolated network. Prefer what the runtime provides.
- **The real environment stays out of the repository.** Hostnames, addresses, account names and credentials for the owner's systems live in configuration and module roots outside this repository. The repository holds only synthetic samples.
- **The lake is shared and easy to hurt.** The owner's other systems depend on the same query engine, and a careless query can exhaust it. The connector enforces the owner's query rules itself (§7.3); it does not rely on agents to remember them.

## 4. Approaches considered

| | Approach | Trade-off |
|---|---|---|
| **A** | One local TypeScript server; everything pluggable is a folder with a manifest | Fastest to a working slice; one language; the ledger and the screen share code. New connector kinds, route finders and model providers are code in this repository; modules choose and configure them. |
| B | The same core, but every source is its own service speaking MCP, on this machine, the network or the web | Any language; existing servers plug in. But those servers do not declare cost, time-window needs or what an empty result means, so each still needs a manifest; more moving parts to audit; a later slice. |
| C | A Python core | Best data-shaping libraries. Two languages; replay cannot share code with the screen. |

Hosted agent services and agent frameworks were dropped: they tie the tool to one model vendor or run the agent loop where the ledger cannot see it.

**The owner picked A**, with the module contract written so that a remote service (B) can be added later as one more connector kind.

**Language: TypeScript**, over Go. The owner named both as good options. TypeScript wins here because the server and the browser share the ledger types and the code that turns entries into screen state, so replay shows exactly what live showed. **(my call)**

**Runtime: Bun.** Checked on the owner's machine (Bun 1.3.14): SQLite, a SQL client for Postgres and MySQL, YAML and TOML parsing, SHA-256 hashing, an HTTP server, a bundler and a test runner are all built in. **(my call)**

## 5. Shape of the system

```
 browser (GUI) ──commands──▶ server (loopback) ──append──▶ ledger (SQLite, one file per case)
      ▲                         │                          blobs  (raw bytes, by SHA-256)
      └────entries (stream)─────┤
                                ├─ module registry  ◀── manifests from configured module roots
                                ├─ connectors        files · sql · http        (read-only)
                                ├─ route finder      cheapest paths over the pivot graph
                                ├─ pipeline engine   stages, gates, send-backs
                                ├─ agent runner      one loop, every call logged ──▶ model providers
                                └─ checks runner     scripts in, findings out
```

One rule holds the design together: **the ledger is the only source of truth.** The browser sends commands. The server checks them, appends entries, and streams entries back. Everything on screen is computed from entries by the same functions on both sides.

## 6. The ledger

### 6.1 Entries

One chain per case, plus one "workbench" chain for things that are not part of a case (modules loaded, settings changed). A case folder is self-contained and can be copied elsewhere and verified on its own. **(my call)**

Each entry has:

| Field | Meaning |
|---|---|
| `seq` | Position in the chain, starting at 1, no gaps. This is the order of record. |
| `ts` | UTC time from the server clock, ISO 8601 with milliseconds. |
| `actor` | `human`, `agent` or `system`, with an id. For agents: stage, profile, model, effort, and where the model runs. |
| `type` | What happened (list below). |
| `payload` | The details, as canonical JSON. Large or raw content is a blob reference. |
| `cause` | The `seq` of the entry that led to this one, if any. |
| `run`, `stage`, `job` | Which pipeline run, stage and background job this belongs to. |
| `prev_hash`, `hash` | `hash` is SHA-256 over `prev_hash` plus the canonical JSON of every other field. |

Canonical JSON means sorted keys, UTF-8, no insignificant whitespace, so the same entry always hashes the same.

The server is the only writer. Appends to a case are serialised, so parallel agents interleave in arrival order.

### 6.2 Blobs

Raw bytes are stored once, named by their SHA-256, and referenced from entries:

- every source result, exactly as returned;
- every model request body and response body (never transport headers, so no credentials);
- every check script's input and output;
- every published bundle.

### 6.3 Entry types

Grouped by what they record. The builder may refine names and payloads; the coverage may not shrink.

- **Case and run:** case created; phase changed; run started, paused, resumed, interrupted, finished; stage started, finished, sent back (with reason); gate waiting, gate passed.
- **Plans:** plan proposed, accepted (which steps, which budgets), denied, re-plan requested.
- **Queries:** query issued (source id, source manifest hash, connector kind, the exact query text or request, bound values, time window, why, who asked, estimated cost); query result (blob hash, row count, coverage, duration, actual cost); query failed (error).
- **Models:** model request (provider, model, effort, where it runs, the context pack as a list of item ids with content hashes, blob hash of the messages); model response (blob hash, stop reason, usage, the model that actually answered); model declined.
- **Cards:** created, kept, moved, discarded, restored, pinned, sent back to Incoming.
- **Proposals:** created, accepted, edited then accepted, rejected.
- **Analysis:** assessment made (statement, likelihood term, confidence, the cards it rests on, assumptions, reasoning); narrative section set; research requested.
- **Checks and challenges:** check run (script id, script hash, input hash, pass or fail, findings); challenge raised; challenge answered.
- **Validation:** verify run (the original query entry, the new result's hash, outcome: matches, differs, could not run).
- **Product and feedback:** product published (bundle hash); feedback recorded (measure id, value, note).
- **Undo:** an undo is a new entry that reverses a named earlier entry. Nothing is ever deleted or edited.

### 6.4 Reasoning

Every tool an agent can call has a required `why` parameter, and every assessment carries its reasoning. These are stored verbatim. The interface labels them "reasoning as stated by the agent": it is the agent's own account, recorded as given, not a guarantee of what happened inside the model. Where a provider returns a summary of the model's thinking, it is kept in the response blob.

### 6.5 From entries to screen

Screen state is a fold: `state = apply(state, entry)` over the chain. The `apply` functions are pure, live in shared code, and run identically on the server and in the browser.

- Live view: fold to the head of the chain.
- Replay: fold to entry N.
- Tests: the state at entry N during a live run must equal the state replay shows at entry N.

The server may cache snapshots for speed. Snapshots are never the truth.

### 6.6 Verifying the chain

Verification recomputes every hash from entry 1, and checks that every referenced blob exists and matches its name. It reports the first entry that fails. It runs:

- from the command line, against a case folder, with no server running;
- in the interface, where the brief shows a custody chip: "chain intact · 412 entries", or an amber warning naming the failing entry.

### 6.7 Re-validating a finding

"Verify" on a card re-runs its stored query against the same source, as a new logged query, and compares the result to the original:

- **matches:** green "validated" tag, with the time of validation;
- **differs:** amber tag and a row-level difference. The text says plainly that the source may have changed since; a difference does not prove the original was wrong;
- **could not run:** amber tag with the reason.

The original result is never replaced.

## 7. Modules

### 7.1 Where modules come from

A configuration file lists **module roots** in order. In this slice a root is a directory path, which covers this machine and mounted network locations. The configuration file lives outside the repository (it holds machine-specific paths); a sample ships in the repository. With no configuration, the server loads the bundled sample root, so the tool runs out of the box.

When a manifest is loaded, its content hash is recorded on the workbench chain. Query entries cite the hash of the source and pivot manifests in force, so "which definition was used" is provable.

Manifests are YAML. **(my call)**

**What a root may supply. (my call)** A root supplies manifests, context parts and data. It does not supply code that runs inside the server: connector kinds, route finders, model providers and agent tools live in this repository and are chosen by name in manifests. A bad manifest is rejected at load with a clear error and does not stop the server.

There is one exception: check scripts (§9.6). They run as separate programs, never inside the server, with a timeout and an environment stripped of credentials. A root's scripts run only if configuration marks that root as trusted for scripts. The bundled sample root is trusted; any other root is not until the owner says so.

### 7.2 Kinds of module

| Kind | What it declares |
|---|---|
| **Source** | Where data is and how to reach it |
| **Observable types** | The kinds of value that can be pivoted on, and how to recognise them |
| **Pivots** | Ways to get from one kind of value to another using a source |
| **Seeker** | A route finder over the pivots |
| **Model** | A model provider and where it runs |
| **Stage** | One step of the pipeline |
| **Check** | A validation script |
| **Context parts** | Profiles, personas, procedures, skills, gates, output schemas, objectives, frameworks (guide §13) |

### 7.3 Sources and connectors

A source manifest names a **connector kind** and a location, so the same kind serves all three places the owner wants to point at:

| Connector | Points at | Query form |
|---|---|---|
| `files` | A path or glob: local disk or a mounted network share | SQL over the files as tables. CSV and JSON lines in this slice. |
| `sql` | A database. This slice builds and tests SQLite only. Postgres and MySQL are added when the owner first points at one, each with its own read-only tests against a real server. **(my call)** | SQL |
| `http` | A web or network API over https (http allowed for loopback only) | A request template and a response-to-rows mapping |
| `trino` | A data lake's query engine on the network (Trino over Iceberg tables) | SQL, sent over the engine's HTTP statement protocol |

**The `trino` connector. (my call, following the owner's statement that their real data is in the lake)** The owner's lake is reachable from this machine and holds live data, so it is the first real source. The connector:

- sends one read statement at a time (select, show, describe, explain) under its own named identity, with the session in UTC;
- **enforces guardrails declared per table in the source manifest**, and refuses a query that breaks them, with a clear reason:
  - a guarded table must be filtered on its time column, and the filter comes from the step's window;
  - time literals must carry an explicit zone;
  - no "select everything" on a guarded table; large text columns only when named;
  - no exact distinct count on a guarded table (an approximate one is offered instead);
  - a sort must have a limit;
  - a row cap and a timeout always apply;
- **estimates before it runs**, by asking the engine for the plan, so the person sees the cost first;
- reports partial coverage when the row cap is hit or the engine stops the query.

These guardrails mirror the owner's own written rules for querying the lake. The builder must read those rules (their location is in the owner's configuration notes, not in this repository) before writing the connector or any pivot for it.

**Source quality notes.** A source manifest can declare known problems with its data, each with the time range affected (for example: a period where events were recorded twice). A card whose window overlaps such a note is tagged, and the note is carried into the product's account of source quality (§9.6, check 5).

A source manifest also declares:

- its tables, columns, and which observable type each column holds;
- its time column, if it has one;
- its cost (below);
- its handling marking;
- whether it is `confirmed` (guide §5.4: unconfirmed sources can be excluded from routes);
- whether agents may write their own queries against it (`adhoc`), off by default;
- limits: maximum rows and a timeout;
- the **name** of the credential it needs. The value comes from the environment or a secrets file outside the repository.

Every connector implements the same small interface: describe itself, estimate a query, run a query. A run returns rows, the raw bytes, and **coverage**:

- `full`: the source answered completely;
- `partial`: with a reason (stopped at the row limit, timed out, window clipped, source reported an error part-way).

Read-only is enforced inside each connector: `files` opens read-only; `sql` uses a read-only connection and refuses anything but a single read statement; `http` sends GET, or POST only to endpoints the manifest marks as read-only searches.

**Cost. (my call)** The guide speaks of free and costly steps, so there are two classes, not three.

- Each source declares a **weight**: a number, zero or more, set by the owner. Zero means free. Anything above zero is costly. Weight exists only to rank routes against each other.
- Each source also declares the **unit** its real cost is counted in (seconds, a currency, lookups against a quota), and its connector estimates a query's cost in that unit. That estimate is what the person sees before anything runs.
- A costly step's **budget** is given in that source's unit. The connector stops before exceeding it and reports partial coverage.
- Query budgets are per step. The model budget (§8.3) is per run. They are separate.
- **Agents run free things only.** Anything costly an agent wants (a step, an alternative route, its own query, a re-run to verify) becomes a proposal with its estimate, and waits for the person to give a budget.

### 7.4 Observable types and pivots

Observable types (address, domain, host, account, hash, and so on) are declared in a manifest, each with a recogniser, so any matching value on a card becomes a clickable chip (guide §5.1).

A pivot declares:

- `from` an observable type, `to` a goal type;
- the source it uses and its query template, with placeholders for the value and the window;
- whether it needs a time window;
- its weight, if it differs from its source's;
- which result columns yield which observable types;
- **what an empty result means**: either `proven-negative` (the source is complete for this question, so empty is an answer) or `not-seen` (absence here is not proof of absence).

### 7.5 Goal seeking

The seeker answers one question: given what I have, what are the cheapest routes to what I want?

- Input: the values in hand, the goal type, and limits (a ceiling on a route's total weight, whether unconfirmed sources are allowed, the window).
- Output: routes, lowest total weight first, fewer hops breaking ties. Each hop shows source, free or costly with its estimate, whether it needs a window, and what an empty result means (guide §5.4).

When a hop is blocked (failed, empty, partial, or over budget), the seeker marks that edge as a roadblock and re-routes from what is now known. Free alternatives may run within the accepted plan. Costly alternatives become a proposal to the person. The trail of attempts is recorded.

The bundled seeker finds lowest-weight paths over the pivot graph. It sits behind an interface and is chosen by name in configuration, so another can be added in code and selected. Pointing at a route finder that runs elsewhere, on the network or the web, comes with remote modules (§15). **(my call)**

The same seeker serves the Pivot panel on a card and the planner agent.

## 8. Agents

### 8.1 One loop, owned by the server

The server runs one agent loop for every agent and every model: assemble the context pack, call the model, execute any tool calls, repeat. Every model call and every tool call passes through code that writes the ledger entry first. An agent has no other way to act.

### 8.2 The fixed tool list

Tools are defined in code. A stage manifest picks from this list and cannot add to it.

| Tool | Does | Used by |
|---|---|---|
| `list_sources`, `describe_source` | Read source manifests | Planner, researchers |
| `find_routes` | Ask the seeker for routes | Planner, researchers |
| `run_step` | Run an accepted plan step | Researchers |
| `run_pivot` | Run a free pivot inside the accepted plan's goals | Researchers |
| `run_query` | Run an agent-written query, only on sources marked `adhoc` | Researchers |
| `list_cards`, `read_card` | Read cards and their provenance | Senior analyst, evaluator, adversary |
| `verify_card` | Re-run a card's query (§6.7) | Evaluator, adversary |
| `propose_assessment` | Propose a finding with likelihood, confidence, basis, assumptions | Senior analyst |
| `propose_narrative` | Propose text for a narrative section, with citations | Senior analyst, publisher |
| `request_research` | Send a question back to research | Senior analyst |
| `raise_challenge`, `answer_challenge` | The adversary's challenges and the analyst's answers | Adversary, senior analyst |

Every tool requires `why`. Every tool that reaches a source follows the cost rule in §7.3: free runs, costly becomes a proposal that waits for a budget.

### 8.3 Model providers and the dropdown

A provider can list its models and run one model turn. Two ship in the slice:

| Provider | Runs | Notes |
|---|---|---|
| `scripted` | On this machine | Replays prepared answers. Used for tests and for a demo with no model at all. |
| `local endpoint` | On this machine or the network | Any server that speaks the common chat-completions protocol with tool calls. Several endpoints can be configured; the dropdown lists every model each one reports. |

The slice is built against the owner's local model server on this machine (§17). A `claude` provider, using the official Anthropic TypeScript SDK with the model list read live, follows as soon as a key exists; it is not part of this slice. **(my call)**

Each stage shows a **model** dropdown and an **effort** dropdown. Defaults come from the profile. Each model is tagged with where it runs: this machine, your network, or hosted.

**Markings decide where data may go. (my call)** Configuration maps each handling marking to the places allowed. The check is made at the moment data would leave, on every model call:

- the marking that counts is the strictest of the case's marking and everything in that call's context pack (a card carries its source's marking);
- if the chosen model is not allowed for that marking, the call is not made. The stage pauses and offers two ways on: choose an allowed model, or leave the stricter items out of the pack;
- the dropdown shows models that are not allowed as disabled, with the reason;
- a plan step warns when it uses a source stricter than the Research stage's chosen model allows;
- each model request entry records the marking that applied.

Effort maps to the provider's own effort setting where it has one, and is disabled where it does not.

Outcomes that are not answers are recorded as themselves, never as empty results:

- **declined:** a hosted model's safety layer may refuse a request. The stage shows "declined" in amber and offers a re-run on another model.
- **fallback:** where a provider can hand a declined request to another of its models, that is on by default, and the entry records the model that actually answered. It can be switched off in the model manifest. **(my call)**

The run shows a running total of model usage. A run budget can be set; at the budget the engine pauses and asks (guide §2, "cost before action"). Prices come from the model manifest, which the owner maintains.

Where a model returns its reasoning as text alongside its answer, as the owner's local model does, that text is stored with the response and shown in the Pipeline lens and in Replay.

When the `claude` provider is built, the builder must read the provider's current SDK documentation first, and not code it from memory.

### 8.4 The context pack

As in the guide (§6, §13): a profile maps the activity to an agent, persona, goal, method, procedure, skills, output schema, references, gates and objective. The pack is assembled for each turn. The list of items given, with content hashes, is recorded in the model request entry.

The slice ships one profile, "Investigation", with a persona for each pipeline stage.

### 8.5 Two places agents appear

- **The pipeline's stage agents** do the run. Their context, transcripts, tool calls and outputs are shown per stage in the Pipeline lens.
- **Your agent**, in the Agent lens, is the conversational assistant the guide describes (§6): it answers from a snapshot of the case, has no tools, and its answers can be proposed into the Narrative.

### 8.6 Built to work on a local model **(my call)**

The pipeline must work on a mid-sized model running on the owner's machine, not only on the strongest hosted ones. So:

- **Small steps.** Each stage asks for one bounded thing. A researcher works one sub-goal; the senior analyst drafts one section at a time.
- **Code checks every output.** Stage outputs are validated against their schemas by code, with one retry carrying the errors (§9.2). Nothing downstream trusts an unvalidated output.
- **Values, not query text.** Agents normally call pivots and pass values; the connector fills the query template. This avoids a known weakness of local models, which can mangle quoted text inside a tool call. It is one reason agent-written queries are off by default.
- **A context budget per turn.** The provider reports the model's loaded context size. The pack is assembled to fit, the Agent and Pipeline lenses show its size (guide §6), and what was left out is listed and recorded.
- **Results are trimmed for the model, never for the record.** A large result is given to the model as a capped, summarised view; the full bytes are in the blob store and on the card.

## 9. The pipeline

### 9.1 Stages

Stages are manifests in the module root. Each names who runs it (an agent, a script, or a person's gate), its tools, its output schema, its default model and effort, where it goes on pass, where it sends work back to on fail, and which phase of the methodology framework it belongs to. The owner has said there are more steps than these; adding one means adding a file.

The bundled pipeline:

```
1 Frame      agent    reads the objective, guidance and framework; states the goals, window and limits
2 Plan       agent    finds routes to each goal; proposes the plan              ▸ you accept (guide §7)
3 Research   agents   one per sub-goal, in parallel; blocked ▸ re-route, or back to 2
4 Assemble   agent    the senior analyst drafts findings and narrative; needs more ▸ back to 3
5 Checks     scripts  product schema + analytic-standards form checks; fail ▸ back to 4
6 Evaluate   agent    invariants: every claim is supported by what its cited cards say; fail ▸ back to 4
7 Challenge  agent    the adversary attacks it; anything that must be addressed ▸ back to 4
8 Publish    agent    packages the product as a preview                          ▸ you approve
9 Feedback   you      scored against the objective's measures
```

"Orchestration" is two things: stage 1 is an agent that frames the run, and the engine is plain code that starts stages and moves work between them. Transitions are decided by the engine from each stage's validated output, so the flow is deterministic and every transition is an entry. **(my call)**

### 9.2 Rules of the engine

- **Your gates:** you accept the plan, and you approve publishing. Between those, stages hand off on their own. Approving publishing is also where you accept the draft (§9.5). **(my call)**
- **Pause** stops new work starting; running queries finish and are logged. **Resume** continues.
- **Send-back cap:** three send-backs along any one edge, then the run pauses and asks you. **(my call)**
- **Bad output:** a stage whose output fails its schema gets one retry with the errors, then the run pauses.
- **Parallel research:** up to three researchers at once by default, shown in the jobs indicator.
- **Restart:** if the server stops mid-run, the run is marked interrupted and can resume from the last finished step.

### 9.3 Plans

The plan follows the guide (§7): a goal line, the window, counts of free and costly steps with an estimate, then sub-goals with their steps. Buttons: Run the free steps · Accept all · Deny · Re-plan. Costly steps each wait for a budget. Nothing runs before acceptance.

Accepting a plan creates one lane per sub-goal. **(my call)**

### 9.4 Cards, triage and what agents may do with them

Each query result becomes a card in Incoming, with its provenance. Agents never keep, move or discard cards. When the senior analyst cites a card you have not kept, the citation is drawn dashed, and accepting the draft keeps the cited cards into their sub-goal's lane. You can triage by hand at any time.

### 9.5 The draft, and what may be published **(my call)**

The senior analyst's output is a **draft**: a proposal, drawn dashed in the Narrative lens. Each revision is numbered and hashed. Stages 5 to 7 work on a draft, and every check result, evaluation and challenge is recorded against the hash of the revision it examined.

At the publish gate you see the draft, its check results, the challenges with their answers, and the bundle preview. You can:

- **Approve.** This accepts the draft: the narrative becomes accepted, the cards it cites are kept into their lanes, and the bundle is written.
- **Edit.** Your change makes a new revision, authored by you. It goes back through stages 5 to 7 before it can be approved.
- **Reject**, with a reason. The run returns to Assemble, or stops if you say so.

You may also edit the draft in the Narrative lens before the gate; that too makes a new revision and restarts from stage 5.

One rule is fixed: **only a revision whose exact hash has passed stages 5 to 7 can be published.** What is published is byte for byte what was checked.

### 9.6 The form checks (stage 5)

Scripts can check form. They cannot judge whether the analysis is good; that is for the evaluator, the adversary and you.

The bundled checks, based on the tradecraft standards of ICD 203:

1. The product validates against its output schema.
2. Each key finding uses exactly one likelihood term from the standard scale.
3. Each key finding states a confidence level and its basis, and no sentence combines a confidence level with a likelihood term.
4. Every finding cites at least one card, and every citation resolves.
5. Every cited source has a quality and credibility note.
6. Assumptions are listed apart from evidence, and judgments are labelled as judgments.
7. Alternatives considered is present and not empty.
8. Gaps and limits is present, and no partial-coverage card is cited as a proven negative.
9. The product names the objective it serves and the question asked.
10. The product says whether it changes or is consistent with earlier judgments on the same question, or that it is the first.
11. The product's marking is at least as restrictive as every card it cites.

The likelihood scale and confidence levels live in a data file, not in code, so the owner can correct them against the published directive.

A check is a program: JSON in, findings out. It can be written in any language. Each run records the script's hash.

### 9.7 Publishing and feedback

The publisher proposes a bundle and you see a preview. On approval it is written to the case folder:

- the product as Markdown, and as JSON in the output schema;
- a provenance appendix: every cited card expanded to its source, exact query, why, who, when, marking and hashes;
- the handling marking, top and bottom;
- the hash of the chain head at the moment of publishing.

Feedback is recorded against the measures defined on the objective:

- **measures of performance** are computed from the ledger where possible (elapsed time, queries run, cost, steps blocked, send-backs, checks failed);
- **measures of effectiveness** are entered by you.

## 10. The interface

Everything follows the guide's principles (§2), visual language (§3), wording rules (§10) and accessibility rules (§12).

### 10.1 In the slice

| Part | Guide | Notes |
|---|---|---|
| Home | §4.1 | Only "Investigate" is live. Other tiles are "soon". |
| Which one? | §4.2 | With a dashed "+ New investigation" tile first. **(my call)** |
| Trail, top bar, command bar, jobs indicator | §4.3, §4.4 | |
| Work area: Incoming, brief, lanes, shelf, toasts with Undo | §5 | No file tree. |
| Cards with provenance and value chips | §5.1 | Actions: Pivot…, Verify, Cite, Keep, Move, Back to Incoming, Discard, Pin. Drag onto a lane keeps; drag above or below a card moves. |
| Keyboard and the "?" card | §5.2 | Every key for parts in the slice. |
| Lenses: Agent, Steps, Timeline, Narrative, Worklog, Discarded, Jobs | §5.3, §6, §7 | |
| Pivot panel | §5.4 | |
| New lenses: **Pipeline** and **Replay** | new | Below. |

"+ New investigation" asks for: title, what was asked and why, starting values, window, objective, marking. Its button reads "Create and frame the run".

### 10.2 Additions to the guide

**The phase strip**, in the brief, with the custody chip:

```
Brief: CASE-1 · TLP:AMBER · title                              chain intact · 412 entries   [Hide]
Asked for: … · ✔ 3/5 goals · plan accepted · draft 2                          [Run] [Pause]
Frame ✓ ▸ Plan ✓ ▸ Research ● 3 running ▸ Assemble ▸ Checks ▸ Evaluate ▸ Challenge ▸ Publish ▸ Feedback
```

Stages are grouped under the phases of the methodology framework. Clicking a stage opens the Pipeline lens at that stage.

**The Pipeline lens** (key `Q`): one row per stage with its state, its model and effort dropdowns, the context it was given as chips, its transcript, its tool calls, and its send-backs with reasons. **(my call on the key)**

**The Replay lens** (key `E`):

```
Replay · entry 137 of 412 · 2026-11-23T20:02:11.482Z · agent: researcher-2      [◂] [▸] [Play] [Live]
  136  20:02:09  researcher-2  query issued   dns-logs · select … where address = '…' · why: confirm …
▸ 137  20:02:11  researcher-2  query result   14 rows · full coverage · sha256 9f3c…
  138  20:02:11  system        card created   c12 "Hostnames for …"
```

- Stepping (`◂ ▸`, or `J`/`K`) moves one entry. The whole work area re-renders as it was at that entry, read-only, with a banner, and highlights what changed.
- The selected entry shows who, what, why, the exact query, the source, the hashes, and a link to the raw bytes.
- Filter by actor, type or stage. `Esc` or "Live" returns to the present.
- **(my call on the key)**

**One key for "the next thing":** `Shift+Enter` performs whatever the run is waiting on (accept the plan, approve publishing, resume). The button it triggers always says what will happen (guide §10). **(my call)**

**Command bar verbs:** open, go to, investigate, run, pause, accept plan, approve, verify, replay, summarize. Anything else goes to your agent (guide §6).

**Times:** UTC with milliseconds in provenance, the Worklog and Replay; short local time elsewhere, with UTC in the tooltip. **(my call)**

### 10.3 Roles

The slice has one view, analyst, set in configuration. The server still checks every command against the role (guide §11), so the other views can be added without rework.

## 11. Storage and layout

```
<data directory>/                     outside the repository; location set in configuration
  workbench.sqlite                    the workbench chain and the index of cases
  cases/<case-id>/ledger.sqlite       that case's chain
  cases/<case-id>/blobs/<sha256>      raw bytes
  cases/<case-id>/published/<n>/      product bundles
```

```
src/core/       ledger, hashing, canonical JSON, the apply functions (shared with the browser)
src/server/     HTTP, commands, entry stream, roles
src/modules/    registry, manifests, connectors, seeker
src/agents/     the loop, the fixed tools, the context pack, providers
src/pipeline/   engine, stage runners, checks runner
src/web/        the interface
sample/         a module root: context, sources and data, pivots, stages, checks, a small API fixture
docs/           gui-guide.md and designs
tests/
```

## 12. Sample data

Synthetic only: documentation address ranges and example domains, placeholder names.

- Three sources, one per connector kind: network flows in a SQLite file (`sql`); DNS and sign-in logs as JSON lines and an asset list as CSV (`files`); a reputation lookup served by a small local fixture (`http`).
- One planted story that the pipeline can find from a single starting value.
- At least one dead end that forces a re-route, one result with partial coverage, and one proven negative, so the honest-negative rules are exercised.
- A sample objective with measures, a strategy-to-task chain, a methodology framework with phases, the Investigation profile and personas, and an output schema for the product.
- A script for the `scripted` model that drives the full run, including one send-back.

### Real data

Checked from the owner's workstation on 2026-11-23, read-only:

| System | Result |
|---|---|
| Data lake (Trino over Iceberg) | Reachable and answering. About fifty tables: the full Wazuh event archive, normalised security events (sign-ins, DNS, network, files, findings), threat-intelligence tables, honeypot events, risk baselines and health data. Live: millions of events in the last day. |
| SSH to the SIEM host | Works, with administrator rights. Not needed by the workbench itself. |
| Wazuh API | Signs in with the existing read-only account, but that account cannot see agents or manager details. |
| Wazuh indexer | Answers, but rejects the existing read-only account. |

So the slice points at the lake. The owner's real module root (source manifests, pivots and quality notes for the lake) is built alongside the slice but kept outside this repository.

Two things the owner may want to decide later, neither blocking:

- The lake's main endpoint accepted queries under a bare user name. The workbench enforces read-only itself, but a dedicated read-only identity for it on the lake would be a stronger guarantee.
- A Wazuh read account with enough scope to list agents would let the workbench use Wazuh as an asset inventory.

## 13. Testing

- **Ledger:** appending; chain verification; a changed row or blob is detected at the right entry.
- **State:** the fold is deterministic; undo; state at entry N is the same live and in replay.
- **Connectors:** writes are refused; partial coverage is tagged on truncation and timeout; windows are applied.
- **Seeker:** cheapest route; limits respected; re-routing around a roadblock.
- **Pipeline:** a full scripted run reaches the publish gate; send-backs; the cap; pause and resume; a declined model.
- **Checks:** each form check, with a passing and a failing example.
- **Interface:** the keyboard map; no HTML injection (enforced by a lint rule); reduced motion; one browser run through the whole slice.
- **Custody acceptance test:** after a full run, every card traces to a query issued, a query result and a blob; chain verification passes; replay ends in the same state as live.
- **Draft rule:** a revision that has not passed stages 5 to 7 cannot be published; an edit sends it back through them.
- **Markings:** a model call whose pack is stricter than the chosen model allows is not made.
- **Lake connector:** each guardrail refuses what it should, tested against a stand-in for the engine; the tests never touch the live lake.
- **Real investigation:** run by hand, not by the test suite. One investigation against the live lake, driven by the owner's local model, reaches the publish gate, and its custody checks pass. This is the bar for "done".
- **Local endpoint provider:** tested against a stand-in server in the test suite, and against the real local model by hand.

## 14. Left to the builder

- Table schemas, exact entry names and payload shapes, API routes.
- How manifests are validated.
- How the interface code is organised (no framework is required) and bundled.
- How the `files` connector executes SQL over files.
- The format of the scripted model's script.
- Snapshot strategy for long chains.
- Animation details within the guide's rules.

## 15. What comes after this slice

Each is its own design, in this order unless the owner changes it:

1. The rest of the work area: Graph, Notes and Ticket lenses, linking by drag, Combine, My folders and the file tree.
2. Hunts.
3. Resources: Strategy, Requirements, Gaps, Agent inventory, with cross-links (guide §9).
4. Requester panels and Learn.
5. Remote modules: sources as separate services, module roots over https or git, lake-scale file formats.
6. Signing, trusted timestamps, case export; more than one user, with sign-in.

## 16. Calls made by the designer

Check these while reading. Each is easy to change now and harder later.

1. TypeScript over Go; Bun as the runtime; YAML manifests.
2. One ledger chain per case, plus one for the workbench.
3. The engine is plain code; "orchestrator" is the framing agent at stage 1.
4. You gate the plan and publishing only; everything between hands off on its own, with a cap of three send-backs per edge.
5. Accepting a plan makes one lane per sub-goal. Agents never move cards; accepting a draft keeps the cards it cites.
6. Researchers may run free pivots inside the accepted goals without asking, and may write their own queries only on sources marked `adhoc`.
7. Models are tagged by where they run, and a case's marking limits which can be chosen.
8. A provider's fallback after a decline is on by default and always recorded.
9. Scripts check form only; the eleven checks in §9.6.
10. New keys: `Q` Pipeline, `E` Replay, `Shift+Enter` for the next thing.
11. UTC in custody views, local time elsewhere.
12. Module roots are directories only in this slice; publishing writes a local bundle only.
13. Approving publishing is where you accept the draft. Any edit goes back through checks, evaluation and challenge. Only a revision that passed them, unchanged, can be published.
14. Cost has two classes, free and costly. A weight ranks routes; the estimate and the budget are in each source's own unit. Agents run free things only.
15. The marking that governs a model call is the strictest thing in its context, checked on every call; a call that is not allowed is not made.
16. Module roots supply manifests, context and data, not code that runs in the server. Check scripts are the exception and run only from roots marked trusted.
17. In this slice you point at sources and pivots. The route finder is chosen by name from those built in; pointing at one that runs elsewhere comes later.
18. The `sql` connector is built and tested for SQLite only in this slice.
19. A `trino` connector is added, pointed at the owner's lake, with the owner's query rules enforced inside it.
20. Tests use only synthetic data and a stand-in engine. The real investigation is run by hand.
21. The owner's real manifests live outside this repository. No Wazuh connector in this slice.
22. The slice ships two model providers, scripted and local endpoint. The `claude` provider waits for a key.
23. The pipeline is shaped for a local model: small steps, code-checked outputs, values instead of query text, a context budget, trimmed views for the model.

## 17. Settled: the model to build against

The owner loaded a local model for this work on 2026-11-23: Qwen 3.6 35B, served by LM Studio on this machine. Checked the same day:

- it answers on the loopback address, loaded with a context of about 131,000 tokens;
- given a tool with a required `why`, it made one well-formed call with a sensible reason, then answered correctly from the result;
- it returns its reasoning as text, which the ledger will keep;
- it is fast: a tool-calling turn took about a second.

Because it runs on this machine, case data never leaves it, so no marking restricts its use.

"Done" for this slice is therefore: every test passes on the scripted model, and one real investigation against the live lake, driven by this local model, reaches the publish gate with its custody checks passing.

The model gateway on the owner's network can be added later as a second endpoint. Its key has not been used.
