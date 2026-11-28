# A synthetic company (slice 15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person builds, with one command, a synthetic company that shares nothing with the real or dev setups: a fake lake (one SQLite file of thirteen day-partitioned sources, generated from a seed), a module root over it (sources with field notes on every column, pivots, types, inventories, a playbook, the case types, the loops) and a configuration with its own data folder and port. Nine storylines with known answers are written into the background noise, five malicious and four benign look-alikes, each a YAML manifest. A new connector, `fakeathena`, runs the guarded SQL over the file, opens no network connection, and prices every query in USD from the partitions its window touches and the columns it names, so budgets, cost ceilings and costly-step approvals behave as they would against a billed lake. `synth tasks` makes one case per storyline and writes its ground truth beside it; a person turns it into a known answer with one command after publishing, or runs `synth seed-tasks` to make published, answered task cases for the improve loop.

**Architecture:** Two repositories, two parts, one hand-over.
- **Part A, pivot v0.3.0** (Tasks 0 to 11). `src/synth/` holds the generator (a seeded company model, per-table background noise, the mess rules, the storyline engine, the lake writer and the build that assembles lake, root and ground truth). `synth/catalogue/` holds the manifests of the thirteen sources and their pivots; `synth/storylines/` the nine storylines. `src/connectors/fakeathena.ts` is a connector like any other: it guards a request with the existing guard, refuses a table that is not its source's, runs the statement in the local query process pivot's `sql` connector already uses, and prices it with the pure cost model of `src/connectors/fakeathena-cost.ts`. The lake holds no ground truth; the build writes it to a folder of its own.
- **The hand-over.** Part A ends with an annotated tag `v0.3.0` in the pivot worktree, not pushed. The owner pushes pivot's branch and tag. No task pushes. Part B starts when the tag is on the remote.
- **Part B, the workbench** (Tasks 12 to 17). The workbench pins pivot `v0.3.0` and becomes `0.15.0`. `bun run synth` has five forms: `build` (pivot's build, then the generic half of the sample, the workbench's own overlay and a configuration), `tasks`, `answer`, `seed-tasks` and `show`. Every form but `build` refuses a configuration that is not a synthetic setup's. No ledger entry type, payload, gate, role or route is added: a synthetic case is an ordinary case, its queries go through `runQuery`, and a known answer is slice 14's `answer.known`, written by the person who runs the command.

**Tech Stack:** Bun 1.3.14, TypeScript 7 (strict), `bun test`, `bun:sqlite`. No new dependency in either repository.

**Spec:** `docs/superpowers/specs/2026-11-28-slice-15-synthetic-company-design.md` in the workbench ("the design"; the owner's direction; the controller commits it from the scratchpad before Task 12, and gives Part A's tasks its text). Branch `slice-15-synth` in the pivot worktree `<pivot>` (off `main`, v0.2.0) and branch `slice-15-synth` in the workbench worktree `<repo>` (off `main`, 0.14.0). Decisions the design left open are the "Ruling:" lines in `rulings.md` beside the briefs; where a task states one, it is the requirement.

In this plan `<pivot>` is the pivot worktree and `<repo>` the workbench worktree the controller names when it dispatches a task, `<data>` a workbench's data folder (in a test, a temporary one), `<synth>` the folder a synthetic setup is built in (in a test, a temporary one; on the owner's machine `<lake>/synth`) and `<lake>` the owner's lake folder, which no task touches.

## Global Constraints

- **Synthetic data never meets real data.** No task reads or writes `<lake>/`, the owner's data folder, roots or configuration. The generator writes only inside the folder it is given. `synth build` refuses a folder that is not empty, a folder inside `<repo>`, and a folder that is, holds or sits inside the data folder, a root or a store of the configuration the command would load with no `--config`. `synth tasks`, `answer`, `seed-tasks` and `show` refuse a configuration with no `synth.json` beside it, so a synthetic case is never made in a data folder that is not a synthetic setup's.
- **The fake lake says what it is.** A lake file carries `_lake_meta` with `kind = pivot-synthetic-lake` and `format = 1`. The `fakeathena` connector opens no file that does not, read-only. A `fakeathena` source is accepted only from a trusted root.
- **No network.** Nothing under `src/synth/`, `src/connectors/fakeathena.ts` or `src/connectors/fakeathena-cost.ts` (pivot) or under `src/synth/` (workbench) names `fetch`, `Bun.connect`, `Bun.listen`, `Bun.serve`, `WebSocket` or a `node:net`, `node:http`, `node:https`, `node:http2`, `node:tls`, `node:dgram` or `node:dns` import, or imports pivot's `http` or `trino` connector. A test holds this by reading the files and by running a build and queries with `globalThis.fetch` replaced by a function that counts its calls.
- **The guard, custody and `runQuery` are unchanged.** `src/guard/sqlguard.ts` and `tests/guard/sqlguard.test.ts` are not edited. The connector calls `assertReadOnly`, `checkGuardedShape` and `checkGuardrails` as they are. In the workbench, `src/modules/runner.ts` is not edited: every query on the fake lake is `query.issued`, then the contact, then `query.result` or `query.failed`, as for any source. No ledger entry type and no payload field is added; old ledgers fold as they did.
- **The lake holds no answer.** Ground truth is written to `<synth>/truth/`, never into the lake, the root or a script. A `fakeathena` query may name only the tables its own source's manifest lists; `_lake_meta`, `_lake_tables`, `_lake_partitions`, `sqlite_*` and `pragma_*` are refused.
- **The judge stays blind.** In the workbench, a ground-truth file is read only by `src/synth/tasks.ts`, `src/synth/answer.ts` and `src/synth/seed.ts`, which a person's command runs. Nothing under `src/pipeline/`, `src/agents/`, `src/server/`, `src/core/` or `src/web/` imports `src/synth/`. No file `synth build` writes into the root, and no product a seeded case publishes, holds a ground truth's summary or a claim. A known answer is written only by `setKnownAnswer`, by `{ kind: "human", id: config.user }`.
- **A person's gates stay a person's.** `synth seed-tasks` accepts a plan and approves a product as the person who runs it, through `engine.acceptPlan` and `engine.approve`, exactly as `investigate accept-plan` and `investigate approve` do. It gives no budget, so no costly step runs in a seed. No other code path passes a gate.
- **Deterministic.** No `Math.random` and no clock (`Date.now`, `new Date()` with no argument) anywhere in the generator: every draw comes from `stream(seed, name)`. The same `SynthParams` give the same lake file bytes, the same root files and the same ground-truth files. Sorting is by `<` on strings, never `localeCompare`. Costs are computed in integers of bytes and rounded once to a millionth of a dollar.
- **Bounded.** Parameters are checked against `PARAM_LIMITS`; a build whose `projectedBytes` exceeds `MAX_LAKE_BYTES` (2 000 000 000) is refused before a file is made.
- **Public repositories.** Everything committed is synthetic and says so. Addresses in committed text are loopback or the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24): both repositories' hygiene tests refuse any other dotted quad, and they are not edited. The fake company's internal addresses are in 10.x and are **computed** (`[10, site, net, n].join(".")`): no manifest, test, fixture, document or commit message holds one written out. A test that needs one reads it from the company model or a ground-truth record. Domains are `*.example`, `example.com`, `example.net` or `example.org`. Vendors, people, hosts and products are invented and read as invented. No word the private-terms file lists (the owner's network words), no home path and no real host appears; a path on a machine is written `<pivot>`, `<repo>`, `<data>`, `<synth>` or `<lake>`.
- **Existing behaviour is unchanged.** pivot's `sample/` and the workbench's `sample/` are not edited; their loops' hashes and every acceptance test of slices 1 to 14 are what they were. The `sql`, `files`, `http` and `trino` connectors behave as before. A manifest that named no `fakeathena` source loads to the same hash and the same fields.
- **Exact values:** the connector kind is `fakeathena`; its cost unit is `USD`; `FAKEATHENA_USD_PER_TB` is `5`; `TB` is `1_000_000_000_000` bytes; `MIN_BILLED_BYTES` is `10_000_000`; a cost is `Math.round(billed * per_tb / TB * 1e6) / 1e6`; the estimate prefix is `EXPLAIN (TYPE IO, FORMAT JSON) `; `LAKE_FORMAT` is `1`; `LAKE_KIND` is `"pivot-synthetic-lake"`; `GROUND_TRUTH_FORMAT` is `1`; `DEFAULT_PARAMS` is `{ seed: 15, start: "2026-10-01", days: 30, users: 200, hosts: 300, sites: 3, volume: 1, scale: 50000 }`; `TINY_PARAMS` is `{ seed: 15, start: "2026-10-01", days: 4, users: 12, hosts: 16, sites: 2, volume: 0.05, scale: 50000 }`; pivot's `VERSION` is `"0.3.0"`; `WORKBENCH_VERSION` is `"0.15.0"`; a synthetic setup's port is `4757`; the seed loop's id is `synth-seed`; a synthetic case's title starts with `[synthetic] `; the truth folder beside the cases is `<data>/synth-truth/`.
- **Tests.** pivot: `timeout 120 bun test <file>` while iterating; `timeout 600 bun test && timeout 300 bun run typecheck` before each commit. Workbench: `timeout 120 bun test <file>`; `timeout 900 bun test && timeout 300 bun run typecheck` before each commit, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. Every test builds with `TINY_PARAMS` (or smaller) under a fresh `mkdtempSync` folder and removes it, closes every connector, pool, workbench and engine it opens, and asserts `state.skipped` is `[]` when it drives a session. No test asserts an absolute duration. A file that builds a lake builds it once (`beforeAll`). Report real RED: the failing run of the new tests, made before the implementation exists.
- **No wait loops, nothing left running.** Never wait with a `pgrep`-based loop or an `until` loop on a log (other sessions on this machine run `bun test` too, so such a loop never ends). Run commands in the foreground with a time limit. Leave no background process behind: no server, no watcher, no query child.
- **Commits.** On `slice-15-synth` of the repository the task names, never pushed; `git add` by explicit path (tasks beside yours may have uncommitted work in the tree). Never `git checkout`, `switch`, `stash` or `reset`. Never `git push`, and never `git push --tags`. End every commit message with the attribution lines your own harness reminder gives you.
- **Other trees are not yours.** A Part A task works only in `<pivot>`; a Part B task only in `<repo>` (it reads `node_modules/pivot`, and edits nothing there). Do not touch any other worktree of either repository or `<lake>/`.
- **A test outside your task's Files that your change breaks:** fix it if no task running beside yours lists that file; otherwise report it and leave it.

## The fake lake: what is in the file

One SQLite file, written by `buildLake`. Every statement that makes it is issued in a fixed order inside one transaction per table, with `PRAGMA page_size = 4096`, `journal_mode = OFF` and `synchronous = OFF`, then `VACUUM`; nothing in it depends on the clock or the folder.

| Table | What it holds |
|---|---|
| one table per source (below) | the rows; an event table has `ts` (UTC, `YYYY-MM-DDTHH:MM:SS.mmmZ`) and `dt` (`YYYY-MM-DD`, the day of `ts`), an index on `dt`, and an index on `(key, ts)` for each key column `TABLES` names |
| `_lake_meta(key TEXT PRIMARY KEY, value TEXT)` | `kind`, `format`, `params` (the canonical JSON of the `SynthParams`), `digest` |
| `_lake_tables(name TEXT PRIMARY KEY, columns TEXT, row_bytes INTEGER, partitioned INTEGER)` | each source table: its column names (a JSON list, `dt` included), the simulated width of one row, whether it has `dt` |
| `_lake_partitions(tbl TEXT, dt TEXT, rows INTEGER, bytes INTEGER, PRIMARY KEY (tbl, dt))` | per table and day: the rows written and the simulated bytes, `rows * row_bytes * scale`; a table with no `dt` has one row with `dt = ''` |

`digest` is the SHA-256 of, for each source table in name order, its name and every row in rowid order as canonical JSON. It does not depend on SQLite's file layout, so it is the value a test holds as a literal; the file's own bytes are also compared between two builds of one test run.

The thirteen sources (`id`: table): `signins`: `signins` · `groups`: `group_members` · `process`: `process_start` · `dns`: `dns` · `proxy`: `proxy` · `flows`: `flows` · `dhcp`: `dhcp_leases` · `wifi`: `wifi_events` · `email`: `email` · `cloud`: `cloud_audit` · `vulns`: `vuln_findings` · `assets`: `assets` · `reputation`: `reputation`. Task 3 gives every column. `signins`, `process`, `dns`, `proxy`, `flows`, `email` and `cloud` are costly (`cost: { weight: 0.001, unit: USD }`) and guarded; `dhcp`, `wifi` and `vulns` are guarded and free (`weight: 0`); `groups` and `assets` have no time column and are free; `reputation` bills per lookup (`cost: { weight: 0.002, unit: USD, per_lookup: 0.002 }`).

## How the hard questions are answered

**How a query is guarded and run.** A `fakeathena` request is guarded as a lake request is and run as a local one is.
1. *Guarded.* `render(req)` writes the text once with every placeholder as a literal (`renderLiteral`, as the `trino` connector does) and gives that text to `assertReadOnly`, `checkGuardedShape(sql, guards, window, source.limits.max_rows)` and `checkGuardrails(sql, guards)`, where `guards` are the source's tables marked `guarded`. Any violation is a `GuardError` with the guard's own sentences. So a guarded table is read by one select, alone, whose where clause begins with its time column compared to the request's two window ends.
2. *Kept to its own tables.* `tableProblem(stripped, own, lake)` refuses a statement that names a lake table the source's manifest does not list (`table <t> is not one of source <id>'s tables`), a `_lake_*` table, `sqlite_*` or `pragma_*` (`this source's queries name only its own tables`). One file holds every source; without this, a query through a free source could read a costly one.
3. *Rendered for the record.* `render` returns `renderSql(req)`: the text with `$name` parameters. That is the text `query.issued` records, with the bound values beside it, as for a `sql` source.
4. *Run.* `run(req)` repeats 1 and 2, checks the file is a lake, prices the request, refuses it when `req.budget` is below the price (`the budget of <b> USD is below the cost of this query (<c> USD); not run`), and hands it to `LocalQueryHost` with the spec `{ kind: "fakeathena", path, tables, pricing }`. The child opens the file read-only, runs the statement with `runOnDatabase`, and answers with the rows and the cost.
5. *Kept.* The raw bytes are `{"columns": [...], "rows": [...], "stats": { "bytes_scanned": n, "billed_bytes": n, "partitions": n, "usd": n }}`. `rowsOfSqlRaw` reads the columns and rows back and ignores `stats`, so `rowsOfBlob` and the workbench's reuse and revalidation work as for a `sql` result, and the bytes scanned are in the stored result of every query, under its hash.
The lake speaks SQLite's SQL. A statement written for another dialect fails as any bad statement does (`the source refused the query: …`); no text is translated.

**How a query is priced.** `scanOf` is a pure function of the stripped statement, the request's window, the lake's table and partition lists and the pricing.
- *Tables.* Every lake table the statement names (`tablePattern` over `stripForAnalysis`).
- *Partitions.* With both window ends set, the days from `window.from.slice(0, 10)` to the day of the last millisecond before `window.to`, both included; with an end open, every partition. A table with no `dt` is always its one partition.
- *Columns.* Of the table's columns (`_lake_tables.columns`), those the stripped statement names as whole words; `select *` (the guard's `SELECT_STAR`) counts them all; at least one.
- *Bytes.* For each table, `Math.ceil(partition bytes * named columns / all columns)`; `bytes_scanned` is the sum, `billed_bytes` is `Math.max(bytes_scanned, MIN_BILLED_BYTES)`.
- *Dollars.* `usd = Math.round(billed_bytes * per_tb / TB * 1e6) / 1e6`, with `per_tb` the source's `cost.per_tb` or `FAKEATHENA_USD_PER_TB`. A source with `cost.per_lookup` costs that amount for every query, whatever it scans.
`estimateRequest(req)` is `{ ...req, text: "EXPLAIN (TYPE IO, FORMAT JSON) " + text, max_rows: 2, budget: null }`, as the `trino` connector's is; the guard already allows exactly that explain. `run` of such a request executes nothing: it answers one row, columns `bytes_scanned`, `billed_bytes`, `partitions`, `usd`, with `cost: null`. `readEstimate` reads `{ amount: usd, unit: "USD" }` from it. So an estimate is a query the runner issues and records (`purpose: "estimate"`), a narrower window is priced lower before anything runs, and the price a result reports is the price that was estimated. A per-lookup source needs no estimate query: `estimate(req)` gives `{ amount: per_lookup, unit: "USD" }` and `estimateRequest` is null, as the `http` connector prices a request.

