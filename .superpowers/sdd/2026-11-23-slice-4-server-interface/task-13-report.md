# Task 13 report: Pivot panel, Verify, row-level difference

Status: done. `bun test`: 1817 pass, 0 fail; `bun run typecheck` clean (run before the final CSS-only addition and the commit).

## TDD
RED runs, before any implementation existed:
- state/ledger: `ENTRY_TYPES.length` expected 68 received 67; `route.finished` malformed payload not recorded in `skipped` (2 fail).
- `tests/modules/rows.test.ts`: `Cannot find module ".../connectors/rows"`.
- `tests/modules/revalidate.test.ts`: `Export named 'difference' not found`.
- `tests/server/seek.test.ts`: 13 fail (404 for the new routes, unknown commands).
- `tests/web/pivot.test.ts` / `verify.test.ts`: 0 pass, 7 fail (module `src/web/trail` missing; no `.verify`).
GREEN: all of the above pass after implementation; full suite and typecheck pass (including custody and lint tests).

## What was built
- `src/core/types.ts`, `state/run.ts`, `describe.ts`: entry type `route.finished` (ENTRY_TYPES now 68; shape-only reducer, malformed goes to `skipped`).
- `src/modules/connectors/{sqlite,http,trino}.ts` export pure readers (`rowsOfSqlRaw`, `rowsOfHttp`, `rowsOfTrino`); `rows.ts` has `rowsOfBlob`. The sql/files raw bytes and the http URL/rows reading are shared by `run` and the reader; http finds the endpoint by re-rendering each endpoint against the recorded text, bound values and window.
- `src/modules/revalidate.ts`: `difference()`; a side whose read-back rows do not hash to the recorded `rows_hash` is not trusted ("cannot be read back row by row").
- `src/core/wire.ts`: `Difference`, `RouteView`. `src/server/roles.ts`: Reading `difference`.
- `src/server/seek.ts`: `GET /api/routes`, commands `run_route`, `run_pivot`, `verify_card`; `src/server/app.ts` mounts them and `GET /api/cases/:id/cards/:card/difference`.
- Web: `src/web/trail.ts` (`routeTrail`), `panels/pivot.ts`, `panels/verify.ts`, `api.ts`, `views/card.ts`, `views/workarea.ts` (the `pivot` handler), `commands.ts` (`verify c1` now sends `verify_card`), `style.css`.

## Rulings and how they were kept
- No source call inside the case queue. `run_route` and `verify_card` check in the queue and run in `hub.background`; `run_route` ends with one commit (`route.finished` + `job.finished`) that re-checks the job is still running; if `runRoute` throws, `job.finished` is `failed` and the error goes to the hub's reporter. `run_pivot` asks the source in `prepare` (outside the queue, before it is entered) so its refusal and the estimate text can be returned; see deviation 1.
- Every query goes through `runPivot`/`runRoute`/`revalidateCard` (runQuery). Nothing under `src/server` imports a connector (custody test passes).
- A costly pivot with no budget runs nothing: `run_pivot` answers `this lookup is costly: the estimate is <n> <unit>; give a budget`; in a route it ends the hop and the panel shows a budget block, nothing runs until the person sets one.
- Caveats are shown as recorded (one line each). A partial lookup reads `partial: <reason>`, never as a negative.
- Replay: Pivot and Verify disabled; value chips and column buttons are disabled and do not call `nav.pivot`; the workarea `pivot` handler also refuses in replay; the verify difference is not fetched in replay.

## Deviations and things to know
1. `run_pivot` and the brief's "waited for": the controller ruling says commands answer at once, but the brief needs a `Refused` carrying the estimate. I put the lookup in `prepare`, which the app runs before the serial queue, so it holds nothing. If the controller wants it strictly in the background the estimate refusal would have to come from a local estimate only.
2. The trail has no entry for a hop that "needs a budget" (the runner writes nothing when it returns `needs_budget` for a person without a budget). The panel finds it from the `route.finished` caveat `<pivot>: needs a budget`, shows the pivot's `costly (<weight> per <unit>)` from the reference as the estimate, and takes the value from the starting values of the pivot's `from` type (editable). The exact estimate is given by `run_pivot`'s refusal if the budget is too low.
3. Trino reader cannot know a budget stop (budget not in the issued entry); `difference()` therefore verifies the hash and reports "cannot be read back" rather than guessing. Trino's own `execute` still builds rows incrementally; only the reader is shared as a pure function, not `run`.
4. The final-commit re-check for `verify_card` is not possible: `revalidateCard` writes `verify.run` itself.
5. Edited outside the brief's file list: `tests/core/ledger.test.ts` (count 68), `tests/web/card.test.ts` (Pivot and Verify are now enabled), `src/web/commands.ts` (verify in the bar), `src/web/views/workarea.ts`. `.trail` CSS was scoped to `nav.trail` because the panel's trail uses the class name the test names.
6. The "Pivot..." action starts from the distinct typed values in the card's preview rows (at most 12; a chip click removes one when there are several).
7. Uncommitted edits by another engineer in `src/web/lenses/replay.ts`, `src/web/views/brief.ts`, `tests/web/replay.test.ts` were left alone and not staged.

## Review fix round
RED first: 6 of the new/updated tests failed (recovery order, malformed escape, difference reader throwing, "rate:" label, two costly routes, route window). All pass after the fix; typecheck clean.
- `run_pivot` now calls `hub.engine(case)` (recovery) in `prepare` before the lookup. To reach the hub, `prepare`'s context gained `hub` (one line in `src/server/commands.ts` and the call in `app.ts`; outside the stated file list, needed).
- `pivot.ts`: a new route clears `ran` and `budgets`; the budget block's `run_pivot` uses the window the route ran with; the label reads "rate: <w> per <unit>"; the job is found by seq (the newest `job.started` between the seq before the command and the seq it answered) not by title. The command answer was not changed to carry the job id (that is a shared wire shape); the seq bound gives the same identity.
- Difference route: 400 on a malformed escape; `difference()` returns the unreadable reason if reading throws.
Deferred as ruled: a budget-block lookup does not join the route's trail.
