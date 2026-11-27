// The workbench's own YAML writer: block style, keys in the order given, every string a JSON string, so a parser gives the value back.
import type { Json } from "../core/canonical";

/** A key that reads as itself, unquoted: a plain word that is no YAML keyword. Any other key is written as a JSON string. */
const PLAIN_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const KEYWORDS = new Set(["true", "false", "null", "yes", "no", "on", "off", "y", "n", "nan", "inf"]);

/**
 * A string as a YAML double-quoted scalar. JSON's escapes are YAML's; the characters JSON leaves as they are and YAML would read
 * otherwise (DEL, the C1 controls, the line and paragraph separators, a byte-order mark) are escaped too.
 */
function quoted(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
const keyOf = (k: string): string => (PLAIN_KEY.test(k) && !KEYWORDS.has(k.toLowerCase()) ? k : quoted(k));

function scalar(v: Json): string | null {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
  if (typeof v === "string") return quoted(v);
  if (Array.isArray(v)) return v.length === 0 ? "[]" : null;
  return Object.keys(v).length === 0 ? "{}" : null;
}

/** The lines of a non-empty list or mapping at an indent. */
function block(v: Json, indent: number, out: string[]): void {
  const pad = " ".repeat(indent);
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = scalar(item);
      if (s !== null) { out.push(`${pad}- ${s}`); continue; }
      // the item's first line follows the dash; the rest line up under it
      const inner: string[] = [];
      block(item, indent + 2, inner);
      out.push(`${pad}- ${inner[0]!.slice(indent + 2)}`, ...inner.slice(1));
    }
    return;
  }
  for (const [k, item] of Object.entries(v as Record<string, Json>)) {
    const s = scalar(item);
    if (s !== null) out.push(`${pad}${keyOf(k)}: ${s}`);
    else {
      out.push(`${pad}${keyOf(k)}:`);
      block(item, indent + 2, out);
    }
  }
}

/** Block-style YAML of a JSON value: keys in the order given, every string as a JSON string, so Bun.YAML.parse gives the value back. */
export function toYaml(value: Json): string {
  const s = scalar(value);
  if (s !== null) return `${s}\n`;
  const out: string[] = [];
  block(value, 0, out);
  return `${out.join("\n")}\n`;
}
