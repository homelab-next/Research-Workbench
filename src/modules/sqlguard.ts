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
  /**
   * Lower-cased, comments removed, whitespace collapsed; each string literal is a numbered marker (\u0003n\u0003) and each quoted
   * identifier a different one (\u0002n\u0002), so no word inside either can be read as syntax.
   */
  marked: string;
  /** The bodies of the string literals, as written, by marker number. */
  literals: string[];
  /** The bodies of the quoted identifiers, lower-cased, by marker number. */
  quoted: string[];
}

/**
 * The single scanning pass. Anything this scanner does not understand as an
 * identifier quote could hide a literal or comment opener from it, so such
 * characters are recorded as violations here, where they are met.
 */
function scan(sql: string): Scan {
  let out = "";
  let kept = "";
  let marked = "";
  const literals: string[] = [];
  const quoted: string[] = [];
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
      if (c === "'") { marked += `\u0003${literals.length}\u0003`; literals.push(body); }
      else { marked += `\u0002${quoted.length}\u0002`; quoted.push(body.toLowerCase()); }
      kept += sql.slice(i, j);
      i = j;
    } else if (c === "-" && sql[i + 1] === "-") {
      const e = sql.indexOf("\n", i);
      out += " ";
      kept += " ";
      marked += " ";
      i = e === -1 ? n : e + 1;
    } else if (c === "/" && sql[i + 1] === "*") {
      const e = sql.indexOf("*/", i + 2);
      out += " ";
      kept += " ";
      marked += " ";
      i = e === -1 ? n : e + 2;
    } else {
      if (c === "`") flag("backtick identifiers are not allowed");
      else if (c === "[" && !(i > 0 && /[\w$)\]"]/.test(sql[i - 1]!))) flag("bracket identifiers are not allowed");
      out += c;
      kept += c;
      marked += c;
      i++;
    }
  }
  return { stripped: out.toLowerCase().replace(/\s+/g, " ").trim(), kept, violations, marked: marked.toLowerCase().replace(/\s+/g, " ").trim(), literals, quoted };
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
export function tablePattern(table: string, metadata = false): RegExp {
  return new RegExp(`(?<![\\w$])${table.toLowerCase().split(".").map(escapeRe).join("\\s*\\.\\s*")}${metadata ? "\\$" : "(?![\\w$])"}`);
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
  const { stripped: s, kept, marked } = scan(sql);
  // A quoted identifier or a literal is never a keyword or a column: the time-filter and sort tests read text with both blanked.
  const blanked = marked.replace(/\u0002\d+\u0002/g, '"q"').replace(/\u0003\d+\u0003/g, "''");
  const noWindows = blankWindows(blanked);
  const violations: string[] = [];
  const add = (v: string): void => { if (!violations.includes(v)) violations.push(v); };

  for (const g of guards) {
    const table = g.table.toLowerCase();
    if (!tablePattern(table).test(s)) continue;

    if (g.time_column !== null) {
      const col = escapeRe(g.time_column.toLowerCase());
      const cmp = new RegExp(`(?<![\\w$])${col}\\s*(?:>=?|<(?!>)=?|=|between\\b)|[<>=]\\s*(?:[\\w$]+\\.)?${col}(?![\\w$])`);
      if (!cmp.test(blanked)) add(`needs a time filter on ${g.time_column}`);
    }
    if (SELECT_STAR.test(s)) add(`select * is not allowed on ${g.table}; name the columns`);
    if (/\bcount\s*\(\s*distinct\b/.test(s)) add("exact distinct counts are not allowed; use approx_distinct");
    if (/\border\s+by\b/.test(noWindows) && !/\blimit\b|\bfetch\s+first\b/.test(blanked)) add("a sort needs a limit");
    // Literals are emptied in the stripped text, so read the comment-free text with literals kept.
    for (const m of kept.matchAll(TS_LITERAL)) {
      if (!ZONED.test(m[1]!.trim())) { add("time literals need an explicit time zone"); break; }
    }
  }
  return violations;
}

export interface WindowLiterals { from: string; to: string }

type Tok = { k: "w" | "q" | "s" | "p"; v: string };
const TOKEN = /\u0002(\d+)\u0002|\u0003(\d+)\u0003|[\w$]+|>=|<=|<>|!=|[^\s]/g;
const BANNED_WORDS = new Set(["join", "union", "intersect", "except", "with", "or"]);
const SHAPE_ENDS = new Set(["and", "group", "having", "order", "limit", "offset", "fetch"]);
const NOT_ALIAS = new Set(["where", "group", "having", "order", "limit", "offset", "fetch", "on", "using", "cross", "inner", "left", "right", "full", "natural", "tablesample"]);

function tokens(marked: string, scanned: Scan): Tok[] {
  const out: Tok[] = [];
  for (const m of marked.matchAll(TOKEN)) {
    if (m[1] !== undefined) out.push({ k: "q", v: scanned.quoted[Number(m[1])]! });
    else if (m[2] !== undefined) out.push({ k: "s", v: scanned.literals[Number(m[2])]! });
    else out.push({ k: /^[\w$]/.test(m[0]) ? "w" : "p", v: m[0] });
  }
  return out;
}

/** The body of a rendered window literal, TIMESTAMP '<body>'. */
function literalBody(l: string): string | null {
  return /^TIMESTAMP '(.*)'$/s.exec(l)?.[1] ?? null;
}

/**
 * The shape a statement that names a guarded table must have: one select over that table alone, whose where clause begins with
 * the time column compared to exactly the request's two window literals. Anything else is refused. Empty means allowed.
 */
export function checkGuardedShape(sql: string, guards: TableGuard[], window: WindowLiterals | null): string[] {
  const scanned = scan(sql);
  const stripped = scanned.stripped.replace(EXPLAIN_PREFIX, "");
  let marked = scanned.marked;
  if (scanned.marked.startsWith("explain")) marked = scanned.marked.replace(EXPLAIN_PREFIX, "");
  marked = marked.replace(/[\s;]+$/, "");
  const violations: string[] = [];
  const add = (v: string): void => { if (!violations.includes(v)) violations.push(v); };
  for (const g of guards) {
    const table = g.table.toLowerCase();
    const re = tablePattern(table);
    const meta = tablePattern(table, true);
    if (!re.test(stripped) && !meta.test(stripped)) continue;
    if (window === null) { add("a guarded table needs a bounded window"); continue; }
    const body = stripped.replace(/[\s;]+$/, "");
    if (new RegExp(`^(?:describe|desc|show\\s+columns\\s+from)\\s+${re.source}$`).test(body)) continue;
    if (meta.test(stripped)) { add("metadata tables of a guarded table are not queried"); continue; }
    const toks = tokens(marked, scanned);
    const words = (w: string): number => toks.filter(t => t.k === "w" && t.v === w).length;
    const mentions = [...stripped.matchAll(new RegExp(re.source, "g"))].length;
    if (mentions !== 1 || words("select") !== 1 || words("from") !== 1) add("a query on a guarded table names it once, in one select with one from");
    if (toks.some(t => t.k === "w" && BANNED_WORDS.has(t.v))) add("join, union, intersect, except, with and or are not allowed on a guarded table");
    const clause = `the where clause must begin with ${g.time_column} >= {window.from} and ${g.time_column} < {window.to}`;
    if (!whereShape(toks, table, g.time_column, window)) add(clause);
  }
  return violations;
}

/** After the single from: the table, an optional alias, where, and the two comparisons against the window's own literals. */
function whereShape(toks: Tok[], table: string, timeColumn: string | null, window: WindowLiterals): boolean {
  let i = toks.findIndex(t => t.k === "w" && t.v === "from") + 1;
  if (i === 0) return false;
  const ident = (): string | null => {
    const t = toks[i];
    if (t === undefined || (t.k !== "w" && t.k !== "q")) return null;
    i++;
    return t.v;
  };
  const parts: string[] = [];
  for (;;) {
    const p = ident();
    if (p === null) return false;
    parts.push(p);
    if (toks[i]?.k === "p" && toks[i]!.v === ".") { i++; continue; }
    break;
  }
  if (parts.join(".") !== table) return false;
  let alias: string | null = null;
  if (toks[i]?.k === "w" && toks[i]!.v === "as") i++;
  else if (!(toks[i]?.k === "w" && toks[i]!.v === "where")) {
    if (toks[i]?.k !== "w" || NOT_ALIAS.has(toks[i]!.v)) return false;
  }
  if (toks[i]?.k === "w" && toks[i]!.v !== "where") { alias = toks[i]!.v; i++; }
  if (!(toks[i]?.k === "w" && toks[i]!.v === "where")) return false;
  i++;
  if (timeColumn === null) return true;
  const col = (): boolean => {
    if (alias !== null) {
      if (!(toks[i]?.k === "w" && toks[i]!.v === alias && toks[i + 1]?.k === "p" && toks[i + 1]!.v === ".")) return false;
      i += 2;
    }
    if (!(toks[i]?.k === "w" && toks[i]!.v === timeColumn.toLowerCase())) return false;
    i++;
    return true;
  };
  const op = (o: string): boolean => (toks[i]?.v === o && toks[i]?.k === "p" ? (i++, true) : false);
  const lit = (l: string): boolean => {
    const want = literalBody(l);
    if (want === null || !(toks[i]?.k === "w" && toks[i]!.v === "timestamp") || toks[i + 1]?.k !== "s" || toks[i + 1]!.v !== want) return false;
    i += 2;
    return true;
  };
  if (!(col() && op(">=") && lit(window.from) && toks[i]?.k === "w" && toks[i]!.v === "and")) return false;
  i++;
  if (!(col() && op("<") && lit(window.to))) return false;
  const next = toks[i];
  return next === undefined || (next.k === "w" && SHAPE_ENDS.has(next.v));
}
