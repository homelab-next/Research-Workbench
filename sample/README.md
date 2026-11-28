---
kind: readme
id: sample
title: Sample module root
---
# Sample module root

Synthetic data with one planted story, for tests and demos. Everything here is invented: reserved
example addresses (192.0.2.x, 198.51.100.x, 203.0.113.x), example.com/.net/.org names and made-up accounts.

- Generate the data (written to `sample/data/`, not committed): `bun run sample:data`
- Start the stand-in reputation service on 127.0.0.1:4801: `bun run sample:fixture`

The story: account `j.doe` signs in to `ws-17.example.net` from an address it has never used, and minutes
later that workstation starts calling `198.51.100.77` every ten minutes. Start from that address.

## Pivots

The six windowed pivots in `pivots.yaml` declare `times`, the columns of their result that say when a value was seen: four
return each value with its first and last time and a count (`times: { first: first_seen, last: last_seen, count: events }`),
and the flows and WiFi pivots return one row per event with its time (`times: { at: ts }`). The workbench reads those columns from
every row of the result and records on the card what was observed and when, which the Timeline and the Graph draw from.

## Field notes: the WiFi log

`sources/wifi.yaml` is a wireless controller's log. Its `message` column says what it `reveals` (the host name a device announced and
the access point it joined) and has two `extract` rules (`device`, an asset, and `access_point`, a host). A second story is planted in
it: a device joined the WiFi at `192.0.2.61`, an address no lease names, and only the connection message says it was
`ws-17.example.net`. A card from `address_to_wifi` carries that value as `extracted`, Research sends the work back to Plan
because it opens `asset_to_accounts` to an open sub-goal, and the planner can follow it. `tests/sample/glean-acceptance.test.ts`
scripts that run.

## Playbook and inventories

- `playbooks/address-triage.yaml`: Triage an address. It asks the asset list, falls back to the lease records only when the asset list came back empty (a branch taken or skipped), looks up the names that resolved to the address and, for each name found (up to 5), who looked it up (a fan-out). It ends on the asset step, so the outcome is the asset list's answer. Run it from the Pivot panel; the scripted run asks two of these lookups already, so the playbook reuses them.
- `inventories/assets.yaml`: the asset list, declared complete for internal hosts, with a basis. An empty answer from it is a proven negative.
- `inventories/leases.yaml`: lease records, derived from addresses handed out and not complete. An empty answer from it is only "not seen".

Together they show "Does it belong?": a known address is a known asset; an address in neither list reads as proven not a known asset because the asset list is complete.

## Asking the person

Plan, Research and Assemble may put a question to the person with `ask_person` (their stage manifests list it), and the
profile gives those three stages the skill `context/skills/ask-the-person.md`: when to ask, what to look at before asking
what a device is, and never to conclude that something does not belong because the sources are silent. The reviewers
may not ask. The scripted run asks nothing, so it publishes as it did before; `tests/sample/person-acceptance.test.ts`
adds one scripted question to a copy of it.

## A demo run

The sample carries a scripted investigation (`scripts/sample-run.yaml`): the models are the scripted one, so no real model
is used and the only network address is the stand-in reputation service on 127.0.0.1, which `--sample-fixture` starts
(and the sample data, which it generates if missing) for as long as the command runs. Three commands take the question to a
published product, each stopping where a person must decide:

```
bun run investigate start --sample-fixture --title "Sample" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" \
  --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN
bun run investigate accept-plan CASE-1 --budget s3=1 --sample-fixture
bun run investigate approve CASE-1
```

The first stops at the plan gate and prints the steps, the second at the publish gate, the third publishes
`published/1` in the case folder. Then `bun run verify <data_dir>/cases/CASE-1` should say the chain is intact. Add
`--config <file>` to choose the settings; the root named first in them is where the sample data is generated.

## Unloading the demo case

