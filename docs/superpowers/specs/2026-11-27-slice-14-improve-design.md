# Slice 14: the improve loop

## Intent

The owner (2026-11-27): "we are basically building all the requirements for https://github.com/google-research/harness2 and let people make it adaptable where the strategy/guidance/skill/memory/tools/etc come from for any give loop." The order agreed was loops as resources (slice 12), then memory (slice 13), then the improve loop (this slice). On the details: "Keep going. We can modify later if needed."

harness2's method (core/recursion.py, library.py, spec.py) has four parts:
- **Propose:** edit the harness tree.
- **Probe:** run the edited harness on tasks.
- **Compose:** keep what the contrasting runs support.
- **Reflect:** write lessons into a per-domain library.

A judge scores the runs only after selection, so scores never steer the proposer. In the workbench:
- the harness is a loop: its stages, skills, procedures, playbooks and field notes;
- the domain is a case type;
- the library is slice 13's shared memory.

## Goals

0. **Carried from slice 13:** `src/core/loopfile.ts` still has its own archive reader. Fold it into `packfile.ts`, so case, memory and loop files share one hardened reader.
1. **Known answers.** The person can attach a known answer to a published product of a case: a short text, plus optional expected findings (an id or claim, with a likelihood and confidence) and a marking. It is recorded as `answer.known` in the case's ledger, by the person only.
   - A case with a known answer is a **task** for its case type.
   - The known answer is a judge input only. No propose, probe or compose prompt ever contains it.
2. **The improve loop** is a loop manifest (`loops/improve.yaml`) whose stages run in order: Select, Propose, Probe, Compose, Judge, Reflect, Adopt.
   - **Select** (code) picks up to N tasks of the chosen case type, plus the target loop and its bound version.
   - **Propose** (model, builder-style) proposes up to K candidate changes to the target loop. Each is a set of manifest diffs (skill, procedure, playbook steps, field notes, stage tools or efforts) and is validated as a save would be. It never touches checks, guardrails, markings, sources' locations or credentials.
     - Its pack holds the tasks' questions and starting values, the target loop's outline, the original runs' worklogs and products (but not the known answers), and the case type's shared lessons.
   - **Probe** (code) runs, for each candidate and for the unmodified base, each task's question and window as a child case of the improve case.
     - Each child binds a **staged candidate version** of the loop. It is a copy-on-write version, not saved to the root and not visible to normal cases.
     - The children's queries go through `runQuery` against the live sources, recorded in each child's own ledger, within a per-improve-case budget (lookups and model tokens) from config. Gates inside probe children are passed only by the person or skipped by the loop's declared policy. The default is that probe children run with the plan gate auto-accepted by code, recorded as `gate.passed` by `{system, improve-probe}`.
     - Probe children never publish. They end at their publish gate, and their draft is the output.
   - **Compose** (model plus code) sees each candidate's probe outputs beside the base's, still with no known answers. It picks the candidate the contrasts support, or none, and writes why.
   - **Judge** (code first; a model only for free-text comparison) runs after Compose has committed its choice. It scores every probe output against the task's known answer: findings matched by claim, likelihood and confidence distance. It records the scores. Nothing earlier can read them.
   - **Reflect** (model) writes lesson proposals for the case type from the contrasts and scores. They go to slice 13's memory as `lesson.proposed`, never accepted.
   - **Adopt** is a person gate. The chosen candidate's diffs are shown as builder proposals with their scores. The person accepts or rejects each one, and an accept writes into the trusted root as the person. Nothing is adopted automatically.
3. **Surfaces.**
   - A "Known answer" form on a published product, person only.
   - "Improve this loop" on a loop's page, with a case type and N and K; it creates an improve case.
   - The improve case's lenses show the candidates, the probe children (links), Compose's reason, the scores (once Judge has run), the lesson proposals, and the Adopt gate.
4. **The sample.** A synthetic case type with three tasks carrying known answers, and a scripted improve run end to end.

## Non-goals

- No automatic adoption and no automatic lesson acceptance.
- No multi-round recursion in this slice: one round of propose, probe and compose. Sequential rounds can come later, as harness2's "sequential" mode.
- No tuning of model weights.

## Constraints

- **Gates:** the person's gates stay the person's. The only code-passed gate is the probe child's plan gate, declared in the improve loop, recorded as the system and visible.
- **Custody:** every probe query is in a child ledger through `runQuery`. Probe children are marked at least as strictly as their task case.
- **The judge is blind until it runs:** a test proves no pack before Judge contains a known answer's text or its findings.
- **Staged candidate versions:** they never enter the live registry for normal cases. They are garbage-collected when the improve case finishes, except the adopted one, which becomes a normal saved version.
- **Ledger rules:** replay at N equals live at N, verify passes, and old ledgers fold unchanged.
- **Public repo:** synthetic names and placeholders only. The owner's known answers stay in their data folder.
- **Stack:** Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.
