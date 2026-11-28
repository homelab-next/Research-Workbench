# Analyst Workbench: GUI layout and design themes

A rebuild guide for the interface and its design ideas. It contains no data, sources, names or configuration from any real environment: every example is a placeholder. Build the data layer for whatever environment hosts it.

> Saved verbatim from the project owner's brief on 2026-11-23. This is the reference for how the interface looks and behaves. Design documents under `docs/superpowers/specs/` cite it by section number.

## 1. What it is, in one paragraph

A single-page workbench for threat-intelligence work that serves three kinds of people from one front door: people who need help (requesters), people who do the work (analysts), and people who steer it (leaders). Work happens on a "stage": results stream in on the left, the analyst keeps what matters into lanes, and lenses slide in to show the case from other angles (timeline, graph, notes, narrative, agent). An embedded agent works beside the analyst. It is given the right context for the activity automatically, and it only ever proposes: nothing is written anywhere until a person accepts it.

## 2. Design principles

- **Nothing moves under the mouse.** Inner screens are top-aligned and never recenter as content loads or filters. Only the home screen is vertically centred.
- **Every level is one click away.** What you pick shrinks into a trail at the top-left, so you can jump back to any level without a back button.
- **Propose, never write.** Agents, planners and drafts produce proposals with Accept / Edit / Reject. Writes to other systems are shown as previews behind an explicit gate.
- **Provenance on everything.** Every card says where it came from, what was asked, why, who ran it, when, and its handling marking. Citations are chips that jump to the card.
- **Honest negatives.** "Nothing found" is shown differently from "could not fully look": partial coverage is tagged, and never presented as a proven negative.
- **Cost before action.** Anything that costs money or time shows its estimate before it runs, and costly steps wait for an explicit budget.
- **Never lose work.** Discard moves to a Discarded lens; undo works on keep, move, discard and send-back.
- **Show what the agent was given.** The agent's context is visible as chips, can be trimmed (×) or extended (+), and is recorded with each answer.
- **Short words.** Labels are a verb or noun in sentence case, one to three words. Detail lives in tooltips.
- **The UI follows permissions.** People only see the columns and tiles their role allows; the server checks again.

## 3. Visual language

- **Theme:** dark. Near-black blue background, slightly lighter panels, thin 1px borders, generous rounded corners (8 to 16px). One accent colour (a soft sky blue) for focus, targets and links.
- **Type:** system UI font, 13 to 15px body; headings light weight; monospace only for queries, code and raw text.
- **Tags (pills):** small rounded labels with a thin border. Colour carries meaning:
  - green: done, proven negative, validated
  - amber: partial, draft, needs attention, gap
  - violet: agent-made
  - blue: system / pre-filled
  - neutral: human
- **Handling markings (TLP-style chips):** always visible on tiles, cards and exports; red, amber, green and clear each have their own colour, and the label always includes the full marking text.
- **Tiles:** rounded squares (not circles) with fixed slots so text always fits: a 2-line head, an up to 3-line descriptor, and one row of chips at the bottom. Mode tiles on the home page are wide, short rows.
- **Motion:** cards slide when they move (FLIP animation), discards slide out, the trail shrinks smoothly. All motion respects reduced-motion settings. No decorative animation.
- **Dashed vs solid:** dashed borders mean "proposed / not yet accepted / new"; solid means accepted.

## 4. Screen map

```
Home (kiosk)
├── Get help            (requesters)
│   ├── Ask for help          → self-help panel
│   ├── My requests           (soon)
│   └── Give feedback         → feedback panel
├── Do the work         (analysts)
│   ├── Work tickets          → pick one → work area
│   ├── Investigate           → pick one → work area
│   ├── Hunt                  → pick one (+ New hunt) → work area
│   ├── Actors                → pick one → work area
│   └── My folders            → folder panel → case → work area (with file tree)
└── Resources           (analysts and leaders)
    ├── Strategy              → strategy-to-task tree
    ├── Requirements          → requirement sets
    ├── Gaps                  → capability and collection gaps
    ├── Priorities            (leaders, soon)
    ├── Learn                 → research panel (analysts)
    ├── Agent inventory       → inventory panel (analysts)
    ├── Loops                 → the loops → a loop's outline → its forms (analysts)
    └── Memory                → shared lessons by case type (analysts)
```

### 4.1 Home (kiosk)

