// What a playbook would also have fetched when a plan uses only some of its lookups as single pivots (slice 9 goal 5).
// Browser-safe and pure: the server passes the registry's playbooks and pivots, the browser the reference it was sent.
import type { Plan } from "../types";

/** A playbook as this reads it: the types it starts from and the pivot of each step. */
export interface PlaybookShape { id: string; title: string; inputs: readonly { type: string }[]; steps: readonly { pivot: string }[] }
/** A pivot as this reads it: its title and the type it finds. */
export interface PivotShape { id: string; title: string; to: string }
/** A playbook the plan covers only in part: the start type, the lookups the plan uses, and those the playbook would also have made. */
export interface PlaybookGap { playbook: string; title: string; from: string; used: string[]; also: { pivot: string; title: string; to: string }[] }

/**
 * Each playbook (not itself a step of the plan) of which the plan's pivot steps use some lookups but not all, for a type the playbook starts
 * from. Only steps of sub-goals whose first step starts from that type count; with `accepted` given, only those steps. In playbook order.
 */
export function playbookGaps(plan: Plan, accepted: readonly string[] | null, playbooks: readonly PlaybookShape[], pivots: readonly PivotShape[]): PlaybookGap[] {
  const steps = plan.steps.filter((x) => accepted === null || accepted.includes(x.id));
  const played = new Set(steps.flatMap((x) => (x.playbook === undefined ? [] : [x.playbook.id])));
  const out: PlaybookGap[] = [];
  for (const p of playbooks) {
    if (played.has(p.id)) continue;
    const types: string[] = [];
    for (const i of p.inputs) if (!types.includes(i.type)) types.push(i.type);
    for (const type of types) {
      const goals = plan.subgoals.filter((g) => {
        const first = steps.find((x) => g.steps.includes(x.id));
        return first !== undefined && first.from.type === type;
      });
      const used = new Set(steps.filter((x) => x.playbook === undefined && goals.some((g) => g.steps.includes(x.id))).map((x) => x.pivot));
      const mine: string[] = [];
      for (const st of p.steps) if (!mine.includes(st.pivot)) mine.push(st.pivot);
      const hit = mine.filter((pv) => used.has(pv));
      const also = mine.filter((pv) => !used.has(pv));
      if (hit.length === 0 || also.length === 0) continue;
      out.push({
        playbook: p.id, title: p.title, from: type, used: hit,
        also: also.map((pv) => {
          const v = pivots.find((x) => x.id === pv);
          return { pivot: pv, title: v?.title ?? pv, to: v?.to ?? "unknown" };
        }),
      });
    }
  }
  return out;
}

/** One line per gap, as the planner's pack and the plan view say it; "" for none. */
export function gapsText(gaps: readonly PlaybookGap[]): string {
  return gaps.map((g) => `- The plan uses ${g.used.join(", ")} of the playbook ${g.title} (${g.playbook}, from ${g.from}) as single pivots; the playbook would also have fetched: ${g.also.map((a) => `${a.title} (${a.pivot}, finds ${a.to})`).join("; ")}.`).join("\n");
}
