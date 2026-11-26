# Slice 8: the person can always overrule, and can be asked

## Intent

The person running an investigation often knows things no source holds: what a device is, who installed it, which room an access point is in. They can also go and look. The owner's words (2026-11-26): "i should always be able to overrule because i may have additional information unavailable to the model", and "there is always the option to just ask the human questions. i could physically move in 3d space to answer".

A dev case is the case in point. Asked about an unrecognised WiFi device, the model concluded "roughly even chance the device is idle, rogue or non-compliant". The owner knew what it was and where it was. The lake held the clue, in a connection message naming the device's hostname and access point, but the lookups dropped that field, and no step let the model ask the person "where is that access point, and is a device like this expected there?".

Today a ruling on a reviewer conflict is fixed for the rest of the run (`review.ruled`, types.ts). The person cannot overrule a finding that no reviewer disputed. They cannot add what they know as evidence. And the model cannot ask them anything.

## Goals

1. **Person-sourced evidence.** The person adds a card in their own words (`made_by: "human"`): a statement, optionally tied to observables (a MAC, an address), with how they know (saw it, installed it, was told). Agents can cite it like any card. Checks and the published product label which findings rest on the person's word, and say so in the sourcing (ICD 203 source description).
2. **Overrule a finding, at any time.** The person sets a finding's likelihood, its confidence, or whether it stays, with a note. A new `finding.overruled` entry records it, and the earlier state stays in the ledger. The analyst must hold the overrule: `holds()` in `src/pipeline/conflict.ts` extends to overrules. A reviewer point that would move it back is held, as for rulings. Any other point on the finding goes back as usual.
3. **Revise a ruling.** A later `review.ruled` on the same conflict replaces the earlier one. The fold keeps both, the latest wins, and the lens shows the history. Drop "fixed for the rest of the run".
4. **The model can ask the person.** A new agent tool, `ask_person`, records `question.asked` with the question, why it matters, and the cards or observables it is about. It is offered in Plan, Research and Assemble. Asking does not stop the run. The agent gets "asked; carry on with what does not depend on the answer". At most N open questions per run, from config with a default of 3.
   - The person answers in the Narrative lens or the command bar with `answer_question`. That records `question.answered` and creates a person-sourced card holding the answer, citing the question.
   - A stage may not pass while a question it marked `blocking: true` is unanswered. The run then pauses with the reason "waiting for the person's answer to q1", and resuming without an answer is allowed: the agent proceeds, and the gap is named.
   - The dev driver script never answers a question. Answering is the person's.
5. **The skill tells the model to ask.** The device-identification skill (dev root, outside the repo) already says: put "is it expected on that access point?" to the person, and never conclude "does not belong" from silence. The sample root gets a generic version.

## Non-goals

- No chat with the model mid-stage. Questions and answers are entries and cards, and the existing agent lens conversation stays as it is.
- No automatic trust in the person's word over the data. The card is labelled as the person's, and reviewers may still point out where it conflicts with a data card. It is not a ruling.
- No change to gates: only the person passes the plan and publish gates, by their own buttons.

## Anti-goals

- A question that silently blocks a run forever.
- An overrule that a reviewer can undo.
- A person's statement presented as data in the published product.

## Constraints

- Ledger rules hold. Every new entry type is in the hash chain, folded by the shared `apply`, replayed identically, and `verify` passes. Old ledgers fold unchanged: the new types are additive, and an old `review.ruled` stays the latest because it is the only one.
- The single custody point (`runQuery`) is untouched. None of this sends a query.
- Marking: a person card takes the case marking unless the person sets a stricter one, and the marking floor for analyst requests holds.
- Public repo: synthetic names only in tests and the sample.
- Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.

## Approaches considered

- **(A) Notes only.** The person writes a free-text note the agent may read. Cheap, but not citable, not checked, and nothing holds it. Rejected: it is the gap we have.
- **(B) Person cards, overrules and questions as first-class ledger entries.** *Picked.* It reuses cards (citations, checks, packs) and the `holds()` machinery from the CASE-3 fix, so the person's authority is enforced in code, not by prompt.
- **(C) A separate "person" stage in the pipeline.** Rejected: the person should be able to act at any time, not at one point in the order.

## Left to the builder

Exact payload shapes, lens layout (follow the existing Narrative and Evidence lenses), the command-bar wording, and which existing check reads person-sourced cards (likely check 8's sourcing rule and the assemble schema's sourcing text). All decisions must be recorded in the plan ledger.
