import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { Actor, CheckFinding, Draft } from "../../core/types";
import { draftOf, withFormExceptions } from "../../agents/draft";
import { checkInput, checksFor, runCheck } from "../checks";
import type { StageEnd, StageEnv } from "../engine";
import type { CheckManifest } from "../manifests";
import { contextFrom } from "./agent";

const CHECKS: Actor = { kind: "system", id: "checks" };

interface Ran { check: string; pass: boolean; blocking: boolean; findings: CheckFinding[] }

/** Runs every check on one draft and records each run against its hash. Null when the run was stopped meanwhile; a string when the input cannot be made. */
async function runAll(env: StageEnv, checks: CheckManifest[], d: Draft): Promise<Ran[] | string | null> {
  const { session, deps, stage } = env;
  const done: Ran[] = [];
  for (const check of checks) {
    let input: ReturnType<typeof checkInput>;
    try {
      input = checkInput(check.id, session.state, d, deps.registry, deps.profile, contextFrom(deps), stage.id);
    } catch (err) {
      return `Checks cannot be given its input: ${(err as Error).message.split("\n")[0]}`;
    }
    const run = session.state.run.id;
    const o = await runCheck(check, input);
    // a person stopped the run while the check ran: nothing is recorded
    const written = session.commit((s) => (s.run.id !== run || s.run.status === "finished" ? [] : [{
      type: "check.run" as const, actor: CHECKS, run: s.run.id, stage: stage.id,
      payload: {
        check: check.id, script_hash: o.script_hash, input: session.blobs.put(o.input), output: session.blobs.put(o.output),
        draft_hash: d.hash, pass: o.pass, findings: o.findings, ...(check.blocking ? {} : { blocking: false }),
      },
    }]));
    if (written.length === 0) return null;
    done.push({ check: check.id, pass: o.pass, blocking: check.blocking, findings: o.findings });
  }
  return done;
}

/**
 * Checks: runs each form check, in order, on the draft pinned at the start of the stage, and records every run against that draft's hash
 * with the exact input and output. The stage passes, naming that hash, only when every check a trusted root declares was loaded, ran, and
 * every blocking one passed.
 *
 * A failed non-blocking check does not send the draft back. When nothing blocking failed, the failed non-blocking checks are noted under
 * "Form exceptions noted" in gaps_and_limits: if that changes the product, Checks writes it as a new revision in its own name, checks that
 * revision once more, and passes (or fails) on it. So the product that is published says which form exceptions it carries, and is the one checked.
 */
export async function checksRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps } = env;
  const first = latestDraft(session.state);
  if (first === null) return { kind: "stalled", reason: "Checks: there is no draft to check" };
  // a bound run's checks are its loop version's, run from the content store; with no loop, every check the trusted roots declare
  const { checks, problems, broken } = checksFor(deps, env.stage.id, session.dir);
  if (checks.length === 0 && broken.length === 0) return { kind: "stalled", reason: `Checks has nothing to run: ${problems.length === 0 ? "no check is installed" : problems.join("; ")}` };
  // a check that is declared but cannot be loaded stalls the run before anything runs: it is for a person to repair, not for the analyst to answer
  if (broken.length > 0) {
    const b = broken[0]!;
    const more = broken.length > 1 ? ` and ${broken.length - 1} more` : "";
    return { kind: "stalled", reason: `Checks cannot run: check ${b.id} could not be loaded: ${b.problem}${more}` };
  }
  let d = first;
  let done = await runAll(env, checks, d);
  if (done === null) return { kind: "stopped" };
  if (typeof done === "string") return { kind: "stalled", reason: done };

  if (!done.some((c) => !c.pass && c.blocking)) {
    const noted = done.filter((c) => !c.pass && !c.blocking);
    const exceptions = noted.flatMap((c) => (c.findings.length === 0 ? [{ check: c.check, where: "check", message: "failed without saying why" }] : c.findings));
    const gaps = withFormExceptions(d.product.gaps_and_limits, exceptions);
    if (gaps !== d.product.gaps_and_limits) {
      const reason = noted.length > 0 ? `Checks noted form exceptions: ${noted.map((c) => c.check).join(", ")}` : "Checks removed form exceptions that no longer apply";
      const pinned = d;
      const run = session.state.run.id;
      const made: { draft: Draft | null } = { draft: null };
      session.commit((s) => {
        if (s.run.id !== run || s.run.status === "finished") return [];
        // the note is the only change: the cards the revision cited by tool only are carried with it
        const next = draftOf({ ...pinned.product, gaps_and_limits: gaps }, s.drafts.length + 1, CHECKS, reason, pinned.cited ?? []);
        made.draft = next;
        return [{ type: "draft.revised", actor: CHECKS, run: s.run.id, stage: env.stage.id, payload: { draft: next } }];
      });
      if (made.draft === null) return { kind: "stopped" };
      d = made.draft;
      done = await runAll(env, checks, d);
      if (done === null) return { kind: "stopped" };
      if (typeof done === "string") return { kind: "stalled", reason: done };
    }
  }

  const output = { checks: done.map(({ check, pass, blocking }) => (blocking ? { check, pass } : { check, pass, blocking: false })) } as unknown as Json;
  const failing = done.filter((c) => !c.pass && c.blocking);
  if (failing.length === 0) return { kind: "finished", outcome: "pass", draft_hash: d.hash, output, reason: null };
  const more = failing.length > 1 ? ` and ${failing.length - 1} more` : "";
  const f = failing[0]!;
  return { kind: "finished", outcome: "fail", draft_hash: d.hash, output, reason: `${f.check} failed: ${f.findings[0]?.message ?? ""}${more}` };
}
