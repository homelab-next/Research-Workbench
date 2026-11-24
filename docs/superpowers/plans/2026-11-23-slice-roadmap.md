# Investigation Slice: Roadmap

**Spec:** [`docs/superpowers/specs/2026-11-23-investigation-slice-design.md`](../specs/2026-11-23-investigation-slice-design.md)
**GUI reference:** [`docs/gui-guide.md`](../../gui-guide.md)

The slice is too large for one plan. It is built as five plans, in order. Each plan produces working, tested software on its own, and each later plan is written against the code the earlier ones actually produced. A plan file is added to this directory when its turn comes.

| # | Plan | Produces | Proven by |
|---|---|---|---|
| 1 | **Ledger core** | Canonical JSON and hashing; the append-only ledger; blob store; chain verification and its command-line tool; a JSON Schema validator; the state fold shared by server and browser; the data directory and case sessions | Unit tests; a tampered ledger is caught at the right entry; state at entry N is identical live and replayed |
| 2 | **Modules** | Configuration and module roots; manifest loading and hashing; observable types; the SQL guard; connectors `sql` (SQLite), `files`, `http`, `trino`; the query runner that logs every query and makes cards; pivots and the route finder; re-validation of a card; the synthetic sample module root | Unit tests against stand-in servers; routes re-plan around a roadblock; every guardrail refuses what it should |
| 3 | **Agents and pipeline** | Model providers `scripted` and `local endpoint`; the context pack and marking rule; the fixed tool list; the agent loop; the pipeline engine with gates, send-backs, pause and resume; stage runners; draft revisions and the publish rule; the form checks; publishing and feedback; a headless command-line run | A full scripted run reaches the publish gate; the custody acceptance test passes |
| 4 | **Server and interface** | The loopback server, commands, entry stream and roles; the interface from the GUI guide for every part in the slice; the Pipeline and Replay lenses | Server tests; DOM tests; one browser run through the whole slice |
| 5 | **Real run** | The owner's real module root for the lake (kept outside this repository); configuration for the local model; a README | One investigation against the live lake, driven by the local model, reaches the publish gate with custody checks passing |

## Task lists

### Plan 1: Ledger core (`2026-11-23-slice-1-ledger-core.md`)

1. Scaffold, canonical JSON, hashing
2. Shared types and the ledger
3. Blob store, chain verification, `verify` command
4. JSON Schema validator
5. State fold: case, cards, lanes, undo
6. State fold: run, plan, queries, jobs, proposals
7. State fold: drafts, reviews, challenges, publishing, feedback, conversation
8. Data directory, case sessions, id allocation

### Plan 2: Modules

1. Configuration, module roots, manifest loading and hashing
2. Observable types and recognisers
3. SQL guard: single read statement, and the per-table guardrails
4. Connector interface; `sql` (SQLite) and `files`
5. `http` connector
6. `trino` connector, with a stand-in engine for tests
7. Query runner: cost rule, ledger entries, blobs, cards, quality notes
8. Pivots and the route finder
9. Re-validating a card
10. Sample module root: synthetic data, manifests, API fixture

### Plan 3: Agents and pipeline

0. Close out plan 2
1. Core additions and session recovery
2. Provider interface, model manifests, the `scripted` provider
3. The `local` endpoint provider, with a stand-in server for tests
4. Context parts, the pack, its budget, the marking rule
5. The fixed tool list: sources, research and cards
6. Analysis tools and the draft builder
7. The agent loop
8. Pipeline manifests and the engine: stages, gates, send-back cap, pause, resume, interrupted
9. Stage runners: Frame, Plan, Research
10. Stage runners: Assemble, Evaluate, Challenge; draft revisions
11. The checks runner and the eleven form checks
12. Publishing and feedback
13. The scripted run, the headless command, the custody acceptance test

### Plan 4: Server and interface (as built: fifteen tasks)

0. Close out plan 3, and move local queries off the server's thread
1. The server: loopback, the request guard, roles, cases and the entry stream
2. Commands: the run and its gates, triage, settings
3. Evidence: blobs, bundles, the bundle preview and the custody report
4. Interface foundation: build, the DOM helper, the store that folds entries, and the injection lint
5. Home, "which one?", New investigation, the trail, the top bar and the command bar
6. The work area: Incoming, the brief with its phase strip and custody chip, lanes, cards, the shelf and toasts
7. The keyboard map, the "?" card, dragging and motion
8. Lenses: Steps with the plan gate, Timeline, Worklog, Discarded, Jobs
9. The Pipeline lens: stages, model and effort, context, transcript, feedback
10. The Narrative lens and the publish gate
11. Your agent: the conversational agent and the Agent lens
12. The Replay lens
13. The Pivot panel and Verify on a card
14. The serve command, the whole run in the DOM and in a browser, and the security notes (`docs/security-notes.md`)

### Plan 5: Real run

1. The owner's module root for the lake, and local model configuration
2. The real investigation, and the README
