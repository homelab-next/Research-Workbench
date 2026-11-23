import type { Json } from "../core/canonical";

export interface ObservableType { id: string; title: string; pattern: string }

/** Compiles a type's pattern so that it must match the whole string, whatever anchors it has. Throws on an invalid pattern. */
export function compileType(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`);
}

export class Observables {
  private readonly compiled: { id: string; re: RegExp }[];

  constructor(types: ObservableType[]) {
    this.compiled = types.map(t => ({ id: t.id, re: compileType(t.pattern) }));
  }

  /** The id of the first type whose pattern matches the whole value, or null. Only strings can match. */
  recognise(value: unknown): string | null {
    if (typeof value !== "string") return null;
    for (const t of this.compiled) if (t.re.test(value)) return t.id;
    return null;
  }

  matches(type: string, value: string): boolean {
    const t = this.compiled.find(c => c.id === type);
    return t !== undefined && typeof value === "string" && t.re.test(value);
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
