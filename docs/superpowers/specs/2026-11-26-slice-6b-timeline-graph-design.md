# Research Workbench: what was observed, when, and how it links (6b)

Design, 2026-11-26. Status: written for the owner, who has opted out of design questions for this round. Every decision below is a ruling by the designer with its reason; section 13 lists them again so they can be checked in one pass.

This design builds on [`2026-11-23-investigation-slice-design.md`](2026-11-23-investigation-slice-design.md) ("the slice design") and [`2026-11-26-slice-6a-playbooks-design.md`](2026-11-26-slice-6a-playbooks-design.md) ("6a"). Where it says "6a §7.3" it means that section. The plan that implements it is [`../plans/2026-11-26-slice-6b-timeline-graph.md`](../plans/2026-11-26-slice-6b-timeline-graph.md).

The evidence is the second real investigation, dev CASE-2 (633 entries, 7 lake queries, 121 model requests, publish gate in 66 minutes), the 6a final review, and the owner's own pivots as they stand today.

---

## 1. Intent

After 6a a case fills with cards quickly and cheaply. What the workbench still cannot show is the thing an analyst asks of those cards first:

1. **When was this seen?** A card says "12 rows". It does not say that the address was first seen on the 17th and last seen an hour ago. Two of the owner's nine pivots already return a first time, a last time and a count; nothing reads them.
2. **How do these values hang together?** The address led to a MAC, the MAC to two more addresses, one of those to a host. That chain exists only in the order the cards arrived.

6b adds two lenses that answer these from the record: the **Timeline** (what was observed, on the data's own time axis) and the **Graph** (observed values, linked by the pivots that found one from the other). It also closes what 6a's review and dev CASE-2 left open (section 10).

## 2. Goals, non-goals, anti-goals

### Goals

1. **Times from results.** A pivot declares which of its result columns hold time. The runner reads them once, from every row of the result, and the card carries what was observed: per value, first seen, last seen, how many events, and the count at each time where the pivot returns one row per event or per bucket.
2. **One observed model, from the fold.** A pure, browser-safe function of the folded case state says what each card observed. The Timeline model and the Graph model are built from it and from nothing else. Replay at entry N gives exactly what live gave at entry N.
3. **The Timeline lens.** One row per value, on one horizontal axis that covers the case window and everything observed; a mark per card; the cards that say so one click or one key away.
4. **The Graph lens.** A node per observed value, an edge per "this pivot, on this value, found that value", with the card. A layout that is the same every time. A node's cards, its links, its "does it belong?" verdict and a "Pivot…" action.
5. **A safe way to draw.** SVG made through one small builder with the same rules as the HTML helper: fixed tags, fixed attributes, text as text nodes, numbers as numbers.
6. **The carried items** of section 10.

### Non-goals (6b)

- A time brush, zoom or pan on the Timeline. The axis is the case window widened to what was observed. Narrowing is done by type filter.
- A force-directed layout, dragging nodes, or saved positions.
- Editing the graph: linking two cards by drag (gui-guide §5.1), lanes as branches, notes as nodes. The Graph shows what the record's lookups found, nothing a person drew.
- Reading times from a result whose pivot declares none. The workbench does not guess which column is a time.
- Folding case differences in a value (`AA:BB` and `aa:bb`) into one node. A value is the string the source returned; the pivot's query is the place to normalise it.
- Time zones other than UTC. A time with no zone is read as UTC (section 5.2).
- A budget a person can give a playbook, and the other items of 6a §13.

### Anti-goals (these make it a failure even if it runs)

- A time, a link or a count shown in either lens that is not on a card in the record, or that changes when the module root changes after the fact.
- A layout or an order that differs between two renders of the same state (live, replay, another browser).
- Text from a source reaching the page as markup: a value, a title or a pivot id written into an attribute or an element by any path except the two builders.
- A count summed across cards as if the cards counted different events.
- A real host, address, account, schema, table or column name of the owner's in the repository, a test or a commit message.

## 3. Constraints

- **The ledger is the only source of truth** (6a §3). What a lens shows is a function of the entries. The page's reference (titles of types and pivots) may supply words; it never decides a time, a link or a verdict. This is the lesson of 6a's review finding I2.
- **One custody point.** Nothing in 6b reaches a source. Times are read from a result the runner already holds, in the same commit that makes the card.
- **The fold never throws and never mutates its input.** The new card field is optional; a card recorded before 6b folds as it did.
- **The page's rules** (`tests/web/lint.test.ts`, and the page's content policy in `src/server/guard.ts`): no HTML sink, no inline style (`style-src 'self'`), no element made outside the helper. SVG geometry therefore goes in attributes, colour in classes.
- **Markings.** A card's observed times and values are as strict as the card. Neither lens sends anything anywhere; both read cards the person may already open.
- **Replay.** Both lenses read `store.shown`, so they show the case as of the replay position, and every action that would change the case is disabled there.

