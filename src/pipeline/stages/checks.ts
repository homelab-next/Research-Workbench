import type { Json } from "../../core/canonical";
import { latestDraft } from "../../core/state";
import type { Actor } from "../../core/types";
import { checkInput, runCheck } from "../checks";
import type { StageEnd, StageEnv } from "../engine";
import { loadChecks } from "../manifests";

const CHECKS: Actor = { kind: "system", id: "checks" };

/**
 * Checks: runs each form check, in order, on the draft pinned at the start of the stage, and records every run against that draft's hash
 * with the exact input and output. The stage passes, naming that hash, only when every check passed.
 */
export async function checksRunner(env: StageEnv): Promise<StageEnd> {
  const { session, deps, stage } = env;
  const d = latestDraft(session.state);
  if (d === null) return { kind: "stalled", reason: "Checks: there is no draft to check" };
  const { checks, problems } = loadChecks(deps.registry);
  if (checks.length === 0) return { kind: "stalled", reason: `Checks has nothing to run: ${problems.length === 0 ? "no check is installed" : problems.join("; ")}` };
  const done: { check: string; pass: boolean; first: string }[] = [];
  for (const check of checks) {
    let input: ReturnType<typeof checkInput>;
    try {
      input = checkInput(check.id, session.state, d, deps.registry, deps.profile);
    } catch (err) {
      return { kind: "stalled", reason: `Checks cannot be given its input: ${(err as Error).message.split("\n")[0]}` };
    }
    const o = await runCheck(check, input);
    session.commit((s) => [{
      type: "check.run", actor: CHECKS, run: s.run.id, stage: stage.id,
      payload: {
        check: check.id, script_hash: o.script_hash, input: session.blobs.put(o.input), output: session.blobs.put(o.output),
        draft_hash: d.hash, pass: o.pass, findings: o.findings,
      },
    }]);
    done.push({ check: check.id, pass: o.pass, first: o.findings[0]?.message ?? "" });
  }
  const output = { checks: done.map(({ check, pass }) => ({ check, pass })) } as unknown as Json;
  const failing = done.filter((c) => !c.pass);
  if (failing.length === 0) return { kind: "finished", outcome: "pass", draft_hash: d.hash, output, reason: null };
  const more = failing.length > 1 ? ` and ${failing.length - 1} more` : "";
  return { kind: "finished", outcome: "fail", draft_hash: d.hash, output, reason: `${failing[0]!.check} failed: ${failing[0]!.first}${more}` };
}