- Centred question in light type: "How can I help you today?"
- Below it, up to three columns, each with a bold title and a one-line subtitle, holding stacked mode tiles. Each tile shows the mode name and a short count ("4 queued", "1 open", "soon").
- A command input under the columns (analysts only): "investigate CASE-1", "open hunt", "research …".
- A muted hint line at the bottom.
- "Soon" tiles are dimmed but still clickable (they open an explanatory empty stage).

### 4.2 "Which one?" screens

- Top-aligned heading "<Mode>: which one?".
- A filter box (search by name, tag, marking, state; Enter opens the first match; Esc clears).
- A grid of square tiles. Hunts get a dashed "+ New hunt" tile first.
- "Nothing matches" message when the filter empties the grid.
- *Investigate: cases.* The grid shows the loaded cases only. Each case tile has a "⋯" menu ("More for CASE-1") holding **Unload**, which packs the case into the case store and takes it off the list, with a toast "CASE-1 was unloaded to the case store". Unload is off while the case's run is running (its title says to pause or stop it first); any other refusal shows "Refused: …" in the menu. A tile whose unload failed carries an "unload failed" chip whose title is the reason. A **Case store** button on the list opens the Case store view (8). A tab that has a case open when it is unloaded says so and goes to the list.

### 4.3 The trail (top-left, always present after home)

- A home dot, then levels: modes → items → lanes.
- At each level the current choice is a labelled pill; siblings are tiny dots with hover labels.
- Hovering a mode dot opens a fly-out list of that mode's items.

### 4.4 Top bar

Left: trail. Centre: command bar ("/" focuses it). Right: jobs indicator (count of running background jobs; click for the jobs lens).

## 5. The work area

```
┌────────────────────────────────────────────────────────────────────────────────────┐
│ trail                          [ command bar ]                         jobs (3)    │
├──────────┬───────────────┬─────────────────────────────────────────────────────────┤
│ Files    │ Incoming      │ Brief: CASE-1 · marking · title    [Ticket] [Hide]      │
│ (F)      │ sort / group  │ Asked for: … · ✔ 3/11 questions · plan · notes · summary│
│ optional │ ┌───────────┐ ├──────────┬──────────┬──────────┬────────────┐          │
│ tree     │ │ card      │ │ Lane 1   │ Lane 2   │ Lane 3   │ + New lane │          │
│          │ │ card      │ │ card     │ card     │          │            │          │
│          │ │ card      │ │ card     │          │          │            │          │
│          │ └───────────┘ │          │          │          │            │          │
│          │ key hints     │          │          │          │            │          │
├──────────┴───────────────┴──────────┴──────────┴──────────┴────────────┴──────────┤
│ shelf: Agent · Ticket · Steps · Timeline · Graph · Notes · Narrative · Worklog · …  │
└────────────────────────────────────────────────────────────────────────────────────┘
```

- **Files column (optional, far left):** only for cases read from a person's own folder. Folder groups collapse; files with partial coverage get a warning mark; clicking a file jumps to its card. F toggles it, and the choice is remembered.
- **Incoming (left):** the stream of new results waiting for triage. A sort/group bar at the top (arrived, event time, step, source, started by, status; ↑↓ reverses; group by step, source, started by or type; remembered). Pinned cards stay on top. A key-hint footer.
- **Brief (top of stage):** the case id, marking chip, title, who asked and what they asked for, and status buttons (questions answered, plan state, notes, summary state) that open the matching lens. Collapsible, remembered.
- **Questions for you (under the brief):** each open question a stage put to the person, with why it matters and an answer box; an answered one is one line with its answer card. At the publish gate it also lists the draft's findings, each with an Overrule button that opens its form in the Narrative lens. While the Narrative lens is open, the lens holds these at its top instead, so no form is on screen twice.
- **Lanes (stage):** columns of kept cards. One lane is the keep target (highlighted). Lanes can be renamed in place, added, and removed when empty. Hunt lanes carry a hypothesis: "Supports if …", "Refutes if …", and a result selector (unresolved / supported / refuted / cannot test).
- **Shelf (bottom):** lens buttons with their key letters. A lens opens docked at the bottom (wide) or on the right (tall); V toggles the side, remembered. Esc closes.
- **Toasts:** short messages bottom-centre, with an Undo button when the action can be undone.

### 5.1 Cards

Anatomy, top to bottom:

- Title (bold) and tags (new, partial, proven negative, pinned, agent / human / system).
- One-line body.
- Optional rows table. Every value that looks like an observable is a clickable chip; a column header selects every value in the column. Values not yet in the case are drawn dashed.
- When open: provenance block (source, query, why, by, marking, when, job id), and an action row (Pivot…, Combine…, Hunt this, Add as a card, Cite, Note, Keep / Move / Back to Incoming / Discard / Pin).

