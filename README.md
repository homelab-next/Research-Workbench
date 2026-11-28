# Research Workbench

## What this is

A workbench for an analyst who investigates on their own network. You ask a question. Agents do the legwork: they frame the run, plan routes over the data you can reach, run the queries, put the findings together, check them and attack them. You stay at the gates. Nothing is published until you press Approve. The aim is speed without losing control.

Every action is written to an append-only ledger, and each entry is chained to the one before by a hash. The exact queries, the sources, the models' answers and your own decisions are all in it. Any finding can be traced to the bytes behind it, re-run, and replayed one action at a time. That chain of custody is the point.

The catalogue of sources and pivots, the query guard, the connectors and the route search come from [pivot](https://github.com/homelab-next/pivot), the workbench's one first-party dependency, pinned to the tag `v0.3.0` in `package.json` (the lock file pins the hash of the annotated tag object, which names exactly one commit). pivot only plans and reaches sources; the workbench keeps its own custody. Every query it sends goes through its runner and into the case's ledger, never through pivot's run endpoint or log. There is no third-party runtime dependency.

This first slice is one investigation, end to end, on one machine, for one person. What it leaves out is listed in section 2 of [the design spec](docs/superpowers/specs/2026-11-23-investigation-slice-design.md).

## Run the sample

The sample is invented data with one planted story. It uses a scripted model, so it needs no model server and contacts nothing outside this machine.

```bash
bun install
bun run serve --sample-fixture
```

It prints one line, `Workbench: http://127.0.0.1:<port>/`. Open that address in a browser. The sample data is generated on the first run. `--sample-fixture` also starts a small stand-in reputation service on `127.0.0.1:4801`.

To reach the publish gate:

1. On Home, click "+ New investigation".
2. Give it a title, a question and a reason. Add the starting value `address` = `198.51.100.77`. Set the window from `2026-11-17T00:00:00.000Z` to `2026-11-24T00:00:00.000Z`, the objective `sample-objective` and the marking `TLP:GREEN`.
3. Click "Create and frame the run". The run stops at the plan gate, in the Steps lens.
4. Give the one costly step a budget of 1, then click "Accept: run N steps".
5. The run goes on and stops at the publish gate, in the Narrative lens. Read the draft. "Approve: publish draft N" is your choice. Nothing presses it for you.

The same run works without a browser. Each command stops where a person must decide:

```bash
bun run investigate start --sample-fixture --title "Sample" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" \
  --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN
bun run investigate accept-plan CASE-1 --budget s3=1 --sample-fixture
bun run investigate approve CASE-1
```

The first stops at the plan gate. The second stops at the publish gate. The third publishes `published/1` in the case folder. Then check the chain:

```bash
bun run verify <data_dir>/cases/CASE-1
```

It says whether the chain is intact. See [sample/README.md](sample/README.md) for the story behind the data.

## Point it at your own data

Make a module root of your own. It is a copy of the generic half of the sample (stages, checks, context), pointed at your model server:

```bash
bun run new-root ~/workbench/root --base-url http://127.0.0.1:1234/v1 --model example/model-a
```

It refuses a folder inside this repository or a folder that is not empty. It prints a configuration. Save it as a file, for example `~/workbench/config.yaml`, and pass it to every command with `--config`.

Keep the configuration, the root and the data outside this repository. Do not put them at `~/.config/research-workbench/`. Every command reads that folder when you give no `--config`, so a file there changes what a bare `bun run serve` does, and the sample would start reading your real settings. Keep your own files where only you choose to point at them.

The configuration holds `data_dir`, `user` (the name recorded against your actions), `roots`, `secrets_file`, `marking_policy`, `server.port` and `research.parallel`. Paths in it are relative to the file.

### Types of value

Observable types are defined in `<root>/types.yaml`. A new root has `address` and `domain`. A column or a pivot may only use a type that is defined there. Add the types your data has, with a pattern for each:

```yaml
kind: types
types:
  - { id: address, title: Address, pattern: '(?:\d{1,3}\.){3}\d{1,3}' }
  - { id: domain, title: Domain, pattern: '(?=.{1,253}$)(?:[a-z0-9-]{1,63}\.)+[a-z]{2,63}' }
  - { id: host, title: Host, pattern: '[a-z]{2,6}-\d{1,3}' }
```

### A source for a lake

A source manifest sits in `<root>/sources/`. This one uses invented names. Put your own in your own file.

```yaml
kind: source
id: lake
title: Security data lake
connector: trino
location: https://trino.example.org:8443
user: workbench
tls_verify: true
marking: "TLP:AMBER"
where: network
confirmed: true
adhoc: false
cost: { weight: 5, unit: rows }
limits: { max_rows: 500, timeout_ms: 60000 }
quality: Network flows and sign-ins. About one hour behind.
quality_notes:
  - { id: dup-1, text: "Flow rows are doubled in this window; halve the counts.", from: "2026-11-10T00:00:00.000Z", to: "2026-11-11T00:00:00.000Z" }
tables:
  - name: lake.example_security.net_flows
    time_column: event_time
    guarded: true
    large_columns: [raw_payload]
    columns:
      - { name: src_addr, type: address }
      - { name: dst_addr, type: address }
      - { name: host_name, type: host }
```

What the fields mean:

- `guarded: true` marks a big table that only a narrow query may touch. The workbench checks every statement against a fixed shape before it is sent (the rules below). A guarded table needs a `time_column`. Guard every event table.
- `adhoc: false` keeps agents from writing their own queries to the source. They may only run the pivots you wrote.
- `marking` and `where` say how sensitive the data is and where it lives. See "Markings" below.
- `cost` is what a query on this source costs. With `unit: rows` the cost is the engine's own estimate of the rows a query returns, and a budget in rows is checked against it before the query runs. It bounds the rows returned, not the rows scanned; the required time window is what bounds the scan. `weight` is the cost used when a pivot does not set its own.
- `quality` and `quality_notes` travel with every card from this source. Write down known faults, with the exact UTC window they cover.
- `tls_verify: false` is allowed for a self-signed certificate. Preflight notes it, because the certificate is then not checked.

### The guarded shape

A statement that names a guarded table must be one plain query. The rules, in plain words:

1. A `describe` of the table, or `show columns from` it, is allowed as it is.
2. The table's metadata tables (a name ending in `$`, such as `events$files`) are refused.
3. The statement names the table once, in one `select` with one `from`.
4. No `join`, `union`, `intersect`, `except`, `with` or `or`. Exact `count(distinct ...)` is refused too; use `approx_distinct`. `select *` is refused; name the columns. Table functions and `explain analyze` are refused.
5. The `where` clause must begin with the time column `>=` the window's start and the time column `<` the window's end, using the request's own window. Other conditions follow with `and`. A limit, if any, must stay under the source's `max_rows`.
6. The window must have both ends. An open window is refused.

Control characters in a statement are refused as well, and so is a number written straight into a word (`1.5or`).

A good pivot. It asks about one value, bounds the window, names its columns, aggregates and keeps a small limit:

```yaml
kind: pivots
pivots:
  - id: address_to_hosts
    title: Hosts that talked to the address
    from: address
    to: host
    source: lake
    query: "select host_name, count(*) as events from lake.example_security.net_flows where event_time >= {window.from} and event_time < {window.to} and dst_addr = {value} group by host_name order by events desc limit 50"
    needs_window: true
    weight: 0
    empty_means: not-seen
    yields: { host_name: host }
```

The three refusals you will meet most:

- `the where clause must begin with event_time >= {window.from} and event_time < {window.to}`. Put the two window bounds first, before any other condition.
- `select * is not allowed on lake.example_security.net_flows; name the columns`. List the columns you need.
- `join, union, intersect, except, with and or are not allowed on a guarded table`. Use `in (...)` instead of `or`, and run two pivots instead of a join.

`bun run preflight` runs every pivot through the guard before you start (see the next section), so you see these in a list instead of mid-run.

### `empty_means`

Every pivot says what an empty answer means. `not-seen` says only that nothing was found in this source and window. `proven-negative` says the source is complete for this question, so nothing found means nothing happened. Use `not-seen` unless you know the source is complete. A wrong `proven-negative` makes a gap look like a clean result.

### Cost

A query costs `weight` in the source's `unit`. A pivot may set its own `weight`. A pivot with `weight: 0` is free: an agent may run it inside an accepted plan. A pivot with no weight takes the source's, so it is costly and waits for the budget you give it at the plan gate. Use `unit: rows` for a lake: the engine's estimate is in rows.

### Credentials

A secret value never goes in a manifest, a ledger or a command line.

1. The source names the credential: `credential: LAKE_PASSWORD`.
2. The root's entry in the configuration allows that name: `credentials: [LAKE_PASSWORD]`. A root that is not listed for a name cannot use it.
3. The value is in the environment under that name, or in a secrets file named in the configuration (`secrets_file: ./secrets.yaml`) holding `LAKE_PASSWORD: <value>`. Set the file to mode 600. Do not print it.

A source with no password (a user name only) needs none of this.

### Markings and the policy

Each source has a `marking`: `TLP:CLEAR`, `TLP:GREEN`, `TLP:AMBER`, `TLP:AMBER+STRICT` or `TLP:RED`. Each model has a `where`: `machine`, `network` or `hosted`. `marking_policy` in the configuration says where each marking may go. The default lets the two least restrictive go anywhere, keeps the next two off hosted models, and keeps the most restrictive on this machine. Cards keep their marking into drafts and into the published bundle, and a model is never given text its place may not see. Preflight fails if a source's marking may not go to the model of a stage that reads it.

### Playbooks

A playbook is a fixed list of lookups, run in code with no model and no budget. It is one file, `kind: playbook`, anywhere under a trusted root (the sample keeps it in `playbooks/address-triage.yaml`):

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

That is the whole grammar. There is no `else`, no `and` and no loop.

- `inputs`: one or more, each a name and a type of value. No two inputs share a type.
- `steps`: one to twelve, run in the order written, one at a time. `pivot` names a loaded pivot. `from` is `input.<name>` or the id of an earlier step; a step that starts from an earlier step runs once for each value that step found, in the order found, up to `max_values` (default 5, at most 20). `when` (optional) is `<earlier step>.rows` or `<earlier step>.empty`.
- `end` (optional): step ids. The outcome of the playbook is the outcome of the first listed step that ran. Without it, the last step.

What `rows` and `empty` mean: a step has `rows` if any of its lookups returned a row. A step is `empty` only if it ran and every lookup came back with no rows and full coverage. A lookup that was partial, failed, refused or waiting for a budget makes the step neither, so a step that depends on it is skipped and the record says it could not tell. A branch never treats "we could not look" as "there was nothing".

Limits: at most 12 steps a playbook, 20 values a step, 50 lookups a run. A playbook never spends a budget: a lookup whose pivot is costly is not sent, the step says it needs a budget and the playbook goes on. Run that pivot by hand with a budget; running the playbook again reuses the answer. A playbook that does not load (an unknown pivot, a bad `from`, a duplicate id) is rejected with the reason and the server still starts.

Start one from the Pivot panel (a button under the routes for each playbook the card's values can fill) or from the command bar: `run playbook address-triage on 198.51.100.77`. The planner may also offer a playbook as one plan step in place of a route, if every lookup in it is free; Research then runs it in code with no researcher. Each run is one job. Every lookup goes through the same runner as any other query, so it is recorded as a query with a card, and the run's steps are recorded as `playbook.*` entries. Before a lookup is sent, the runner looks for an answer in the case to the same pivot, value and window under the same manifests, with full coverage and a card that still exists; if there is one, no query is sent and the step says "reused, no query sent". A lookup a researcher answered is reused by a playbook, and the other way round.

### Inventories

An inventory says what a list of things (one type of value) holds and whether it is complete. It is one file, `kind: inventory`, under a trusted root:

```yaml
kind: inventory
id: assets
title: Asset list
holds: asset
scope: internal hosts
complete: true
basis: Every internal host is entered by hand before it is given an address.
derived: false
```

A pivot asks an inventory with one more line, `inventory: assets`. Its `to` must be the inventory's `holds`, and its manifest must come from a trusted root. Its `empty_means` is decided by the inventory: `proven-negative` if the inventory is complete, `not-seen` if not. Leave `empty_means` out, or state the one the inventory implies; the other is rejected.

`complete: true` needs a `basis`, one sentence on why the list can be relied on to hold everything in its scope. A list worked out from observed events (`derived: true`) only holds what was seen and cannot be complete; that pair is refused. When in doubt, say `complete: false`.

A card from an inventory pivot says what the answer proves:

- `2 rows · in Asset list`
- `No rows · proven negative · not in Asset list, which is complete for internal hosts`
- `No rows · not seen (not proof of absence) · Asset list is not declared complete`

A partial result keeps its "partial" wording and is never either of the last two.

"Does it belong?" is a button on the Pivot panel. It asks every inventory that takes the card's value, as one playbook made on the spot, and gives one verdict: a known asset; not a known asset (proven, because a complete inventory came back empty); not seen in any inventory (none is complete, so this proves nothing); or could not tell.

### What was observed

A pivot may say which of its result columns are times, with a `times` line in its manifest. There are two shapes:

```yaml
times: { first: first_seen, last: last_seen, count: events }   # one row per value, with its span and a count
times: { at: ts }                                              # one row per event, with its time (count optional)
```

`first` and `last` go together; `at` stands alone; `count` is optional. Each name must be a column of the query (or of the http endpoint), must not also be a yielded column, and may be named only once. A pivot that breaks this is rejected with the reason and the rest of its file still loads.

A card made by a pivot's own query carries `observed`, worked out from the result the runner already holds, in the same commit that makes the card: the value the pivot ran on, the span over every row, and the values it found, each with its first and last time, a count and a few points on a time line. Nothing is queried again, and the times are normalised UTC strings. A time that cannot be read is counted as unread, never guessed.

Two lenses show it, both built from the recorded entries alone: the Timeline (key `T`), a row per value with a mark per card that saw it on the data's own time axis, and the Graph (key `G`), the observed values as nodes with the pivots that found one from another as edges. Two caps apply: a card keeps at most 100 sightings (24 points each; the rest are counted in `more`), and the Timeline draws at most 200 rows, while the Graph places at most 60 nodes and 12 neighbours of a node. A value the Graph does not draw is reachable from a drawn neighbour's detail, or, when nothing drawn links to it, from the list under the header ("N more values are linked to nothing drawn"), each a button that focuses the graph on it.

Editing a pivots file changes the hash of every pivot in it, including a `times` line, so a lookup answered before the edit is not reused after it.

A source column (or a pivot's result column) may also say what it `reveals` and carry `extract` rules that pull typed values out of its text (pivot's field notes; see pivot's README for the limits). The sample's `sources/wifi.yaml` notes that a WiFi connection message names the device's host name and the access point it joined. When the runner makes a card it runs those rules over every row. A pivot uses its own and its inherited column notes; a query with no pivot uses the source's columns. What matches goes on the card as `extracted`, each value with its rule, its column, the first row it was in and `by: "code"`. A model never has to notice them: the card's pack part, `read_card` and a lookup's result list them (at most 20, then how many more), and they carry the card's marking.

After a plan has been accepted, each Plan pass gets a part built by code, "What the new values open up". It lists the values extracted since that plan, and earlier ones no query has used yet, grouped by type with the pivots that start from each type (their cost and what they reveal) and the open sub-goals each has a route to. It lists at most 20: those not looked up first, then those reaching an open sub-goal, then the cheapest route; the rest are counted. When a value extracted since that plan that no query has used, and no accepted step starts from, opens a route to an open sub-goal, Research sends the work back to Plan, naming at most three such values in the reason. It does so at most `glean.max_sendbacks` times a run (default 2; 0 turns it off). The model only chooses which values to follow. When a plan runs some of a playbook's lookups as single pivots for a type the playbook starts from, the Steps lens shows "Playbooks run only in part" with what the playbook would also have fetched, and the next Plan pass is told the same.

## The person

You know things no source holds, and you can go and look. The workbench records what you say as yours, keeps it apart from what a source returned, and labels every finding that rests on it.

Each finding is labelled with its id (f1, f5 …) wherever it appears, since reviewers, checks and the controller name findings by id. A refused command of yours (an answer, an overrule, a ruling, a statement, a send-back) says "Refused:" and the server's reason beside the control that sent it.

Where to act: answer a question in **Questions for you**, first under the brief on the case screen (and at the top of the Narrative lens); overrule a finding with the **Overrule** button under it in the Narrative lens, or beside it in the list of findings under Questions for you at the publish gate. The publish gate's box names the questions still open and the overrules in force next to Approve. None of these passes a gate.

### A statement

"Add what you know" in the Incoming column (or `state <text>` in the command bar) records a statement: your text (at most 4000 characters), how you know it (saw it myself, did it myself, was told, or did not say how; the command bar records "did not say how"), an optional detail (at most 500 characters), up to 20 values it is about, and a marking no lower than the case's. It is a card made by you, with no query, no source and no rows. It is shown as "your statement", never as "nothing found".

An agent is shown it as "Source: the person (…). A statement by the person running the investigation, not data from a source." and may cite it like any card. When a draft cites a statement, the workbench (not the analyst) writes a sources entry "the person" naming each statement, how you know it and which findings cite it. Each such finding in `product.md` gets a line "Rests on the person's statement: [c5] (did it myself). A statement, not data from a source.", and the provenance has a `person` block. Check 5 fails a finding that cites a statement when the sources do not say so.

### Overruling a finding

In the Narrative lens, each finding has an Overrule button that opens its form in place: a likelihood, a confidence, whether it must stay or be dropped, and a note, which is required. Your latest overrule of a finding replaces the earlier one; setting nothing withdraws it. Overrules hold for the whole case, not one run.

Code holds every draft to your overrule, not the analyst's prompt: Assemble's builder sets the likelihood (and words the statement again), the confidence, or restores or drops the finding in each draft it makes. Neither reviewer may move it back: a point that would do so is refused or not sent back, and a draft that does not hold an overrule cannot be published. An overrule made while a run is in progress, off the publish gate, sends the work back to Assemble when the current stage ends, with your overrule as the reason, so the analyst rewrites the finding's confidence basis and reasoning to rest on your note. At the publish gate nothing goes back by itself: see "Your changes at the publish gate" below. A reviewer's point about the overruled finding's reasoning or wording still goes back to the analyst; only a point that asks for another value is held. The published product says under the finding which value you set, with your note, and the provenance lists your overrules.

### Revising a ruling

When Evaluate and Challenge disagree on a finding, the run waits for your ruling. You can change a ruling while its run is in progress ("Change the ruling" in the Narrative lens). The latest ruling is the one that holds; the earlier ones are kept and shown as replaced. A ruling changed at the publish gate waits with your other changes (below). Between a ruling and an overrule of the same finding, the later one holds: an overrule made after a ruling takes its place, and a ruling that keeps a value, made after an overrule, takes the overrule's place.

### Your changes at the publish gate

At the publish gate an overrule, a revised ruling or an answer does not send the draft back by itself, so you can make several against the draft on screen. The gate box lists them under "Your changes" (each with its finding's id) beside Approve, with one button, "Send back to Assemble with my changes": it records a send-back in your name with all of their reasons together (`send_back_changes`, or the button), and the run goes on from Assemble. While changes are unsent, Approve reads "Approve without my changes" and the box says the draft does not hold them; Approve stays the gate's own button, and a draft that does not hold an overrule still cannot be published.

### Questions

Plan, Research and Assemble may put a question to you with `ask_person` (the sample gives those three stages the skill `ask-the-person`; the reviewers may not ask). A question says why it matters and which cards and values it is about. It appears in Questions for you, under the brief and at the top of the Narrative lens, and the brief counts the questions waiting for you; once answered it folds to one line with its answer card. Answer it there, or with `answer ask-1 <text>` in the command bar. The answer is a card, a statement that answers the question, marked at least as strictly as the case and as the model request that wrote the question. A question takes one answer; to correct one, add a statement.

At most `questions.max_open` questions (default 3) may be unanswered in a run; `0` turns asking off:

```yaml
questions: { max_open: 3 }
```

A stage may mark its question blocking when its result would be wrong without the answer. The stage finishes its pass, and the run then pauses before the next stage, waiting for your answer. Answering resumes the run by itself. Resuming without an answer goes on without it: the question is recorded as gone on without, that stage's later questions do not block, and every draft names it under "Questions the person has not answered:" in its gaps and limits. Check 8 fails a draft whose gaps do not name an open question.

## Before a run

```bash
bun run preflight --config ~/workbench/config.yaml
```

It reads your files and asks your model server what it has. It never contacts a data source, opens no workbench and writes nothing. It prints one line per check, then `ready` or `not ready: N to fix`. It exits 0 when ready, 1 when not, 2 for a wrong command line. A line starts with `ok`, `FAIL` or `note`.

- `configuration`: which file was read.
- `outside the repository`: the configuration, secrets file and roots are not inside this repository.
- `secrets`: every credential a root may use has a usable value.
- `manifests`, `pipeline`, `checks`: they load without a problem.
- `lake sources`: none is open to agent-written queries. A note says an unguarded table or an unchecked certificate.
- `pivots`: every pivot renders against the guard. This is where a refusal from the last section shows up.
- `model listed`, `model loaded`, `context`: the model server lists the model, it is loaded, and the context each request has holds at least 32768 tokens (change this with `--min-context`).
- `context fit`: every stage's reply cap (`max_output_tokens`) leaves the pack its half of the context each request has. If it does not, the line names the cap that fits.
- `marking policy`: every source's marking may go to every stage's model.
- `model answers`: one fixed test question, with no case data, answered with a well-formed tool call. It is the only thing preflight sends anywhere, and no ledger records it. `--no-question` leaves it out.

The rule is `max_output_tokens + floor(slot × 0.5) ≤ slot`, where `slot` is the context divided by `parallel`. A stage that names a `fast_model` is checked for it too, as `<stage> (fast)`.

Load the model in one slot. If the server splits the context between several slots, each request has only its share, so `parallel` in the model manifest says how many slots share the context, and `context` is the whole of it. Preflight checks the reply caps against the share, and a stage whose cap does not fit stops before it calls the model.

A reply is streamed, and watched as it comes in. A model that falls into a loop, saying the same thing over and over until its output limit, is cut off at once instead of running for minutes. The reasoning and the reply are watched apart: either is a loop when its last `window` characters have already appeared `repeats` times before. The reasoning is also a loop when it ends in one short passage (20 to 200 characters) said at least 40 times in a row over at least 4000 characters; the reply is not read for that, because a table or a JSON array repeats a row by nature. The model manifest sets this with `loop_guard: { enabled, window, repeats }`; each left out is its default (on, 400, 3). The cut reply is in the ledger as a failed response, with what the model had said so far and the text it repeated. When the manifest's `efforts` list `none`, the same request is then made once more with `reasoning_effort: none`, which turns the model's thinking off, and the ledger notes why. Otherwise, or when that loops too, the stage fails as on any other model failure.

When `model loaded` fails, load the model in the model server's own loader, with a large context (131072 tokens is a good start), and run preflight again. Do not start a run on a model that loaded itself on the first request. An automatic load may use the server's small default context, and a run needs a large one.

When it says `ready`:

```bash
bun run serve --config ~/workbench/config.yaml
```

It prints the address and any `problem:` lines. Fix those first.

## Custody

- The chip. The brief at the top of a case shows a custody chip, for example "chain intact · 412 entries", or an amber warning naming the failing entry.
- `bun run verify <case folder>` recomputes every hash from the first entry and checks every blob, with no server running. It exits 0 when the chain is intact.
- Verify, on a card, re-runs the card's stored query as a new logged query and compares the result. It says validated, differs (the source may have changed) or could not run. The original is never replaced.
- Replay, a lens, steps through the case one recorded action at a time.

## Cases: load and unload

A case is **loaded** while its folder is in `<data_dir>/cases/` (`ledger.sqlite`, `blobs/`, `published/`); the case list shows the loaded cases and nothing else. **Unloading** packs the case into one file in the **case store** and takes it out of the working set. **Loading** checks a case file, verifies the chain it holds, and brings the case back. The case store is a folder you choose, `<data_dir>/store` unless the configuration says otherwise; a backup disk, a share, or a folder another program reads will do. Export and import are the same two operations against another folder: `unload --to <dir>` and `load <file>`.

```yaml
cases:
  store: /srv/workbench/store   # the case store (default <data_dir>/store); relative to this file
  on_complete: keep             # keep (default) or unload: the default of "Unload after publishing"
  max_bytes: 2147483648         # the largest case file a load accepts (2 GiB)
```

The four commands, with your configuration's `--config` on each:

```bash
bun run cases unload CASE-1 --config ~/workbench/config.yaml
bun run cases unload CASE-1 --to /mnt/backup/cases --config ~/workbench/config.yaml
bun run cases load CASE-1 --config ~/workbench/config.yaml
bun run cases load /mnt/backup/cases/CASE-1.TLP-GREEN.tar.gz --config ~/workbench/config.yaml
bun run cases store list --search 198.51.100.77 --config ~/workbench/config.yaml   # by id, title, question or starting value
bun run cases store delete CASE-1 --config ~/workbench/config.yaml
```

- `unload` and `load` take the workbench's lock, so the server must be stopped while they run (in the interface the server does the same work itself). `store list` and `store delete` read only the store folder, so they work while the server runs. `load` takes a case id (the file of that case in the store) or the path of a file.
- `store delete` shows the case and asks you to type its id; it removes only that file from the store (a loaded case is not touched) and writes a line to `<store>/deleted.log` (id, title, head, when, who) before the file goes. The server checks the typed id too.
- **The file.** One `CASE-12.TLP-AMBER.tar.gz` per case: the marking is in the name. Its first member is `case.json`, the manifest: the format (1), the case id, the hash of entry 1 (`origin`), the title, the question, the marking, the starting values, the run's status and outcome, the products published, the head (its sequence number and hash), the number of entries, the workbench version, when it was unloaded, and the size and sha256 of every other file. The rest is every regular file of the case folder, unchanged. Nothing is redacted or left out; a folder that holds a link or a special file is not packed, and the unload says which.
- **The record goes with the case.** The ledger records `case.unloaded` (who, the store's name and the head before it) before the file is made, so the file holds that entry and its head is the one `case.json` names. A load records `case.loaded` (who, the file's name and the head it arrived with). Every entry before them is the same, byte for byte, so `bun run verify <data_dir>/cases/CASE-1` checks a loaded case like any other, and Replay shows it from entry 0.
- **What may be unloaded.** Not while a run is running, a job or a query is running, or your agent is answering; pause or stop the run first. A paused or waiting run may be unloaded, and it comes back paused or waiting. The store file stays when a case is loaded; the next unload replaces it.
- **Unload after publishing.** At the publish gate a box beside Approve, "Unload after publishing", is ticked or not as `cases.on_complete` says, and you may change it before you approve. Its value is recorded on your approval, and once the run has finished as published the workbench unloads the case. `bun run investigate approve CASE-1 --unload` (or `--keep`) does the same on the command line. If that unload fails, the case stays loaded, its tile says "unload failed" with the reason, and the failure is in its ledger; it is not tried again by itself.
- **One id everywhere.** A case keeps the id it was made with, wherever it is loaded. A file whose id is held here by another case (another entry 1) is refused with "CASE-1 is taken here by another case"; the same case loaded twice is refused as "already loaded". The id counter never gives an id twice: it counts the loaded cases, the store's file names, `deleted.log` and a mark in the data folder (`cases/.high-water`) that only goes up, so an id stays used after its case was unloaded elsewhere, deleted, or while the store is unplugged.
- **A stop in the middle.** An unload writes the file under a temporary name, reads it back against `case.json`, puts it in place, and only then takes the folder out of the working set. A stop or failure before that last step leaves the case loaded; the ledger records `case.unload_failed` (at the next open, after a stop) and the next unload replaces any file already written. A load extracts to a temporary folder, checks every file and verifies the chain before the case appears, and refuses the whole file otherwise.

## Loops

A **loop** is the order of work a case follows: its stages, their gates, the context each stage is given, the checks that run on a draft, and which stage runs another loop. It is a manifest (`kind: loop`) in a module root's `loops/` folder, like any other. A case is made for one loop, and its run binds the loop's version when it starts: a `loop.bound` entry names the loop, its version and its pipeline hash, and the lock (every stage, persona, rules, skill, schema and check it resolved to, each with its hash) is a blob of the case. A loop edited while a case runs on it does not change that run; the case's next run binds the new version. A case made before loops existed goes on as it did, held to the hash it recorded.

The sample has five loops:

- **Investigation** (`sample/loops/investigation.yaml`): the nine stages, Frame to Feedback, with the plan gate and the publish gate. It is the default loop (`loops.default`), and every case made without `--loop` is one of it.
- **Unknown device** (`sample/loops/unknown-device.yaml`): the investigation's nine stages written inline, for cases of the type `unknown-device`, with memory: Plan, Research and Assemble are given the shared lessons a person accepted for the type, Research and Assemble the case's notebook, Research may write a note, and Feedback proposes lessons. See [Memory](#memory).
- **Triage** (`sample/loops/triage.yaml`): Sort, which turns a report into one question, then Investigate, which runs the investigation loop as a **child case** and brings its findings back. Triage has no gate of its own: the child's plan and publish gates are the person's, passed in the child, and while the child waits the triage case is paused, "waiting on child CASE-2". When the child publishes, its findings come back to the triage case as note cards that say where they came from (the child, its loop, its run, its head), carry the marking of the child's product, and cite nothing of the triage case. The triage run then ends as `completed`. Replaying the triage case reads the child's head and the hash of what came back from its own ledger; it never opens or re-runs the child.
- **Device check** (`sample/loops/device-check.yaml`): six stages written inline, for cases of the type `device-check` ("Which device held this address?"), on its own script. It is the target of the sample's improve run.
- **Improve** (`sample/loops/improve.yaml`): the improve loop's seven stages, Select to Adopt. See [Improve a loop](#improve-a-loop).

The command line, with `--config <file>` on each and the server stopped:

```bash
bun run loops list
bun run loops show triage
bun run loops export triage --to <dir>
bun run loops import <dir>/triage.v1.<12 hex>.loop.tar.gz
bun run loops trust triage-<12 hex>
```

`list` prints each loop with its version, the first 12 hex of its pipeline hash and its stages, or why it is not usable. `show` prints each stage with its gate, its send-back edges and its three groups (context, middleware, orchestration), each item with its source and hash. `export` writes a **loop file** into `loops.store` (`<data_dir>/loops`) unless `--to` names a folder. `import` checks a loop file and writes what it holds into a new folder of `loops.imports` (`<data_dir>/imported`), a root that is **not trusted**; `trust` adds that folder to the configuration's `roots` as trusted, after printing what it will supply. Neither `import` nor `trust` needs a usable loop, so a first import into an empty root works. What a loop file holds and never holds is in [docs/security-notes.md](docs/security-notes.md).

A case of another loop is started with `--loop`:

```bash
bun run investigate start --loop triage --sample-fixture --title "Triage" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" \
  --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN
```

It prints that CASE-1 waits on child CASE-2, and the command that passes the child's gate. The child's `accept-plan` and `approve` carry the triage case on by themselves; [sample/README.md](sample/README.md) walks through it. In the interface, the Loops tile on Home lists the loops, opens a plain outline of each, copies and edits one in forms (a save is the loop's next version), exports, imports and trusts loop files, and starts a new case from a loop; see [docs/gui-guide.md](docs/gui-guide.md).

The configuration's `loops` block, with its defaults:

```yaml
loops:
  default: investigation          # the loop of a case made without --loop
  max_depth: 2                    # the most levels of child cases below a case no case started
  max_children: 8                 # the most child cases one case may start
  store: <data_dir>/loops         # where export writes and the Loops page lists loop files
  imports: <data_dir>/imported    # where an import lands; each folder is a root that is not trusted
```

## Build a loop with help

The Loops page, and each loop's page, has a panel **Build with help**: a conversation with a **builder**, an agent that helps you wire a loop and what it needs (a source for a database or a service, its pivots, its field notes, a playbook, a skill, a stage). It does three things, and only three:

- **It reads** the catalogue: the loops and their stages, the sources with their fields and pivots, the connector kinds and what each needs, the roots and whether each is trusted, and whether a file it drafted would pass a save's check. What it reads has every source's location and user, every path and every secret value taken out; roots are named by their folder's name, and credentials only by their names.
- **It proposes** whole files under the root a save writes into. Each proposal is checked exactly as a save is checked, on a copy of the root with the files laid over it; one that does not pass is the builder's error, with the reasons, and you never see it. One that passes is shown to you file by file, as a diff against the file on disk. You **Accept** or **Reject** each file. Only an accepted file is written, in your name, and it is checked again against the root as it is then, so a file that needs another accepted first is refused with the reason. A file that changed on disk after it was proposed is *stale* and cannot be accepted: ask the builder to propose it again.
- **It asks for a probe**: one loaded pivot on one value, or one read-only query on one loaded source (for example the statement that lists a SQLite file's tables). Nothing runs until you **Approve** it; then it runs through the same runner and query guard as a case's queries, in your name and with your budget when it is costly, and its answer is a card of the conversation. One probe waits at a time. To probe a source or pivot it proposed, accept its file first.

The builder never decides, never writes a file and never sees a secret. A credential is named in a source by reference (`credential: <name>`), granted to its root in the configuration (`roots[].credentials`), and its value is set outside the workbench, in the secrets file or the environment. A file that holds a secret value or a key such as `password` is refused, and a value of a secret the workbench holds that is pasted into the conversation, or written by the model, is recorded as `[redacted secret]`. Each conversation is a ledger of its own, `<data_dir>/builders/BUILD-N/`, recorded like a case: what you asked, what the builder read, what it proposed, what you accepted or rejected, the probes and their answers. Its marking starts at the one you pick and rises to the strictest card a probe brought back, and that marking governs which models it may be sent to. Every file you accept is also recorded on the workbench chain as `manifest.written`, with `why: builder` and the conversation's id.

The sample has a scripted builder conversation, `sample/scripts/sample-builder.yaml`, over the sample's partner blocklist (`data/blocklist.sqlite`, generated with the rest of the sample data and named by no source): asked for the blocklist as a source with a pivot from an address, and for a loop that rechecks an address with the investigation, the builder reads the catalogue, has a deliberately bad pivot (a query that deletes) refused by the guard, and proposes the source with its field notes and the pivot `address_to_blocklist`, then the stage `recheck` and the loop **Triage recheck**. Once the four files are accepted it asks to list the blocklist's tables, then to run the new pivot on `198.51.100.77`. The two tests drive it end to end on the scripted model, the second in a real browser:

```bash
bun test tests/sample/builder-acceptance.test.ts
bun test tests/web/browser-builder.test.ts
```

## Memory

A case can carry what was learned forward in two ways, and both are notes, never rules.

**The notebook** is a case's own memory: short notes (`fact`, `decision` or `pointer`, at most 600 characters, naming up to 10 cards), entries of the case's own ledger. An agent adds one with the tool `note_memory`, only where its loop's stage lists the tool; a person adds, revises or drops one in the case's **Memory lens** (key `m`). A note is not evidence and is never cited. It reaches a stage only where the loop names `memory: case/notes` for one of that stage's references, as the stage starts; at most `memory.max_notes` (40) notes are live at once.

**Shared lessons** are memory across cases. A lesson belongs to one **case type** (a `case-types` manifest of a trusted root: `id`, `title`, `about`), has a title (120 characters), a text (1200), a marking and up to 8 triggers (`{ observable: <type> }`, `{ source: <id> }`, `{ finding: <words> }`; all must match, and a lesson with none applies to every case of its type). Lessons live in the **memory store**, a ledger of its own at `<data_dir>/memory`, apart from every case.

How a lesson becomes shared:

1. It is **proposed**, from one of three places: a loop's Feedback stage that runs an agent with the `lessons-output` schema (after a published run of a typed case, its model is asked what would have made the case faster or more correct, and up to three answers are filed, each checked by code; one that does not check out is dropped with its reason, the others are filed as proposals); a person (the Memory page, or `bun run memory propose`); or a `lesson-seeds` manifest of a trusted root, which the workbench files once per item when `serve` or `investigate` loads the roots.
2. **A person accepts it** (or rejects it, with a reason). Only a person does; a model, a stage or a seed never shares a lesson. Accepting names the hash of the proposal the person was shown, so a proposal changed since then is refused, and it may raise the lesson's marking but never lower it. A shared lesson can later be retired, or replaced by a new version.
3. When a run of a loop that reads shared memory starts, code **selects** the shared lessons of the case's type whose triggers match the case (its observable types, the sources it used or its loop lists in `uses.sources`, the words of its latest findings) and that are not marked stricter than the case, newest acceptance first, at most `memory.max_lessons` (12). No model chooses what is loaded. What was selected, with each lesson's whole text, hash, marking, provenance and the triggers that matched, is **locked** into a blob of the case (`memory.bound`), so a replay or a case file needs no store. A lesson reaches only the stages whose loop names `memory: shared/<type>` (or `shared/*`) for a reference, as a part of its own after the stage's rules, persona, procedure and the case, under a line that says it is a note to weigh, not a rule.

A case gets its type at creation (`--type`, the new-case form, or the loop's `case_type`), or from the person later. A case of a loop that reads shared memory and has no type is asked: Frame proposes a type and the run waits on a blocking question after Frame; the person's answer sets the type, the lessons of that type are bound, and only then does Plan run. A resume without the answer goes on with no case type confirmed and no shared lessons loaded; the pause and the case's Memory lens say so. A case with no type is given no shared lesson. A loop that names no memory (the sample's investigation and triage loops) writes no memory entry at all.

The command line, with `--config <file>` on each; every form but `verify` needs the server stopped:

```bash
bun run memory list [--type unknown-device] [--status proposed]
bun run memory show LESSON-1
bun run memory propose --type unknown-device --title "..." --text "..." --marking TLP:GREEN --when observable=address
bun run memory accept LESSON-1 [--marking TLP:AMBER]
bun run memory reject LESSON-3 --reason "too general"
bun run memory retire LESSON-2 --reason "the asset list is no longer complete"
bun run memory export [--to <dir>]
bun run memory load <dir>/memory.TLP-GREEN.<12 hex>.memory.tar.gz
bun run memory verify [--case CASE-2]
bun run investigate start --type unknown-device ...
```

`export` writes a **memory file**, `memory.<marking>.<12 hex of its head>.memory.tar.gz`, into `memory.files` (`<data_dir>/memory-files`) and leaves the store in place. `load` replaces the whole store, and only when the store here is empty, holds only the seed proposals a first start filed (no person has proposed, accepted, rejected or retired anything in it), or the file is the same store further on; stores are never merged. After a load, the next start files again any seed of the roots the loaded store does not hold, as a proposal. `verify` checks the store's chain and every lesson's hash and, with `--case`, each lesson the case's runs were locked to against the store here. In the interface the **Memory** tile on Home opens the Memory page (proposals to review, shared lessons, export and load), and a case's Memory lens shows its type, its notebook and the lessons its run was given and why; see [docs/gui-guide.md](docs/gui-guide.md). What memory holds, who writes it and how markings gate it is in [docs/security-notes.md](docs/security-notes.md), and the sample's Unknown device loop in [sample/README.md](sample/README.md).

The configuration's `memory` block, with its defaults:

```yaml
memory:
  store: <data_dir>/memory          # the shared store's ledger
  files: <data_dir>/memory-files    # where export writes and the Memory page lists memory files
  max_lessons: 12                   # the most shared lessons a run is given
  max_notes: 40                     # the most live notes a case's notebook holds
```

## Improve a loop

The **improve loop** tries changed versions of a loop against cases whose right answer you know, scores them in code, and offers the best one for you to adopt. It never changes a loop by itself.

1. **Known answers.** On a published product of a case, you set a **known answer**: a text (600 characters at most) and up to 12 expected findings, each a claim, a likelihood term of the case's standard and a confidence, and optionally marked *theirs to say* (`asks: true`) for a claim only you know, such as who owns a device: the investigation should ask you, not guess. It is an entry of that case's own ledger, in your name; a later one for the same product replaces it, and you may withdraw it. A case of the type with a known answer on a published product is a **task**.
2. **An improve case.** "Improve this loop" (on a loop's page) or `bun run improve start` makes a case of the loop `improve` for a target loop and a case type, with how many tasks (1 to 8) and candidates (1 to 4) to try, and starts it. Its seven stages run in a fixed order:
   - **Select** takes the newest tasks, up to the number asked, leaving out any stricter than the improve case, and records the target loop's version. It copies the seq and hash of each known answer, never its text.
   - **Propose** is an agent with the loop builder's tools. Each change it proposes is checked as a save is, then by the candidate rules: it may change only a skill's or a procedure's text, a playbook's steps and end, a source's field notes, and a stage's tools, turn cap and efforts, and only in a file the agent was shown (a change of a file left out of its context is dropped, with the reason). A change that passes is **staged**: built beside the live loop, in `improve.staged` (`<data_dir>/staged`), without writing a root, the workbench chain or the content store. A staged version covers every file of its change: a source's field notes and a playbook's steps are named in its lock beside the loop's components, and its probes query through a registry loaded from a snapshot of the root with the change laid over it. A staged version is never listed, current or bound by a case of yours, and Adopt writes a candidate only when the root with its files laid over gives the version that was probed.
   - **Probe** runs every task again as a **probe child** under the unchanged loop (`base`) and under each candidate (`K1`, `K2`, …), so 3 tasks and 2 candidates make 9 children. A child's plan gate is the one gate code passes: free steps only, no budget, so nothing costly runs in a probe. Its queries go through the same runner and guard as a case's, against the live sources, and the children share `improve.probe_lookups` and `improve.probe_tokens` evenly. The shares are per run: a second run of the same improve case is given them whole again. A child's lookups are a hard cap; its tokens are checked between model calls, so one call may go past its share. A child never publishes; it ends at its publish gate, and its latest draft is the output. A child that asks the person a blocking question goes on without the answer, as your resume without it would (no one is there to answer); the question stays asked, and the output lists the questions it asked.
   - **Compose** is an agent that compares the outputs and chooses a candidate, or none. It is told which output is the base's and nothing of the answers.
   - **Judge** then scores each output against its task's known answer, in code, from 0 to 1000: a claim matched by shared words is worth 500, likelihood agreement up to 250, confidence agreement up to 250. A claim that is theirs to say also counts when the probe asked you about it: 1000 × min(1, (such claims + 1) / the questions the probe asked), the better of that and a finding stating it. The Judge is the only stage that reads an answer, and it runs only after Compose has chosen; a Judge stage has no tools, so nothing it is shown reaches a later stage. A task whose answer you withdrew after Select is not scored, and the Judge says so.
   - **Reflect** is an agent given the comparisons and the scores, never an answer. It may propose lessons to the shared memory, which wait for a person like any other proposal.
   - **Adopt** waits at the `adopt` gate, for you, when a candidate was chosen. You accept or reject the whole candidate. Accepting writes every file of it into the root in your name, as an accepted builder file is written, and only if the root still gives the version that was probed. The next case of the loop binds that version, a normal saved version. When the run ends the staging folder is removed; the probe children stay and verify on their own.

The improve case's ledger records what Select took, each probe's output with the child's head, the choice, the answers' copy and the scores, so it replays and verifies without its children or its tasks. `bun run verify` also checks each probe against its child where the child is loaded, recomputes the scores from the improve case alone, and fails a case where a gate was passed by code anywhere but a probe child's plan gate and its questions passed over, or where an accept wrote a file the probed version does not name.

The command line, with `--config <file>` on each and the server stopped (it decides nothing at Adopt: that is the browser's Improve lens):

```bash
bun run improve answer CASE-1 --product 1 --text-file <file>.txt --findings <file>.json --marking TLP:GREEN
bun run improve withdraw CASE-1 --product 1 --reason "the device was renamed"
bun run improve start device-check --type device-check --marking TLP:GREEN --tasks 3 --candidates 3
bun run improve show CASE-4
```

`answer` sets the known answer on a published product, its text from `--text` or, kept out of your shell's history, `--text-file`; the findings file is a JSON list of `{ claim, likelihood, confidence }`, each likelihood a term of the case's own standard, with `"asks": true` on a claim that is yours to say. `start` makes the improve case, runs it as far as it goes and prints `show`, which gives the tasks, the candidates, each probe with its child and outcome, the choice and, once the Judge has run, the scores. The sample's Device check loop has a scripted improve run; [sample/README.md](sample/README.md) walks through it, and what the improve loop may and may not do is in [docs/security-notes.md](docs/security-notes.md).

**Upgrading a root.** A root that keeps its own copy of `context/schemas/judge-output.yaml` must add the optional `asked` array to it (`{ probe, expected, question }` items, as in the sample's copy), or a Judge model can never name a question to the person that asks about a claim that is theirs to say; code still matches such questions by their words.

The configuration's `improve` block, with its defaults:

```yaml
improve:
  max_tasks: 3                 # the most tasks one improve run selects
  max_candidates: 3            # the most candidates one improve run tries
  probe_lookups: 240           # the lookups all of one run's probe children share
  probe_tokens: 1200000        # the tokens all of one run's probe children share
  own_tokens: 400000           # the improve case's own run budget
  staged: <data_dir>/staged    # where staged candidates are built; a cache. Never the data folder, a folder that holds it, or a folder the workbench keeps (cases, stores, roots); a sweep removes only the folders staging made
```

## A synthetic company

A **synthetic setup** is a whole workbench over an invented company: pivot's fake lake (a month of thirteen log sources, with their noise,
their mess and nine planted storylines), a root over it, and the ground truth of each storyline. It is for practising investigations and for
giving the improve loop tasks whose answers are known. It shares nothing with your own setup: it is built in a folder of its own, with its
own data folder, its one trusted root and its own configuration, and it never reads or writes `<lake>`, your data folder, your roots or your
configuration. Everything in it is synthetic. What is in it, how a query is priced and where its answers are kept is in
[docs/synthetic-company.md](docs/synthetic-company.md).

Build one in a new or empty folder `<synth>` outside `<repo>`, on the scripted model or on a model of yours:

```bash
bun run synth build <synth> --scripted
bun run synth build <synth> --base-url http://127.0.0.1:1234/v1 --model example/model-a
```

The build refuses a folder that is not empty, a folder inside this repository, and a folder that is, holds or sits inside the data folder, a
root or a store of the configuration the workbench would load with no `--config`. It prints the tables with their simulated sizes and the
storylines placed by id and case type, never whether one is malicious. A `--scripted` setup's stages name the scripted model `synth-run`,
which is not shipped: write `<synth>/root/scripts/synth-run.yaml` before a run. Every other form takes the setup's own configuration and
refuses one with no `synth.json` beside it, so a synthetic case is never made in your data folder:

```bash
bun run serve --config <synth>/config.yaml
bun run synth tasks --config <synth>/config.yaml
bun run synth answer CASE-1 --config <synth>/config.yaml
bun run synth seed-tasks --config <synth>/config.yaml
bun run improve start investigation --type suspicious-signin --marking TLP:GREEN --config <synth>/config.yaml
```

`serve` opens the setup on port 4757. `synth tasks` (with the server stopped) makes a case for each storyline's task, titled `[synthetic] …`,
of its case type, marked `TLP:GREEN`, and puts its ground truth beside the cases folder, at `<data>/synth-truth/<case>/ground-truth.json`.
Work the case as any other; once it is published, `synth answer` sets its known answer from that truth, as you. `synth seed-tasks` makes, for
each storyline, a case of the scripted seed loop `synth-seed`, accepts its plan with no budget, approves its product and sets its known answer:
a task for the improve loop at once, with nothing costly run. Its product judges nothing (it is not the answer, so Propose is never shown the
truth). `improve start` then tries changed versions of the investigation loop against those tasks. `bun run synth show --config
<synth>/config.yaml` prints the setup and the case each storyline became; `--reveal` prints the verdicts, and spoils the cases.

**What costs money there.** Nothing is real money: the `fakeathena` connector bills in simulated USD, as a scanning lake does. Seven sources
are costly (`signins`, `process`, `dns`, `proxy`, `flows`, `email`, `cloud`): 5 USD a terabyte of the simulated bytes a statement reads, only
the days its window touches and the share of the columns it names, at least 10 MB a query. `reputation` costs 0.002 USD a lookup; `groups`,
`dhcp`, `wifi`, `vulns` and `assets` are free. At the plan gate each costly step shows its estimate in USD, made by an estimate query the
runner records, and waits for the budget you give it; a budget below the estimate runs nothing of it:

```bash
bun run investigate accept-plan CASE-1 --budget s2=0.5 --config <synth>/config.yaml
```

**Sizes.** The default company (30 days, 200 people, 300 hosts, 3 sites) is a lake file of about 1.1 GB whose tables read, at the default
scale, as a few terabytes. The tests build a tiny one (4 days, 12 people, 16 hosts, 2 sites, a twentieth of the volume): a file under 1 MB
whose tables read as about 13 GB. A build is projected first (the rows of each table at their width, times 1.8 for SQLite's overhead), and one
projected over 2 GB is refused before a file is made; take fewer days, hosts, people or less volume.

## Known limits

- Build with help offers the models that the loops' stages name, so in the interface a builder conversation cannot be given the sample's scripted builder (`scripted / sample-builder`); the tests above set it through the conversation's model route.
- A route that is in flight cannot be ended. Stopping the run stops what comes next, not a query already started.
- A lookup run from the Pivot budget block is recorded, but is not part of the route's trail.
- The files database is rebuilt for each query, so a large file source is slow.
- The entry stream has no backpressure limit, and each read opens the case again.
- There is no sign-in. The server answers on `127.0.0.1` only, for one person on one machine. See [docs/security-notes.md](docs/security-notes.md) for what is and is not guaranteed.
- Source text is untrusted. Rows, notes and manifest text from a source are shown as text and treated as data, but a source can still say something misleading.
- A source's own words can reach a model. Text from an untrusted root (source and pivot titles, quality notes, the titles of cards made from its sources) is withheld from what a model is shown, but a source from a trusted root can still say something misleading.
- The lake guard is strict, and it is written for one query engine's rules. It has been tested against a stand-in, not against every way an engine can read a statement. Treat it as one safeguard among several (read-only access, `adhoc: false`, the row estimate and the budget), not the only one.
- A card that a published product cites can be discarded afterwards. The published bundle is unchanged, but the case no longer shows the card as live.
- A server error from a case ledger that cannot be read shows as a generic 500.
- A playbook cannot be given a budget: a costly lookup in it waits, and a person runs that pivot by hand.
- A step starts from the type its earlier step's pivot yields, not from a named column of its rows.
- The fast model (`fast_model` in a stage manifest) has no dropdown; it is set in the manifest only.
- Run one researcher at a time against a real lake (`research.parallel: 1`, which `new-root` sets).
- A statement by the person is not drawn in the Timeline or the Graph: it observed nothing in a source. Its values show on its card.
- A reviewer that keeps failing a draft only over a value you overruled pauses the run each time (it cannot move the value back, but "Evaluation failed on this revision" stays a publish blocker): edit the draft, or choose another model for that reviewer.
- An overrule sets a finding's likelihood, confidence or place in code; the confidence basis and reasoning are the analyst's until its next Assemble pass rewrites them. An overrule made with no run in progress reaches the next run's drafts but is not sent to the analyst as a reason.
- A blocking question holds the run after its stage's pass, not inside it: that stage does not run again on resume, so it finished its work without the answer. The stages after it read the answer.
- The case store may be shared by several workbenches, so a temporary `.part` file an unload left behind after a stop is never removed by the workbench: the Case store view and `store list` count it as a leftover, and you remove it by hand. Its name carries the case's marking (`.tmp-CASE-1.TLP-AMBER-<pid>-<uuid>.part`), and it is a whole copy of the case.
- An unload never replaces a file of another case that has the same id (two workbenches sharing a store or an export folder both have a CASE-1), nor a later or diverging copy of the same case: it is refused and nothing is written. It replaces only an earlier copy of the same case. A store or `--to` folder inside `<data_dir>/cases` is refused.
- The Case store view and `store list` check each file against its own ledger: a file whose `case.json` gives another title, question, marking, starting value, status or products than its ledger is listed as unreadable, and a load refuses it.
- A case file from another workbench whose id this workbench used once, for a case now unloaded elsewhere (not to this store), cannot be told from that case coming back, so it loads.
- A tab does not read the custody or the blobs of a case while it is being unloaded. A read already on its way when the unload began is refused with 409 (the browser may log that); it is not shown as a failed check, and it is asked again if the case stays.
