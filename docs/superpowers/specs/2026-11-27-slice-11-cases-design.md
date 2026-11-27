# Slice 11: cases load and unload

## Intent

The owner (2026-11-27): "ideally i can import, export, create new, remove, and auto remove/export on complete for the cases". On remove: "remove is tidiness on the display. i basically only want open cases or maybe i am looking at an old case as a follow up". On the model: "basically im thinking of it more like a load/unload concept".

Cases live outside the repository in the data folder (`<data>/cases/CASE-N/`: ledger.sqlite, blobs, published/). Today every case stays loaded forever. A case cannot be put away, moved between machines, or kept elsewhere on completion. Products will be read by many agents in harness loops, so an unloaded case must be a stable, verifiable unit.

## The model

- **Loaded** cases are the workbench's working set: they are in `<data>/cases/` and the case list shows them.
- **Unloading** packs a case into one file in the **case store** and takes it out of the working set.
- **Loading** brings a case from the store back into the working set, after verifying it.
- **The case store** is a folder, `<data>/store/` by default, set by `cases.store` in the config (a backup disk, a share, or a folder another agent reads). Export and import are the same operation against a different folder: `unload --to <dir>` and `load <file>`.

## Goals

1. **The case file.** One `.tar.gz` per case holds the whole case folder plus `case.json`. That manifest names the case id, title, question, marking, starting observables, status, products published, the ledger head hash, the entry count, the workbench version, and a sha256 for every file. The file name carries the marking: `CASE-12.TLP-AMBER.tar.gz`. Nothing is stripped or redacted.
2. **Unload.** This is a person command, or code on completion as configured; an agent may not unload.
   - It is refused while a run is running. A paused or waiting run may be unloaded, and it comes back paused.
   - The ledger records `case.unloaded` first: when, who, the store's name only, and the head before the entry. The file then contains that entry, and its head is the one `case.json` names.
   - The file is written to a temporary name, fsynced, and checked by reading it back against `case.json`. Only then is it renamed into place and the case folder removed. A failure at any step leaves the case loaded and records `case.unload_failed`.
3. **Load.** It reads a case file and checks every file's hash against `case.json`. It then rebuilds the ledger and verifies the chain and the head. Any failure refuses the load, and nothing is written.
   - The ledger records `case.loaded`: who, when, the file's name and the head it arrived with.
   - A case loaded from the store keeps its id. The id counter never reuses an id seen in the store or in the working set.
   - A case from another workbench, whose id is already taken, gets the next free id, and its original id is recorded in `case.loaded`.
   - Loading does not delete the store file; the next unload replaces it.
4. **The case list.** It shows loaded cases. A "Case store" view lists the store's files from their `case.json`, without unpacking them, and can be searched by id, title, question or observable value. It has a Load button on each. A loaded case has Unload in its menu.
5. **Follow up.** Load an old case, then start a new run in it. The existing change rules apply: product 2 states its change from product 1.
6. **Auto on complete.** The config setting is `cases: { store: <folder>, on_complete: unload | keep }`, with `keep` as the default. With `unload`, a run that finishes as published is unloaded into the store. If that fails, the case stays loaded, and the failure shows in the list and is recorded.
7. **Delete.** It applies only to a file in the store, behind typing its id. It is a server command, never offered to agents, and it keeps a one-line record in `<store>/deleted.log` (id, title, head, when, who).
8. **Command line:** `unload <case> [--to <dir>]`, `load <file|case-id>`, `store list [--search <text>]` and `store delete <case>`.

## Non-goals

- No redacted or partial file.
- No sync between machines.
- No retention policy: unloading is tidiness.

## Constraints

- **Ledger rules.** New entries are hash-chained, validated on fold, and replay exactly. Old ledgers fold unchanged. `verify` checks a loaded case like any other.
- **Custody and markings.** The marking is in the file name and in `case.json`. The store folder is the person's configuration.
- **Paths.** Load refuses an archive entry with an absolute path, a `..` or a link, and caps total size (default 2 GB, configurable).
- **Security.** Only the existing loopback server with its Host and Origin guard serves these commands. Store delete takes the typed id, and the server refuses it without that.
- **Public repo:** tests use synthetic cases only.
- **Stack:** Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.

## Calls made on the owner's behalf

- An unload is recorded in the ledger before the file is made, so the record travels with the case.
- Loading keeps the store file until the next unload replaces it.
- A running case cannot be unloaded; a paused one can.
- Auto-unload on complete is off by default.