Behaviours:

- Click opens; double-click keeps; "O" keeps a card open while others open.
- Drag: onto a lane keeps it there; onto the upper or lower third of a card moves it above or below (a line shows where); onto the middle of a card, or with Alt, links the two (the link shows in the graph); onto Incoming sends it back to triage.
- Two-finger swipe in Incoming: right keeps, left discards.

Your statements:

- **"Add what you know"** opens a form at the top of Incoming: what you know, how you know it (saw it myself, did it myself, was told, did not say how), a detail, the values it is about (a type and a value per row, "Add another value", at most 20) and a marking (the case's, or a stricter one). Add stays off until there is text. A refused statement leaves the form as you typed it.
- **A statement card** carries the tag "your statement", never "nothing found". Its provenance block reads Source (the person), How they know, About, Answers (the question it answers, if any), Marking and When, in place of the query lines. It has Cite, Keep and Discard, and no Pivot or Verify: there is no query to run again.

### 5.2 Keyboard

| Where | Keys |
|---|---|
| Anywhere | ? help card · / command bar · Esc closes, then steps up a level |
| Incoming | J/K or ↓/↑ move · Space or → keep into target lane · X / ← / Backspace discard · P pin · O keep open · Enter open · U undo |
| Columns | Tab / Shift+Tab next / previous column · H/L or [/] the same · 0 Incoming · 1–9 set keep target |
| Lanes | J/K move · Shift+H / Shift+L move the card one lane left / right (left of the first lane is Incoming) · F2 rename |
| Lenses | A agent · I ticket · S steps · T timeline · G graph · N notes · R narrative · W worklog · D discarded · B jobs · V dock side |
| Notes | M note on the current card · C cite it · Cmd/Ctrl+Enter save |
| Files | F toggle the file tree |

A "?" card lists all of this, grouped by area.

Command bar words for the person: `state <what you know>` adds a statement (how you know: "did not say how"); `answer ask-1 <text>` answers a question the same way; `overrule f1` opens the Narrative lens on that finding's Overrule form, where the values are chosen. None of them passes a gate.

### 5.3 Lenses

- **Agent:** see section 6.
- **Ticket:** who asked, what they asked, their indicators and questions.
- **Steps:** the plan (planner proposal or hunt plan, see 7) and each question with its goal, status and Plan / Run.
- **Timeline:** what was observed, on the data's own time axis: a row per value, a mark per card that saw it.
- **Graph:** observed values as nodes, the pivots that found one from another as edges, each with its cards; a node shows its cards, its links, its "does it belong?" verdict and Pivot…; nodes are clickable and keyboard-reachable. A tall layout when docked right. Past the 60-node cap, values that nothing drawn links to are listed under the header, each a button that focuses the graph on it; a detail lists 50 links and a button shows the rest.
- **Notes:** typed notes (note, to-do, question, decision), on the case or on a card; external links (https only).
- **Narrative:** Summary, Key findings, Gaps and limits, Assessment. "#" in a section opens a picker to cite a kept card; dragging a card into a section cites it. Drafts (from the agent or the workbench) arrive as proposals to accept, edit or discard. "Copy as Markdown" expands every citation into its provenance and adds the marking.
  - *Questions box* (first in the lens): each question a stage put to you, with why it matters, the cards and values it is about and the stage that asked. Its tag says "the run waits on this" (blocking, unanswered, the run going), "answered", "went on without your answer" or "question". An unanswered one has an answer box, a "how you know" select and a detail; an answered one shows its answer card. Questions from an earlier run stay answerable. At the publish gate, a line names each question answered since the draft was written, and the gate box names the questions still open and the overrules in force next to Approve. *Your changes* (in the gate box): each overrule, revised ruling and answer since the draft was made, each with its finding's id (or the question's), and one button, "Send back to Assemble with my changes", which sends them as one reason. None of them sends the draft back by itself; while any is unsent, Approve reads "Approve without my changes" and a line says the draft does not hold them.
  - *Finding ids:* every finding starts with its id as a visible label (f1, f5 …), as does its Overrule form ("Overrule f5"), a conflict and each line of Your changes: reviewers, checks and the controller name findings by id.
  - *Refusals:* a person's command that is refused (an answer, an overrule, a ruling, a statement, a send-back, a rejection) shows "Refused: <the server's words>" beside the control that sent it, which keeps what was typed; the command bar says it under the bar.
  - *Overrule form* (under each finding, an "Overrule" button that opens it in place): a likelihood (the standard's terms), a confidence, whether it stays ("must stay", "drop it") and a note. It sends only when something is set and the note is written. An active overrule shows "You overruled: …", the overrules it replaced, and Withdraw (which also needs a note). Findings you dropped are listed with their overrule, so they can be withdrawn.
  - *Ruling history:* a ruled conflict shows its ruling and each ruling it replaced ("Earlier: … (replaced)"). While the run is in progress, "Change the ruling" opens the rule form again; at the publish gate it says that a changed ruling waits under "Your changes" until the person sends the draft back.
  - *Unload after publishing* (in the gate box, between Approve and Reject, only while the run waits at the publish gate): a checkbox whose title names the case store. It starts ticked or not as the setting says (the Case store view's "Unload a case to the store when it is published", saved as `cases.on_complete`); the choice is per run. Ticking it sends nothing and records nothing. Approve sends its value with the approval, and once the run has finished as published the workbench unloads the case and the page goes to the list. It is off while replaying and for a view that may not approve.
- **Worklog:** what the system did, in the order of record (human, agent, system); every entry one toggle away.
- **Memory** (`m`): the case's memory, in three simple lists (see 8.2). *Case type*: the case's type, or "No case type"; when the case has none and Frame proposed one, "Frame suggests: <title>" with **Confirm** and Frame's reason; a select of None and each case type with **Set** (None clears it). A case whose loop reads shared lessons and has no type says "This case has no type, so no shared lesson is offered to it.", and after a resume that went on without answering Frame's question of the type, "The run went on without the case's type: no case type confirmed; no shared lessons loaded." *Notebook*: the live notes, newest first, each with its kind, its text, its cards as chips, and "noted by <who>" ("at the <stage> stage" for an agent's); **Revise** (a person's new text), **Drop** (off until a reason is typed) and **Propose as a lesson** (opens the Memory page with the form filled from the note, filed from this case); a form to add a note (kind, text with a live "<n> / 600" count; an empty or too-long note is refused in place); dropped notes under a closed "Dropped notes (n)". *Shared lessons loaded*: "Bound at entry #<seq>, from the store at entry <n>", then each lesson the run was given with its id, title, marking chip, text, "Offered because: <the trigger that matched>", "Went to: <stages>" and where it came from ("no longer shared" when it was retired or replaced since), and how many were left out and why (stricter than the case, triggers did not match, over the limit), never which; then the lessons proposed from this case, each with its status and a **Memory page** button. In Replay the type and the notebook are those of the entry shown, every control is off, and the lessons listed are the ones of the binding in force at that entry ("At entry #N the binding of entry #M was in force: the lessons below.").
- **Discarded:** everything discarded, restorable.
- **Jobs:** every background job with status, source and duration.

### 5.4 Pivot and Combine panels (inside a card)

- **Pivot:** pick the answer you want (a goal type); the panel shows the cheapest routes to it, each hop with source, cost class, whether it needs a time window, and what an empty result means. Window (case-anchored, N days, custom, all time) and limits (max cost, unconfirmed sources) are adjustable. Running a route reroutes around roadblocks and shows the trail.
- **Playbooks:** under the routes, a button for each playbook whose inputs the card's values can fill, for example "Run Triage an address on 198.51.100.77 · up to 8 lookups, no model". It uses the panel's window and reason (say why first), asks only free sources and spends no budget. Below the buttons, the trail of the run you started: each step with its pivot, skipped steps with the reason, each lookup's value and outcome with what its answer means (proven negative, not seen, the reuse, the failure) and a card chip, "reused, no query sent" where an earlier answer was used, and "N values not followed" where a step hit its limit. If the server stopped mid-run it reads "Interrupted"; run it again and answered lookups are reused. A second press on the same value and window is refused while one is running. The command bar does the same for one value: `run playbook address-triage on 198.51.100.77`.
- **Does it belong?** A button for each value an inventory can be asked about ("Does 198.51.100.77 belong? · asks 2 inventories"). It asks every inventory and shows one line each and one verdict: **Known asset** (some inventory lists it); **Not a known asset: proven for <scope>** (none lists it and a complete inventory came back empty with full coverage; what each empty answer proves is what the record says it proved when it was asked, not what the inventory says today); **Not seen in any inventory; none is complete, so this proves nothing**; **Could not tell** (a lookup failed, was partial or waited for a budget, and nothing listed it).
- **Combine:** several conditions on one table (value A AND value B); lists only tables that have every column; runs calibrated (1 day, then 7, then 30) and stops before a step would exceed the budget.

## 6. The agent pane

```
agent: <category agent>   Profile: Investigation  [draft]  from <base profile> · serves <objective>   tools: none
Loaded for this turn (52k chars):
 [⚖ Base rules] [👤 Persona ×] [🎯 Goal ×] [▪ Output schema ×] [📘 SOP ×] [🛠 Skill ×] [🚧 Gates ×] [🧭 Objective ×] [📓 Lesson ×] [📦 The case]
 [+ Add a skill, SOP or lesson… ▾]  [Serves: the profile's choice ▾]   [Restore 2 left out]
 ┌ excerpt of the selected item ┐
Quick asks: [Synopsis] [What next?] [Draft the response] [What's weak?]
conversation …
 your agent · Investigation profile · 12:04   answer text with [c12] citation chips
   [Propose as Summary] [Propose as Assessment] [Keep as note]
[ ask your agent … ]
```

- One agent per activity category, plus a profile (the "harness") that automatically assembles what the agent gets: rules, persona, goal and method, output schema, procedure, skills, references, gates, the objective chain it serves, the most relevant lessons, and a snapshot of the case.
- The chips show exactly that. × leaves an item out of the next turn; "+" adds one from the inventory; "Serves" changes the objective. Base rules and the case cannot be removed.
- Answers stream in; citations become chips; an answer can be proposed into Narrative or kept as a note.
- Follow-ups continue the same conversation while the agent is the same; switching category starts fresh.
- Free text in the command bar goes to the agent; "summarize" asks for a synopsis; navigation only happens on explicit words ("open", "go to", "investigate", a mode or case name), so a question never throws you out of the case.

## 7. Plans

- **Planner proposal (cases):** a goal line, window, counts (free steps, costly steps, estimate), then sub-goals with steps (checkbox, route, cost, window use, warnings). Buttons: Run the free steps · Accept all (costly steps wait for a budget field each) · Deny · Re-plan. Nothing runs until accepted.
- **Hunt plan (hunts):** numbered sections — 1 Intelligence (basis, relevance, why now, serves, confidence, gaps), 2 Scope, 3 Hypotheses (collapsible, each with statement, priority, why, observables, data sources marked known / to confirm, supports, refutes, positive control, query approach, false positives), 4 Readiness, 5 Baseline, 6 Execution, 7 Budget / escalation / deliverables, Open questions (each with "Add as question"). A workbench draft shows at once; the agent's draft replaces it when it arrives. Accept turns hypotheses into lanes.
- **New hunt form:** name, what and why, optional actor (its techniques appear as checkboxes), other technique ids, objective picker, skills (defaults pre-ticked), more context (procedures, lessons) in a collapsible section, window, scope, marking. "Create and draft the plan".

## 8. Centre panels (inner kiosk screens)

All panels are top-aligned cards with a max height and their own scroll.

- **Ask for help (self-help):** a big text box ("paste an address, link or hash, or describe what you saw") → "Check it" → What we checked (✓ / ⚠ per check; restricted results are never shown, only counted: "the team holds more about this") → Answer in plain words with a verdict tag (probably nothing to do / an analyst should look / need more to go on) → "This solved it" or "I still need help" → a pre-filled ticket draft (copy, link to the form) → a required 1–5 star rating with optional comment (Send disabled until rated; a small Skip) → "Ask something else" / Home.
- **Case store** (`#/investigate/store`, also `store` in the command bar): "Files in <folder>", the setting, a search box ("Search by id, title, question or observable value", answered by the server from each file's `case.json`, nothing unpacked), and one row per case file, newest unload first: id, title, question, marking chip, status, outcome, number of entries and when it was unloaded. **Load** checks the file, verifies its chain and opens the case; a loaded case shows a "Loaded" tag instead. **Delete** opens a box, "Type CASE-1 to delete its file from the case store. This cannot be undone.", whose button stays off until the id is typed exactly (Cancel and Escape close it). Files that cannot be read are listed with their reason and no button; temporary files left by a stopped unload are counted. A refusal shows "Refused: …" on the row. The setting is a checkbox, off by default, "Unload a case to the store when it is published": it is saved to the configuration file and recorded on the workbench chain, and it is only the default of the gate's box; on its own it unloads nothing. In the command bar, `unload` unloads the open case and `load CASE-3` loads that case's file from the store and opens it.
- **Give feedback:** about (dropdown), star rating, comment, Send.
- **Learn (research):** one search box; results from the team's own material first (each with kind icon, marking chip, snippet, Open); then a cited research brief from the research agent (links clickable, https only); follow-up box continues the thread; recent searches as chips.
- **My folders:** add a folder path; each folder shows its detected layout and its cases (newest first) as small buttons, with a filter. Folders are read in place; nothing is written into them.
- **Strategy:** a collapsible tree from strategy to tasks, colour-coded by level; each node shows its measures (target, source), control, data availability, work type, and which workbench activities serve it; a node with several parents appears under each, marked. Depth buttons (to SO / OO / TO / TT) and a filter that keeps the path to each match.
- **Requirements:** requirement sets with status counts; each need with status tag, cadence, "needed by" objective chips and sources; "More" shows detail and what would close it. Filter and status picker.
- **Gaps:** counts per cycle stage (clickable filters), kind picker; capability / product gaps (uncovered statement chips, "draws on", "waits on", "blocks", serves, priority, owner; More shows why and how to close) and collection gaps from the requirements beside them.
- **Agent inventory:** tabs per kind with counts and a ⚠ problem badge (profiles, agents, skills, procedures, personas, frameworks, gates, output schemas, references, lessons); a filter and "only problems"; each row says what it is for, who loads it, where it is mentioned, its problems, and Read; profiles list what they load as chips; a framework row shows coverage per stage and every statement with what covers it ("only uncovered" shows the gaps). "+ New <kind>" opens an inline form (title, name that follows the title, use-when, body or template, kind-specific fields) and creates the part without ever overwriting an existing one.

### 8.1 Loops

A loop is the order of work a case follows (its stages, gates, context, checks and sub-loops). The **Loops** tile in the Resources column counts the usable loops ("2 usable") and opens `#/loops`.

- **The Loops list.** One tile per loop: its title (a link to the loop), `v<version> · <12 hex>` (the whole pipeline hash is the tooltip), its stage titles joined with " → " ("Sort → Investigate"), its about text, and **New case from this loop**. A loop that is not usable shows its problems instead and has no button. Titles and about texts are text: a title that looks like markup is drawn as those characters.
- **The outline** (`#/loops/<id>`). The heading gives the title, the version and hash, the caps ("depth cap 2 · children cap 8"), the root it comes from (or "implicit loop") and the about text, then **Export**, **New case from this loop**, **Copy** and **Edit**. The stages are a numbered list; each is a collapsed row such as "6. Evaluate · runs agent · on pass → Challenge · on fail → Assemble", with "plan gate" or "publish gate" when it has one, an "inline" chip for a stage written in the loop itself, and its hash chip. Opening a stage shows three groups. **Context**: persona, rules, goal, procedure, skills, references, gate guides, schema, framework, standard. **Middleware**: the checks and their programs, and what is built in (the query guard, the marking policy, a review stage's citation check), marked "built in" with no hash. **Orchestration**: tools, model and effort, fast model, turn cap, send-back cap and, for a stage that runs another loop, that loop as a link, its hash, and what it is given and what comes back. Each item has a source chip (root, pinned, loop output, inline, built in) and a hash chip.
- **Copy and edit.** **Copy** asks for an id (lower-case letters, digits and -) and a title and opens the copy's forms (`#/loops/<id>/edit`). **Edit** opens the same forms on a usable loop of a trusted root. The forms hold the title and about text, and the stages in order, each with Move up, Move down and Remove (removing one clears the edges that named it and says so), and its title, runs, gate, reviews, on pass, on fail, tools (checkboxes), model, turn cap; a sub-loop stage picks the loop it runs and, for each of that loop's inputs and outputs, what it is given and how it comes back (as note cards, or as a draft section). **Add stage** adds a copy of a stage or a sub-loop stage. A **Components** table per stage (and one for every stage) sets each component's source: root, or pinned to a hash. **Check** says what a save would refuse, beside the stage it is about; **Save** writes the loop as its next version ("Saved as version 2 · <12 hex>") and refuses a save over a version someone else saved since the screen loaded. A stage that was not edited stays a reference to its stage manifest. Leaving with unsaved changes asks once. Running cases keep the version they started with; the next run binds the saved one.
- **Loop files.** **Export** writes `<loop>.v<version>.<12 hex>.loop.tar.gz` into the loop store (`loops.store`) and offers a **Download** link. Under the list, **Loop files** lists each file in the store with what an import would do ("12 to write, 30 already here") or its conflicts, a **Download** link and **Import**, which is off for a file with a problem or a conflict. An import lands in a root that is not trusted, and its loops show there with the reason ("accepted only from a trusted root").
- **Trusting a root.** Each root that is not trusted has **Trust this root**, with a box where the folder's name is typed; the button stays off until the box holds exactly that name. The text says what trusting allows: "Trusting it lets its loops, stages and checks load, and its check scripts run." Trusting writes the root into the configuration file.
- **A new case from a loop** (`#/investigate/new/<loop>`) is the new-case form headed "New case from a loop", with "Loop: <title>".
- **The case type on a new case.** Every new-case form has a **Case type** select: None and each case type of the loaded roots. Opened from a loop that has a case type, it is preset to that type (until the person picks); a type chosen is the case's, recorded as the person's. With None chosen, a line says "A case of this loop that names no type takes the loop's: <title>." The case list shows each case's type as a chip beside its loop.
- **A parent waiting on a child.** A case whose stage runs another loop makes a child case and is paused while the child waits for the person. Its brief shows "Paused: waiting on child CASE-2: it waits for a person at its plan gate" once, with **Open CASE-2** beside it. The child's top bar has "child of CASE-1", which goes back. The person passes the child's gates in the child, with the child's own buttons; nothing passes a gate for the person, in either case. When the child settles, the parent goes on by itself; when the child publishes, its findings arrive in the parent's Incoming as note cards that name where they came from. The case list shows a case's loop when it is not the default, "child of CASE-1" on a child and "waiting on CASE-2" on a parent.

- **Build with help.** The Loops page (for a new loop) and each loop's page (for that loop) end with a panel headed **Build with help**, with the conversation's marking chip beside the heading. It lists the conversations about that loop, newest first, each with its id, title, turns and what waits for the person ("1 change waiting", "1 probe waiting"). **New conversation** takes a marking (least restrictive first, from the markings the person may use) and a model, and opens the new conversation. The open conversation draws each question and answer as the agent pane does ("thinking…" while the builder works); the box sends on Enter and Shift+Enter makes a new line.
  - **A change.** Under the box, each change the builder proposed has its title and its reason, then one disclosure per file: its path, "new file" or "changed", and its kind and id. Opened, it shows the diff against the file on disk, one line each, starting with `+`, `-` or a space (the colour only repeats the sign). Each file has its own **Accept** and **Reject**. **Accept** writes that one file into the root, in the person's name, after checking it again against the root as it is now; a refusal (for example a loop whose stage has not been accepted yet) is shown at that file, which stays undecided. A decided file says "Accepted" or "Rejected" and has no buttons. After an accept the Loops list is read again, so a new loop shows at once. A proposal that did not pass the save's check never appears: it went back to the builder as its error.
  - **Stale.** A file that changed on disk after the builder proposed it is *stale*: it says "This file changed on disk since it was proposed, so it cannot be accepted." and has no Accept, only Reject. Ask the builder to propose it again against the file as it is now.
  - **A probe.** A probe the builder asks for shows what would run (the pivot and the value, or the query as text), "on the source <id>", the builder's reason, "costly" with a Budget field when it would cost, and **Approve** and **Reject**. Nothing is sent before **Approve**. Once decided it says "Approved: ran · …" (or why it was refused) or "Rejected"; a probe that ran shows its card (id, title, marking) and the card's first rows as text. One probe waits at a time.
  - No key presses Accept or Approve; titles, reasons, paths, diff lines and answers are text, so a line that looks like markup is drawn as those characters.

### 8.2 Memory

The **Memory** tile in the Resources column (after Loops) counts the lessons waiting for a person ("2 to review") and opens `#/memory`. Shared lessons are notes from earlier cases that a person accepted for a **case type**; a run of a loop that reads them is given the ones whose triggers match the case and whose marking is not stricter than the case's, selected by code. Simple lists and `details` rows only: no graph, no ring.

- **By case type.** One section per case type, headed by its title and about text (and "No case type here now" for lessons of a type no root loads now). Each lesson is a closed row: its id, title, marking chip, status (`proposed`, `shared`, `rejected`, `retired`, `superseded`) and where it came from in words ("seed connection-message of sample-unknown-device", "from CASE-1 (run run-1, product 1), written by the model of its feedback stage", "proposed by a person"). Proposals come first. Opened, a row shows the text, its triggers in words ("Applies to every <type> case" when it has none), its provenance with **Open CASE-N** when that case is loaded here, what it replaces or was replaced by, the reason of a decision, and its history ("#<seq> · <time> · <what> by <who>").
- **Deciding.** A proposal has **Accept**, with a marking select of its own marking and the stricter ones (a lesson's marking may be raised, never lowered), and **Reject**, off until a reason is typed. Accept names the version the row was drawn from; if the proposal changed since, it is refused and the row says so. A shared lesson has **Retire** (with a reason) and **Propose a new version** (fills the form; accepting the new version replaces the old). Nothing is shared but by a person pressing Accept.
- **Propose a lesson.** A form: case type, title (120), text (1200, with a live count), marking, and up to 8 triggers (an observable type, a source, or words a finding contains). It refuses in place an empty or too-long field. Opened from a note's **Propose as a lesson**, it says "From note mN of CASE-N" (with **Name no case**), its marking starts at the case's, and the server refuses one below the case's or its product's.
- **Memory files.** **Export** writes `memory.<marking>.<12 hex>.memory.tar.gz` into `memory.files` and lists it, with a **Download** link; **Load** replaces the whole store with a file, only after the 12 characters of its head are typed, only when this store is empty, holds only the seed proposals a first start filed (none decided by a person), or the file is this same store further on, and never while a run is running. A refusal is shown beside the button, in the server's words.
- Every title, text, trigger, reason and file name is text: one that looks like markup is drawn as those characters.

## 9. Cross-linking (a core theme)

Every id is a chip that opens where it lives:

- objective → Strategy, filtered to it
- framework statement → Inventory › Frameworks, filtered to it
- skill / procedure → Inventory, opened
- requirement item → Requirements, opened
- gap → Gaps, filtered to it
- card citation → the card in its lane
- file in the tree → its card

Each page also shows the reverse links ("loaded by", "mentioned in", "covered by", "blocks", "serves").

## 10. Wording rules

- Tile labels: verb or noun, sentence case, 1–3 words ("Work tickets", "Investigate", "Ask for help").
- Counts: 1–3 words ("4 queued", "soon"); never sentences.
- Tiles never repeat what the head already says; markings move into chips; long or repeated text goes to the tooltip and accessible name.
- Buttons say what happens ("Accept: make 3 hypothesis lanes", "Run the free steps now (4)").
- Requester-facing text uses plain words and no internal tool names.

## 11. Roles and views

Three views drive what is shown: requester (Get help), analyst (Do the work, and most of Resources), leader (Resources, plus leader-only tiles). The server enforces the same views on every call; hiding a tile is never the only control.

## 12. Accessibility

- Everything reachable by keyboard; visible focus rings in the accent colour.
- Every button and input has an accessible name; tiles carry the full text as their name.
- No HTML injection: the UI is built from DOM nodes only; links are https-only and open with noopener.
- Reduced motion respected; colour is never the only signal (tags also have text).

## 13. Concepts behind the screens (environment-neutral)

- **Local-first:** the app is served on the person's own machine (loopback only) until a real deployment with auth exists.
- **Profiles (harness):** a small mapping of activity → agent, persona, goal, method, procedure, skills, schema, references, objective; the pack is assembled per turn and logged with the answer.
- **Context repository:** a local git repository holds everything agents are given (profiles, skills, procedures, personas, gates, schemas, lessons, objectives, requirements, gaps). The app reads it; creating new parts writes new files only.
- **Agents start with no tools.** Read-only tools are granted only from a fixed list in code, never by editing a profile.
- **Read-only by default.** Results from other systems are read; every write is a proposal with a preview and a gate.

## 14. Rebuild checklist

A rebuild matches this concept when:

- [ ] Home is a centred kiosk with role-filtered columns of tile rows; inner screens are top-aligned and do not jump.
- [ ] Picking a mode or item shrinks it into the top-left trail; every level is one click away.
- [ ] The work area has Incoming, lanes, brief, shelf of lenses (bottom or right), jobs indicator, optional file tree.
- [ ] Cards show provenance; values are clickable; drag rules (above/below move, middle or Alt link, Incoming returns).
- [ ] Keep, move, discard and send-back are undoable; discard never deletes.
- [ ] Partial coverage is tagged and never shown as a proven negative.
- [ ] The agent pane shows its loaded context as removable/addable chips and only proposes.
- [ ] Plans and hunt plans are proposals; nothing runs until accepted; costly steps wait for a budget.
- [ ] Self-help shows only shareable results, offers a pre-filled ticket, and asks for a rating to finish.
- [ ] Strategy, Requirements, Gaps and Inventory cross-link every id both ways.
- [ ] Tiles use fixed slots, short labels and markings as chips; full text in tooltips.
- [ ] Keyboard map and "?" help card as in 5.2.
