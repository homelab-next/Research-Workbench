// The staging folders of improve runs: where each is, the mark staging leaves in each folder it makes, and the sweep that removes only those.
// This file names no module root; it writes only under the configuration's improve.staged.
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workbench } from "../../core/workbench";
import type { Config } from "../../modules/config";

/** A staging folder's name: the improve case's id, a dash, and the first 12 hex of its first entry's hash. */
const FOLDER = /^(CASE-[1-9][0-9]*)-([0-9a-f]{12})$/;
/** What an origin that cannot be read gives a folder's name: it is no case's, so a sweep removes it. */
const NO_ORIGIN = "none";
/** The folder of a staging store made for an improve case whose origin could not be read. */
const NO_ORIGIN_FOLDER = /^(CASE-[1-9][0-9]*)-none$/;
/** The file staging writes inside each folder it makes: the improve case and its full origin. A sweep removes no folder without it. */
export const STAGED_MARK = ".improve-staged";

export const inProgress = (status: string): boolean => status !== "none" && status !== "finished";

/** The folder of an improve case's staging store: "<case id>-<first 12 hex of its first entry's hash>". */
export function stagedFolder(improve: { case: string; origin: string | null }): string {
  return `${improve.case}-${improve.origin === null ? NO_ORIGIN : improve.origin.slice(0, 12)}`;
}

/** Makes an improve case's staging folder, with the mark that tells a sweep staging made it. */
export function markStaged(folder: string, improve: { case: string; origin: string | null }): void {
  mkdirSync(folder, { recursive: true });
  const at = join(folder, STAGED_MARK);
  if (!existsSync(at)) writeFileSync(at, JSON.stringify({ case: improve.case, origin: improve.origin }));
}

/** The improve case and origin a folder's mark names, when the mark is a file staging wrote and agrees with the folder's name; null otherwise. */
function markOf(folder: string, name: string): { case: string; origin: string | null } | null {
  const m = FOLDER.exec(name) ?? NO_ORIGIN_FOLDER.exec(name);
  if (m === null) return null;
  try {
    const at = join(folder, STAGED_MARK);
    if (!lstatSync(folder).isDirectory() || !lstatSync(at).isFile()) return null;
    const mark = JSON.parse(readFileSync(at, "utf8")) as { case?: unknown; origin?: unknown };
    if (mark.case !== m[1]) return null;
    if (mark.origin === null) return m[2] === undefined ? { case: m[1]!, origin: null } : null;
    return typeof mark.origin === "string" && m[2] !== undefined && mark.origin.startsWith(m[2]) ? { case: m[1]!, origin: mark.origin } : null;
  } catch {
    return null;
  }
}

/**
 * Removes each folder staging made (its name is an improve case's staging folder and its mark, written by staging, agrees) whose improve case
 * is loaded here with that origin and has no run in progress, or whose case's origin could not be read. Anything else in the folder is left
 * alone: a sweep never removes what staging did not make. Returns what it removed.
 */
export function sweepStaged(config: Config, wb: Workbench): string[] {
  const dir = config.improve.staged;
  if (!existsSync(dir)) return [];
  const status = new Map(wb.listCases().map((c) => [c.id, c.run_status]));
  const removed: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const at = join(dir, name);
    const mark = markOf(at, name);
    if (mark === null) continue;
    if (mark.origin !== null) {
      // a case that is not loaded here (in the store, say) keeps its folder; so does one whose run is in progress
      if (wb.loadedOrigin(mark.case) !== mark.origin) continue;
      if (inProgress(status.get(mark.case) ?? "none")) continue;
    }
    rmSync(at, { recursive: true, force: true });
    removed.push(at);
  }
  return removed;
}
