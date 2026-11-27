# Research Workbench

## What this is

A workbench for an analyst who investigates on their own network. You ask a question. Agents do the legwork: they frame the run, plan routes over the data you can reach, run the queries, put the findings together, check them and attack them. You stay at the gates. Nothing is published until you press Approve. The aim is speed without losing control.

Every action is written to an append-only ledger, and each entry is chained to the one before by a hash. The exact queries, the sources, the models' answers and your own decisions are all in it. Any finding can be traced to the bytes behind it, re-run, and replayed one action at a time. That chain of custody is the point.

The catalogue of sources and pivots, the query guard, the connectors and the route search come from [pivot](https://github.com/homelab-next/pivot), the workbench's one first-party dependency, pinned to the tag `v0.1.0` in `package.json` (the lock file pins the hash of the annotated tag object, which names exactly one commit). pivot only plans and reaches sources; the workbench keeps its own custody. Every query it sends goes through its runner and into the case's ledger, never through pivot's run endpoint or log. There is no third-party runtime dependency.

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

## The person

You know things no source holds, and you can go and look. The workbench records what you say as yours, keeps it apart from what a source returned, and labels every finding that rests on it.

### A statement

"Add what you know" in the Incoming column (or `state <text>` in the command bar) records a statement: your text (at most 4000 characters), how you know it (saw it myself, did it myself, was told, or did not say how; the command bar records "did not say how"), an optional detail (at most 500 characters), up to 20 values it is about, and a marking no lower than the case's. It is a card made by you, with no query, no source and no rows. It is shown as "your statement", never as "nothing found".

An agent is shown it as "Source: the person (…). A statement by the person running the investigation, not data from a source." and may cite it like any card. When a draft cites a statement, the workbench (not the analyst) writes a sources entry "the person" naming each statement, how you know it and which findings cite it. Each such finding in `product.md` gets a line "Rests on the person's statement: [c5] (did it myself). A statement, not data from a source.", and the provenance has a `person` block. Check 5 fails a finding that cites a statement when the sources do not say so.

### Overruling a finding

In the Narrative lens, each finding has an Overrule form: a likelihood, a confidence, whether it must stay or be dropped, and a note, which is required. Your latest overrule of a finding replaces the earlier one; setting nothing withdraws it. Overrules hold for the whole case, not one run.

Code holds every draft to your overrule, not the analyst's prompt: Assemble's builder sets the likelihood (and words the statement again), the confidence, or restores or drops the finding in each draft it makes. Neither reviewer may move it back: a point that would do so is refused or not sent back, and a draft that does not hold an overrule cannot be published. An overrule at the publish gate sends the work back to Assemble, with your overrule as the reason, so the analyst rewrites the finding's confidence basis and reasoning to rest on your note.

### Revising a ruling

When Evaluate and Challenge disagree on a finding, the run waits for your ruling. You can change a ruling while its run is in progress ("Change the ruling" in the Narrative lens). The latest ruling is the one that holds; the earlier ones are kept and shown as replaced. A ruling changed at the publish gate sends the work back to Assemble with the new ruling as the reason. An overrule made after a ruling on the same finding takes the ruling's place.

### Questions

Plan, Research and Assemble may put a question to you with `ask_person` (the sample gives those three stages the skill `ask-the-person`; the reviewers may not ask). A question says why it matters and which cards and values it is about. It appears in the Narrative lens's question box, and the brief counts the questions waiting for you. Answer it there, or with `answer ask-1 <text>` in the command bar. The answer is a card, a statement that answers the question, marked at least as strictly as the case and as the model request that wrote the question. A question takes one answer; to correct one, add a statement.

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

## Known limits

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
- An overrule sets a finding's likelihood, confidence or place in code, but leaves the analyst's confidence basis and reasoning as written until the analyst rewrites them.
- A blocking question holds the run after its stage's pass, not inside it: that stage does not run again on resume, so it finished its work without the answer. The stages after it read the answer.
