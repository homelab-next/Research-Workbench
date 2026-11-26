import type { Json } from "../core/canonical";
import type { Schema } from "../core/schema";
import { ManifestError } from "./manifests";

export const MAX_PLAYBOOK_STEPS = 12, DEFAULT_STEP_VALUES = 5, MAX_STEP_VALUES = 20, MAX_PLAYBOOK_LOOKUPS = 50;

export interface PlaybookInput { name: string; type: string }
export interface PlaybookStep {
  id: string; pivot: string; from: { input: string } | { step: string };
  when: { step: string; is: "rows" | "empty" } | null; max_values: number;
}
export interface PlaybookManifest { id: string; title: string; hash: string; about: string; inputs: PlaybookInput[]; steps: PlaybookStep[]; end: string[] }

const WORD = "^[a-z][a-z0-9_]{0,31}$";
const WORD_RE = new RegExp(WORD);
const word: Schema = { type: "string", pattern: WORD };

/** Shape and string forms only; the number of steps, names and references are checked by toPlaybook, so the reason can name the step. */
export const PLAYBOOK_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "id", "inputs", "steps"],
  properties: {
    kind: { const: "playbook" },
    id: { type: "string", minLength: 1 },
    title: { type: "string", minLength: 1 },
    about: { type: "string" },
    inputs: {
      type: "array", minItems: 1,
      items: { type: "object", additionalProperties: false, required: ["name", "type"], properties: { name: word, type: { type: "string", minLength: 1 } } },
    },
    steps: {
      type: "array", minItems: 1,
      items: {
        type: "object", additionalProperties: false, required: ["id", "pivot", "from"],
        properties: {
          id: word, pivot: { type: "string", minLength: 1 }, from: { type: "string", minLength: 1 }, when: { type: "string", minLength: 1 },
          max_values: { type: "integer", minimum: 1, maximum: MAX_STEP_VALUES },
        },
      },
    },
    end: { type: "array", items: { type: "string" } },
  },
};

/** Builds a playbook from a validated body. Throws ManifestError naming the step for a `from` or `when` outside the grammar. */
export function toPlaybook(body: Record<string, Json>, hash: string): PlaybookManifest {
  const b = body as Record<string, any>; // validated against PLAYBOOK_SCHEMA by the caller
  const inputs: PlaybookInput[] = b.inputs.map((i: any): PlaybookInput => ({ name: i.name, type: i.type }));
  const inputNames = new Set<string>();
  const inputTypes = new Set<string>();
  for (const i of inputs) {
    if (inputNames.has(i.name)) throw new ManifestError(`duplicate input name "${i.name}"`);
    if (inputTypes.has(i.type)) throw new ManifestError(`two inputs of type ${i.type}; run-on-a-value would be ambiguous`);
    inputNames.add(i.name);
    inputTypes.add(i.type);
  }
  if (b.steps.length > MAX_PLAYBOOK_STEPS) throw new ManifestError(`a playbook has at most ${MAX_PLAYBOOK_STEPS} steps, not ${b.steps.length}`);
  const earlier = new Set<string>();
  const steps: PlaybookStep[] = [];
  for (const s of b.steps) {
    const id: string = s.id;
    if (id === "input") throw new ManifestError(`step "input": a step may not be named input`);
    if (earlier.has(id)) throw new ManifestError(`duplicate step id "${id}"`);
    let from: PlaybookStep["from"];
    const m = /^input\.(.+)$/.exec(s.from);
    if (m !== null) {
      if (!inputNames.has(m[1]!)) throw new ManifestError(`step "${id}": from "${s.from}" is not an input or an earlier step`);
      from = { input: m[1]! };
    } else {
      if (!earlier.has(s.from)) throw new ManifestError(`step "${id}": from "${s.from}" is not an input or an earlier step`);
      from = { step: s.from };
    }
    let when: PlaybookStep["when"] = null;
    if (s.when !== undefined) {
      const w = /^([^.]+)\.([^.]+)$/.exec(s.when);
      if (w === null || (w[2] !== "rows" && w[2] !== "empty")) throw new ManifestError(`step "${id}": when "${s.when}" must be <earlier step>.rows or <earlier step>.empty (rows or empty)`);
      if (!earlier.has(w[1]!)) throw new ManifestError(`step "${id}": when "${w[1]}" is not an earlier step`);
      when = { step: w[1]!, is: w[2] };
    }
    steps.push({ id, pivot: s.pivot, from, when, max_values: s.max_values ?? DEFAULT_STEP_VALUES });
    earlier.add(id);
  }
  const end: string[] = b.end ?? [steps[steps.length - 1]!.id];
  for (const e of end) if (!earlier.has(e)) throw new ManifestError(`end: "${e}" is not a step`);
  return { id: b.id, title: b.title ?? b.id, hash, about: b.about ?? "", inputs, steps, end };
}

export const isPlaybookWord = (s: string): boolean => WORD_RE.test(s);

export function fromText(s: PlaybookStep): string {
  return "input" in s.from ? `input.${s.from.input}` : s.from.step;
}
export function whenText(s: PlaybookStep): string | null {
  return s.when === null ? null : `${s.when.step}.${s.when.is}`;
}

/** The most lookups a run can send: 1 for a step from an input, max_values for a step from a step; at most MAX_PLAYBOOK_LOOKUPS. */
export function maxLookups(p: PlaybookManifest): number {
  const n = p.steps.reduce((sum, s) => sum + ("input" in s.from ? 1 : s.max_values), 0);
  return Math.min(n, MAX_PLAYBOOK_LOOKUPS);
}
