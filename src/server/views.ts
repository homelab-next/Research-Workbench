import { isPlainObject } from "../core/canonical";
import type { Marking } from "../core/types";
import type { InventoryView, ModelView, PivotView, PlaybookView, Reference, SourceView } from "../core/wire";
import { termsOf } from "../agents/draft";
import { scrub } from "../agents/tools/kit";
import { mayGo } from "../agents/pack";
import { pivotWeight } from "../modules/manifests";
import { fromText, maxLookups, whenText } from "../modules/playbooks";
import type { EngineDeps } from "../pipeline/engine";
import { SEND_BACK_CAP } from "../pipeline/next";

/** Text that came from a source, a manifest or an exception, safe to send. */
export function shown(deps: EngineDeps, text: string): string {
  return scrub(deps.runner.registry, text);
}

const sentence = (id: string): string => (id === "" ? id : id[0]!.toUpperCase() + id.slice(1).replace(/[_-]+/g, " "));

/** What may be asked, from the registry. A source is described without its location, credential, user, folder or root. */
export function referenceOf(deps: EngineDeps): Reference {
  const { registry } = deps.runner;
  const sources: SourceView[] = registry.sources().map((x) => ({
    id: x.id, title: shown(deps, x.title), connector: x.connector, marking: x.marking, where: x.where, confirmed: x.confirmed, adhoc: x.adhoc,
    cost: { weight: x.cost.weight, unit: x.cost.unit }, quality: shown(deps, x.quality),
  }));
  const pivots: PivotView[] = registry.pivots().map((p) => {
    const source = registry.source(p.source);
    const weight = source === null ? (p.weight ?? 0) : pivotWeight(p, source);
    return { id: p.id, title: shown(deps, p.title), from: p.from, to: p.to, source: p.source, free: weight === 0, weight, needs_window: p.needs_window, empty_means: p.empty_means, inventory: p.inventory };
  });
  const objectives = registry.all("objective").map((m) => {
    const list = Array.isArray(m.body.measures) ? (m.body.measures as unknown[]) : [];
    const measures = list.flatMap((x) => (isPlainObject(x) && typeof x.id === "string" && (x.kind === "mop" || x.kind === "moe") && typeof x.title === "string"
      ? [{ id: x.id, kind: x.kind as "mop" | "moe", title: shown(deps, x.title) }] : []));
    return { id: m.id, title: shown(deps, typeof m.body.title === "string" ? m.body.title : m.id), measures };
  });
  const phases: Reference["phases"] = [];
  for (const stage of deps.pipeline.stages) {
    if (stage.phase !== null && !phases.some((p) => p.id === stage.phase)) phases.push({ id: stage.phase, title: sentence(stage.phase) });
  }
  const playbooks: PlaybookView[] = registry.playbooks().map((p) => ({
    id: p.id, title: shown(deps, p.title), about: shown(deps, p.about), inputs: p.inputs.map((i) => ({ name: i.name, type: i.type })),
    steps: p.steps.map((s) => ({ id: s.id, pivot: s.pivot, from: fromText(s), when: whenText(s), max_values: s.max_values })),
    end: [...p.end], free: registry.costlyPivots(p).length === 0, max_lookups: maxLookups(p),
  }));
  const inventories: InventoryView[] = registry.inventories().map((i) => ({
    id: i.id, title: shown(deps, i.title), holds: i.holds, scope: shown(deps, i.scope), complete: i.complete,
  }));
  return {
    types: registry.types().map((t) => ({ id: t.id, title: shown(deps, t.title) })), sources, pivots, objectives, phases,
    profile: { id: deps.profile.id, title: shown(deps, deps.profile.title) }, send_back_cap: SEND_BACK_CAP, playbooks, inventories,
    likelihood: likelihoodTerms(deps),
  };
}

/** The profile standard's likelihood terms, in the standard's order (least likely first); [] when it lists none. */
function likelihoodTerms(deps: EngineDeps): string[] {
  const standard = deps.profile.standard === null ? null : deps.registry.get("standard", deps.profile.standard);
  return (termsOf(standard?.body ?? null)?.likelihood ?? []).map((t) => shown(deps, t));
}

/** How long a provider may take to list its models before it is given up on. Tests may change it. */
export const LIMITS = { modelListMs: 5000 };

/** Every model every provider lists, each marked allowed or not for this marking under the policy. A provider that cannot list, or takes more than LIMITS.modelListMs, is left out; `onSlow` hears of the slow ones. */
export async function modelsFor(deps: EngineDeps, marking: Marking, onSlow?: (provider: string) => void): Promise<ModelView[]> {
  const lists = await Promise.all(deps.providers.all().map(async (provider) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const slow = new Promise<never>((_, reject) => { timer = setTimeout(() => { onSlow?.(provider.id); reject(new Error("slow")); }, LIMITS.modelListMs); });
      slow.catch(() => undefined);
      return (await Promise.race([provider.models(), slow])).map((m): ModelView => {
        const allowed = mayGo(marking, provider.where, deps.config.marking_policy);
        return {
          provider: provider.id, model: m.id, where: provider.where, efforts: m.efforts, context: m.context, allowed,
          reason: allowed ? null : `${marking} may not go to a ${provider.where} model`,
        };
      });
    } catch {
      return [];
    } finally {
      clearTimeout(timer);
    }
  }));
  return lists.flat();
}