**How budgets, ceilings and approvals behave.** Nothing new: a `fakeathena` source with `weight` above zero is costly. In pivot's `runLogged` the charge is the larger of the weight and the estimate, held to `budgets.USD` less what `spent` says. In the workbench an agent's costly query becomes a `costly_query` proposal with the estimate, a plan step on a costly pivot is listed costly and waits for the budget the person gives it at the plan gate, and a budget below the estimate runs nothing. Tasks 11 and 17 hold each of these with a test.

**How a storyline is written without code.** A storyline is a YAML manifest (`kind: storyline`): `params`, a `cast` drawn from the company (`pick: user | host | site | external_address | external_domain | access_point | new_device | sha256`, with `where`, `count`, `distinct_from`), `events` (a table, a time as an offset from the storyline's start, an optional `repeat`, and a row of templates such as `{{victim.account}}`), a `task` (what the analyst is asked: title, question, starting values, window, the type wanted, a free `seed_route`) and a `truth` (summary, entities, expected findings with likelihood and confidence). The generator places the storyline (`start: { earliest, latest, hour }`, fractions of the period), draws the cast from `stream(seed, "story:<id>:<name>")`, renders the rows into the tables, and renders the ground truth. A storyline longer than the period is left out and named in the build's report. A storyline names a host by its role in the cast, never by an address.

**How the mess is made and what is declared.** `src/synth/mess.ts` holds seven rules, each a transform of one table's rows of one day and, for four of them, a quality note the build writes into the source's manifest: a logging gap (`proxy`), a duplicated window (`dns`), partial coverage (the last site is missing from `flows`), clock skew (`wifi`, seven minutes fast). Three are not declared, because finding them is the work: a host renamed half-way (`assets` holds the new name), a device with a randomised MAC (a new one each day on `dhcp` and `wifi`), and DNS that is complete for the corporate networks and partial for the guest network. That last one is declared where pivot declares completeness: two inventories (`dns-corp`, complete, with its basis; `dns-guest`, not complete) and a pivot for each. Everything the rules did is in `<synth>/truth/mess.json`.

**Where the ground truth goes.** pivot's build writes `<synth>/truth/<storyline>.json` (a `GroundTruth`) and `<synth>/truth/mess.json`. `synth tasks` makes a case from `task` and writes `<data>/synth-truth/<case>/ground-truth.json`: the truth plus the case's id and the hash of its first entry. `synth answer <case>` checks that hash, takes the case's latest published product and calls `setKnownAnswer` as the person, with the truth's summary and findings. The limits of a known answer (600 characters, 12 findings, 300 characters a claim, the seven likelihood terms of the sample's standard) are checked by pivot when a storyline loads, so no answer is refused later.

**What a seeded task is.** `synth seed-tasks` makes, for each storyline, a case of the loop `synth-seed` (Frame, Plan, Research, Assemble, Checks, Publish, on the scripted model `synth-seed`). The script is written into the root by `synth build` from each storyline's `task` alone: one goal, one sub-goal on the storyline's free `seed_route`, and a product of one finding that says the lookup was run and judges nothing (`roughly even chance`, `low`). The command accepts the plan and approves the product as the person, then sets the known answer from the truth. The product is deliberately not the answer (Ruling): slice 14's Select copies a task's published product into what Propose is told, so a seed that published the truth would hand the answer to a model.

## What can run in parallel

Tasks in one wave touch disjoint files. A wave starts when the one before it is committed.

**Part A, in `<pivot>`:**

| Wave | Tasks |
|---|---|
| A1 | **Task 0** (the connector kind in the catalogue) ∥ **Task 1** (seeded draws, parameters, the company) ∥ **Task 2** (the lake format and the cost model) |
| A2 | **Task 3** (the tables, the noise, the lake writer) ∥ **Task 4** (the `fakeathena` connector) |
| A3 | **Task 5** (the storyline engine and the ground truth) ∥ **Task 6** (the mess) ∥ **Task 7** (the catalogue: thirteen sources, their pivots, field notes on every column) |
| A4 | **Task 8** (the five malicious storylines) ∥ **Task 9** (the four benign look-alikes) |
| A5 | **Task 10** (the build, the script, the public surface) |
| A6 | **Task 11** (acceptance, documents, v0.3.0 and its tag) |

**The hand-over:** the owner pushes pivot's `slice-15-synth` (or its merge) and the tag `v0.3.0`.

**Part B, in `<repo>`:**

| Wave | Tasks |
|---|---|
| B1 | **Task 12** (pivot v0.3.0, workbench 0.15.0, the connector kind where the workbench names kinds) |
| B2 | **Task 13** (`bun run synth`: the command, `build`, `show`, the overlay) |
| B3 | **Task 14** (`synth tasks` and `synth answer`) ∥ **Task 15** (the seed loop and `synth seed-tasks`) |
| B4 | **Task 16** (documents) ∥ **Task 17** (acceptance and boundaries) |

Task 3 creates `src/synth/lake.ts` with the two hooks Tasks 5 and 6 fill (`RowSource`, `DayTransform`); Task 5 owns `src/synth/storyline.ts` and `truth.ts`, Task 6 `src/synth/mess.ts`, Task 7 `synth/catalogue/**`; none of the three edits `lake.ts`. Tasks 8 and 9 each own their own files under `synth/storylines/` and their own test file. Task 4 owns `src/connectors/index.ts`, `rows.ts`, `local-host.ts`, `local-child.ts`, `literals.ts` and the one move out of `trino.ts`; Task 0 owns `src/catalogue/**` and `src/connectors/types.ts`. Task 13 creates `src/cli/synth.ts` with all five forms and one stub module each for `tasks`, `answer` and `seed` under `src/synth/`; Task 14 owns `src/synth/tasks.ts` and `answer.ts`, Task 15 `src/synth/seed.ts`, `seed-script.ts` and the seed loop's overlay files; neither edits `src/cli/synth.ts`. Task 16 owns `README.md`, `docs/**` and `tests/repo/readme.test.ts`; Task 17 owns `tests/synth/acceptance.test.ts`, `tests/helpers/synth-script.ts` and the boundary tests.

## File Structure

**pivot (`<pivot>`):**

| File | Responsibility | Task |
|---|---|---|
| `src/catalogue/manifests.ts`, `registry.ts`, `src/connectors/types.ts` | `fakeathena` as a connector kind; `cost.per_tb`, `cost.per_lookup`; the registry's rules for such a source | 0 |
| `src/synth/rng.ts`, `params.ts`, `company.ts` (new) | `stream`; `SynthParams`, limits, `projectedBytes`; the company model | 1 |
| `src/synth/format.ts`, `src/connectors/fakeathena-cost.ts` (new) | The lake's meta tables, written and read; `scanOf`, `priceOf`, `tableProblem` | 2 |
| `src/synth/tables.ts`, `noise.ts`, `lake.ts` (new) | `TABLES`; the background rows; `buildLake`, the digest | 3 |
| `src/connectors/fakeathena.ts`, `literals.ts` (new), `index.ts`, `rows.ts`, `local-host.ts`, `local-child.ts`, `trino.ts` (one function moves out) | The connector | 4 |
| `src/synth/storyline.ts`, `truth.ts` (new) | The storyline schema, the cast, the events, `GroundTruth` | 5 |
| `src/synth/mess.ts` (new) | The seven rules, their notes, `mess.json` | 6 |
| `synth/catalogue/**` (new) | `types.yaml`, `sources/*.yaml`, `pivots.yaml`, `inventories/*.yaml`, `playbooks/*.yaml` | 7 |
| `synth/storylines/*.yaml` (new) | Five malicious storylines; four benign | 8, 9 |
| `src/synth/build.ts`, `paths.ts` (new), `scripts/make-synth.ts` (new), `src/index.ts`, `package.json` | `buildSynth`; `bun run synth`; the exports | 10 |
| `tests/synth/acceptance.test.ts` (new), `tests/repo/*.test.ts`, `README.md`, `docs/design.md`, `docs/security-notes.md`, `src/version.ts`, `package.json` | End to end; the golden digest; no network; documents; v0.3.0 | 11 |

**workbench (`<repo>`):**

| File | Responsibility | Task |
|---|---|---|
| `package.json`, `bun.lock`, `src/core/casefile.ts`, `src/modules/revalidate.ts`, `src/agents/tools/builder.ts`, `tests/repo/pivot-seam.test.ts`, `README.md` (one line) | The pin; the version; `fakeathena` where the workbench names connector kinds | 12 |
| `src/cli/synth.ts`, `src/synth/build.ts`, `src/synth/setup.ts` (new), stubs `src/synth/tasks.ts`, `answer.ts`, `seed.ts`, `scripts/new-root.ts`, `synth/root/case-types.yaml` (new), `package.json` (the script) | `bun run synth`; `build`; `show`; the generic half; the configuration; `synth.json` | 13 |
| `src/synth/tasks.ts`, `src/synth/answer.ts` | One case per storyline; `ground-truth.json`; the known answer | 14 |
| `src/synth/seed.ts`, `src/synth/seed-script.ts` (new), `synth/root/loops/synth-seed.yaml`, `synth/root/context/synth-seed-profile.yaml` (new) | The seed loop, its generated script, `seed-tasks` | 15 |
| `README.md`, `docs/synthetic-company.md` (new), `docs/security-notes.md`, `tests/repo/readme.test.ts` | Documents | 16 |
| `tests/synth/acceptance.test.ts`, `tests/helpers/synth-script.ts` (new), `tests/server/boundaries.test.ts`, `tests/repo/hygiene.test.ts` (one test added) | An investigation on the fake lake on the scripted model; costs and budgets; blindness; boundaries | 17 |

## Review Focus

Inputs the design implies and a person will meet, most likely first. Each has its test in the task named.

1. **A person runs `synth tasks` or `synth seed-tasks` with no `--config`, or with the real configuration.** Refused before the workbench is opened: `this configuration is not a synthetic setup's`. *Task 13 Step 5; Task 14 Step 1.*
2. **`synth build` on a folder that holds something, or on the data folder, a root or the lake folder of the configuration in use.** Refused, nothing written. *Task 13 Step 1.*
3. **A query through a free source that names a costly source's table, or `_lake_partitions`, or `sqlite_master`.** Refused by the connector with its sentence, before the file is read. *Task 4 Step 1.*
4. **A `fakeathena` source pointed at a database that is not a synthetic lake** (the sample's flows file, any SQLite file). Refused: `<location> is not a synthetic lake`. *Task 4 Step 1.*
5. **A budget just below the estimate, and the same query over a narrower window.** The first runs nothing and says what it would cost; the second costs less and runs. *Task 4 Step 3; Task 11 Step 2; Task 17 Step 3.*
6. **An agent writes a query in another dialect** (`approx_distinct`, `date_trunc`). It fails as a refused statement, recorded as `query.failed`, and the run goes on. *Task 4 Step 5.*
7. **Parameters at the edges:** three days, eight users, a period too short for a storyline, a size over 2 GB. The first two build; the storyline is left out and named; the last is refused before a file is made. *Task 1 Step 1; Task 5 Step 5; Task 10 Step 1.*
8. **The same seed twice, and a different seed.** The same bytes; a different digest. *Task 3 Step 5; Task 11 Step 1.*
9. **`synth answer` on a case that is not the one the truth was written for** (the data folder was replaced, the ids repeat). Refused by the origin hash. *Task 14 Step 3.*
10. **`synth tasks` run twice.** The second makes no second case for a storyline that has one. *Task 14 Step 1.*
11. **A seed run that stops somewhere other than its two gates** (a check blocks, a model turn is missing). The command says which case and why, exits 1, and sets no answer. *Task 15 Step 5.*
12. **A storyline whose truth breaks a known answer's limits, or whose seed route is costly.** Refused when the storyline loads, with the sentence. *Task 5 Step 1; Tasks 8 and 9.*
13. **A manifest of today that names no `fakeathena` source.** It loads to the same hash and fields; `cost` has no `per_tb` or `per_lookup`. *Task 0 Step 1.*

---

## Part A: pivot v0.3.0

### Task 0: The connector kind in the catalogue

**Repository:** pivot (`<pivot>`). Wave A1.

**Files:**
- Modify: `src/catalogue/manifests.ts`, `src/catalogue/registry.ts`, `src/connectors/types.ts`
- Test: `tests/catalogue/fakeathena-manifest.test.ts` (new), `tests/catalogue/trusted-only.test.ts`, `tests/catalogue/registry.test.ts`; and any test that lists the connector kinds

**Interfaces (Produces):**
```ts
// src/catalogue/manifests.ts
SourceManifest["connector"]: "sql" | "files" | "http" | "trino" | "fakeathena";   // SOURCE_SCHEMA's enum gains it
SourceManifest["cost"]: { weight: number; unit: string; per_tb?: number; per_lookup?: number };   // each present only when the manifest states it
// SOURCE_SCHEMA.cost gains: per_tb: { type: "number", minimum: 0 }, per_lookup: { type: "number", minimum: 0 }
// src/connectors/types.ts
Connector["kind"]: "sql" | "files" | "http" | "trino" | "fakeathena";
```
The registry's rules for a source, each a `ManifestError` with its sentence:
- from a root that is not trusted: `a fakeathena source is accepted only from a trusted root` (the same line that refuses `http` and `trino`);
- its cost unit is not `USD`: `a fakeathena source's cost unit must be USD (the lake is billed in dollars), not <unit>`;
- its `location` is absolute, or holds `://`: `a fakeathena source's location is a path to a lake file, relative to the manifest`. It may lead outside the root (Ruling): the lake is data the root reads, as a `trino` location is; the connector opens it only when it says it is a synthetic lake;
- it states both `per_tb` and `per_lookup`: `a source is billed per terabyte scanned or per lookup, not both`;
- a source of another connector states `per_tb` or `per_lookup`: `only a fakeathena source states per_tb or per_lookup`;
- it lists no table: `a fakeathena source lists its tables`.
The existing rule `guarded table <t> needs a time_column` applies as it does. `toSource` copies `per_tb` and `per_lookup` only when stated.

- [ ] **Step 1: failing tests** (`tests/catalogue/fakeathena-manifest.test.ts`).

```ts
test("a fakeathena source loads from a trusted root, with its tables, its USD cost and per_tb", () => {});
test("a fakeathena source with per_lookup loads, and its cost carries per_lookup and no per_tb", () => {});
test("each refusal is said in its sentence", () => {
  // an untrusted root · unit rows · an absolute location · a location with :// · per_tb with per_lookup · per_tb on a sql source · no tables
});
test("a location that leads outside the root is accepted for fakeathena and still refused for sql", () => {});
test("a source that states neither field has a cost of exactly { weight, unit }: the sample's sources are what they were", () => {
  // load pivot's sample root; for every source Object.keys(cost) is ["weight", "unit"]; every manifest hash equals the hash of its file's bytes as before
});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS**, with `tests/catalogue/**` green. **Step 5:** `timeout 600 bun test && timeout 300 bun run typecheck` (the typecheck will name every exhaustive use of the kind; `src/connectors/index.ts` and `rows.ts` are Task 4's: their `Partial` map and `default:` already take an unknown kind). **Step 6: commit** `feat(catalogue): fakeathena is a connector kind, billed in USD per terabyte or per lookup`.

---

### Task 1: Seeded draws, parameters, the company

**Repository:** pivot (`<pivot>`). Wave A1.

**Files:**
- Create: `src/synth/rng.ts`, `src/synth/params.ts`, `src/synth/company.ts`
- Test: `tests/synth/rng.test.ts`, `tests/synth/params.test.ts`, `tests/synth/company.test.ts` (new)

**Interfaces (Produces):**
```ts
// src/synth/rng.ts
export interface Rng { next(): number; int(lo: number, hi: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean; shuffle<T>(xs: readonly T[]): T[]; hex(n: number): string }
/** A generator of its own for `name`: mulberry32 seeded with the first four bytes of sha256(`${seed}:${name}`). Adding a stream never moves another. */
export function stream(seed: number, name: string): Rng;
// src/synth/params.ts
export interface SynthParams { seed: number; start: string; days: number; users: number; hosts: number; sites: number; volume: number; scale: number }
export const DEFAULT_PARAMS: SynthParams; export const TINY_PARAMS: SynthParams;      // the exact values of the Global Constraints
export const PARAM_LIMITS = { days: [3, 90], users: [8, 2000], hosts: [8, 3000], sites: [2, 8], volume: [0.01, 4], scale: [1, 1000000] } as const;
export const MAX_LAKE_BYTES = 2_000_000_000;
/** The parameters with defaults filled, or the refusal: a seed that is not a safe integer of zero or more, a start that is not a real YYYY-MM-DD, a value outside its limits, an unknown key. */
export function checkParams(given: Partial<SynthParams>): SynthParams | string;
/** UTC milliseconds of the start of day `n` (0-based), and the YYYY-MM-DD of a time. */
export function dayStart(p: SynthParams, n: number): number; export function dtOf(ms: number): string; export function iso(ms: number): string;
// src/synth/company.ts
export interface Site { id: string; index: number; corp_net: number; guest_net: number; access_points: string[] }
export interface User { account: string; name: string; mailbox: string; role: "staff" | "admin" | "service"; site: string; groups: string[]; host: string | null }
export interface Host { name: string; ip: string; mac: string; site: string; role: "workstation" | "server"; owner: string; os: string; vendor: string; wireless: boolean }
export interface External { address: string; domain: string; kind: "saas" | "cdn" | "storage" | "mail" | "unknown"; verdict: "benign" | "suspicious" | "unknown" }
export interface Company { params: SynthParams; domain: string; sites: Site[]; users: User[]; hosts: Host[]; externals: External[]; groups: string[]; vendors: string[] }
export function makeCompany(p: SynthParams): Company;
/** An address of the company's own: `[10, site.index + 1, net, n].join(".")`. The only place a 10.x address is made. */
export function internalAddress(site: Site, net: "corp" | "guest", n: number): string;
```
The company, exactly: sites are `site-a`, `site-b`, …; the domain is `corp.example`; an account is `<initial>.<surname>` (matching `[a-z]\.[a-z]{2,20}`), unique, from fixed lists of invented given names and surnames; a mailbox is `<account>@corp.example`; one user in twenty is `admin`, and there are four `service` accounts (`s.backup`, `s.deploy`, `s.scanner`, `s.mailer`); a workstation is `ws-<4 digits>`, a server `srv-<role><2 digits>` (`srv-db01`, `srv-file01`, `srv-web01`, `srv-bak01`, …), one server in ten hosts, each workstation owned by a user in order; a MAC is `02:` and five bytes drawn (locally administered, so no real vendor's block); vendors are the fixed invented list `["Example Devices", "Sample Networks", "Demo Displays", "Placeholder Systems", "Testline Printers"]`; externals are 120 addresses spread over the three documentation ranges, each with a domain `<word>.<word>.example` or under `example.com`, `example.net`, `example.org`; an access point is `ap-<site letter>-<2 digits>`, three a site. `makeCompany` is a pure function of the parameters.

`projectedBytes(p)` belongs to Task 3 (it needs the tables); Task 1 exports only the limits.

- [ ] **Step 1: failing tests.**

```ts
test("stream gives the same draws for the same seed and name, and other draws for another name or seed", () => {});
test("a stream's first draws are the ones this test holds", () => { /* three literals, so a change of algorithm is seen */ });
test("checkParams fills the defaults and refuses, each with its sentence", () => {
  // days 2 · days 91 · users 7 · sites 9 · volume 0 · scale 0 · seed -1 · seed 1.5 · start "2026-02-30" · an unknown key
});
test("makeCompany is the same for the same parameters, and every name in it is invented", () => {
  // deep-equal twice; every domain ends .example or is under example.com/net/org; every external address is in a documentation range;
  // every internal address starts with the two characters "10" and a dot, checked with startsWith, never a literal quad
});
test("accounts, host names and MACs are unique and match the catalogue's type patterns", () => {});
test("the edges build: 8 users and 8 hosts on 2 sites; 2000 users and 3000 hosts on 8 sites", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): seeded streams, bounded parameters and a company made from them`.

---

### Task 2: The lake format and the cost model

**Repository:** pivot (`<pivot>`). Wave A1.

**Files:**
- Create: `src/synth/format.ts`, `src/connectors/fakeathena-cost.ts`
- Test: `tests/synth/format.test.ts`, `tests/connectors/fakeathena-cost.test.ts` (new)

**Interfaces (Produces):**
```ts
// src/synth/format.ts
export const LAKE_FORMAT = 1; export const LAKE_KIND = "pivot-synthetic-lake";
export const META_TABLES = ["_lake_meta", "_lake_tables", "_lake_partitions"] as const;
export interface LakeTable { name: string; columns: string[]; row_bytes: number; partitioned: boolean }
export interface LakePartition { table: string; dt: string; rows: number; bytes: number }
export interface LakeCatalog { format: 1; params: Record<string, Json>; digest: string; tables: LakeTable[]; partitions: LakePartition[] }
/** Creates the three meta tables in an open database and writes them. Called once, last, by the lake writer (and by a test that makes a lake by hand). */
export function writeLakeCatalog(db: Database, c: Omit<LakeCatalog, "format">): void;
/** The catalog of an open database, or null when it is not a synthetic lake of this format (no `_lake_meta`, another kind, another format, a malformed row). Reads; never writes. */
export function readLakeCatalog(db: Database): LakeCatalog | null;
// src/connectors/fakeathena-cost.ts   (pure: imports only ../guard/sqlguard and types)
export const FAKEATHENA_USD_PER_TB = 5; export const TB = 1_000_000_000_000; export const MIN_BILLED_BYTES = 10_000_000;
export const ESTIMATE_PREFIX = "EXPLAIN (TYPE IO, FORMAT JSON) ";
export interface Pricing { per_tb: number; per_lookup: number | null }
export interface Scan { bytes_scanned: number; billed_bytes: number; partitions: number; usd: number }
export function pricingOf(cost: { per_tb?: number; per_lookup?: number }): Pricing;
/** What the statement would scan and cost. `sql` is the request's text (placeholders left in); pure. */
export function scanOf(sql: string, window: TimeWindow, catalog: Pick<LakeCatalog, "tables" | "partitions">, pricing: Pricing): Scan;
/** Why the statement may not run for a source whose tables are `own`; null when it may. */
export function tableProblem(sql: string, source: string, own: readonly string[], catalog: Pick<LakeCatalog, "tables">): string | null;
/** True when the request's text is this connector's own estimate of another. */
export function isEstimate(text: string): boolean;
```
`scanOf` and the dollars are as "How a query is priced" states, with these details: the statement is read through `stripForAnalysis` (so a table or column named only inside a string literal does not count); a table is named when `tablePattern(name)` matches; a column when `(?<![\w$])<name>(?![\w$])` matches; `*` when the guard's select-star pattern does (copy the pattern's text into this file with a comment naming where it is from: the guard exports none of it, and the guard is not edited); `partitions` is the number of partition rows counted over all named tables; a statement that names no lake table scans nothing and bills the minimum. `tableProblem` gives `table <t> is not one of source <id>'s tables` for a lake table outside `own`, and `this source's queries name only its own tables` for any of `META_TABLES`, `sqlite_\w+` or `pragma_\w+`.

- [ ] **Step 1: failing tests for the format.**

```ts
test("a catalog written is the catalog read", () => {});
test("a database with no _lake_meta, another kind, format 2, or a partition row that is not numbers is not a lake", () => {});
test("readLakeCatalog writes nothing: the file's bytes are the same after it", () => {});
```
- [ ] **Step 2: failing tests for the cost model** (a catalog written as a literal in the test: two partitioned tables of ten columns over five days, one table with no `dt`).

```ts
test("a one-day window scans one partition, and a three-day window three", () => {});
test("a window that ends at midnight does not touch the day that starts there", () => { /* to = day 3 at 00:00:00.000Z touches days up to day 2 */ });
test("an open window end scans every partition", () => {});
test("three of ten columns scan three tenths of the bytes, rounded up; select * scans them all; a column named only in a string literal is not counted", () => {});
test("a table with no dt is one partition whatever the window", () => {});
test("the price is billed bytes times 5 over a terabyte, to a millionth of a dollar, and never below ten megabytes' worth", () => {
  // 1 TB exactly is 5; 123_456_789_012 bytes is 0.617284; 1 byte is billed as 10 MB: 0.00005
});
test("per_tb in the pricing replaces 5; per_lookup is the price whatever is scanned", () => {});
test("tableProblem names a table that is another source's, and refuses the meta tables, sqlite_master and pragma_table_info", () => {});
test("isEstimate is true for the connector's own prefix in any letter case and false for a plain select", () => {});
test("scanOf is pure: the same inputs give the same Scan, and its inputs are not changed", () => {});
```
- [ ] **Step 3: FAIL. Step 4: implement. Step 5: PASS. Step 6:** full run and typecheck. **Step 7: commit** `feat(connectors): the fake lake's catalog and the cost of a scan, as pure code`.

---

### Task 3: The tables, the noise, the lake writer

**Repository:** pivot (`<pivot>`). Wave A2. Consumes Tasks 1 and 2.

**Files:**
- Create: `src/synth/tables.ts`, `src/synth/noise.ts`, `src/synth/lake.ts`
- Test: `tests/synth/tables.test.ts`, `tests/synth/lake.test.ts` (new)

**Interfaces (Produces):**
```ts
// src/synth/tables.ts
export interface ColumnSpec { name: string; sql: "TEXT" | "INTEGER"; width: number }
export interface TableSpec { source: string; name: string; partitioned: boolean; columns: ColumnSpec[]; keys: string[]; per_day: (p: SynthParams) => number }
export const TABLES: readonly TableSpec[];                       // thirteen, in name order
export const tableOf = (name: string): TableSpec;                 // throws for an unknown name
export const rowBytes = (t: TableSpec): number;                   // the sum of its columns' widths
export function projectedBytes(p: SynthParams): number;           // Σ per_day * days * rowBytes * 1.6 over the partitioned tables, plus the others
export type Row = Record<string, string | number | null>;
// src/synth/noise.ts
/** The background rows of one table for one day, in time order. A pure function of its arguments. */
export function noiseRows(table: TableSpec, day: number, company: Company): Row[];
// src/synth/lake.ts
/** Rows a caller adds to the noise (the storylines'). */
export interface RowSource { name: string; rows(table: TableSpec, day: number, company: Company): Row[] }
/** A change to one table's rows of one day, after the noise and the added rows are merged and sorted (the mess). */
export interface DayTransform { name: string; apply(table: TableSpec, day: number, rows: Row[], company: Company): Row[] }
export interface LakeBuild { file: string; digest: string; tables: { name: string; rows: number; bytes: number }[] }
export function buildLake(file: string, company: Company, opts?: { sources?: RowSource[]; transforms?: DayTransform[] }): LakeBuild;
```
The tables and their columns (each event table also has `ts` first and `dt` last; widths are the implementer's, fixed in `TABLES`):

| Table | Columns | Keys | Rows a day at volume 1 |
|---|---|---|---|
| `signins` | `user`, `src_ip`, `user_agent`, `mfa` (`passed`, `failed`, `not_required`), `outcome` (`success`, `failure`), `country`, `city`, `app` | `user`, `src_ip` | 6 a user |
| `group_members` (no `dt`) | `group_name`, `user`, `added_ts` | `user`, `group_name` | 2 a user, once |
| `process_start` | `host`, `user`, `process`, `command_line`, `parent`, `sha256`, `pid` | `host`, `user`, `sha256` | 60 a host |
| `dns` | `client_ip`, `query`, `qtype`, `answer`, `network` (`corp`, `guest`), `site` | `client_ip`, `query`, `answer` | 150 a host |
| `proxy` | `client_ip`, `user`, `method`, `url`, `domain`, `status`, `bytes_out`, `bytes_in`, `user_agent` | `client_ip`, `user`, `domain` | 80 a host |
| `flows` | `src_ip`, `dst_ip`, `dst_port`, `proto`, `bytes`, `packets`, `action`, `site` | `src_ip`, `dst_ip` | 120 a host |
| `dhcp_leases` | `mac`, `ip`, `hostname`, `vendor_class`, `lease_end`, `network`, `site` | `mac`, `ip`, `hostname` | 2 a host |
| `wifi_events` | `ip`, `message`, `controller` | `ip` | 6 a wireless host |
| `email` | `sender`, `recipient`, `subject`, `url`, `attachment_name`, `attachment_sha256`, `verdict` (`delivered`, `quarantined`, `blocked`) | `recipient`, `sender`, `attachment_sha256` | 12 a user |
| `cloud_audit` | `principal`, `action`, `resource`, `src_ip`, `user_agent`, `outcome` | `principal`, `src_ip` | 4 a user |
| `vuln_findings` | `host`, `ip`, `cve`, `severity`, `product`, `status` | `host`, `ip` | 3 a host, on every seventh day |
| `assets` (no `dt`) | `host`, `ip`, `mac`, `owner`, `site`, `role`, `os`, `vendor` | `host`, `ip`, `mac`, `owner` | one a host, once |
| `reputation` (no `dt`) | `indicator`, `kind` (`address`, `domain`, `hash`), `verdict` (`benign`, `suspicious`, `malicious`, `unknown`), `first_seen`, `feed` | `indicator` | one an external address and domain, once |

`per_day` is `Math.max(1, Math.round(count * volume))`. The noise is plausible and dull: staff sign in from their site's addresses in working hours with MFA; workstations resolve and browse the externals by a fixed popularity; servers talk to each other; every corporate host is in `assets` and takes leases; a WiFi connection message reads `<hostname> <last two MAC bytes> connected to <access point>. Connection Info: channel <n>` and a disconnection `client <last two MAC bytes> disconnected`; `cve` values are `CVE-2099-<4 digits>` (a year no real one has). Each table's rows of a day come from `stream(seed, "noise:<table>:<day>")`.

`buildLake`: refuses a file that exists (`<file> already exists`); for each table in `TABLES` order creates it, and for each day merges `noiseRows`, each source's rows and applies each transform in order, sorts by `ts` then by the row's canonical JSON, inserts in one transaction, and records the partition; creates the indexes; writes the catalog with `writeLakeCatalog`; `VACUUM`s; closes. `dt` is always computed from `ts` here, last, so no source or transform sets it. The digest is as "The fake lake" states.

- [ ] **Step 1: failing tests for the tables.**

```ts
test("there are thirteen tables, one a source, each event table with ts first and dt last", () => {});
test("projectedBytes of the default parameters is under MAX_LAKE_BYTES, and of 3000 hosts for 90 days at volume 4 is over", () => {});
```
- [ ] **Step 2: FAIL, implement `tables.ts`, PASS.**
- [ ] **Step 3: failing tests for the noise and the writer** (`TINY_PARAMS`, built once in `beforeAll`).

```ts
test("the lake has every table, the three meta tables, and an index on dt and on each key", () => {});
test("_lake_partitions holds, for every table and day, the rows that are there and rows * row_bytes * scale", () => {});
test("every ts is inside the period and every dt is the day of its ts", () => {});
test("every address in the lake is the company's or an external's; every domain is a reserved example name", () => {});
test("a row a RowSource adds is in the table, in time order, and counted in its partition", () => {});
test("a DayTransform that drops a table's rows of one day leaves that partition with zero rows and zero bytes", () => {});
test("buildLake refuses a file that exists", () => {});
```
- [ ] **Step 4: FAIL, implement, PASS.**
- [ ] **Step 5: failing tests for determinism.**

```ts
test("two builds of the same parameters are the same file, byte for byte, and have the same digest", () => {});
test("another seed gives another digest; another scale gives the same rows and other partition bytes", () => {});
test("no file under src/synth names Math.random, Date.now or a Date made with no argument", () => {});
```
- [ ] **Step 6: FAIL, fix, PASS. Step 7:** full run and typecheck. **Step 8: commit** `feat(synth): thirteen tables of background noise in one deterministic lake file`.

---

### Task 4: The `fakeathena` connector

**Repository:** pivot (`<pivot>`). Wave A2. Consumes Tasks 0 and 2.

**Files:**
- Create: `src/connectors/fakeathena.ts`, `src/connectors/literals.ts`
- Modify: `src/connectors/index.ts`, `src/connectors/rows.ts`, `src/connectors/local-host.ts`, `src/connectors/local-child.ts`, `src/connectors/trino.ts` (`renderLiteral` moves out; it re-exports it)
- Test: `tests/connectors/connector-fakeathena.test.ts` (new), `tests/connectors/rows.test.ts`, `tests/connectors/custody.test.ts`

**Interfaces (Produces):**
```ts
// src/connectors/fakeathena.ts
export class FakeAthenaConnector implements Connector {
  readonly kind = "fakeathena";
  constructor(source: SourceManifest, ctx: ConnectorContext);
  render(req: QueryRequest): string;                       // guards the literal rendering; returns renderSql(req)
  estimate(req: QueryRequest): Promise<Cost | null>;        // per_lookup: its price; else null. Never opens the file.
  estimateRequest(req: QueryRequest): QueryRequest | null;  // per_lookup: null; else the EXPLAIN of the same text, max_rows 2, budget null
  readEstimate(out: QueryOutcome): Cost | null;             // { amount: usd, unit: "USD" } from the one row; null for anything else
  run(req: QueryRequest): Promise<QueryOutcome>;
  close(): void;
}
/** The stats a fakeathena result's raw bytes carry; null when they carry none. Pure. */
export function statsOfRaw(bytes: Uint8Array): Scan | null;
// src/connectors/local-host.ts
LocalSpec gains: { kind: "fakeathena"; path: string; scan: Scan; cost: Cost }
// src/connectors/index.ts: FACTORIES gains fakeathena. src/connectors/rows.ts: case "fakeathena" reads as "sql" does.
// src/connectors/literals.ts: renderLiteral, moved from trino.ts unchanged; trino.ts has `export { renderLiteral } from "./literals"`, so its importers and its tests are as they were.
```
The connector, as "How a query is guarded and run" states. In detail:
- The lake file is `resolve(source.dir, source.location)`. Missing: `lake file not found: <location>`. It is opened on this thread, read-only, once, only to read its catalog (`readLakeCatalog`); null is `<location> is not a synthetic lake`. A source table the catalog does not hold is `table <t> is not in the lake`. The handle is closed by `close()`.
- `render` and `run` first take the estimate prefix off a request that has it (`isEstimate`), guard the rest with the prefix put back (so the guard sees the explain it allows), and check `tableProblem` on the rest.
- `run` of an estimate: no child, no statement; one row `[bytes_scanned, billed_bytes, partitions, usd]`, columns of those names, `coverage: { kind: "full" }`, `cost: null`, raw from `sqlRaw`.
- `run` of a statement: `scan = scanOf(...)`, `cost = { amount: scan.usd, unit: "USD" }`; a `req.budget` below `cost.amount` throws the `ConnectorError` of the hard questions; else `LocalQueryHost.query(req)` with the spec. The child (`local-child.ts`) opens the file read-only, runs `runOnDatabase`, and writes raw as `{ columns, rows, stats: scan }` with `cost`. A timeout is partial coverage as for `sql`, with `cost` still the scan's (the lake bills what it scanned).
- Row limit, time limit, placeholder and binding behaviour are `runOnDatabase`'s, unchanged.
- The file imports nothing that can reach a network: not `./http` or `./trino` (which is why `renderLiteral` moves to `./literals`), nor `parseBase`, `readCapped`, `refuseOwnServer` or `loadCredential` of `./shared`. A source's `credential` and `user` are ignored.

The tests make a lake by hand (a few tables and rows with `bun:sqlite`, then `writeLakeCatalog`), so this task does not wait for Task 3.

- [ ] **Step 1: failing tests for what is refused.**

```ts
test("a select on a guarded table without the window shape is refused in the guard's own sentences, the ones the trino connector gives for the same text", () => {});
test("a write, two statements, an attach and a pragma are refused by assertReadOnly", () => {});
test("a statement that names another source's table, _lake_partitions, sqlite_master or pragma_table_info is refused and the file is not queried", () => {});
test("a location that is not there, a SQLite file that is not a lake, and a manifest table the lake lacks are each refused with their sentence", () => {});
```
- [ ] **Step 2: FAIL, implement, PASS.**
- [ ] **Step 3: failing tests for rows and cost.**

```ts
test("run binds values instead of pasting them, and returns the rows the window holds", () => {});
test("a result's cost is scanOf's price for the statement and window, in USD", () => {});
test("the raw bytes hold the columns, the rows and the stats; rowsOfBlob reads the rows back; statsOfRaw reads the stats", () => {});
test("a one-day window costs less than a three-day window of the same statement, and naming fewer columns costs less", () => {});
test("estimateRequest's request renders, passes the guard, runs without executing the statement and readEstimate gives the price run then reports", () => {
  // a statement that would fail in SQLite (a function that does not exist) still gets its estimate: nothing was executed
});
test("a budget below the price runs nothing and says the price; a budget of exactly the price runs", () => {});
test("a per_lookup source costs per_lookup for every query, gives that as its estimate with no estimate request, and never opens the file to price", () => {});
test("max_rows stops the result with partial coverage, and a statement past its time limit comes back partial, as for a sql source", () => {});
```
- [ ] **Step 4: FAIL, implement, PASS.**
- [ ] **Step 5: failing tests for the edges.**

```ts
test("a statement in another dialect (approx_distinct) is a ConnectorError 'the source refused the query', not a crash", () => {});
test("the pool gives one connector a source and closes its handle; a closed connector opens again on the next run", () => {});
test("the connector and the cost model import nothing that reaches a network, and a run calls fetch zero times", () => {});
test("the file's bytes are the same after a hundred queries", () => {});
```
- [ ] **Step 6: FAIL, implement, PASS. Step 7:** full run and typecheck, with `tests/connectors/connector-sqlite.test.ts`, `connector-files.test.ts` and `tests/guard/sqlguard.test.ts` unchanged and green. **Step 8: commit** `feat(connectors): fakeathena runs guarded SQL over a synthetic lake and bills the scan`.

---

### Task 5: The storyline engine and the ground truth

**Repository:** pivot (`<pivot>`). Wave A3. Consumes Tasks 1 and 3.

**Files:**
- Create: `src/synth/storyline.ts`, `src/synth/truth.ts`
- Test: `tests/synth/storyline.test.ts`, `tests/synth/truth.test.ts` (new), `tests/synth/fixtures/*.yaml` (two small storylines for the tests)

**Interfaces (Produces):**
```ts
// src/synth/truth.ts
export const GROUND_TRUTH_FORMAT = 1;
export const LIKELIHOOD_TERMS = ["almost no chance", "very unlikely", "unlikely", "roughly even chance", "likely", "very likely", "almost certain"] as const;
export const TRUTH_LIMITS = { summary: 600, findings: 12, claim: 300 } as const;
export interface TruthFinding { claim: string; likelihood: (typeof LIKELIHOOD_TERMS)[number]; confidence: "low" | "moderate" | "high" }
export interface PublicTask { storyline: string; case_type: string; title: string; question: string; starting: Observable[]; window: TimeWindow; want: string; seed_route: string[] }
export interface GroundTruth {
  format: 1; storyline: string; title: string; malicious: boolean; seed: number; task: PublicTask;
  summary: string; entities: { role: string; type: string; value: string }[]; findings: TruthFinding[];
  events: { table: string; rows: number; first: string; last: string }[];
}
export function readGroundTruth(bytes: Uint8Array): GroundTruth | null;     // null for anything that is not one
// src/synth/storyline.ts
export interface Storyline { id: string; title: string; malicious: boolean; case_type: string; span_days: number; /* and the parsed params, cast, events, task and truth */ }
export class StorylineError extends Error {}
/** Parses and checks one manifest; throws StorylineError naming the file's id and what is wrong. */
export function parseStoryline(text: string): Storyline;
export function loadStorylines(dir: string): Storyline[];                   // every *.yaml of the folder, by id with `<`; two with one id is an error
export interface Placed { storyline: Storyline; truth: GroundTruth; rows: Map<string, Row[]> }
/** Places each storyline, draws its cast and renders its rows and its truth. One longer than the period is in `left_out`. */
export function placeStorylines(list: Storyline[], company: Company): { placed: Placed[]; left_out: { id: string; why: string }[]; source: RowSource };
```
The manifest (`kind: storyline`), every key:
```yaml
kind: storyline
id: example-story                 # ^[a-z][a-z0-9-]{1,40}$
title: One line a person reads
malicious: true
case_type: suspicious-signin      # ^[a-z0-9][a-z0-9-]{0,63}$
span_days: 2                      # the days from its start to its last event, rounded up
start: { earliest: 0.2, latest: 0.6, hour: 2 }   # fractions of the period; the day is drawn between them so that the span fits
params: { attempts: 40 }          # numbers and strings, read as {{params.attempts}}
cast:
  attacker: { pick: external_address, where: { verdict: unknown } }
  victim: { pick: user, where: { role: staff } }
  others: { pick: user, count: "{{params.attempts}}", distinct_from: [victim] }
events:
  - table: signins
    at: "+00:10:00"               # an offset from the start: "+HH:MM:SS" or "+Nd HH:MM:SS"
    repeat: { over: others, every_s: 20, jitter_s: 5 }   # or { count: N, every_s, jitter_s }; `each` is the member
    row: { user: "{{each.account}}", src_ip: "{{attacker.address}}", outcome: failure, mfa: not_required, user_agent: "example-client/1.0", country: ZZ, city: "", app: mail }
task:
  title: Sign-ins from {{attacker.address}}
  question: Who signed in from {{attacker.address}}, and did any attempt succeed?
  starting: [{ type: address, value: "{{attacker.address}}" }]
  window: { before_days: 1, after_days: 1 }     # whole days around the storyline's own first and last event
  want: account
  seed_route: [address_to_asset]
truth:
  summary: "{{attacker.address}} tried {{params.attempts}} accounts and got into {{victim.account}}."
  entities: [{ role: attacker, type: address, value: "{{attacker.address}}" }, { role: victim, type: account, value: "{{victim.account}}" }]
  findings:
    - { claim: "{{attacker.address}} made failed sign-ins to many accounts in a few minutes", likelihood: almost certain, confidence: high }
```
The pools and what a member offers a template: `user` (`account`, `mailbox`, `name`, `site`, `host`, `ip`: its workstation's), `host` (`name`, `ip`, `mac`, `site`, `owner`, `os`, `vendor`; `where: { role }`), `site` (`id`), `external_address` and `external_domain` (`address`, `domain`; `where: { kind, verdict }`), `access_point` (`name`, `site`), `new_device` (a device the company's `assets` does not hold: `name`, `ip` on a guest network, `mac`, `vendor`, `site`; `where: { vendor, random_mac }`), `sha256` (`value`, drawn). A column the row does not give takes the table's noise value for the row's subject when it has one (`site`, `network`), else the empty string or zero. A column the table does not have is an error.

Checked when a storyline loads, each a `StorylineError` with its sentence: an unknown key; an unknown table, column, pool or template name; `count` that is not a number once rendered; a `repeat` with neither `over` nor `count`; `span_days` under 1 or an event past it; a summary over 600 characters once rendered at its longest, more than 12 findings, a claim over 300; a likelihood that is not one of the seven terms; a confidence that is not `low`, `moderate` or `high`; no starting value; a question that does not hold its first starting value's template; an empty `seed_route`. (Whether the seed route is a free pivot of the catalogue is Tasks 8 and 9's test: this file does not read the catalogue.)

`placeStorylines`: the cast is drawn from `stream(seed, "story:<id>:<name>")`, the start day from `stream(seed, "story:<id>:start")`; two storylines never share a cast member drawn with `pick` (a later one draws again). `truth.events` counts the rows written. `source.rows(table, day, company)` gives the placed rows of that table and day.

- [ ] **Step 1: failing tests for the manifest.**

```ts
test("a storyline parses to its id, title, case type and span", () => {});
test("each mistake is refused with its sentence", () => { /* every line of the list above */ });
test("loadStorylines gives the folder's storylines by id, and refuses two with one id", () => {});
```
- [ ] **Step 2: FAIL, implement, PASS.**
- [ ] **Step 3: failing tests for placing** (`TINY_PARAMS`, the two fixture storylines).

```ts
test("the cast is the same for the same seed and another for another seed", () => {});
test("the rows are in the lake built with the storyline's source, at the times the offsets say, with dt of their ts", () => {});
test("a repeat over a cast list writes one row a member, every_s apart within the jitter", () => {});
test("the truth is rendered: no {{ is left in it, its task window holds every event, and its events count the rows", () => {});
test("the truth round-trips through readGroundTruth, and a truth with a thirteenth finding or an unknown term is not one", () => {});
```
- [ ] **Step 4: FAIL, implement, PASS.**
- [ ] **Step 5: failing tests for the edges.**

```ts
test("a storyline of three days in a period of three days is placed at day 0; one of four days is left out and named", () => {});
test("two storylines that pick a user never get the same one", () => {});
test("a new_device is in no row of assets and its address is on a guest network", () => {});
test("the rows of a storyline are not in the lake built without its source: the lake's digest differs by exactly those rows", () => {});
```
- [ ] **Step 6: FAIL, implement, PASS. Step 7:** full run and typecheck. **Step 8: commit** `feat(synth): storylines are manifests placed into the noise, each with its ground truth`.

---

### Task 6: The mess

**Repository:** pivot (`<pivot>`). Wave A3. Consumes Tasks 1 and 3.

**Files:**
- Create: `src/synth/mess.ts`
- Test: `tests/synth/mess.test.ts` (new)

**Interfaces (Produces):**
```ts
export interface MessNote { source: string; id: string; text: string; from: string | null; to: string | null }
export interface MessRecord { rule: string; declared: boolean; table: string; detail: Record<string, Json> }
export interface Mess { transforms: DayTransform[]; notes: MessNote[]; record: MessRecord[] }
/** The seven rules for this company. A pure function of it. */
export function makeMess(company: Company): Mess;
```
The rules, each drawing from `stream(seed, "mess:<rule>")`:

| Rule | Table | What it does | Declared |
|---|---|---|---|
| `gap` | `proxy` | no rows for six hours of one day in the middle third of the period | note `proxy-gap`, with `from` and `to` |
| `duplicate` | `dns` | every row of a four-hour window of one day is written twice | note `dns-duplicates`, with `from` and `to` |
| `coverage` | `flows` | no row whose `site` is the last site | note `flows-site-coverage`, no times |
| `skew` | `wifi_events` | every `ts` is seven minutes later | note `wifi-clock-skew`, no times |
| `rename` | all with `host` or `hostname`, but `assets` | one workstation has its old name before the middle day and its new one from it; `assets` holds the new one | not declared |
| `random_mac` | `dhcp_leases`, `wifi_events` | one wireless workstation shows a new locally administered MAC each day | not declared |
| `dns_guest` | `dns` | of the rows whose `network` is `guest`, three in five are dropped | declared by the catalogue's inventories (Task 7), not by a note |

A note's text says what a reader needs and no more (`No proxy log was kept between the two times: an empty answer there is a gap, not an absence.`). `record` holds what each rule did, for `mess.json`: the window, the host and its two names, the device and its MACs, the counts.

- [ ] **Step 1: failing tests** (`TINY_PARAMS`; one lake built with the transforms and one without, once).

```ts
test("the proxy gap holds no row and the note's from and to are its ends", () => {});
test("the dns window holds each row twice and nothing outside it is doubled", () => {});
test("flows has no row of the last site, and every other table has rows of it", () => {});
test("every wifi ts is seven minutes after the same row's ts in the lake without the mess", () => {});
test("the renamed host has one name before the middle day and the other from it, and assets holds only the new one", () => {});
test("the device with the randomised MAC has as many MACs in dhcp_leases as days it was seen, each locally administered", () => {});
test("guest dns rows are about two in five of what they were, and corp rows are all there", () => { /* bounds, not an exact count */ });
test("makeMess is the same for the same company; four rules have a note and three have none; the record names all seven", () => {});
test("the partitions' rows and bytes are the rows that are there after the mess", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): seven kinds of real-world mess, four declared as quality notes`.

---

### Task 7: The catalogue

**Repository:** pivot (`<pivot>`). Wave A3. Consumes Tasks 0 and 3.

**Files:**
- Create: `synth/catalogue/types.yaml`, `synth/catalogue/sources/{signins,groups,process,dns,proxy,flows,dhcp,wifi,email,cloud,vulns,assets,reputation}.yaml`, `synth/catalogue/pivots.yaml`, `synth/catalogue/inventories/{assets,dhcp-leases,dns-corp,dns-guest}.yaml`, `synth/catalogue/playbooks/address-triage.yaml`, `synth/catalogue/README.md`
- Test: `tests/synth/catalogue.test.ts` (new)

**Interfaces (Produces):** a module root's worth of manifests, loadable from a trusted root once a lake is at `../../lake.sqlite` from each source file (`<synth>/root/sources/x.yaml` reads `<synth>/lake.sqlite`).
- **Types:** `address`, `domain`, `host`, `account`, `mac`, `hash`, `url`, `access_point`, `vendor` (the nine the design names) and `verdict` (Ruling: the reputation pivots need a type to arrive at). Patterns: `address` and `domain` as pivot's sample has them; `host` `[a-z]{2,6}-[a-z0-9]{2,12}`; `account` `[a-z]\.[a-z]{2,20}`; `mac` `(?:[0-9a-f]{2}:){5}[0-9a-f]{2}`; `hash` `[0-9a-f]{64}`; `url` `https?://[^\s"']{1,2000}`; `access_point` `ap-[a-z]-\d{2}`; `vendor` `[A-Z][A-Za-z0-9 .&-]{1,40}`; `verdict` `(?:benign|suspicious|malicious|unknown)`.
- **Sources:** `connector: fakeathena`, `location: ../../lake.sqlite`, `marking: "TLP:GREEN"`, `where: machine`, `adhoc: true` on the seven costly ones and `false` on the others, `limits: { max_rows: 500, timeout_ms: 20000 }`, the cost of "The fake lake", a `purpose`, two to four `answers`, a `quality` that says the lake speaks SQLite's SQL and what the source lacks, and no `quality_notes` (the build appends the mess's). Each table has `about`, `time_column: ts` and `guarded: true` where it has `ts`, `large_columns` where a column is long (`command_line`, `url`, `user_agent`, `message`, `subject`).
- **Field notes on every column:** every column of every table, `dt` included, has a `meaning` (one line) and a `reveals` (what else its text gives away, or what it is commonly mistaken for; one line, never empty). A typed column has its `type`. `extract` rules where the text holds a typed value that is not the column's own type: `process_start.command_line` (a `url`, a `domain`, an `address`), `proxy.url` (the `domain`), `wifi_events.message` (the `host`, the `access_point`), `dhcp_leases.vendor_class` (the `vendor`), `email.recipient` and `email.sender` (the `account` of a company mailbox), `email.url` (the `domain`), `cloud_audit.resource` (a `domain` when it names a bucket's host), `vuln_findings.product` (the `vendor`).
- **Pivots:** at least thirty, so that every type but `verdict` has a pivot from it and one to it, every source has one, and every storyline can be followed. Every pivot has `title`, `answers`, `empty_means`, `yields`, `needs_window: true` and `times` on an event table. Named ones later tasks rely on: `address_to_asset` and `host_to_asset` (inventory `assets`, `proven-negative`), `address_to_lease` and `mac_to_leases` (inventory `dhcp-leases`), `account_to_groups`, `account_to_assets`, `address_to_wifi`, `host_to_vulns`, `address_to_queries_corp` (inventory `dns-corp`, `proven-negative`, `network = 'corp'`) and `address_to_queries_guest` (inventory `dns-guest`, `not-seen`), `domain_to_clients`, `address_to_signins`, `account_to_signins`, `host_to_processes`, `hash_to_hosts`, `address_to_flows_out`, `address_to_flows_in`, `address_to_proxy`, `account_to_proxy`, `domain_to_proxy_clients`, `account_to_email`, `hash_to_email`, `account_to_cloud`, `address_to_cloud`, `address_to_reputation`, `domain_to_reputation`, `hash_to_reputation`. A pivot on a free source says `weight: 0`; one on a costly source says none (it takes the source's).
- **Inventories:** `assets` (complete; basis: every corporate host is entered before it is given an address), `dhcp-leases` (derived, not complete), `dns-corp` (complete; basis: corporate clients can reach no other resolver), `dns-guest` (not complete: guest clients may use their own resolver).
- **Playbook:** `address-triage`, after the sample's: the asset list, the lease only when the asset list is empty, then the WiFi log.

- [ ] **Step 1: failing tests.**

```ts
test("the catalogue loads from a trusted root over a tiny lake with no problems", () => {
  // copy synth/catalogue to <tmp>/root, build a TINY lake at <tmp>/lake.sqlite, Registry.load: problems is []
});
test("it is refused from a root that is not trusted", () => {});
test("there are thirteen sources, one a table of TABLES, and each manifest lists exactly its table's columns, in order", () => {});
test("every column has a meaning and a reveals, each one line and not empty", () => {});
test("every extract rule compiles and pulls the value it names out of a row of the tiny lake", () => { /* one row a rule */ });
test("every pivot's query passes the connector's render with a value of its from type and a window, and runs on the tiny lake", () => {});
test("every type but verdict has a pivot from it and a pivot to it, and every source has a pivot", () => {});
test("a pivot on a free source is free and one on a costly source is costly; no free pivot reads a costly table", () => {});
test("the two dns inventories are one complete with a basis and one not, and each has its pivot", () => {});
test("no manifest holds an address outside the documentation ranges, a home path or a URL host that is not a reserved example name", () => {});
```
- [ ] **Step 2: FAIL. Step 3: write the manifests. Step 4: PASS. Step 5:** full run and typecheck (the hygiene tests read the new files). **Step 6: commit** `feat(synth): a catalogue over the fake lake, with field notes on every column`.

---

### Task 8: The five malicious storylines

**Repository:** pivot (`<pivot>`). Wave A4. Consumes Tasks 4, 5 and 7.

**Files:**
- Create: `synth/storylines/phish-chain.yaml`, `password-spray.yaml`, `insider-exfil.yaml`, `crypto-miner.yaml`, `cloud-key.yaml`
- Test: `tests/synth/storylines-malicious.test.ts` (new)

**Interfaces (Produces):** five manifests of Task 5's schema, each `malicious: true`, `span_days` at most 3 (so all fit `TINY_PARAMS`).

| Id | Case type | What happens (the rows) | Starts from | Seed route |
|---|---|---|---|---|
| `phish-chain` | `suspicious-process` | an email with a link and an attachment to one user; the attachment's hash runs under an office process on the user's workstation with a script host as its child; the workstation calls one external address every ten minutes; a credential tool's hash runs; sign-ins by the user's account to two servers, and a process on each | the workstation (`host`) | `host_to_asset` |
| `password-spray` | `suspicious-signin` | one external address fails sign-ins to many accounts minutes apart, then succeeds on one with `mfa: not_required`, then that account reads mail from it | the address | `address_to_asset` |
| `insider-exfil` | `large-transfer` | one user's workstation posts large bodies to one storage domain over two evenings, after the user joined a group that reads a file server; flows of the same size | the account | `account_to_groups` |
| `crypto-miner` | `suspicious-process` | a server with an open critical finding starts a process with a pool's address in its command line, resolves the pool's domain and holds one long flow to it; reputation says `malicious` for the domain | the server (`host`) | `host_to_vulns` |
| `cloud-key` | `cloud-activity` | the service account `s.deploy` acts from an external address it never used, lists resources, makes a key and reads a bucket; a commit-like process on a workstation shows the key was typed there days before | the account | `account_to_groups` |

Each truth has a summary and three to six findings whose claims name the cast's values, with terms from the seven and a confidence. Write the claims as a careful analyst would state them, one fact each.

- [ ] **Step 1: failing tests** (one `TINY_PARAMS` build with the five, the mess and the catalogue, in `beforeAll`).

```ts
test("the five load, fit a period of four days and are all placed", () => {});
test("each truth is within a known answer's limits and names only values that are in the lake", () => {});
test("each seed route is one free pivot of the catalogue from the type of the task's first starting value", () => {});
test("each claim's values can be reached: for each storyline, a chain of the catalogue's pivots from the starting value arrives at every entity of its truth", () => {
  // followed with the fakeathena connector, the task's window, and a budget; the chain is written in the test, one a storyline
});
test("phish-chain: the beacon's flows are ten minutes apart, and the attachment's hash is in email and in process_start", () => {});
test("password-spray: exactly one success from the address, after the failures", () => {});
test("insider-exfil: the bytes posted to the storage domain are more than a hundred times the user's daily median", () => {});
test("crypto-miner: the server has the finding before the process starts", () => {});
test("cloud-key: the service account's rows from the new address are all after the key was typed", () => {});
test("nothing in the five files is an address written out that is not a documentation address", () => {});
```
- [ ] **Step 2: FAIL. Step 3: write the manifests. Step 4: PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): five malicious storylines with known answers`.

---

### Task 9: The four benign look-alikes

**Repository:** pivot (`<pivot>`). Wave A4. Consumes Tasks 4, 5 and 7.

**Files:**
- Create: `synth/storylines/smart-tv.yaml`, `it-admin.yaml`, `backup-job.yaml`, `vpn-travel.yaml`
- Test: `tests/synth/storylines-benign.test.ts` (new)

**Interfaces (Produces):** four manifests, each `malicious: false`, `span_days` at most 3. Each looks like a malicious storyline of the same case type until a source says otherwise; its truth says what it is, which source shows it, and that it is very unlikely or almost no chance to be hostile.

| Id | Case type | What happens | What shows it is benign | Starts from | Seed route |
|---|---|---|---|---|---|
| `smart-tv` | `unknown-device` | a `new_device` of an invented display vendor joins a guest network, takes a lease, resolves the vendor's update and streaming domains and sends steady flows to them | its `vendor_class` and its WiFi connection message name the vendor and a host name such as `tv-lounge`; it is in no asset list, and reputation says `benign` for its domains | its address | `address_to_asset` |
| `it-admin` | `suspicious-process` | an `admin` user runs script hosts with encoded-looking command lines on six workstations in an hour | the account is in the administrators group, the commands fetch from the company's own deployment host, and the same hashes ran on the same day a week before in the noise | one of the workstations | `host_to_asset` |
| `backup-job` | `large-transfer` | the server `srv-bak01` sends a very large flow to one storage address every night at the same time | the account is `s.backup`, the times are regular, the destination is the same every night and benign in reputation | the server (`host`) | `host_to_asset` |
| `vpn-travel` | `suspicious-signin` | a user signs in from an external address in another country for three days | MFA passed each time, the user agent is the user's usual one, and the user's workstation is silent on the network those days | the account | `account_to_groups` |

The invented vendor is one of the company's list (`Demo Displays`); no real maker, product or operating system is named.

- [ ] **Step 1: failing tests** (one build, as Task 8's).

```ts
test("the four load, fit a period of four days and are all placed", () => {});
test("each truth is within a known answer's limits, is not malicious, and holds a finding that says so with a term of 'unlikely' or below for the hostile reading", () => {});
test("each seed route is one free pivot of the catalogue from the type of the task's first starting value", () => {});
test("each entity of each truth is reached by a chain of the catalogue's pivots from the starting value", () => {});
test("smart-tv: the device is in no row of assets; its lease and its WiFi message give the vendor and the host name; the extract rules pull both out", () => {});
test("it-admin: the admin is in the administrators group and every hash of the run is also in the noise of an earlier day", () => {});
test("backup-job: the nightly flows start within five minutes of the same time", () => {});
test("vpn-travel: every sign-in from the travel address passed MFA, and the workstation has no flows on those days", () => {});
test("with all nine storylines in one tiny build, no two share a cast member and all nine are placed", () => {
  // skipped until Task 8's files are there: test.skipIf(!existsSync(...)); Task 11 runs it unskipped
});
```
- [ ] **Step 2: FAIL. Step 3: write the manifests. Step 4: PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): four benign look-alikes with known answers`.

---

### Task 10: The build, the script, the public surface

**Repository:** pivot (`<pivot>`). Wave A5. Consumes Tasks 1 to 9.

**Files:**
- Create: `src/synth/build.ts`, `src/synth/paths.ts`, `scripts/make-synth.ts`
- Modify: `src/index.ts`, `package.json` (the script `synth`)
- Test: `tests/synth/build.test.ts`, `tests/cli/make-synth.test.ts` (new), `tests/repo/library.test.ts`

**Interfaces (Produces):**
```ts
// src/synth/paths.ts
export const SYNTH_CATALOGUE: string;    // <package>/synth/catalogue, from import.meta.dir
export const SYNTH_STORYLINES: string;   // <package>/synth/storylines
// src/synth/build.ts
export interface SynthBuild {
  dir: string; lake: string; root: string; truth: string; params: SynthParams; digest: string;
  storylines: { id: string; title: string; malicious: boolean; case_type: string }[];
  left_out: { id: string; why: string }[];
  tables: { name: string; rows: number; bytes: number }[];
  tasks: PublicTask[];
}
export class SynthRefused extends Error {}
/**
 * Builds a synthetic company in `dir`: <dir>/lake.sqlite, <dir>/root (the catalogue, each source with the mess's quality notes appended),
 * <dir>/truth/<storyline>.json and <dir>/truth/mess.json. Throws SynthRefused, writing nothing, for parameters checkParams refuses, a size over
 * MAX_LAKE_BYTES, or a folder that exists and is not empty. What it made is removed if it fails part-way.
 */
export function buildSynth(dir: string, params?: Partial<SynthParams>, opts?: { storylines?: string; catalogue?: string; only?: string[] }): SynthBuild;
// src/index.ts gains: buildSynth, SynthRefused, checkParams, DEFAULT_PARAMS, TINY_PARAMS, readGroundTruth, LIKELIHOOD_TERMS, SYNTH_CATALOGUE, SYNTH_STORYLINES,
//   and the types SynthParams, SynthBuild, GroundTruth, PublicTask
```
The root is a copy of the catalogue folder (regular files only; a link is refused). A quality note is appended to its source's file as one more YAML key at the end (`quality_notes:` and one flow mapping a note, strings written with `JSON.stringify`), and the file is then parsed again to check it is what was meant. `<dir>/truth/` is beside the root, never inside it. `opts.only` builds with the named storylines alone (an unknown id is refused).

`scripts/make-synth.ts`: `bun run synth <dir> [--seed N] [--start YYYY-MM-DD] [--days N] [--users N] [--hosts N] [--sites N] [--volume X] [--scale N] [--only id,id]`. It prints the folder's three parts, each table's rows and simulated size, the storylines placed and left out, and the digest; exit 0. A refusal prints its sentence, exit 1; a wrong command line prints the usage, exit 2. It writes nowhere but `<dir>`.

Nothing under `src/synth/` or `src/connectors/fakeathena*.ts` imports `src/run/`, `src/service/` or `src/index.ts`.

- [ ] **Step 1: failing tests.**

```ts
test("buildSynth makes the lake, the root and the truth, and the root loads from a trusted root with no problems", () => {});
test("the four declared kinds of mess are quality notes of their sources, with the times mess.json records", () => {});
test("a truth file is there for each storyline placed, and none for one left out", () => {});
test("the build is the same twice: the lake's bytes, every root file and every truth file", () => {});
test("a folder that is not empty, days of 2, and parameters over 2 GB are each refused and nothing is written", () => {});
test("a build that fails part-way leaves no folder behind", () => { /* a catalogue folder with one broken source */ });
test("only builds the named storylines; an unknown id is refused", () => {});
test("the lake holds no ground truth: no table holds a truth's summary or a claim, and the root holds no file of the truth folder", () => {});
test("the script builds a tiny company, prints the digest and exits 0; a refusal exits 1; --help exits 2 with the usage", () => {
  // spawned with cleanEnv, in the foreground, with a time limit
});
test("the package exports the synth surface, and nothing under src/synth or the connector imports the run code or the service", () => {});
```
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): one call builds the lake, its root and its ground truth`.

---

### Task 11: Acceptance, documents, v0.3.0

**Repository:** pivot (`<pivot>`). Wave A6. Consumes everything before it.

**Files:**
- Create: `tests/synth/acceptance.test.ts`
- Modify: `src/version.ts`, `package.json` (the version), `tests/repo/library.test.ts`, `tests/repo/hygiene.test.ts` (one test added; no existing test changed), `README.md`, `docs/design.md`, `docs/security-notes.md`, `tests/synth/storylines-benign.test.ts` (the skipped test runs)

**Interfaces:** Produces `VERSION = "0.3.0"` and the annotated tag `v0.3.0` on the commit of this task, **not pushed**.

- [ ] **Step 1: failing tests for determinism** (`tests/synth/acceptance.test.ts`; one `TINY_PARAMS` build in `beforeAll`).

```ts
test("the tiny company's digest is the one this test holds", () => {
  // run once, read the digest, hold it as a literal; a change to the generator, a storyline or the mess is then seen and must be meant
});
test("two builds in two folders have the same lake bytes, root files and truth files", () => {});
test("all nine storylines are placed in the tiny company", () => {});
```
- [ ] **Step 2: failing tests for cost and pruning, through the run log** (`runLogged` with a `RunLog` and a `ResultStore` in a temporary folder, the registry loaded from the built root).

```ts
test("a costly pivot with no budget for USD is needs_budget and nothing is written to the log", () => {});
test("with a budget, the estimate is a query of its own in the log (purpose estimate) and the result's cost is the estimate", () => {});
test("the same pivot over one day costs less than over the whole period, by the partitions' bytes", () => {
  // both costs are scanOf's for the two windows, computed in the test from _lake_partitions
});
test("a ceiling below the estimate is needs_budget with the estimate, and the result query was never issued", () => {});
test("a shared spent map stops the second lookup of a follow once the ceiling is used", () => {});
test("the reputation pivot costs its per_lookup, with no estimate query", () => {});
test("a free pivot on assets runs with no budget and still reports what it scanned", () => {});
test("the stored result of every query holds its bytes scanned, and verifyLog passes", () => {});
```
- [ ] **Step 3: failing tests for the guard and the network.**

```ts
test("the guard is unchanged: src/guard/sqlguard.ts has the hash it had at v0.2.0", () => { /* the literal, taken from git before this branch */ });
test("an agent-style query on a costly source without the window shape is refused before any contact, with the guard's sentence", () => {});
test("a build and every query of this file called fetch zero times, and no file of the synth code or the connector names a network API", () => {});
test("a truth's values are found in the lake by its storyline's task alone: starting value, window, catalogue pivots", () => { /* one storyline end to end */ });
```
- [ ] **Step 4: FAIL where the code falls short; fix in the file that owns the fault; PASS.**
- [ ] **Step 5: the hygiene test added** (`tests/repo/hygiene.test.ts`): `no file under synth/ or src/synth/ writes out an address of the fake company: internal addresses are computed`, which reads those files for a dotted quad that is not loopback or a documentation address (the existing address test already covers it; this one names the reason in its failure message).
- [ ] **Step 6: documents.** `README.md`: a section "A synthetic company" after the sample's (what it is, `bun run synth <dir>`, the thirteen sources, the nine storylines by id, what the connector bills, a `budgets: { USD: 5 }` line for the service's configuration, where the ground truth is and that it is never in the lake). `docs/design.md`: the connector, the cost model's formula, the storyline manifest, the mess. `docs/security-notes.md`: the lake's marker, the table rule, no network, no ground truth in the lake, each with the test file that holds it (the document's own test checks every test it names exists). Placeholders only.
- [ ] **Step 7: the version.** `src/version.ts` and `package.json` say `0.3.0`; `tests/repo/library.test.ts` expects it and the new exports.
- [ ] **Step 8:** `timeout 600 bun test && timeout 300 bun run typecheck`. **Step 9: commit** `chore: v0.3.0 (a synthetic company: a fake lake, the fakeathena connector, storylines with known answers)`.
- [ ] **Step 10: the tag.** `git tag -a v0.3.0 -m "v0.3.0: a synthetic company (fake lake, fakeathena connector, storylines with known answers)"` on that commit. Do not push the branch or the tag. Report the commit's hash and the tag object's hash (`git rev-parse v0.3.0`): the owner pushes both, and Part B waits for that.

---

## Part B: the workbench

Part B starts when pivot's tag `v0.3.0` is on the remote. No task pushes it; the owner does.

### Task 12: pivot v0.3.0, workbench 0.15.0, the connector kind

**Repository:** workbench (`<repo>`). Wave B1.

**Files:**
- Modify: `package.json`, `bun.lock`, `src/core/casefile.ts` (`WORKBENCH_VERSION`), `src/modules/revalidate.ts`, `src/agents/tools/builder.ts`, `tests/repo/pivot-seam.test.ts`, `README.md` (the one line that names the tag)
- Test: `tests/repo/pivot-seam.test.ts`, `tests/modules/revalidate.test.ts`, `tests/agents/builder-tools.test.ts` (or the file that tests `list_connectors`), `tests/modules/fakeathena-runner.test.ts` (new); and every test that holds `0.14.0` or `v0.2.0`

**Interfaces:**
- Consumes: pivot `v0.3.0` from the remote.
- Produces: `dependencies.pivot` is `github:homelab-next/pivot#v0.3.0`; `WORKBENCH_VERSION` and `package.json`'s version are `0.15.0`; a `fakeathena` source is usable through `runQuery` with nothing in `src/modules/runner.ts` changed.

- [ ] **Step 0: the gate.** `timeout 60 git ls-remote --tags https://github.com/homelab-next/pivot v0.3.0` must print a line. If it prints none, stop and report BLOCKED: the tag is not pushed. Do not install pivot from a folder, a link or a branch: the seam test refuses those, and so does this plan.
- [ ] **Step 1: failing tests.**

```ts
// tests/repo/pivot-seam.test.ts (the two literals of the pin test become v0.3.0 and 0.3.0; nothing else in the file changes)
// tests/modules/fakeathena-runner.test.ts: a lake made by hand with pivot's writeLakeCatalog, a root of one fakeathena source and two pivots
test("runQuery on a free fakeathena pivot writes query.issued, query.result with a USD cost, and a card", () => {});
test("an agent's costly fakeathena pivot issues an estimate query and becomes a costly_query proposal with the estimate in USD; nothing else is sent", () => {});
test("a person's budget below the estimate is needs_budget with the estimate; a budget that covers it runs, and the result's cost is the estimate", () => {});
test("the stored result reads back through rowsOfBlob, so a reused and a revalidated fakeathena query work as a sql one does", () => {});
test("the workbench loads nothing of pivot's run code or service when it loads the connector", () => { /* the seam test's own check still passes */ });
// revalidate and the builder
test("revalidate re-runs a fakeathena query from its stored template and bound values, as it does a sql one", () => {});
test("list_connectors names fakeathena: a synthetic lake file, trusted roots only, cost.unit USD, no credential", () => {});
```
- [ ] **Step 2: FAIL** (the installed pivot is 0.2.0 and has no such connector).
- [ ] **Step 3: the bump.** Set the dependency to `#v0.3.0`; `timeout 300 bun install`; check `bun.lock` pins `pivot@github:homelab-next/pivot#<hash>` and `node_modules/pivot/package.json` says `0.3.0`. Commit nothing from `node_modules`.
- [ ] **Step 4: the code.** `revalidate.ts`: `was.connector === "sql" || was.connector === "files" || was.connector === "fakeathena"`. `builder.ts`: one more entry of `CONNECTORS` (`kind: "fakeathena"`, `about: "a synthetic lake file made by pivot's generator, billed as a lake would be"`, `trusted_only: true`, `needs: ["location", "tables"]`, `location: "the lake file, relative to the manifest; cost.unit must be USD"`, `credential: "none: the file has no sign-in"`, `list_tables: null`). Run `timeout 300 bun run typecheck` and fix every place the wider connector kind is named exhaustively; change no behaviour for the four kinds there were. `WORKBENCH_VERSION` and `package.json`: `0.15.0`. `README.md`: the tag in the one sentence that names it.
- [ ] **Step 5: PASS**, with every test that held `0.14.0` or `v0.2.0` holding the new value and nothing else of it changed. **Step 6:** `timeout 900 bun test && timeout 300 bun run typecheck`. **Step 7: commit** `chore: pivot v0.3.0 (the fakeathena connector); the workbench is 0.15.0`.

---

### Task 13: `bun run synth`: the command, `build`, `show`, the overlay

**Repository:** workbench (`<repo>`). Wave B2. Consumes Task 12.

**Files:**
- Create: `src/cli/synth.ts`, `src/synth/setup.ts`, `src/synth/build.ts`, `src/synth/tasks.ts` (stub), `src/synth/answer.ts` (stub), `src/synth/seed.ts` (stub), `synth/root/case-types.yaml`, `synth/README.md`
- Modify: `scripts/new-root.ts` (two helpers exported; `newRoot` unchanged in what it does), `package.json` (the script `synth`)
- Test: `tests/synth/setup.test.ts`, `tests/synth/build.test.ts`, `tests/cli/synth.test.ts` (new), `tests/cli/new-root.test.ts` (unchanged and green)

**Interfaces (Produces):**
```ts
// src/synth/setup.ts
export const SETUP_FORMAT = 1; export const SETUP_FILE = "synth.json"; export const TRUTH_DIR = "synth-truth"; export const SYNTH_PORT = 4757;
export const SYNTHETIC_PREFIX = "[synthetic] ";
export interface SynthSetup { format: 1; params: SynthParams; pivot: string; workbench: string; digest: string; storylines: { id: string; title: string; malicious: boolean; case_type: string }[]; left_out: { id: string; why: string }[]; model: "scripted" | { provider: string; model: string } }
export class SynthRefused extends Refused {}
/** The setup a configuration belongs to: the synth.json beside its file. Throws SynthRefused "this configuration is not a synthetic setup's (no synth.json beside it); give --config <synth>/config.yaml" for a configuration with no file, or none beside it, or one that is not a setup of this format. */
export function setupOf(config: Config): { dir: string; setup: SynthSetup };
/** Why `dir` may not hold a synthetic setup; null when it may. `ambient` is the configuration the command would load with no --config, or null when none loads. */
export function placeProblem(dir: string, repo: string, ambient: Config | null): string | null;
// src/synth/build.ts
export interface BuildOptions { params: Partial<SynthParams>; model: "scripted" | { base_url: string; model: string; provider?: string; where?: Where }; port?: number; only?: string[]; sample?: string; overlay?: string }
export interface Built { dir: string; config: string; setup: SynthSetup; tables: { name: string; rows: number; bytes: number }[]; files: number }
/** Builds a self-contained synthetic setup in `dir`. Throws SynthRefused, leaving nothing behind, when the place or the parameters are refused or the root it made does not load clean. */
export function buildSetup(dir: string, opts: BuildOptions, ambient?: Config | null): Built;
// src/synth/tasks.ts, answer.ts, seed.ts (stubs here; Tasks 14 and 15 fill them)
export async function synthTasks(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number>;
export async function synthAnswer(ctx: SynthContext, opts: { case: string; product: number | null }): Promise<number>;
export async function synthSeed(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number>;
export interface SynthContext { config: Config; dir: string; setup: SynthSetup; human: Actor; io: { log(line: string): void; error(line: string): void } }
// scripts/new-root.ts
export function pointStage(file: string, text: string, model: { provider: string; model: string }): string;      // was private
/** A loop file's inline stages pointed at the model: each `model: { provider: scripted, ... }` line, at any indent, rewritten and checked by parsing again. */
export function pointLoop(file: string, text: string, model: { provider: string; model: string }): string;
```
`bun run synth` (`src/cli/synth.ts`; exit 0 done, 1 refused or failed, 2 usage; `--help` prints the usage to standard error and exits 2, as every command does):
```
usage:
  bun run synth build <dir> (--scripted | --base-url URL --model ID [--provider ID] [--where machine|network|hosted])
                            [--seed N] [--start YYYY-MM-DD] [--days N] [--users N] [--hosts N] [--sites N] [--volume X] [--scale N] [--only id,id] [--port N]
  bun run synth show        --config <dir>/config.yaml
  bun run synth tasks       --config <dir>/config.yaml [--only id,id] [--marking M]
  bun run synth answer CASE-N --config <dir>/config.yaml [--product N]
  bun run synth seed-tasks  --config <dir>/config.yaml [--only id,id] [--marking M]
build writes only inside <dir>. Every other form needs --config and a synth.json beside it, and (but show) the server stopped.
```
`--config` is required for every form but `build`; the environment's and the home's configuration are never used for them (Ruling). `tasks`, `answer` and `seed-tasks` load the configuration, call `setupOf`, and only then open the workbench.

`buildSetup`, in order, removing `<dir>` if any step throws:
1. `placeProblem`: `<dir> already exists and is not empty` · `<dir> is inside the repository: build the setup outside it` · `<dir> shares a folder with the configuration in use (<what>): a synthetic setup has its own` (when it is, holds or sits inside the ambient configuration's data folder, a root, the case store, the loop store, the imports folder or a memory folder).
2. pivot's `buildSynth(dir, params, { only })`: `lake.sqlite`, `root/` (the catalogue with the mess's notes), `truth/`. A `SynthRefused` of pivot's is passed on in its own words.
3. The generic half of the sample into `root/`: `context/`, `checks/`, `stages/` (each pointed with `pointStage`), `loops/investigation.yaml` and `loops/improve.yaml` (pointed with `pointLoop`), `models/`. With `--scripted`: the sample's `models/scripted.yaml`, and every stage and inline stage names `{ provider: scripted, model: synth-run, effort: null }`; no script of that name is written (a test or a demo supplies `scripts/synth-run.yaml`). With a model: the model manifest `newRoot` writes, and the sample's `models/scripted.yaml` beside it for the seed loop. The sample's `types.yaml`, `pivots.yaml`, `sources/`, `inventories/`, `playbooks/`, `scripts/`, `data/`, `fixture/`, `memory/`, its other loops and its case types are not copied.
4. The overlay `synth/root/**` of this repository, copied over it (regular files only): here `case-types.yaml`; Task 15 adds the seed loop.
5. `config.yaml`: `data_dir: ./data`, `roots: [{ path: ./root, trusted: true, credentials: [] }]`, `server: { port: 4757 }` (or `--port`), `research: { parallel: 1 }`. `data/` is made empty.
6. `synth.json` (`SynthSetup`, canonical JSON, a final newline).
7. The check: `loadRegistry` on the root gives no problem, `loadCaseTypes` gives the five types, and `compose` over a workbench opened on `data/` and closed again gives no problem but, with `--scripted`, the ones that say the script `synth-run` is missing. Any other problem is a `SynthRefused` that lists them.

`synth/root/case-types.yaml` (`kind: case-types`, id `synth-case-types`): `suspicious-signin` ("Sign-ins that do not look like the account's own"), `suspicious-process` ("A process or a script that should not be running there"), `large-transfer` ("An unusual amount of data leaving a host"), `unknown-device` ("A device nobody recognises is on the network"), `cloud-activity` ("A cloud identity doing what it does not usually do"); each with a one-line `about`.

`show` prints the setup: the parameters, the digest, each table's rows and simulated size (read from the lake's catalog with pivot's `readLakeCatalog`, read-only), the storylines placed and left out, the model, the port, and how many task and seeded cases the truth index names (Task 14's index, `0` when there is none). It opens no workbench.

`build` prints what it made and the next commands, with the folder as the person typed it.

- [ ] **Step 1: failing tests for the place and the setup** (`tests/synth/setup.test.ts`).

```ts
test("placeProblem refuses a folder that holds a file, a folder inside the repository, and a folder that is, holds or sits inside each folder of the ambient configuration", () => {});
test("placeProblem takes a new folder, an empty folder, and any folder when no configuration loads", () => {});
test("setupOf refuses the defaults, a configuration with no synth.json beside it, and a synth.json of another format, in its sentence", () => {});
```
- [ ] **Step 2: FAIL, implement `setup.ts`, PASS.**
- [ ] **Step 3: failing tests for the build** (`tests/synth/build.test.ts`; one `--scripted` build with `TINY_PARAMS` in `beforeAll`, one with a model stand-in from `tests/helpers/model-standin.ts`).

```ts
test("the folder holds lake.sqlite, root, truth, data, config.yaml and synth.json, and nothing else", () => {});
test("the configuration loads: its data folder and its one trusted root are inside the folder, and its port is 4757", () => {});
test("the root loads with no problem: thirteen fakeathena sources, the pivots, the ten types, the five case types, the loops investigation and improve", () => {});
test("with --scripted every stage names the scripted model synth-run, and the only problems say that script is missing", () => {});
test("with a model every stage and every inline stage of the improve loop names it, and compose has no problem", () => {});
test("nothing in the root or the data folder holds a truth's summary or a claim", () => {});
test("the sample's own files are untouched and none of its sources, scripts or data is in the root", () => {});
test("a refusal part-way leaves no folder: an overlay with a broken manifest", () => {});
test("pointLoop rewrites every inline model line of the improve loop and nothing else; newRoot makes the files it made before", () => {});
```
- [ ] **Step 4: FAIL, implement, PASS.**
- [ ] **Step 5: failing tests for the command** (`tests/cli/synth.test.ts`; spawned with `cleanEnv`, in the foreground, with a time limit).

```ts
test("--help prints the usage and exits 2; an unknown form and a missing --config exit 2", () => {});
test("build --scripted with tiny parameters exits 0 and prints the digest and the next commands", () => {});
test("build on a folder that is not empty exits 1 with the sentence and writes nothing", () => {});
test("tasks, answer and seed-tasks with a configuration that is not a synthetic setup's exit 1 before the workbench is opened: no data folder is made", () => {});
test("show prints the tables' rows and sizes and the storylines, and opens no workbench: it runs while another process holds the lock", () => {});
```
- [ ] **Step 6: FAIL, implement, PASS. Step 7:** `timeout 900 bun test && timeout 300 bun run typecheck`. **Step 8: commit** `feat(cli): bun run synth builds a self-contained synthetic setup`.

---

### Task 14: `synth tasks` and `synth answer`

**Repository:** workbench (`<repo>`). Wave B3 (beside Task 15). Consumes Task 13.

**Files:**
- Modify: `src/synth/tasks.ts`, `src/synth/answer.ts` (Task 13's stubs)
- Test: `tests/synth/tasks.test.ts`, `tests/synth/answer.test.ts` (new)

**Interfaces (Produces):**
```ts
// src/synth/tasks.ts
export interface TruthFile extends GroundTruth { case: string; origin: string; made_by: "tasks" | "seed-tasks" }
export interface TruthIndex { format: 1; cases: { storyline: string; case: string; origin: string; made_by: "tasks" | "seed-tasks" }[] }
export function truthPath(config: Config, id: string): string;       // <data>/synth-truth/<case>/ground-truth.json
export function readIndex(config: Config): TruthIndex;                // empty when there is none
/** Writes the truth beside the case and adds it to the index (a temporary file, then a rename). Shared with seed-tasks. */
export function recordTruth(config: Config, truth: GroundTruth, session: CaseSession, made_by: TruthFile["made_by"]): void;
/** The case input of a storyline's task, as both forms make it. */
export function caseInput(truth: GroundTruth, marking: Marking): NewCase;
export async function synthTasks(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number>;
// src/synth/answer.ts
/** Sets the known answer of the case's product from its truth file, as the person. Shared with seed-tasks. Throws Refused with the sentence. */
export function answerFromTruth(session: CaseSession, deps: Pick<EngineDeps, "runner" | "profile" | "registry" | "components">, config: Config, human: Actor, product: number | null): { product: number; marking: Marking };
export async function synthAnswer(ctx: SynthContext, opts: { case: string; product: number | null }): Promise<number>;
```
`caseInput`: `{ title: "[synthetic] " + task.title, asked: task.question, why: "synthetic task: storyline <id>, seed <n>", starting: task.starting, window: task.window, objective: null, marking }`. The marking is `--marking` or `TLP:GREEN` (the sources' own).

`synthTasks`: reads every `<synth>/truth/<storyline>.json` with pivot's `readGroundTruth` (a file that is not one is an error that names it); for each, by id, that `--only` does not leave out and the index does not already name with `made_by: "tasks"`: checks the case type is loaded and every starting value matches its type, creates the case as the person with `{ default_loop: config.loops.default, type: truth.task.case_type }`, calls `recordTruth`, and prints `<case> <storyline> (<case type>): <question>`. It starts no run. It prints, last, the two commands that follow: `bun run investigate start` is not one of them (the case exists); they are `bun run serve --config …` to work the case, and `bun run synth answer <case> --config …` once it is published. Exit 0; 1 when a storyline was refused (the others are still made).

`answerFromTruth`: reads the truth file of the case (`there is no ground truth beside <case>`); refuses when its `case` or `origin` is not this session's id and first entry's hash (`the ground truth beside <case> was written for another case`); takes `product`, or the latest published one (`<case> has published no product; publish it first`); sets the marking to the floor `improve answer` uses (the strictest of the case's and the product's); the likelihood scale is the case's bound loop's, as `improve answer` reads it; then `setKnownAnswer(session, deps, { product, text: truth.summary, findings: truth.findings, marking, actor: human }, scale)`. A refusal of `setKnownAnswer` is passed on in its words. `synthAnswer` prints `known answer set for product <n> of <case> from storyline <id> (<marking>)`.

The truth folder is `<data>/synth-truth/`, beside `<data>/cases/`, not inside a case's folder: a case's folder is packed whole when the case is unloaded, and a known answer's source must not travel in a case file (Ruling).

- [ ] **Step 1: failing tests for tasks** (a `--scripted` tiny setup built once; the functions called directly with an `io` that collects lines).

```ts
test("tasks makes one case a storyline, by the person of the configuration, titled [synthetic], of the storyline's case type, with its question, starting values and window", () => {});
test("each case has its ground-truth.json beside the cases folder, naming the case and the hash of its first entry, and the index lists them", () => {});
test("no case has a run, a known answer or a query; its ledger holds only what createCase writes", () => {});
test("a second tasks makes no case; --only makes the named ones; an unknown id exits 1 and makes nothing", () => {});
test("no entry and no blob of any case made holds the truth's summary or a claim", () => {});
test("a truth file that is not a ground truth is named and the others are still made", () => {});
```
- [ ] **Step 2: FAIL, implement, PASS.**
- [ ] **Step 3: failing tests for answer** (a task case carried to a published product by `tests/helpers/synth-script.ts` if Task 17 has landed it, else by the entries helper `tests/helpers/entries.ts`: the test needs a published product, not a real run).

```ts
test("answer on a published task case writes answer.known by the person: the truth's summary, its findings, the floor marking", () => {});
test("answer before the case is published is refused with the sentence and writes nothing", () => {});
test("answer on a case that has no truth, and on a case whose truth names another origin, is refused", () => {});
test("--product names the product; a product the case did not publish is refused in setKnownAnswer's words", () => {});
test("an answer set twice replaces the first, as improve answer does", () => {});
```
- [ ] **Step 4: FAIL, implement, PASS. Step 5:** full run and typecheck. **Step 6: commit** `feat(synth): synth tasks makes a case a storyline with its ground truth beside it; synth answer sets the known answer`.

---

### Task 15: The seed loop and `synth seed-tasks`

**Repository:** workbench (`<repo>`). Wave B3 (beside Task 14). Consumes Task 13; calls Task 14's `recordTruth`, `caseInput` and `answerFromTruth` (their signatures are in this plan; until Task 14 commits, the tests of Steps 1 to 4 do not need them).

**Files:**
- Create: `src/synth/seed-script.ts`, `synth/root/loops/synth-seed.yaml`, `synth/root/context/synth-seed-profile.yaml`
- Modify: `src/synth/seed.ts` (Task 13's stub), `src/synth/build.ts` (one call: the script is written after the overlay)
- Test: `tests/synth/seed-script.test.ts`, `tests/synth/seed.test.ts` (new)

**Interfaces (Produces):**
```ts
// src/synth/seed-script.ts
/** The scripted model's script for the seed loop: for each task, the turns of its five agents, each a turn only for a request that holds the task's question. Reads nothing but the tasks and the registry's pivot titles. */
export function seedScript(tasks: PublicTask[], pivotTitle: (id: string) => string | null): string;
export const SEED_FINDING = "The lookup the seeded plan named was run for the starting value; this product records what it returned and makes no judgment about it.";
// src/synth/seed.ts
export async function synthSeed(ctx: SynthContext, opts: { only: string[] | null; marking: Marking }): Promise<number>;
```
`synth/root/loops/synth-seed.yaml`: the shape of the sample's `device-check` loop (Frame, Plan with the plan gate, Research, Assemble, Checks, Publish with the publish gate), its id `synth-seed`, its profile `synth-seed`, no `case_type`, every agent stage on `{ provider: scripted, model: synth-seed, effort: null }`. `pointLoop` leaves it alone: the seed loop is scripted whatever model the setup uses (Task 13's `buildSetup` points only `investigation.yaml` and `improve.yaml`). `synth/root/context/synth-seed-profile.yaml`: the sample's `device-check` profile without its skill.

`seedScript`, for each task (its turns carry `when: [<the task's question>]`; model the turns on `sample/scripts/sample-check.yaml`):
- `orchestrator`: one goal (the task's title and question, `want`), the task's window, `limits: { allow_unconfirmed: true, max_weight: null }`;
- `planner`: one sub-goal with `have` the task's first starting value and `route` the task's `seed_route`;
- `researcher-g1`: `{"outcome": "answered", "found": [], "note": "The seeded lookup ran; its card holds what it returned."}`;
- `analyst`: `list_cards`, then one `propose_assessment` whose claim is `SEED_FINDING`, likelihood `roughly even chance`, confidence `low`, citing `{{card:<pivot title>: <starting value>}}`, and the narratives the checks ask for (summary, gaps and limits, alternatives, assessment), each saying only that this is a seeded synthetic task and that no judgment was made; then the closing turn;
- `publisher`: a title `[synthetic] <task title>` and a note `Seeded synthetic task; the product judges nothing.`
The script holds nothing of a truth: `seedScript` is given `PublicTask`s, which pivot's build returns in `SynthBuild.tasks`, and never a `GroundTruth`. `buildSetup` writes it to `root/scripts/synth-seed.yaml` after the overlay and before the check, for the storylines placed.

`synthSeed`, for each truth by id that `--only` does not leave out and the index does not name with `made_by: "seed-tasks"`: creates the case as the person (`caseInput`, `{ loop: "synth-seed", type }`), records the truth, starts the run as the person and advances; expects `waiting=plan` and calls `engine.acceptPlan({ actor: human })` (no budget); advances; expects `waiting=publish` with no blocker and calls `engine.approve({ actor: human, unload_after: false })`; advances; then `answerFromTruth`. It prints `seeded <case> for <storyline>: product 1 published, known answer set (synthetic)`. A run that is anywhere else at either point is not pushed on: the command prints `<case> for <storyline> stopped at <where>: <why>`, sets no answer for it, goes on to the next, and exits 1 at the end. It builds its engine and host as `src/cli/improve.ts` does (`compose`, `hostsFor`) and closes them.

- [ ] **Step 1: failing tests for the script** (`tests/synth/seed-script.test.ts`).

```ts
test("the script parses as a kind: script manifest of id synth-seed, with five actors' turns a task", () => {});
test("every turn of a task carries that task's question in when, and no two tasks share a question", () => {});
test("the script holds no summary and no claim of any truth of the build it was made for", () => {});
test("a question with a quote, a colon and a brace is written so that the YAML parses back to it", () => {});
```
- [ ] **Step 2: FAIL, implement, PASS.**
- [ ] **Step 3: failing tests for the loop** (a tiny `--scripted` setup built once).

```ts
test("the built root has the loop synth-seed, usable, on the scripted model synth-seed, and compose has no problem about it", () => {});
test("a seed case runs to its plan gate with one free step, and after the plan is accepted to its publish gate with no blocker, for each of the nine storylines", () => {});
test("the seed run asked only free lookups: no costly_query proposal, no estimate query", () => {});
```
- [ ] **Step 4: FAIL, implement (the loop, the profile, the script's turns until every check passes), PASS.**
- [ ] **Step 5: failing tests for the command** (`tests/synth/seed.test.ts`).

```ts
test("seed-tasks makes, for each storyline, a case of the loop synth-seed that is published and has a known answer, all by the person of the configuration", () => {
  // every gate.passed, plan.accepted, product.published and answer.known of each case is by { kind: "human", id: config.user }; state.skipped is []
});
test("the published product's one finding is SEED_FINDING, and no entry or blob of the case but answer.known holds the truth's summary or a claim", () => {});
test("each seeded case is a task of its case type for the improve loop's Select: published, answered, not stricter than TLP:GREEN", () => {});
test("a second seed-tasks seeds nothing; --only seeds the named ones", () => {});
test("a seed that stops elsewhere (the script's planner turn removed for one storyline) is named with where it stopped, gets no answer, and the others are still seeded; the exit code is 1", () => {});
test("verifyCase passes for every seeded case", () => {});
```
- [ ] **Step 6: FAIL, implement, PASS. Step 7:** full run and typecheck. **Step 8: commit** `feat(synth): synth seed-tasks makes published, answered task cases on a scripted seed loop`.

---

### Task 16: Documents

**Repository:** workbench (`<repo>`). Wave B4 (beside Task 17). Consumes Tasks 13 to 15.

**Files:**
- Create: `docs/synthetic-company.md`
- Modify: `README.md`, `docs/security-notes.md`, `docs/gui-guide.md` (one paragraph), `tests/repo/readme.test.ts`

**Interfaces:** Produces a README section `## A synthetic company`, placed after `## Improve a loop` and before `## Known limits`; the list of sections in `tests/repo/readme.test.ts` gains it there.

What the documents say, in plain words, with placeholders only (`<synth>`, `<data>`, `<repo>`, `<lake>`; no address of the fake company written out; no real vendor or host):
- **README.** What a synthetic setup is and that it shares nothing with the real one. The commands, each in a fenced block the README test runs with `--help` (every flag shown must be in the usage): `bun run synth build <synth> --scripted`, the same with `--base-url` and `--model`, `bun run serve --config <synth>/config.yaml`, `bun run synth tasks --config <synth>/config.yaml`, `bun run synth answer CASE-1 --config <synth>/config.yaml`, `bun run synth seed-tasks --config <synth>/config.yaml`, then `bun run improve start investigation --type suspicious-signin --marking TLP:GREEN --config <synth>/config.yaml`. What costs money there and how a budget is given at the plan gate (`bun run investigate accept-plan CASE-1 --budget s2=0.5 --config …`). One paragraph on the sizes and the 2 GB bound.
- **`docs/synthetic-company.md`.** The thirteen sources with what each is for; the nine storylines by id and case type, without their answers; the mess, and which of it is declared; how a query is priced, with the formula and one worked example in whole numbers; where the ground truth is kept and who may read it; what a seeded task is and why its product judges nothing; how to add a storyline (a YAML file in pivot's `synth/storylines/`).
- **`docs/security-notes.md`.** The separation (the refusals of `build` and of the other forms), the lake's marker, the connector's table rule and that it opens no network connection, the blindness of the judge with respect to truth files, each with the test file that holds it.
- **`docs/gui-guide.md`.** One paragraph: a synthetic case's title starts with `[synthetic]`, and a costly step on the fake lake shows its estimate in USD at the plan gate.

- [ ] **Step 1: failing tests** (`tests/repo/readme.test.ts`).

```ts
test("the README's sections come in order", () => { /* the list with "A synthetic company" before "Known limits" */ });
// the existing tests then check, with no change: every command the README names exists; each runs with --help; every flag the README gives is in the usage
test("docs/synthetic-company.md names every storyline id and every source id the installed pivot ships, and no ground truth", () => {
  // ids read from node_modules/pivot/synth; no truth summary and no claim of a tiny build appears in any document
});
test("every test file docs/security-notes.md names exists", () => {});
```
- [ ] **Step 2: FAIL. Step 3: write. Step 4: PASS. Step 5:** full run and typecheck (the hygiene tests read the documents). **Step 6: commit** `docs: a synthetic company, its commands, its costs and where its answers are kept`.

---

### Task 17: Acceptance and boundaries

**Repository:** workbench (`<repo>`). Wave B4 (beside Task 16). Consumes Tasks 12 to 15.

**Files:**
- Create: `tests/synth/acceptance.test.ts`, `tests/helpers/synth-script.ts`
- Modify: `tests/server/boundaries.test.ts`, `tests/repo/hygiene.test.ts` (one test added; none changed)

**Interfaces (Produces):**
```ts
// tests/helpers/synth-script.ts
/** A scripted investigation of one storyline of a built setup, as a kind: script manifest of id synth-run: written from the build's truth for that storyline, for the loop `investigation`. Test code: it is the one place outside src/synth that reads a truth file. */
export function investigationScript(setup: { dir: string }, storyline: string): string;
/** A tiny --scripted setup with that script in its root, its workbench opened and composed. */
export function synthRun(storyline: string): { dir: string; config: Config; wb: Workbench; deps: EngineDeps; truth: GroundTruth; close(): void };
```
The scripted investigation is of `password-spray`: Frame (two goals: who signed in from the address, and whether the address is known); Plan (three sub-goals: `address_to_asset`, free; `address_to_signins`, costly; `address_to_reputation`, costly per lookup); Research (the steps the plan was given a budget for, then `account_to_signins` on the account that succeeded, asked by the researcher outside the plan, which becomes a proposal); Assemble, Evaluate, Challenge and Publish as `sample/scripts/sample-run.yaml` has them, with findings worded from the truth's entities, not copied from its claims. Card titles are `<pivot title>: <value>`.

- [ ] **Step 1: failing tests for the run** (`tests/synth/acceptance.test.ts`).

```ts
test("a tiny synthetic setup builds, its configuration loads, and its root composes with no problem once the script is there", () => {});
test("an investigation of the password-spray case runs on the scripted model from start to a published product", async () => {
  // start as the person; plan gate; accept with budgets; publish gate with no blocker; approve; run finished, outcome published; state.skipped is []
});
test("every query of the run is on a fakeathena source, went through runQuery (query.issued before query.result), and its stored result reads back", () => {});
test("the case verifies, and fold(entries, n) for every n is the state the session had at n", () => {});
```
- [ ] **Step 2: FAIL, write the helper and the script until the run publishes, PASS.**
- [ ] **Step 3: failing tests for costs and budgets.**

```ts
test("at the plan gate the asset step is free and the sign-in and reputation steps are costly, each with its estimate in USD", () => {});
test("each costly step's estimate is a query of its own in the ledger, purpose estimate, whose one row holds the bytes scanned", () => {});
test("accepting the plan with no budget runs the free step only; the costly steps wait", () => {});
test("a budget below the sign-in step's estimate runs nothing of it and leaves a record of the price; a budget that covers it runs it", () => {});
test("the sign-in result's cost is the estimate, and both are the cost model's figure for the step's window, computed in the test from the lake's partitions", () => {});
test("the same pivot over the case's window costs less than over the whole period", () => { /* two estimates, by a person, no budget: needs_budget with each */ });
test("the reputation step costs its per-lookup price whatever it returned", () => {});
test("the researcher's costly lookup outside the plan becomes a costly_query proposal with an estimate; the person's budget runs it", () => {});
test("the run's query_cost measure is the sum of the costs the sources reported, in USD", () => {});
test("an acceptance with no budget issues no costly query: after it, no query.issued of purpose result names a costly source", () => {});
```
- [ ] **Step 4: FAIL, fix in the file that owns the fault (a fault in pivot is reported, not patched here), PASS.**
- [ ] **Step 5: failing tests for blindness and separation.**

```ts
test("no model.request and no tool.returned of the investigation holds the truth's summary or a claim, word for word", () => {});
test("after synth tasks and synth seed-tasks on the setup, an improve run's Select takes the seeded cases of a type as tasks, and no request before the Judge holds a truth's claim", async () => {
  // Select only, driven with the improve loop's own runner; then read every blob the improve case names
});
test("the setup's folders are its own: the data folder, the root and the lake are inside <dir>, and nothing outside <dir> was written by any command of this file", () => {
  // a HOME made for the test stays empty but for what cleanEnv puts there
});
test("the connector opened no network connection: fetch was called zero times in this file", () => {});
```
- [ ] **Step 6: the boundaries** (`tests/server/boundaries.test.ts`, `tests/repo/hygiene.test.ts`).

```ts
test("nothing under src/pipeline, src/agents, src/server, src/core or src/web imports src/synth", () => {});
test("a ground-truth file is read only by src/synth/tasks.ts, answer.ts and seed.ts: no other file under src names synth-truth or readGroundTruth", () => {});
test("src/modules/runner.ts is the file it was at 0.14.0", () => { /* its hash, held as a literal taken from git before this branch */ });
test("src/synth names no network API", () => {});
test("no file under synth/ or src/synth/ writes out an address of the fake company", () => {});
```
- [ ] **Step 7: FAIL where the code falls short, fix, PASS. Step 8:** `timeout 900 bun test && timeout 300 bun run typecheck`, the full run with `WORKBENCH_REQUIRE_BROWSER=1`. **Step 9: commit** `test(synth): an investigation on the fake lake on the scripted model; costs, budgets, blindness and boundaries`.