Once `published/1` exists, the case can be put away and brought back (the server stopped, since these take the workbench's lock):

```
bun run cases unload CASE-1
bun run cases store list --search 198.51.100.77
bun run cases load CASE-1
bun run verify <data_dir>/cases/CASE-1
```

The first writes `CASE-1.TLP-GREEN.tar.gz` to the case store (`<data_dir>/store` unless `cases.store` says otherwise) and takes the
case off the list; the second finds it by its starting value; the third checks the file, verifies its chain and loads it again, and
`verify` says the chain is intact (its last two entries are `case.unloaded` and `case.loaded`). `bun run investigate approve CASE-1 --unload`
publishes and unloads in one step. The sample's script covers one run; `tests/sample/cases-acceptance.test.ts` adds a second run's
turns to a copy of it, drives all of this on the scripted model, and has the follow-up run in the loaded case publish `published/2`,
whose change is stated against product 1.

## A triage loop

The sample has a second loop, `loops/triage.yaml` (not to be confused with the playbook "Triage an address"). It has two stages. **Sort**
(profile `context/triage-profile.yaml`, the orchestrator persona, scripted by `scripts/sample-triage.yaml`) looks at what may be asked and
turns the report into one goal. **Investigate** runs the investigation loop as a child case, with the triage case's question, starting
values and window as its inputs; the child runs the sample's own `scripts/sample-run.yaml`, as any investigation case does. Triage has no
gate of its own: the child's gates are the person's.

```
bun run investigate start --loop triage --sample-fixture --title "Triage" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" \
  --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN
bun run investigate accept-plan CASE-2 --budget s3=1 --sample-fixture
bun run investigate approve CASE-2
bun run investigate status CASE-1
```

The first runs Sort, makes CASE-2 on the investigation loop and stops: `CASE-1 paused ... waiting on child CASE-2: it waits for a person at
its plan gate`, with the command for the child's gate. The second passes the child's plan gate; the child stops at its publish gate and
CASE-1 is still paused on it. The third publishes the child's product, and CASE-1 goes on by itself: the child's findings come back to it as
note cards that name the child, its run and its head, carry the marking of the child's product and cite nothing of CASE-1, and CASE-1's
run finishes as `completed`. Nothing was sent to CASE-1 after `start`. `bun run verify <data_dir>/cases/CASE-1` checks the triage case and
says the link to CASE-2 matches.

In the interface: Home, Loops, Triage; open Investigate to see that it runs the investigation loop; New case from this loop; the case says
"waiting on child CASE-2" with **Open CASE-2**; pass the child's plan and publish gates there; back in CASE-1 the run is finished and the
returned cards are in Incoming.

To carry the loop to another workbench: `bun run loops export triage` writes `triage.v1.<12 hex>.loop.tar.gz` (the two loops, their stages,
profiles, personas, rules, schemas, checks and the checks' programs; never a model, a script manifest, a source's location or anything under `data/`);
`bun run loops import <file> --config <other>` puts it in a root that is not trusted there, and `bun run loops trust triage-<12 hex> --config
<other>` trusts it. `tests/sample/loops-acceptance.test.ts` drives all of this on the scripted model, and `tests/web/browser-loops.test.ts` in a
browser.

## Memory: the Unknown device loop

The sample has one **case type**, in `case-types.yaml`: `unknown-device`, "Unknown device", "A device nobody recognises is on the network:
what is it, and does it belong?". `memory/unknown-device-lessons.yaml` is a `lesson-seeds` manifest with two synthetic lessons of that type,
both `TLP:CLEAR`, about the sample's own planted data and nothing else:

1. `connection-message`, "Read the connection message before the lease", when the case holds an address: in the WiFi log a connection
   message names the host a device announced, when no lease names the address.
2. `complete-list`, "An empty answer proves absence only from a list declared complete", when the case uses the asset list: the asset list
   is declared complete and the lease records are not.

The workbench files each seed once, as a **proposal**, the first time it loads the roots to work (`serve` or `investigate`; `preflight` and
`memory` do not). Neither is shared with any case until a person accepts it.

The third loop, `loops/unknown-device.yaml` (**Unknown device**, `case_type: unknown-device`), writes all nine stages inline on its own script,
`scripts/sample-device.yaml`, so the investigation loop's stage manifests and hashes are unchanged. Its profile is
`context/unknown-device-profile.yaml`. Plan, Research and Assemble are given the shared lessons of the type (`memory: shared/unknown-device`),
Research and Assemble the case's notebook (`memory: case/notes`), and the loop lists `wifi` and `assets` in `uses.sources`, so a source
trigger can match on a first run. Its Frame answers with the case type (`context/schemas/frame-with-type.yaml`); its researcher writes one note
into the notebook, a pointer to the asset card behind the internal peer; and its Feedback stage runs the reviewer
(`context/personas/reviewer.md`, schema `context/schemas/lessons-output.yaml`), whose answer holds two lessons: one is filed as a proposal
from the case, and the other, whose trigger names an observable type the sample does not have, is dropped with its reason.

```
bun run memory list
bun run memory show LESSON-1
bun run memory accept LESSON-1
bun run memory accept LESSON-2
bun run investigate start --loop unknown-device --sample-fixture --title "Device" --asked "Who is behind the traffic to 198.51.100.77?" --why "demo" \
  --start address=198.51.100.77 --from 2026-11-17T00:00:00.000Z --to 2026-11-24T00:00:00.000Z --objective sample-objective --marking TLP:GREEN
bun run investigate accept-plan CASE-1 --budget s3=1 --sample-fixture
bun run investigate approve CASE-1
bun run memory list --status proposed
bun run memory verify --case CASE-1
bun run memory export
```

On a new data folder, run `bun run serve --sample-fixture` once and stop it, so the seeds are filed; `memory list` then shows them. The two accepts share
them; the case is typed `unknown-device` by its loop, and `start` prints `memory: 2 lessons`: both were bound at the run's start (the case
starts from an address, and the loop uses the asset list). After `approve` the product is published and Feedback has filed `LESSON-3`,
which waits for a person: `bun run memory accept LESSON-3` shares it with the next case of the type, or `bun run memory reject LESSON-3
--reason ...` does not. `verify --case` checks each lesson the run was locked to against the store; `export` writes
`memory.TLP-<marking>.<12 hex>.memory.tar.gz` into `<data_dir>/memory-files`, which `bun run memory load <file>` loads into a new workbench
(one whose store holds only the seeds its first start filed, untouched, or nothing).

