// What a statement or a question is about: values of types this root knows. In modules, so the pipeline and the agents' tools share it.
import type { Observable } from "../core/types";
import type { Observables } from "./observables";
import type { Registry } from "./registry";

/** At most this many values in one `about` list. */
export const MAX_ABOUT_VALUES = 20;

/** Why the values are not ones this root knows: "there is no type <t>", "<value> is not of the type <type>" or "at most 20 values"; null when they are fine. */
export function aboutProblem(registry: Registry, observables: Observables, about: Observable[]): string | null {
  if (about.length > MAX_ABOUT_VALUES) return `at most ${MAX_ABOUT_VALUES} values`;
  const types = new Set(registry.types().map((t) => t.id));
  for (const o of about) {
    if (!types.has(o.type)) return `there is no type ${o.type.slice(0, 40)}`;
    if (!observables.matches(o.type, o.value)) return `${o.value.slice(0, 80)} is not of the type ${o.type}`;
  }
  return null;
}