## 4. Approaches considered

### 4.1 Where observed times come from

| | Approach | Trade-off |
|---|---|---|
| A | The lens reads times out of each card's preview rows, guided by column names (`first_seen`, `ts`, …). | Nothing to declare. But the preview holds 50 rows of a result that may hold 500, the guess is wrong the first time a column is called `since`, and a browser parsing source-shaped time strings is not the same in every engine. |
| **B** | **The pivot declares its time columns; the runner reads every row once and writes a compact summary on the card.** | One line on a pivot. The summary is in the record, so it is replay-exact and independent of today's manifests; it is computed from all rows, not the preview. It adds bytes to `card.created` (bounded, section 5.4). |
| C | A new entry type per observation. | Queryable. But one lookup would write hundreds of entries, and a card would no longer be the single thing that says what a result showed. |

**Ruling: B.** The card is where a result's meaning already lives (coverage, what empty means). What it observed belongs beside them.

### 4.2 Where the model lives

The per-value timeline and the graph could be kept in `CaseState` and updated by a reducer on every card entry, or computed by a pure function of the state when a lens needs them. **Ruling: computed** (`src/core/state/`, browser-safe, pure). A discarded card must drop out and a restored one come back, which an incremental index does badly; the store keeps a snapshot of the state every 200 entries, which an index would multiply; and a function of the state is replay-exact by construction. Each lens caches the result by state identity.

### 4.3 The graph's layout

| | Approach | Trade-off |
|---|---|---|
| A | Force-directed, seeded. | Looks organic. Needs iteration, floating-point drift differs by engine, a new card moves every node, and "the same in replay" has to be argued. |
| **B** | **Layered, by distance from the case's starting values; order within a layer is the order of record.** | Dull and predictable. A new card adds nodes at the end of a layer and moves nothing above it. Integer arithmetic only. Reads left to right as "what led to what", which is what an analyst is asking. |

**Ruling: B.**

### 4.4 How to draw

HTML boxes cannot be placed without inline style, which the page's policy forbids. A canvas cannot be read by a screen reader or reached by keyboard. **Ruling: SVG, through a second builder** (`src/web/svg.ts`) with a fixed list of tags and attributes. No dependency.

## 5. Times from results

### 5.1 The declaration

A pivot gains one optional line, in one of two shapes:

```yaml
# one row per value (or per value and something else): a span
times: { first: first_seen, last: last_seen, count: events }
# one row per event, or per time bucket: points
times: { at: hour, count: events }
```

- `first` and `last` together, or `at` alone. `count` is optional in both.
- **Span:** each row says a value was seen from `first` to `last`, `count` times. Without `count` the count is not known.
- **Points:** each row says a value was seen at `at`, `count` times (once, without `count`). This is the shape that gives counts over time: a query that groups by the value and an hour, or one that returns raw events.

Checked at load (a pivot that fails is rejected with the reason; the server still starts):

- the shape is one of the two;
- the named columns differ from each other and none is a column `yields` names;
- each named column appears as a word in the pivot's query (for a pivot on an `http` source: in the columns of the endpoint it names). This catches a typo before a run; it does not prove the source returns the column.

`times` only names columns of the pivot's own result, so it needs no trusted root.