In the interface: Home, **Memory** shows the two proposals under Unknown device, each with Accept and Reject; Loops, Unknown device, New
case from this loop shows the case type on the form; the case's Memory lens (`m`) shows its type, its notebook (add a note there) and the
lessons its run was given, each with the trigger that offered it. A case made with **None** chosen still takes the loop's type; clear it in
the lens (Set with None) to see Frame ask for the type before Plan runs.

`tests/sample/memory-acceptance.test.ts` drives all of this on the scripted model (an untyped case asked its type, the seeds and the
Feedback proposal accepted on the Memory page's routes, markings, replay, verify, the store file and the case file), and
`tests/web/browser-memory.test.ts` the Memory page and the lens in a browser.

## Build with help: the partner blocklist

The sample data has one file no source names: `data/blocklist.sqlite`, a partner's list of addresses it calls bad (table `blocklist`:
`address`, `listed_at`, `verdict`, `domain` and a free-text `note`), which lists `198.51.100.77` as a beacon to `cdn-update.example.org`.
`scripts/sample-builder.yaml` is a scripted conversation with the loop builder (the `loop-builder` profile in
`context/builder-profile.yaml`, its persona and the `building-loops` skill) that wires it, over three questions from the person:

1. "Add the blocklist as a source with a pivot from an address, and a loop that rechecks an address with the investigation." The builder
   reads the loop catalogue, the adapter catalogue and the connector kinds, checks the source, and proposes a pivot whose query deletes,
   which the query guard refuses (the person never sees it). It then proposes two changes: `sources/blocklist.yaml` (connector `sql`,
   `TLP:AMBER`, with field notes: each column's meaning, and an extract rule that pulls the beacon's domain out of the note) with
   `pivots/blocklist.yaml` (`address_to_blocklist`, address to domain); and `stages/recheck.yaml` (a stage that runs the investigation
   loop) with `loops/triage-recheck.yaml` (**Triage recheck**, which runs it). The person accepts each file, the source before its pivot
   and the stage before the loop.
