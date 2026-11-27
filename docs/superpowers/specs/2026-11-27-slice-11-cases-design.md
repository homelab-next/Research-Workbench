# Slice 11: cases — open by default, archive, follow up, export, import

## Intent

The owner (2026-11-27): "ideally i can import, export, create new, remove, and auto remove/export on complete for the cases". On remove: "remove is tidiness on the display. i basically only want open cases or maybe i am looking at an old case as a follow up".

Cases live outside the repository in the data folder (`<data>/cases/CASE-N/`: ledger.sqlite, blobs, published/). Today every case shows in the case list forever. There is no way to put one away, to move a case between machines, or to keep a copy elsewhere on completion. Products will be read by many agents in harness loops, so an exported case must be a stable, verifiable unit.

## Goals

1. **Open by default.** The case list shows open cases: not yet run, running, paused or waiting, or finished without being published. Archived cases are hidden. A "Show archived" toggle and a search box find old ones by id, title, question, or any observable value.
2. **Archive and unarchive.** These are person commands, recorded in the case's ledger (`case.archived` / `case.unarchived`, with who and when). Archiving changes nothing else about the case. A case archives itself when a run finishes as published, recorded as the engine's act after `run.finished`.
3. **Follow up.** An archived case opens read-only to view. "Start a follow-up run" on it unarchives it and starts a new run in the same case. The existing change rules apply: product 2 states its change from product 1.
4. **Export.** One `.tar.gz` per case holds the whole case folder plus `export.json`. That manifest names the case id, title, marking, the ledger head hash, its entry count, the workbench version, and a sha256 for every file. Before the file is written, the ledger records `case.exported` (when, who, the file name, the destination folder's name only, and the head before the entry). The export then contains that entry, and its head is the one named in `export.json`. The file name carries the marking: `CASE-12.TLP-AMBER.2026-11-27.tar.gz`. Nothing is stripped or redacted.
5. **Import.** It reads an export file and checks every file's hash against `export.json`. It then rebuilds the ledger and verifies the chain and the head. A case that fails any check is refused, and nothing is written. If the id is already in use, the case takes the next free id, and the original id, the origin file name and the head are recorded in a `case.imported` entry. It is appended in the importer's name, so the chain stays intact. An imported case is archived on arrival, can be read and replayed, and is reopened only by starting a follow-up run.
6. **Auto on complete.** The config setting is `cases: { on_complete: { export_to: <folder> | null } }`, off by default. When a run finishes as published and `export_to` is set, the case is exported there and then archived. A failed export, such as a missing folder or a full disk, is shown and recorded (`case.export_failed`), and the case stays open.
7. **Delete for good.** It is available only on an archived case, behind typing its id. It removes the case folder. It is a server command, never offered to agents, and it keeps a one-line record in `<data>/deleted.log` (id, title, head, when, who).
8. **Surfaces.** The case list gets the toggle, search, Archive, Unarchive, Export, Import (a file picker) and Delete for good. The command line gets `export <case> [--to <dir>]`, `import <file>`, `archive <case>`, `unarchive <case>` and `delete <case>`.

## Non-goals

- No redacted or partial export.
- No sync between machines.
- No retention policy: archiving is tidiness.

## Constraints

- **Ledger rules.** New entries are hash-chained, validated on fold, and replay exactly. Old ledgers fold unchanged, and archived is false for them. `verify` checks an imported case like any other.
- **Custody and markings.**
  - Export is not a gate. It is a person command, or code on completion as configured; an agent may not export.
  - The marking is in the file name and in `export.json`.
  - The export folder is the person's configuration.
- **Paths.** Import refuses an archive entry with an absolute path, a `..` or a link, and caps total size (default 2 GB, configurable).
- **Security.** Only the existing loopback server with its Host and Origin guard serves these commands. Delete for good takes the typed id, and the server refuses it without that.
- **Public repo:** tests use synthetic cases only.
- **Stack:** Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.

## Calls made on the owner's behalf

- Archiving is recorded in the ledger, so the record shows when a case was put away and brought back.
- Imported cases arrive archived.
- A publish archives the case automatically.
- Delete for good exists but sits on archived cases only.
