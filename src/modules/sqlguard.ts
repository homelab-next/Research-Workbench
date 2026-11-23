// A refusal filter, not a SQL parser. Query text may be written by a language
// model, so it is treated as hostile and the filter errs toward refusing.

export class GuardError extends Error {
  readonly violations: string[];
  constructor(violations: string[]) {
    super(`query refused: ${violations.join("; ")}`);
    this.name = "GuardError";
    this.violations = violations;
  }
}

export interface TableGuard {
  table: string;
  time_column: string | null;
  large_columns: string[];
}

/**
 * Lower-cased, comments removed, every string literal replaced by '',
 * quoted identifiers kept without their quotes, whitespace collapsed.
 */
export function stripForAnalysis(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"') {
      let j = i + 1;
      let body = "";
      for (;;) {
        if (j >= n) break; // unterminated: the rest is inside the quote
        if (sql[j] === c) {
          if (sql[j + 1] === c) { body += c; j += 2; continue; }
          j++;
          break;
        }
        body += sql[j];
        j++;
      }
      out += c === "'" ? "''" : body;
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      out += " ";
      i = e === -1 ? n : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      out += " ";
      i = e === -1 ? n : e + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out.toLowerCase().replace(/\s+/g, " ").trim();
}

const READ_START = /^(?:select|with|show|describe|desc)\b/;
const FIRST_WORD = /^(?:select|with|show|describe|desc|explain)\b/;
const EXPLAIN_PREFIX = /^explain\b(?:\s+analyze\b)?(?:\s+verbose\b)?(?:\s*\([^)]*\))?\s*/;
const WRITE_WORDS = [
  "insert", "update", "delete", "merge", "create", "drop", "alter", "truncate", "grant", "revoke",
  "commit", "rollback", "attach", "detach", "pragma", "vacuum",
];
const WRITE_WORD_RE = new RegExp(`\\b(?:${WRITE_WORDS.join("|")})\\b`, "g");
const REPLACE_INTO = /\breplace\s+into\b/;

/** Throws GuardError unless `sql` is exactly one read statement. */
export function assertReadOnly(sql: string): void {
  const s = stripForAnalysis(sql);
  if (s === "" || s === ";") throw new GuardError(["empty statement"]);
  const violations: string[] = [];
  const body = s.endsWith(";") ? s.slice(0, -1) : s;
  if (body.includes(";")) violations.push("only one statement is allowed");

  const t = body.trim();
  let isRead = FIRST_WORD.test(t);
  if (isRead && t.startsWith("explain")) isRead = READ_START.test(t.replace(EXPLAIN_PREFIX, ""));
  if (!isRead) violations.push("not a read statement (write refused)");

  const seen = new Set<string>();
  for (const m of body.matchAll(WRITE_WORD_RE)) seen.add(m[0]);
  if (REPLACE_INTO.test(body)) seen.add("replace into");
  for (const w of seen) violations.push(`write keyword refused: ${w}`);

  if (violations.length > 0) throw new GuardError(violations);
}

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SELECT_STAR = /(?:\b(?:select|distinct|all)\s+|,\s*)\*(?=\s*(?:,|from\b|$))|[\w$]\.\*/;
const TS_LITERAL = /\btimestamp\s+'((?:[^']|'')*)'/gi;
const ZONED = /(?:\sutc|z|[+-]\d{2}:\d{2})$/i;

/** Plain-language guardrail violations for queries touching guarded tables; empty means allowed. */
export function checkGuardrails(sql: string, guards: TableGuard[]): string[] {
  const s = stripForAnalysis(sql);
  const violations: string[] = [];
  const add = (v: string): void => { if (!violations.includes(v)) violations.push(v); };

  for (const g of guards) {
    const table = g.table.toLowerCase();
    if (!new RegExp(`(?<![\\w$])${escapeRe(table)}(?![\\w$])`).test(s)) continue;

    if (g.time_column !== null) {
      const col = escapeRe(g.time_column.toLowerCase());
      const cmp = new RegExp(`(?<![\\w$])${col}\\s*(?:>=?|<(?!>)=?|=|between\\b)|[<>=]\\s*(?:[\\w$]+\\.)?${col}(?![\\w$])`);
      if (!cmp.test(s)) add(`needs a time filter on ${g.time_column}`);
    }
    if (SELECT_STAR.test(s)) add(`select * is not allowed on ${g.table}; name the columns`);
    if (/\bcount\s*\(\s*distinct\b/.test(s)) add("exact distinct counts are not allowed; use approx_distinct");
    if (/\border\s+by\b/.test(s) && !/\blimit\b|\bfetch\s+first\b/.test(s)) add("a sort needs a limit");
    // Read from the original: stripping empties the literals.
    for (const m of sql.matchAll(TS_LITERAL)) {
      if (!ZONED.test(m[1]!.trim())) { add("time literals need an explicit time zone"); break; }
    }
  }
  return violations;
}
