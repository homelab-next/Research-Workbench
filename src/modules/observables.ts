import type { Json } from "../core/canonical";

export interface ObservableType { id: string; title: string; pattern: string }

/** Longest string tested against a type; anything longer matches no type. */
export const MAX_VALUE_LENGTH = 512;

const QUANTIFIER = /^(?:[+*]|\{\d+(?:,\d*)?\})/;

/**
 * True when a pattern has a quantified group whose body holds an unbounded quantifier (+, *, {n,}) or an
 * alternation: the shapes that make a backtracking matcher take exponential time. A conservative scan, not a parser.
 */
export function hasNestedQuantifier(pattern: string): boolean {
  const stack: { unbounded: boolean; alt: boolean }[] = [{ unbounded: false, alt: false }];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    const top = stack[stack.length - 1]!;
    if (c === "\\") {
      i++;
    } else if (c === "[") {
      for (i++; i < pattern.length && pattern[i] !== "]"; i++) if (pattern[i] === "\\") i++;
    } else if (c === "(") {
      stack.push({ unbounded: false, alt: false });
    } else if (c === "|") {
      top.alt = true;
    } else if (c === "+" || c === "*") {
      top.unbounded = true;
    } else if (c === "{") {
      const q = QUANTIFIER.exec(pattern.slice(i));
      if (q !== null && /,\}$/.test(q[0])) top.unbounded = true;
    } else if (c === ")" && stack.length > 1) {
      const group = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      const q = QUANTIFIER.exec(pattern.slice(i + 1));
      if (q !== null && (group.unbounded || group.alt)) return true;
      parent.unbounded ||= group.unbounded || (q !== null && /^(?:[+*]|\{\d+,\})$/.test(q[0]));
      parent.alt ||= group.alt;
    }
  }
  return false;
}

/** Compiles a type's pattern so that it must match the whole string, whatever anchors it has. Throws on an invalid or catastrophic pattern. */
export function compileType(pattern: string): RegExp {
  if (hasNestedQuantifier(pattern)) throw new Error("pattern has a quantified group that repeats a repeat or an alternation, which can take exponential time");
  return new RegExp(`^(?:${pattern})$`);
}

export class Observables {
  private readonly compiled: { id: string; re: RegExp }[];

  constructor(types: ObservableType[]) {
    this.compiled = types.map(t => ({ id: t.id, re: compileType(t.pattern) }));
  }

  /** The id of the first type whose pattern matches the whole value, or null. Only strings can match. */
  recognise(value: unknown): string | null {
    if (typeof value !== "string" || value.length > MAX_VALUE_LENGTH) return null;
    for (const t of this.compiled) if (t.re.test(value)) return t.id;
    return null;
  }

  matches(type: string, value: string): boolean {
    const t = this.compiled.find(c => c.id === type);
    return t !== undefined && typeof value === "string" && value.length <= MAX_VALUE_LENGTH && t.re.test(value);
  }

  /** Per column: its hint if one is given, else the type recognised for more than half of the column's non-null strings, else null. */
  columnTypes(columns: string[], hints: Record<string, string | null>, rows: Json[][]): (string | null)[] {
    return columns.map((name, i) => {
      const hint = Object.hasOwn(hints, name) ? hints[name] : null;
      if (hint !== null && hint !== undefined) return hint;
      const counts = new Map<string, number>();
      let strings = 0;
      for (const row of rows) {
        const v = row[i];
        if (typeof v !== "string") continue;
        strings++;
        const t = this.recognise(v);
        if (t !== null) counts.set(t, (counts.get(t) ?? 0) + 1);
      }
      for (const [t, n] of counts) if (n * 2 > strings) return t;
      return null;
    });
  }
}