A pivot's hash covers its file. Adding `times` to one pivot therefore changes the hash of every pivot in that file: answers recorded before are not reused, and a plan accepted before is blocked (section 10, M3). That is correct, since the query changed, and it means the owner edits pivots between cases.

### 5.2 Reading a time

One function, `readTime`, turns a cell into a UTC timestamp with milliseconds (`2026-11-20T03:04:05.123Z`), or says it cannot. It reads strings only, by pattern, never with the engine's date parser:

| Form | Example | Read as |
|---|---|---|
| ISO with `Z` or an offset | `2026-11-20T03:04:05.123Z`, `2026-11-20T03:04:05+01:00` | that instant |
| Date, space, time, optional zone | `2026-11-20 03:04:05.123 UTC`, `2026-11-20 03:04:05`, `2026-11-20 03:04:05.123456 +00:00` | that instant; **no zone means UTC** |
| Date only | `2026-11-19` | midnight UTC |

Fractions past milliseconds are cut. A named zone other than `UTC` or `Z`, a number, a date that does not exist, or anything else is **unreadable**.

Rulings in this table: *no zone means UTC* because the lake and the sample both store UTC, and a pivot over a source in local time can convert in its query; *numbers are not read* because seconds and milliseconds cannot be told apart, and the query can convert them.

The runner is the only caller. The fold and the page only ever compare the normalised strings.

### 5.3 What the card carries

A card made by a pivot's own query gains `observed`:

```ts
interface Span     { first: string | null; last: string | null; count: number | null }
interface Sighting extends Span { type: string; value: string; points: [string, number][] }
interface Observed {
  pivot: string;        // the pivot that ran
  from: Observable;     // the value it ran on, with the pivot's `from` type
  span: Span;           // over every row: what the result says about `from`
  found: Sighting[];    // the values the pivot yielded, in the order found
  more: number;         // yielded values past the cap, not listed
  unread: number;       // rows whose declared time could not be read
}
```

