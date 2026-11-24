import type { EmptyMeans, Marking } from "../core/types";
import { pivotWeight } from "./manifests";
import type { PivotManifest, Registry, SourceManifest } from "./registry";

export interface Hop {
  pivot: string; title: string; source: string; from: string; to: string; free: boolean; weight: number;
  needs_window: boolean; empty_means: EmptyMeans; confirmed: boolean; marking: Marking; unit: string;
}
export interface Route { hops: Hop[]; weight: number }
export interface SeekLimits { max_weight: number | null; allow_unconfirmed: boolean; max_hops: number }
export const DEFAULT_LIMITS: SeekLimits = { max_weight: null, allow_unconfirmed: false, max_hops: 4 };

export interface Seeker {
  routes(have: string[], want: string, limits: SeekLimits, blocked?: ReadonlySet<string>): Route[];
}

const MAX_ROUTES = 5;

function hopOf(p: PivotManifest, s: SourceManifest): Hop {
  const weight = pivotWeight(p, s);
  return {
    pivot: p.id, title: p.title, source: s.id, from: p.from, to: p.to, free: weight === 0, weight,
    needs_window: p.needs_window, empty_means: p.empty_means, confirmed: s.confirmed, marking: s.marking, unit: s.cost.unit,
  };
}

/**
 * Cheapest first: each pivot is an edge between observable types. Simple paths over pivots (no pivot used twice) are
 * enumerated depth-first up to max_hops, so a route may pass through a type it already holds (address, domain, address,
 * asset, account); a route has at least one hop and ends at the first arrival at `want`, so asking for a type already
 * held asks for new values of it. Routes are sorted by weight, hops, then pivot ids.
 */
export function cheapestSeeker(registry: Registry): Seeker {
  return {
    routes(have, want, limits, blocked = new Set()) {
      const edges = new Map<string, Hop[]>();
      for (const p of registry.pivots()) {
        const s = registry.source(p.source);
        if (s === null || blocked.has(p.id) || (!s.confirmed && !limits.allow_unconfirmed)) continue;
        const list = edges.get(p.from) ?? [];
        list.push(hopOf(p, s));
        edges.set(p.from, list);
      }
      const found = new Map<string, Route>();
      const key = (r: Route): string => r.hops.map((h) => h.pivot).join(">");
      const walk = (type: string, path: Hop[], used: Set<string>, weight: number): void => {
        if (limits.max_weight !== null && weight > limits.max_weight) return;
        if (path.length > 0 && type === want) {
          const route = { hops: [...path], weight };
          found.set(key(route), route);
          return;
        }
        if (path.length >= limits.max_hops) return;
        for (const hop of edges.get(type) ?? []) {
          if (used.has(hop.pivot)) continue;
          used.add(hop.pivot);
          path.push(hop);
          walk(hop.to, path, used, weight + hop.weight);
          path.pop();
          used.delete(hop.pivot);
        }
      };
      for (const start of new Set(have)) walk(start, [], new Set(), 0);
      return [...found.values()]
        .sort((a, b) => a.weight - b.weight || a.hops.length - b.hops.length || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0))
        .slice(0, MAX_ROUTES);
    },
  };
}

export const SEEKERS: Record<string, (registry: Registry) => Seeker> = { cheapest: cheapestSeeker };
