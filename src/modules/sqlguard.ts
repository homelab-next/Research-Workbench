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

interface Scan {
  /** Lower-cased, comments removed, literals emptied, whitespace collapsed. */
  stripped: string;
  /** Comments removed, literals and quoted identifiers kept verbatim. */
  kept: string;
  /** Things the scanner cannot read safely, found outside literals and comments. */
  violations: string[];
}

/**
 * The single scanning pass. Anything this scanner does not understand as an
 * identifier quote could hide a literal or comment opener from it, so such
 * characters are recorded as violations here, where they are met.
 */
function scan(sql: string): Scan {
  let out = "";
  let kept = "";
  const violations: string[] = [];
  const flag = (v: string): void => { if (!violations.includes(v)) violations.push(v); };
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
      kept += sql.slice(i, j);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      out += " ";
      kept += " ";
      i = e === -1 ? n : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      out += " ";
      kept += " ";
      i = e === -1 ? n : e + 2;
    } else {
      if (c === "`") flag("backtick identifiers are not allowed");
      else if (c === "[" && !(i > 0 && /[\w$)\]"]/.test(sql[i - 1]!))) flag("bracket identifiers are not allowed");
      out += c;
      kept += c;
      i++;
    }
  }
  return { stripped: out.toLowerCase().replace(/\s+/g, " ").trim(), kept, violations };
}

/**
 * Lower-cased, comments removed, every string literal replaced by '',
 * quoted identifiers kept without their quotes, whitespace collapsed.
 */
export function stripForAnalysis(sql: string): string {
  return scan(sql).stripped;
}

const READ_START = /^(?:select|with|show|describe|desc)\b/;
const FIRST_WORD = /^(?:select|with|show|describe|desc|explain)\b/;
const EXPLAIN_PREFIX = /^explain\b(?:\s+analyze\b)?(?:\s+verbose\b)?(?:\s*\([^)]*\))?\s*/;
const WRITE_WORDS = [
  "insert", "update", "delete", "merge", "create", "drop", "alter", "truncate", "grant", "revoke",
  "commit", "rollback", "attach", "detach", "pragma", "vacuum",
];
// A listed word directly followed by "(" is a function call (truncate(x)), not a statement.
const WRITE_WORD_RE = new RegExp(`\\b(?:${WRITE_WORDS.join("|")})\\b(?!\\()`, "g");
// Never an ordinary read, even as a call.
const ALWAYS_REFUSED_RE = /\bload_extension\b/g;
const REPLACE_INTO = /\breplace\s+into\b/;

/** Throws GuardError unless `sql` is exactly one read statement. */
export function assertReadOnly(sql: string): void {
  const { stripped: s, violations: scanned } = scan(sql);
  if (s === "" || s === ";") throw new GuardError(["empty statement"]);
  const violations: string[] = [...scanned];
  const body = s.endsWith(";") ? s.slice(0, -1) : s;
  if (body.includes(";")) violations.push("only one statement is allowed");

  const t = body.trim();
  let isRead = FIRST_WORD.test(t);
  if (isRead && t.startsWith("explain")) isRead = READ_START.test(t.replace(EXPLAIN_PREFIX, ""));
  if (!isRead) violations.push("not a read statement (write refused)");

  const seen = new Set<string>();
  // A show statement (show create table ...) is a read whatever words it names.
  if (!t.startsWith("show ")) {
    for (const m of body.matchAll(WRITE_WORD_RE)) seen.add(m[0]);
    if (REPLACE_INTO.test(body)) seen.add("replace into");
  }
  for (const m of body.matchAll(ALWAYS_REFUSED_RE)) seen.add(m[0]);
  for (const w of seen) violations.push(`write keyword refused: ${w}`);

  if (violations.length > 0) throw new GuardError(violations);
}

const escapeRe = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Matches a mention of `table` (dotted parts may be spaced) in text from stripForAnalysis. The one pattern for a guarded table. */
export function tablePattern(table: string): RegExp {
  return new RegExp(`(?<![\\w$])${table.toLowerCase().split(".").map(escapeRe).join("\\s*\\.\\s*")}(?![\\w$])`);
}

const SELECT_STAR = /(?:\b(?:select|distinct|all)\s+|,\s*)\*(?=\s*(?:,|from\b|$))|[\w$]\.\*/;
const TS_LITERAL = /\btimestamp\s+'((?:[^']|'')*)'/gi;
const ZONED = /(?:\sutc|z|[+-]\d{2}:?\d{2}|\s[a-z_]+(?:\/[\w+-]+)+)$/i;

/** Blank the contents of every over ( ... ) and window w as ( ... ) span. */
function blankWindows(s: string): string {
  const re = /\b(?:over|window\s+[\w$]+\s+as)\s*\(/g;
  let out = "";
  let last = 0;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) {
    if (m.index < last) continue;
    let depth = 1;
    let j = m.index + m[0].length;
    while (j < s.length && depth > 0) {
      if (s[j] === "(") depth++;
      else if (s[j] === ")") depth--;
      j++;
    }
    out += s.slice(last, m.index) + " ";
    last = j;
  }
  return out + s.slice(last);
}

/** Plain-language guardrail violations for queries touching guarded tables; empty means allowed. */
export function checkGuardrails(sql: string, guards: TableGuard[]): string[] {
  const { stripped: s, kept } = scan(sql);
  const noWindows = blankWindows(s);
  const violations: string[] = [];
  const add = (v: string): void => { if (!violations.includes(v)) violations.push(v); };

  for (const g of guards) {
    const table = g.table.toLowerCase();
    if (!tablePattern(table).test(s)) continue;

    if (g.time_column !== null) {
      const col = escapeRe(g.time_column.toLowerCase());
      const cmp = new RegExp(`(?<![\\w$])${col}\\s*(?:>=?|<(?!>)=?|=|between\\b)|[<>=]\\s*(?:[\\w$]+\\.)?${col}(?![\\w$])`);
      if (!cmp.test(s)) add(`needs a time filter on ${g.time_column}`);
    }
    if (SELECT_STAR.test(s)) add(`select * is not allowed on ${g.table}; name the columns`);
    if (/\bcount\s*\(\s*distinct\b/.test(s)) add("exact distinct counts are not allowed; use approx_distinct");
    if (/\border\s+by\b/.test(noWindows) && !/\blimit\b|\bfetch\s+first\b/.test(s)) add("a sort needs a limit");
    // Literals are emptied in the stripped text, so read the comment-free text with literals kept.
    for (const m of kept.matchAll(TS_LITERAL)) {
      if (!ZONED.test(m[1]!.trim())) { add("time literals need an explicit time zone"); break; }
    }
  }
  return violations;
}
