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

## Playbook and inventories

- `playbooks/address-triage.yaml`: Triage an address. It asks the asset list, falls back to the lease records only when the asset list came back empty (a branch taken or skipped), looks up the names that resolved to the address and, for each name found (up to 5), who looked it up (a fan-out). It ends on the asset step, so the outcome is the asset list's answer. Run it from the Pivot panel; the scripted run asks two of these lookups already, so the playbook reuses them.
- `inventories/assets.yaml`: the asset list, declared complete for internal hosts, with a basis. An empty answer from it is a proven negative.
- `inventories/leases.yaml`: lease records, derived from addresses handed out and not complete. An empty answer from it is only "not seen".

Together they show "Does it belong?": a known address is a known asset; an address in neither list reads as proven not a known asset because the asset list is complete.

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
