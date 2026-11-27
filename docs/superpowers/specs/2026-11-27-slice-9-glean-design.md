# Slice 9: what can be gleaned from each data point

## Intent

The owner (2026-11-26): "the agent needs to ask itself.. what can i glean from any one data point. and that especially matters for the planner because it directly impacts goals and routes. maybe that needs better defined as to what each field is and what you could do with it."

Four dev runs of one unknown-WiFi-device question show the cost:

| Case | What the model had | Result |
|---|---|---|
| A | The WiFi lookups returned status and times only; the connection message (which names the hostname the device announced and the access point it joined) was dropped; no vendor source | "Roughly even chance it's idle or rogue" |
| B | The message returned and a vendor source added | Right answer (the vendor and the device's operating system, on the right access point) in 16 min |
| C | The skill asked for a hostname, but no lookup yielded one, so the planner invented a route twice. It then skipped the playbook and lost the message | 26 min in Plan, then "unlikely to belong because no DNS or flow data", a reason drawn from silence |
| D | A hostname lookup added (first word of the message) | Plan in 1 min; all three clues found |

Each fix was hand-written for one source. The general rule is that every field should say what it reveals, code should pull those values out, and the planner should be told what each new value opens up.

## Goals

1. **Field notes.** Every column of a source table, and every column a pivot returns, can carry `means` (what it is), `reveals` (what can be learned from it) and `extract` (typed values code can pull from it, each with a pattern and a type). Pivot v0.1.x already has per-field meaning (adapter fields); add `reveals` and `extract` there, and the workbench reads them.
   Example: `message: { means: "the device's own connection notice", reveals: "the hostname it announced; the access point it joined", extract: [{ type: host, pattern: "^([^ ]+) " }, { type: access_point, pattern: "connected to (.+?)\\. " }] }`.
2. **Extraction in code.** When a card is made, each `extract` rule runs over its column. Matching values become observables on the card, recorded in the ledger as code-derived with the rule's id, so they replay exactly. The model never has to notice them.
3. **A glean step after Research.** Code lists:
   - every observable that is new since the last plan;
   - the pivots that start from its type, with cost and what they reveal;
   - goals the field notes say it bears on.

   The planner gets this list on its next pass, and the research stage sends work back to Plan when an unvisited observable opens a route to an open goal. The model only judges which to follow. A cap per run stops it chasing everything.
4. **Silence is never a reason, anywhere.** Check 8's not-seen rule today reads findings. Extend it to the summary, assessment and alternatives: a sentence that gives a not-seen card, or "no … was observed", as the reason for a likelihood fails the check (run C: "unlikely … because … no identifying DNS or flow data was observed").
5. **Playbooks are not skipped silently.** When the planner chooses single pivots that cover only part of a playbook for the same starting type, the plan view says what the playbook would also have fetched (run C lost the connection message this way).

## Non-goals

- No free-text parsing by the model at query time: extraction rules are data in manifests, reviewed like any manifest.
- No new source types; the vendor registry and the access-point lookups stay root configuration.

## Constraints

Ledger rules as ever: code-derived observables are entries, replay is exact, and old ledgers fold unchanged. The guard is untouched; extraction runs on returned rows, not in queries. Marking: an extracted value carries its card's marking. Public repo: synthetic examples only.

## Order

Field notes and extraction (1, 2) need a pivot release (v0.2.0) and a workbench bump. The silence check (4) is independent and small, and can go first. The glean step (3) builds on 1 and 2. The playbook note (5) is small.
