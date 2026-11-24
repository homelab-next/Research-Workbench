import type { CaseSession } from "../core/session";
import type { Actor, EntryInput } from "../core/types";

const recovery: Actor = { kind: "system", id: "recovery" };

/**
 * Closes what a stopped process left half done, once, right after a case that was not created in this
 * process is opened: each running query fails as "interrupted" (caused by its query.issued), each running
 * job finishes as failed, and a running run is marked interrupted. A waiting or paused run is left alone: it
 * is waiting for a person, not for this process. One commit; nothing is written when there is nothing to close.
 */
export function recoverSession(session: CaseSession): { queries: string[]; jobs: string[]; interrupted: boolean } {
  const result = { queries: [] as string[], jobs: [] as string[], interrupted: false };
  session.commit((state) => {
    const inputs: EntryInput[] = [];
    for (const q of Object.values(state.queries)) {
      if (q.status !== "running") continue;
      result.queries.push(q.id);
      inputs.push({ type: "query.failed", actor: recovery, payload: { query: q.id, error: "interrupted" }, cause: q.issued_seq });
    }
    for (const j of Object.values(state.jobs)) {
      if (j.status !== "running") continue;
      result.jobs.push(j.id);
      inputs.push({ type: "job.finished", actor: recovery, payload: { job: j.id, outcome: "failed" }, job: j.id });
    }
    if (state.run.status === "running") {
      result.interrupted = true;
      inputs.push({ type: "run.interrupted", actor: recovery, payload: {}, run: state.run.id });
    }
    return inputs;
  });
  return result;
}