2. "What tables does the blocklist hold?" The builder asks for a query probe, `SELECT name FROM sqlite_master WHERE type = 'table'` on
   `blocklist`. The person approves it; it runs through the runner in the conversation's ledger, and the conversation's marking rises
   from `TLP:GREEN` to the source's `TLP:AMBER`.
3. "Now try the pivot on 198.51.100.77." The builder asks for the new pivot on that value; approved, its card has the partner's row and
   the domain the field notes extracted.

Afterwards a new investigation case can run `address_to_blocklist` from the Pivot panel, and a case made from Triage recheck runs the
investigation as a child that stops at its plan gate. `tests/sample/builder-acceptance.test.ts` drives all of this on the scripted model
(and a fourth script whose model manifest, check, credential value and self-running loop are all refused), and
`tests/web/browser-builder.test.ts` drives the first two questions in a browser.

## Improve: the Device check loop

The sample's second case type is `device-check`, "Device check", "Which device held this address?", in a manifest of its own,
`case-types-device-check.yaml`. Its loop, `loops/device-check.yaml`
(**Device check**, `case_type: device-check`, profile `context/device-check-profile.yaml`), writes its six stages inline on its own script,
`scripts/sample-check.yaml`: Frame (which allows the lease records, a source that is not confirmed), Plan (the plan gate), Research,
Assemble, Checks (the form checks) and Publish (the publish gate). Plan, Research and Assemble are given the skill
`context/skills/find-the-device.md`: look the address up in the lease records and the asset list, and treat an empty lease answer as only
"not seen". The loop reads no memory.

The three tasks are three cases of the loop, one for each of three addresses of the sample's data:

| Task | Address | What the data holds | What the loop as it is finds |
|---|---|---|---|
| T1 | `192.0.2.14` | a lease names `ws-14.example.net`, and the asset list agrees | the device, by its lease |
| T2 | `192.0.2.61` | no lease, no asset; only the WiFi log's connection message names `ws-17.example.net` | that the address is not an internal host |
| T3 | `192.0.2.62` | no lease, no asset; only the WiFi log's connection message names `pr-2.example.net` | that the address is not an internal host |

The person runs and publishes each case, then sets a known answer on its product: a text and one expected finding (a claim, a likelihood
term of the sample's standard and a confidence). The known answers are the person's, so none is in the sample; the ones the tests use
(`tests/sample/improve-sample.test.ts`) each hold a canary (`answer-key-1`, `-2`, `-3`) and a claim worded unlike any scripted finding.

The improve loop, `loops/improve.yaml` (**Improve**, profile `context/improve-profile.yaml`), has the seven stages in their fixed order:
Select (a script), Propose (an agent with the four builder tools, schema `propose-output`, given the shared lessons of the type), Probe (a
script; `probe: { plan_gate: accept }`, so code accepts each child's plan, free steps only), Compose (an agent, `compose-output`), Judge (a
script: the scores are code's), Reflect (an agent, `lessons-output`) and Adopt (the person, at the `adopt` gate). Its agents run on
`scripts/sample-improve.yaml`:

- the proposer calls `propose_change` three times: **K1** adds one sentence to `find-the-device` (for an address that is not in the asset
  list, plan the lookup in the WiFi log in place of the lease records: its connection message names the device); **K2** is the
  device-check loop at version 2 with more turns for Research, which changes no output; the third changes a check's timeout, which is
  refused (a candidate never changes a check);
- each child of K1 runs the same script, whose turns for T2 and T3 that carry K1's sentence (chosen by `when`) plan the WiFi lookup and
  name the device;
- the composer chooses K1 and names T2 and T3, where it differs from the base; the reflector answers with one lesson.

With one expected finding per task, each matched at full agreement or not at all, the scores are `base` 333, `K1` 1000 and `K2` 333.
Accepting K1 at Adopt writes the skill into the root, in the person's name; the next device-check case binds the new version.
