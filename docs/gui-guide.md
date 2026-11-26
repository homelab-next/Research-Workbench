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
    └── Agent inventory       → inventory panel (analysts)
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

### 5.3 Lenses

- **Agent:** see section 6.
- **Ticket:** who asked, what they asked, their indicators and questions.
- **Steps:** the plan (planner proposal or hunt plan, see 7) and each question with its goal, status and Plan / Run.
- **Timeline:** *soon* — what was observed, on the data's own time axis.
- **Graph:** case at the top, lanes as branches, cards as nodes, links as edges; nodes are clickable and keyboard-reachable. A tall layout when docked right.
- **Notes:** typed notes (note, to-do, question, decision), on the case or on a card; external links (https only).
- **Narrative:** Summary, Key findings, Gaps and limits, Assessment. "#" in a section opens a picker to cite a kept card; dragging a card into a section cites it. Drafts (from the agent or the workbench) arrive as proposals to accept, edit or discard. "Copy as Markdown" expands every citation into its provenance and adds the marking.
- **Worklog:** what the system did, in the order of record (human, agent, system); every entry one toggle away.
- **Discarded:** everything discarded, restorable.
- **Jobs:** every background job with status, source and duration.

### 5.4 Pivot and Combine panels (inside a card)

- **Pivot:** pick the answer you want (a goal type); the panel shows the cheapest routes to it, each hop with source, cost class, whether it needs a time window, and what an empty result means. Window (case-anchored, N days, custom, all time) and limits (max cost, unconfirmed sources) are adjustable. Running a route reroutes around roadblocks and shows the trail.
- **Playbooks:** under the routes, a button for each playbook whose inputs the card's values can fill, for example "Run Triage an address on 198.51.100.77 · up to 8 lookups, no model". It uses the panel's window and reason (say why first), asks only free sources and spends no budget. Below the buttons, the trail of the run you started: each step with its pivot, skipped steps with the reason, each lookup's value and outcome with a card chip, "reused, no query sent" where an earlier answer was used, and "N values not followed" where a step hit its limit. If the server stopped mid-run it reads "Interrupted"; run it again and answered lookups are reused. A second press on the same value and window is refused while one is running. The command bar does the same for one value: `run playbook address-triage on 198.51.100.77`.
- **Does it belong?** A button for each value an inventory can be asked about ("Does 198.51.100.77 belong? · asks 2 inventories"). It asks every inventory and shows one line each and one verdict: **Known asset** (some inventory lists it); **Not a known asset: proven for <scope>** (none lists it and a complete inventory came back empty with full coverage); **Not seen in any inventory; none is complete, so this proves nothing**; **Could not tell** (a lookup failed, was partial or waited for a budget, and nothing listed it).
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
- **Give feedback:** about (dropdown), star rating, comment, Send.
- **Learn (research):** one search box; results from the team's own material first (each with kind icon, marking chip, snippet, Open); then a cited research brief from the research agent (links clickable, https only); follow-up box continues the thread; recent searches as chips.
- **My folders:** add a folder path; each folder shows its detected layout and its cases (newest first) as small buttons, with a filter. Folders are read in place; nothing is written into them.
- **Strategy:** a collapsible tree from strategy to tasks, colour-coded by level; each node shows its measures (target, source), control, data availability, work type, and which workbench activities serve it; a node with several parents appears under each, marked. Depth buttons (to SO / OO / TO / TT) and a filter that keeps the path to each match.
- **Requirements:** requirement sets with status counts; each need with status tag, cadence, "needed by" objective chips and sources; "More" shows detail and what would close it. Filter and status picker.
- **Gaps:** counts per cycle stage (clickable filters), kind picker; capability / product gaps (uncovered statement chips, "draws on", "waits on", "blocks", serves, priority, owner; More shows why and how to close) and collection gaps from the requirements beside them.
- **Agent inventory:** tabs per kind with counts and a ⚠ problem badge (profiles, agents, skills, procedures, personas, frameworks, gates, output schemas, references, lessons); a filter and "only problems"; each row says what it is for, who loads it, where it is mentioned, its problems, and Read; profiles list what they load as chips; a framework row shows coverage per stage and every statement with what covers it ("only uncovered" shows the gaps). "+ New <kind>" opens an inline form (title, name that follows the title, use-when, body or template, kind-specific fields) and creates the part without ever overwriting an existing one.

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
