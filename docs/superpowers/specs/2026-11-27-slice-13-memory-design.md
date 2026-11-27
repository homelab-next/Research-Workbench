# Slice 13: memory — per case, and shared lessons by case type

## Intent

The owner (2026-11-27): "on one hand we should have a local memory per case, on the otherhand.. lessons learned and root cause analysys split by case type could probably be a shared memory that agents could load only applicable items."

The dev runs show why. The lessons from the unknown-device question were written by hand into a skill:
- read the connection message;
- look up the MAC vendor;
- check the access point's neighbours;
- never conclude from silence;
- ask the person.

They should be recorded as they are learned, reviewed once, and offered to later cases of the same type, with provenance and without a model choosing what to load. Slice 12 reserved the component source `memory: <store>/<selector>` for this.

## Goals

1. **Case memory.** A per-case notebook, `<case>/memory`, holds items written during the case: a fact learned, a decision, a pointer such as "the AP-3 access point is in the lobby; see c5". Each item is an entry in the case's own ledger (`memory.noted`, `memory.revised`, `memory.dropped`), so it unloads and loads with the case, replays, and verifies.
   - Agents may note items with a new tool, `note_memory`, offered where a loop names it. The person may note, revise and drop items.
   - Case memory is offered to the case's own later stages and follow-up runs as a pack part, marked as notes rather than data.
2. **Shared memory.** A store at `<data>/memory/` holds lessons and root-cause write-ups, filed by **case type** (an id from a `case-types` manifest, such as `unknown-device` or `suspicious-login`). Each item carries:
   - its case type;
   - a short trigger: when it applies, as structured conditions (an observable type present, a source used, a finding pattern), not free text alone;
   - its text;
   - its provenance: the case, the product, and who accepted it;
   - its marking;
   - the version it supersedes, if any.
   The store has its own hash-chained ledger: `lesson.proposed`, `lesson.accepted`, `lesson.rejected`, `lesson.retired`.
3. **Written only through a gate.** A lesson is proposed, either by the feedback stage after a publish ("what would have made this case faster or more correct?") or by the person. It becomes shared only when the person accepts it, or a review loop the person names accepts it. It is shown with its provenance, and it is never accepted automatically.
4. **Loaded selectively, in code.** A loop's stage names `memory: shared/<case-type>` (or `shared/*`). At bind, code selects the accepted items whose case type matches the case's type and whose triggers match the case's observables and sources. It locks their hashes into the run, so replay is exact, and offers them as a pack part. No model decides what is loaded.
   - A case's type is set at creation, by the person or by the Frame stage proposing one that the person confirms, or by a loop's default.
5. **Surfaces.**
   - A **Memory** page beside Cases and Loops: shared lessons by case type, each with its provenance, triggers, marking, history, and Accept or Reject for proposals.
   - A case's **Memory** panel: its notebook, plus which shared lessons were loaded and why (the trigger that matched).
   - Simple lists. No ring view yet.
6. **Seeding from today.** The dev case lessons are offered as the first proposals in the dev root only, never in the public sample. The sample gets a generic `unknown-device` case type with two synthetic lessons.

## Non-goals

- No embedding or semantic retrieval. Selection is structured triggers in code.
- No automatic acceptance.
- No cross-workbench sync. The memory store unloads and loads like a case: one file, verified.

## Constraints

- **Ledgers and replay.** Both ledgers (case and memory store) are hash-chained, replay exactly, and verify. Old ledgers fold unchanged.
- **Markings.** A lesson's marking is at least its source product's. A lesson is offered to a case only when the case's marking allows it, so a TLP:RED lesson never reaches a TLP:GREEN case's model.
- **Model-written text** in a lesson is shown as a lesson (a note), never as rules or a persona. It follows slice 12's rule that model-written text cannot become rules.
- **Repository hygiene.** The public repo holds synthetic lessons only. The owner's real lessons live in their data folder.
- **Stack:** Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.
