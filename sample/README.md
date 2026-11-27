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