- **`found`** holds each distinct value of every column `yields` names, typed by that mapping and checked against the type's pattern, as a playbook's fan-out already does. Rows for one value are merged: `first` is the earliest, `last` the latest, `count` the sum (unknown if any row's is unknown).
- **`span`** is the same merge over every row. It is what the result says about the value the pivot ran on: the address was seen with these names between these times.
- **`points`** is filled only for the points shape: each distinct time the value was seen at, with its count, in time order.
- **A pivot with no `times`** still gets `observed`, with every time and count null. The Graph needs the values and the link; only the Timeline needs times.
- **An empty result** gets `observed` with nothing found. The value it ran on is still a node.
- **A row whose declared time cell is missing, null, unreadable, or whose `first` is after its `last`** counts in `unread`. Its value is still found; it adds no time.
- A card made by an ad-hoc query, an assessment or a note has no `observed`.
- **`event_time`**, which every card has and nothing has ever set, becomes `observed.span.first`. Incoming's existing "event time" sort then works.

The card's body is not changed. The time columns are in its rows, where a reviewer's model already reads them.

### 5.4 Limits

- At most **100** sightings on a card. Values past that are counted in `more`.
- At most **24** points on a sighting. More distinct times than that are merged into 24 equal slices of the sighting's own span, each slice's count the sum of its points, each slice placed at its start. The arithmetic is on whole milliseconds, so it is the same everywhere.

Worst case this adds about 100 KB to one `card.created`; a card from one of the owner's pivots (50 rows, a span each) adds about 6 KB.

### 5.5 Cards recorded before 6b

CASE-1 and dev CASE-2 have no `observed`. For such a card the fold works out what it can from the record alone, so the owner's existing cases are not blank:

- the pivot and the value from the card's query (`query.issued` already records both; the fold now keeps them);
- the value's type: a starting value of the case with that value, else the type of the first typed cell holding it on any card, else `unknown`;
- found: the distinct cells of the card's typed preview columns;
- no times.

This reading is marked `legacy` and both lenses say so in one line. It is a best effort over at most 50 preview rows; a lookup run again after 6b replaces it with the real thing.

## 6. The observed model in the fold

Three pure functions in `src/core/state/`, importing nothing outside it.

**`cardObserved(state, card)`** returns the card's `observed` (or the legacy reading of §5.5), or null for a card that has none or is **discarded**. A person who sets a card aside sets aside what it says; restoring it brings it back. Every other card counts, kept or not: the lenses show what was observed, and keeping is about what the product cites.

**`timelineOf(state)`** returns one row per value that has at least one time:

- a **mark** per card and role: the value as the *subject* of a card (the card's `span`, when the card has rows), or as *found* by it (its sighting);
- the row's `first` and `last` are the earliest and latest over its marks. **There is no row total.** Two cards over overlapping windows count the same events, so each mark keeps its own count and the row adds nothing up;
- rows are ordered by first seen, then type, then value, compared as plain strings;
- the axis runs from the earlier of the case window's start and the first thing observed to the later of its end and the last thing observed. An open end of the window is ignored;
- it also returns how many values have no time at all, how many rows were unread, and whether any card was read the legacy way.

**`graphOf(state)`** returns nodes and edges:

- a **node** per value: every starting value of the case, in order, then every value of every card's `observed`, in the order the cards were made and, within a card, the value it ran on and then what it found. A node lists its cards and how many found values its cards could not list (`more`);
- an **edge** from the value a pivot ran on to each value it found, carrying every `{ pivot, card }` that says so. A value found from itself makes no edge;
- a node's key is `<type>|<value>`, the key Incoming's "known value" highlight already uses.

## 7. The Timeline lens

`T` opens it; it replaces the "soon" placeholder and moves nothing (6a ruling 22).

```
[x] Address  [x] Domain  [x] Mac                    2026-11-17T00:00Z ───────── 2026-11-20T00:00Z
▸ address 198.51.100.77   |░░░░░░░[==========]░░░░░░░░░░░░░[=====]░░░|
▾ domain  cdn-update…     |░░░░░░░░░░ ▂▅█▃ ░░░░░░░░░░░░░░░░░░░░░░░░░░|
     c12 · found by Names that resolved to the address · 2026-11-17T08:01:10.000Z → 2026-11-19T22:40:02.000Z · 41 events
     c15 · subject of Clients that looked the name up · …
3 values have no observed time (their pivots declare none); they are in the Graph.
```

- **Header:** a checkbox per type present (all on), and the two ends of the axis in UTC.
- **A row:** a button with the type and the value, and a strip. The strip shades the case window and draws each mark: a span as a bar from first to last (never thinner than 4 units of 1000, so a single moment is visible), points as bars whose height is the count relative to the largest in the row. A mark's tooltip says the card, the pivot's title, the times and the count.
- **Click a mark:** opens its card (`nav.focusCard`).
- **Keyboard:** the row's button is a tab stop; Enter or Space opens the row's detail, a list with one line per mark and the card's chip, which is a button. Every card on the Timeline is therefore reachable without a pointer. The marks themselves are not tab stops: a busy case would have hundreds.
- **Limits:** the first 200 rows are drawn; a line says how many more there are and to narrow by type.
- **Honest lines**, each shown only when true: how many values have no observed time; how many rows had a time that could not be read; that some cards were recorded before times were, so their values appear only in the Graph.
- **Nothing yet:** "No card carries an observed time yet. A pivot gives one when its manifest declares `times`."
- Times are UTC with milliseconds, as everywhere (slice §10.2).

## 8. The Graph lens

`G` opens it (gui-guide §5.2 already gives it that key).

**A change to the gui-guide.** Its §5.3 describes the Graph as "case at the top, lanes as branches, cards as nodes, links as edges". 6b builds a different graph: values as nodes, pivots as edges. Reason: the lanes-and-cards picture repeats what the work area already shows, and the question dev CASE-2 could not answer on screen was "what led to what". The guide's line is rewritten (6a rewrote its Timeline line the same way). Its requirements that carry over are kept: nodes are clickable and keyboard-reachable, and the layout is tall when docked right.

### 8.1 Layout

`layoutGraph(model, { dir, types, focus })` is pure and uses whole numbers.

1. **Visible:** nodes whose type is ticked; edges with both ends visible.
2. **Roots:** the starting values, in order. In **focus** mode, the focused node alone.
3. **Walk** breadth-first from the roots, treating an edge as joining its two ends in either direction, neighbours in the model's order. A node's **layer** is its distance from a root. When the walk runs dry and visible nodes remain that it has not met, the first of them in model order becomes a root.
4. **Two caps.** A node places at most **12** neighbours as its children; at most **60** nodes are placed in all. A neighbour passed over is not made a root later. Every placed node knows how many of its neighbours are not drawn.
5. **Wide** (docked at the bottom): layers are columns, left to right; a layer's nodes stack in the order the walk met them. **Tall** (docked right): one node per line in the walk tree's depth-first order, indented by layer.
6. **Edges** are straight or one-elbow lines between placed nodes; a dot marks the end the pivot found.

Sizes: a node is 180 by 26; columns are 70 apart, rows 8 apart; the tall indent is 24; the margin is 12. Coordinates are written with at most two decimals.

Because the walk follows the order of record, a new card appends: it never reorders what is already drawn in a layer above it.

### 8.2 What is drawn

- **A node:** the type's title, small, and the value (cut at 22 characters; whole in its tooltip and its accessible name). Its colour class is one of eight, by the type's place in the sorted list of types present. A "+N" badge when N of its neighbours are not drawn.
- **The verdict mark.** A value on which "does it belong?" has finished carries a mark from the newest such run: ✓ *Known asset*, ✗ *Not a known asset: proven for <scope>*, ? *Not seen …* or *Could not tell*. The verdict is 6a's `belongsVerdict`, read from the run and the cards in the record; the words are in the node's accessible name and in the detail, so the glyph and colour never carry it alone.
- **An edge:** a line. Its tooltip names the pivot and the cards. The pivot's title is drawn as a label on the edges of the selected node only; on every edge at once the graph is unreadable.
- **The header:** type checkboxes; "Showing 60 of 143 values"; in focus mode, a "Whole graph" button.

### 8.3 Selecting a node

Click, or Enter or Space on it, selects a node and fills the detail beside the drawing:

- the value, its type, and its verdict line if it has one;
- **its cards**, as chips that open the card;
- **its links**, one line each: the direction, the other value, the pivot's title, the cards. The other value is a button that focuses the graph on it, so a value that is not drawn is always one press away;
- a line when its cards hold more values than they list;
- **Pivot…**, which opens the Pivot panel inside the node's newest card, starting from this value (`nav.pivot`). Disabled, with the reason, in replay and for a value no card holds;
- **Focus on this value**.

**Keyboard.** The drawing is one tab stop. Arrow right or down moves to the next node in layout order, left or up to the one before, Home and End to the ends; Enter or Space selects. The detail's buttons follow in tab order.

### 8.4 Nothing yet, and old cases

With no card that observed anything: the starting values as nodes and the line "No lookup has linked these yet." A case read the legacy way (§5.5) draws its graph and says "Some cards were recorded before links were; their links are read from the first 50 rows."

## 9. The SVG builder

`src/web/svg.ts`, the only file besides `dom.ts` that may create an element or set an attribute. The lint test names both and holds the second to the same rules.

```ts
s(tag, props, ...children)
```

- **Tags:** `svg`, `g`, `line`, `rect`, `circle`, `path`, `text`, `title`. Anything else throws.
- **Number attributes:** `x`, `y`, `width`, `height`, `cx`, `cy`, `r`, `rx`, `x1`, `y1`, `x2`, `y2`. Each must be a finite number and is written rounded to two decimals.
- **Built attributes:** `viewBox` from four numbers; `points` (a list of `[x, y]`) becomes a path's `d` as `M x y L x y …` and is allowed on `path` only; `translate` from two numbers; `anchor` is one of `start`, `middle`, `end`; `stretch: true` writes `preserveAspectRatio="none"`.
- **Text attributes:** `class`, `id`, `role`; `name` becomes `aria-label`; `tabindex`; `hidden: true` becomes `aria-hidden="true"`; `data` and `aria` maps with the HTML helper's name rule (lower-case, no name starting `on`).
- **Listeners** through `on`, as functions.
- **Children:** nodes, or strings and numbers, which become text nodes.
- **Never:** `style`, `href`, `d` as a caller's string, `fill` or `stroke` (colour is a class in the stylesheet), `foreignObject`, `use`, `image`, `a`, `script`.

There is no way through it to put a string from a source anywhere but a text node or an attribute value of a fixed attribute.

## 10. Carried items

| # | From | What | Ruling |
|---|---|---|---|
| A | dev CASE-2 | Evaluate said cards cited only in "Gaps and limits" were "not provided in the evaluation context". The reviewers' packs held only the cards the findings cite. | A reviewer's pack holds every card the draft cites anywhere: the findings' cards first, in finding order, then the rest of what the draft cites (its recorded narrative citations and every card its text names). A cited card that is no longer in the case is named in the reviewer's task, so the reviewer says "cited but gone" and does not judge what it held. |
| B | 6a T12 | The `extractJson` test asserts 200 ms and fails under load. | It asserts the shape, not the clock: the time for 1 MiB against the time for 128 KiB, best of three each. Linear is about 8 times; the test fails above 24. |
| C | 6a M7 | The `does-it-belong` id in `wire.ts`. | Done in `683a49a`. The plan checks it with a grep and changes nothing. |
| D | 6a M3 | The plan pins the playbook file's hash, not its pivots. | Every plan step records `pins` (worked out in `src/modules/`, where the planner and the step tool can both reach it): one hash over what the person accepted. For a playbook step: the playbook's hash and, per step, the pivot's hash and its inventory's id and hash. For a route step: the pivot's hash and its inventory's id and hash. A step whose pins no longer match is not run; it finishes `blocked` with the reason, as a changed playbook does. A step recorded without `pins` runs as before. |
| E | 6a M5 | A playbook with several `end` steps: the plan checks only the first. | Every end step must find the wanted type, or the playbook is refused as a plan step with the reason. The step's "if empty" is a proven negative only when every end step's pivot says so. |
| F | 6a M10 | An accepted step run in code is recorded as the researcher's, and only the reason text says no model chose it. | `step.started` gains `by: "workbench"` for a step the workbench ran in code (a route step before the researcher is asked, and a playbook step). The Steps lens shows it. |
| G | 6a M11 | Recovery at start covers only cases whose run is running. | It covers every case with a running run **or a running job**, so a person-started playbook cut off by a restart reads "interrupted" at once. |
| H | 6a M12 | The stage's reply cap is not checked against the fast model's context. | When the cap does not fit the fast model's share of context, the fast model is not used for that stage run and the stage's own model takes the routing turns (6a §8: "if the fast model is not there"). `preflight` already fails it by name. |
| I | 6a M13 | A playbook run can be followed only in the Pivot panel that started it. | A playbook job's row in the Jobs lens opens to the run's steps: the same trail, from the fold. |
| J | 6a T2 | A run halted in its end step can read `answered`; a step never reached leaves no entry. | A run halted in or before its end step ends `blocked`. Every step not reached is recorded `skipped` with the reason (stopped, or the lookup ceiling). |

Not carried further: a budget a person can give a playbook, a step that takes a named column, cost policy as configuration, more inventory sources (6a §13). None blocks a case.

## 11. The sample, and the owner's root

**The sample** gets `times` on its five windowed pivots, so a sample run fills both lenses: four in the span shape (the yielded value, then `first_seen`, `last_seen`, `events`, grouped by the value and ordered by first seen so the order found does not change), and the flows pivot in the points shape (one row per flow, with its time).

**The owner's root** (`~/workbench-lake/root/pivots.yaml`, read for this design; none of its names is repeated here). It holds nine pivots, all windowed, all aggregates capped at 50 rows:

- **two** already return a first time, a last time and a count. Each needs only the `times` line;
- **seven** return a count only. Each needs two columns added to its `select` (the earliest and the latest of the table's time column) and the `times` line.

None needs the points shape to be useful on day one; one that groups by the hour can be added later for a value worth watching. The plan's last task is this checklist, with placeholders, for the controller to carry out in the owner's root and in the dev root.

## 12. Testing

- **Declaration:** each load-time refusal, with its reason; the sample's pivots load.
- **Reading a time:** each row of the table in §5.2, and the unreadable forms.
- **The card:** span and points shapes; rows merged per value; the 100 and 24 limits; unread rows; a pivot without `times`; an empty result; `event_time`.
- **The fold:** a card with `observed` round-trips; a card without it folds as before; a malformed `observed` is skipped, not thrown; `cardObserved` on a discarded and a restored card; the legacy reading.
- **The models:** `timelineOf` and `graphOf` on built states; **replay equals live** at every entry of a sample run; the same state gives deep-equal results twice.
- **The layout:** deterministic; both caps; focus; filters; wide and tall; a new card does not move earlier nodes in a layer above.
- **The builder:** every refused tag, attribute and value; text is a text node; the lint test covers `svg.ts`.
- **The lenses** (happy-dom): rows, marks, a click and a key reaching the card; the detail; the verdict mark; Pivot… disabled in replay; the honest lines; nothing source-shaped becomes markup (a value of `<img src=x onerror=1>` is text).
- **Carried items:** each row of section 10 has a test that fails before its fix.
- **Acceptance:** on the sample, a person-started playbook leaves cards with `observed`; `verify` passes; the hygiene scan runs with the owner's private terms.
- **By hand, by the owner:** the `times` lines on the live lake (plan Task 7).

## 13. Rulings

1. **The pivot declares its time columns; the workbench guesses nothing.**
2. **Two shapes: a span (`first`, `last`) or points (`at`); `count` optional.**
3. **Times are read by pattern, strings only, into UTC with milliseconds. No zone means UTC. Numbers are not read.**
4. **The runner reads every row once and the card carries the summary** (`observed`). The preview's 50 rows are not the source of times or links.
5. **`observed` is written for every pivot card, with or without `times`,** so the Graph does not depend on time columns.
6. **Limits: 100 sightings a card, 24 points a sighting.**
7. **`event_time` is the first time the card observed.**
8. **The models are pure functions of the folded state**, not fields of it.
9. **A discarded card observes nothing; kept and incoming cards count alike.**
10. **Cards from before 6b are read as well as the record allows and marked `legacy`.**
11. **No row total on the Timeline.** Counts stay on the card that made them.
12. **The Timeline's axis is the case window widened to what was observed.** No zoom in 6b.
13. **Timeline marks are clicked; cards are reached by keyboard through the row's detail.**
14. **The Graph is values and pivots, not lanes and cards;** the gui-guide's line is rewritten.
15. **Layered layout by distance from the starting values, in the order of record.** No force layout.
16. **Caps: 12 neighbours placed per node, 60 nodes drawn; every hidden value is reachable through a neighbour's detail and focus.**
17. **Edge labels are drawn for the selected node only;** every edge has a tooltip.
18. **The verdict mark is 6a's verdict, from the record,** with its words in the accessible name.
19. **Pivot… opens the Pivot panel in the node's newest card.** No new command.
20. **SVG through a second builder with fixed tags and attributes;** colour by class; no caller-written path data.
21. **Reviewers' packs hold every card the draft cites anywhere, findings' cards first.**
22. **Every plan step pins what was accepted** (`pins`); a mismatch blocks the step.
23. **`step.started` says `by: "workbench"`** when no model chose the lookup.
24. **Recovery at start covers a running job as well as a running run.**
25. **A halted playbook run ends `blocked` when its end step did not finish; steps not reached are recorded `skipped`.**
26. **A fast model whose context cannot take the stage's reply cap is not used.**
27. **The owner's pivots are changed by the controller from a checklist with placeholders;** none of their names enters the repository.

## 14. What comes after

A time brush on the Timeline and a pivot shape that groups by the hour for the owner's busiest lookups, once a real case shows which values are worth watching. Linking cards by hand and notes on the graph (slice §15). Then the items of 6a §13.
