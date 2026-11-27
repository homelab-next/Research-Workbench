# Slice 12: loops are resources

## Intent

The owner (2026-11-27): "in order to make this a multi capable workbench, we will need to have loop options.. and loops phases can also run other loops. so we need to be able to build, import, export loops on the main page as a resource. we are basically building all the requirements for https://github.com/google-research/harness2 and let people make it adaptable where the strategy/guidance/skill/memory/tools/etc come from for any give loop. we've effectively built an investigation loop with this first iteration."

On the order of work, the owner chose foundation first: loops as resources (this slice), then memory (slice 13), then a harness2-style improve loop (slice 14). On visuals: "a simplistic version working that we can iterate on". A ring view of a loop's segments comes later.

## What harness2 has, and how it maps

The harness2 source read was `core/spec.py`, `tree.py`, `library.py` and `recursion.py`.

- **The harness.** It is a tree of eight components: system prompt, guardrails, memory, tool guidance, subagents, skills, scripts and plugins (hooks). Edits are omitted-is-inherited.
- **The improve loop.** It proposes edits, probes them by running tasks, composes the better harness, and reflects. What it adopts goes into a per-domain library: the adopted tree plus EXPERIENCE.md.
- **The benchmark adapter seam.** It supplies tasks, `execute(task, harness)`, the trajectory, the deliverable, harness validation and a judge. The judge is called only after selection.

Today's workbench has every piece except loops calling loops, a memory store, and the improve loop:
- the pipeline is the loop;
- stages are its phases;
- personas and rules are the system prompt;
- checks, the query guard and markings are the guardrails;
- skills and procedures are skills;
- stage tools are tool guidance;
- playbooks and pivots are scripts;
- checks are plugins;
- the case and its ledger are the run directory, with custody that harness2 lacks.

## Goals

1. **The loop manifest.** `kind: loop`, `id`, `title`, `about`, `version`, `stages: [...]` (today's stage manifests, by id or inline), `profile`, `entry`, `inputs` (typed: a question, observables, a window, or another loop's product), `outputs` (the product schema it promises), and `components`, which says where each component of each stage comes from. Today's pipeline becomes `loops/investigation.yaml`. With no other change, a case runs exactly as before, and an old ledger, its pipeline hash and replay all match.
2. **Sub-loop stages.** A stage may be `runs: loop` with `loop: <id>`, `inputs:` (a mapping from this case's state: cards, observables, findings, the question), and `returns:` (which of the sub-loop's outputs come back, and how they land: as cards with provenance "from sub-loop <id> run <n>", or as a draft section).
   - The sub-loop runs as a **child case**: its own ledger, linked both ways. The parent records `subloop.started` with the child id and input hash, and `subloop.finished` with the child's head and output hash.
   - The child's gates stay gates. A child that reaches a person gate pauses the parent with "waiting on child CASE-N".
   - Depth and count caps come from the config, so a loop cannot recurse without bound.
3. **Component sources.** For each component of a stage, the loop names where it comes from: `root` (today's manifests), `pinned: <hash>` (an exact version from the content store), `loop-output: <loop>.<output>`, or `memory: <store>/<selector>` (reserved for slice 13; refused until then).
   - Every resolved component's hash is in the pipeline hash, so a run records exactly what it ran with.
4. **Loops on the main page.** A "Loops" list sits beside Cases: each loop's title, about, stages, version and hash, with **New case from this loop**. The loop page is a plain outline:
   - stages in order, with gates and send-back edges;
   - each stage expandable to its **context** (persona, rules, skills, procedure, memory sources), its **middleware** (checks, hooks, guard) and its **orchestration** (tools, sub-loops, caps, model and effort);
   - every item shows its source and hash.
5. **Build.** Create a loop by copying an existing one, then edit stages, order, gates, components and sub-loops through forms that write manifests in the trusted root.
   - Each save validates the whole loop: references resolve, the graph has an entry, every send-back target exists, and sub-loop depth is capped.
   - A save records a new version. Running cases keep the version they started with.
6. **Import and export.** A loop file is one `.tar.gz` holding the loop manifest, every manifest it references by hash (stages, personas, rules, skills, procedures, schemas, checks, playbooks, pivots, sources' shapes without credentials), and a `loop.json` with hashes.
   - Import verifies every hash, refuses anything that would overwrite a different manifest with the same id, and lands untrusted by default, so the trusted-only kinds are refused until the person marks the root trusted, following the existing root trust rules. Export never includes secrets, credentials or case data.
7. **Command line:** `loops list`, `loops show <id>`, `loops export <id> [--to]`, `loops import <file>`, `case new --loop <id>`.

## Part B: the loop builder assistant

The owner (2026-11-27): "i also dont hate the idea of having a chatbox for an agent to help you build loops. because if you are referencing mcp, databases that need adapters, various storage and auth locations.. it might be complicated for people".

8. **A builder conversation** on the Loops page and on a loop's page. It reuses the existing agent conversation (src/server/converse.ts and the agent lens) with a builder persona and its own tool set:
   - **Read:** the loop catalogue, pivot's adapter catalogue (purpose, each field's means, reveals and extract rules, and where its values lead), connector kinds, roots and their trust, and the validation result of any manifest.
   - **Propose:** a change as a set of manifest diffs (new or edited loop, stage, source, pivot, playbook, field notes, skill). Before the person sees it, each proposal is validated exactly as a save would be (references, the guard for every pivot, regex rules for extract, sub-loop caps). The person accepts or rejects each diff, and only an accepted diff is written, into the trusted root, as the person.
   - **Probe:** for example "list a source's tables" or "run this pivot on one value". Each probe needs the person's approval and goes through `runQuery`, recorded in a builder ledger, with the same custody rules as a case.
   - **Never:** read or write a secret value. Credentials are named by reference (`secrets.<name>`, a vault key or an environment variable), and the person sets the value outside the workbench. MCP servers and databases are wired as connector manifests that name their credential reference.
9. **The builder ledger.** Each builder session is recorded like a case: the conversation, the proposals, the diffs, what was accepted and by whom, and the probes. Its marking is the strictest of anything it probed.

Part B builds on part A (the loop manifest, the validation and the Loops page) and ships after it.

## Non-goals (this slice)

- Shared or case memory (slice 13).
- The improve loop (slice 14).
- The ring view.
- Editing a loop while a case runs on it: the case keeps its version.

## Constraints

- **Replay.** Replay at N equals live at N. A child case replays on its own, and the parent's replay reads the child's recorded head and output hash, not a re-run.
- **Gates and custody.**
  - Only a person passes a gate, in parent or child.
  - The single custody point (`runQuery`) is unchanged, so a child's queries are recorded in the child's ledger.
  - Marking: a child inherits the parent's case marking as its floor. Returned cards keep their own marking.
- **Repository hygiene.**
  - Public repo: the sample root gains a second, small loop (for example "triage": a two-stage loop whose stage runs the investigation loop as a sub-loop) with synthetic data only.
  - Exports carry no credentials.
- **Stack:** Bun, TypeScript strict, `bun test`, happy-dom and headless Chromium. TDD with real RED.
