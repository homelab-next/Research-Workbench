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

/** A type's pattern that takes longer than this on any probe is refused. An honest pattern takes microseconds. */
export const PATTERN_PROBE_LIMIT_MS = 50;
const PROBE_LENGTHS = [64, 128, 256, MAX_VALUE_LENGTH];
const CLASS_SAMPLE: Record<string, string> = { d: "0", D: "a", w: "a", W: "-", s: " ", S: "a", b: "", B: "" };
const SYNTAX = new Set([..."()[]{}|*+?^$."]);
const TERMINATORS = ["\u0001", "\n", "!", "~", "\u00ff"];

/** The characters a pattern is written with, in order of first use: literals, and a sample for each class escape and for ".". */
function patternChars(pattern: string): string[] {
  const out: string[] = [];
  const add = (c: string): void => { if (c !== "" && !out.includes(c)) out.push(c); };
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      const n = pattern[++i] ?? "";
      add(Object.hasOwn(CLASS_SAMPLE, n) ? CLASS_SAMPLE[n]! : n);
    } else if (c === "{") {
      while (i < pattern.length && pattern[i] !== "}") i++; // a quantifier's digits are not text the pattern reads
    } else if (c === ".") {
      add("a");
    } else if (!SYNTAX.has(c)) {
      add(c);
    }
  }
  return out.length > 0 ? out : ["a"];
}

/** The literal prefixes of a pattern (the characters before its first quantified element, each prefix of them from one character up), and a sample of that quantified element. */
function literalPrefixes(pattern: string): { prefixes: string[]; quantified: string | null } {
  let text = "";
  let quantified: string | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    let lit: string;
    let next = i + 1;
    if (c === "\\") {
      const n = pattern[i + 1] ?? "";
      next = i + 2;
      if (Object.hasOwn(CLASS_SAMPLE, n)) lit = CLASS_SAMPLE[n]!;
      else lit = n;
    } else if (SYNTAX.has(c) && c !== ".") {
      break;
    } else {
      lit = c === "." ? "a" : c;
    }
    if (/^[*+?{]/.test(pattern.slice(next))) { quantified = lit === "" ? null : lit; break; } // this element is quantified: the prefix ends before it
    text += lit;
    i = next - 1;
  }
  const out: string[] = [];
  for (let n = 1; n <= text.length; n++) out.push(text.slice(0, n));
  return { prefixes: out, quantified };
}

/**
 * Times a type's pattern, compiled as compileType compiles it, on three probe strings built from the characters in the
 * pattern (all of them in turn, the first repeated, the last repeated), each ending in a character the pattern does not
 * use so that the match must fail. Each probe is tried at growing lengths up to MAX_VALUE_LENGTH, stopping as soon as
 * one try is over the limit, so a pattern that blows up is caught before the longest probe runs. Returns the slowest
 * time in milliseconds, or that of the first try over the limit.
 */
export function probePattern(pattern: string, limitMs = PATTERN_PROBE_LIMIT_MS): number {
  const re = compileType(pattern);
  const chars = patternChars(pattern);
  const end = TERMINATORS.find((t) => !chars.includes(t)) ?? "\u0002";
  const bodies = [chars.join(""), chars[0]!, chars[chars.length - 1]!];
  // a pattern can be cheap until a literal prefix has matched: try each prefix, then each body
  const { prefixes, quantified } = literalPrefixes(pattern);
  const withPrefix = quantified === null ? bodies : [...bodies, quantified]; // the first repeated element is the likeliest body
  const units = [...bodies.map((body) => ({ prefix: "", body })), ...prefixes.flatMap((prefix) => withPrefix.map((body) => ({ prefix, body })))];
  let worst = 0;
  for (const { prefix, body: unit } of units) {
    for (const length of PROBE_LENGTHS) {
      const probe = (prefix + unit.repeat(Math.ceil(length / unit.length))).slice(0, length - 1) + end;
      const started = performance.now();
      re.test(probe);
      const took = performance.now() - started;
      worst = Math.max(worst, took);
      if (took > limitMs) return took;
    }
  }
  return worst;
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
