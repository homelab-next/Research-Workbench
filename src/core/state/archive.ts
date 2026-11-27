// The fold for a case's moves out of and into the working set, and the person's choice to unload it after publishing.
// Browser-safe: no runtime imports but the shared shape checks.
import type { Entry, Payloads } from "../types";
import { isBool, isNum, isObj, isStr, malformed, recordSkip } from "./guards";
import type { ArchiveState, CaseState } from "./types";

export function initialArchive(): ArchiveState {
  return { pending: null, failed: null, loaded: null, unload_after: false, unloads: 0, loads: 0 };
}

type Head = { seq: number; hash: string };
const isHead = (x: unknown): x is Head => isObj(x) && isNum(x.seq) && Number.isInteger(x.seq) && isStr(x.hash);
const isUnloaded = (x: unknown): x is Payloads["case.unloaded"] => isObj(x) && isStr(x.store) && isHead(x.head);
const isFailed = (x: unknown): x is Payloads["case.unload_failed"] => isObj(x) && isStr(x.reason);
const isLoaded = (x: unknown): x is Payloads["case.loaded"] => isObj(x) && isStr(x.file) && isHead(x.head) && isStr(x.id) && x.id !== "";

/** The head before this entry: the entry carries its own prev_hash, so no other input is needed. */
const namesHeadBefore = (head: Head, entry: Entry): boolean => head.seq === entry.seq - 1 && head.hash === entry.prev_hash;

const withArchive = (s: CaseState, a: Partial<ArchiveState>): CaseState => ({ ...s, archive: { ...s.archive, ...a } });

/**
 * case.unloaded, case.unload_failed and case.loaded, by a person or code (never an agent), and `unload_after` on a person's pass of the publish
 * gate the run waits at. run.started, case.unloaded and case.unload_failed clear `unload_after`, so a failed attempt is not tried again. Runs before
 * applyRun, which clears `run.waiting` on gate.passed.
 */
export function applyArchive(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "case.unloaded": {
      const p = entry.payload as unknown;
      if (!isUnloaded(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "an unload is a person's or the workbench's");
      if (!namesHeadBefore(p.head, entry)) return recordSkip(s, entry, "an unload names the head before it");
      return withArchive(s, {
        pending: { store: p.store, head: { seq: p.head.seq, hash: p.head.hash }, by: entry.actor.id, seq: entry.seq, ts: entry.ts },
        failed: null, unload_after: false, unloads: s.archive.unloads + 1,
      });
    }
    case "case.unload_failed": {
      const p = entry.payload as unknown;
      if (!isFailed(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "an unload is a person's or the workbench's");
      return withArchive(s, { pending: null, failed: { reason: p.reason, seq: entry.seq, ts: entry.ts }, unload_after: false });
    }
    case "case.loaded": {
      const p = entry.payload as unknown;
      if (!isLoaded(p)) return malformed(s, entry);
      if (entry.actor.kind === "agent") return recordSkip(s, entry, "a load is a person's or the workbench's");
      if (!namesHeadBefore(p.head, entry)) return recordSkip(s, entry, "a load names the head it arrived with");
      return withArchive(s, {
        pending: null, failed: null, loads: s.archive.loads + 1,
        loaded: { file: p.file, head: { seq: p.head.seq, hash: p.head.hash }, id: p.id, by: entry.actor.id, seq: entry.seq, ts: entry.ts },
      });
    }
    case "run.started":
      return s.archive.unload_after ? withArchive(s, { unload_after: false }) : s;
    case "gate.passed": {
      const p = entry.payload as unknown;
      // read only on a person's pass of the publish gate the run waits at; applyRun checks the shape of the rest
      if (!isObj(p) || p.gate !== "publish" || entry.actor.kind !== "human" || s.run.status === "finished" || s.run.waiting !== "publish") return s;
      if (p.unload_after !== undefined && !isBool(p.unload_after)) {
        return withArchive(recordSkip(s, entry, "unload_after is true or false"), { unload_after: false });
      }
      return withArchive(s, { unload_after: p.unload_after === true });
    }
    default:
      return s;
  }
}

/** True when the current run finished as published and the person asked for the case to be unloaded then. */
export function unloadDue(state: Readonly<CaseState>): boolean {
  return state.run.status === "finished" && state.run.outcome === "published" && state.archive.unload_after;
}
