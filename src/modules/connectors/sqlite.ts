import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Json } from "../../core/canonical";
import { assertReadOnly } from "../sqlguard";
import { staysInside } from "../registry";
import type { SourceManifest } from "../manifests";
import { effectiveBound, PLACEHOLDER, placeholders } from "./placeholders";
import { LocalQueryHost } from "./local-host";
import { ConnectorError } from "./types";
import type { Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";

const paramName = (name: string): string => name.replace(/\./g, "_");

/** Guards the text, then turns each {name} into a named parameter $name (dots become underscores). */
export function renderSql(req: QueryRequest): string {
  assertReadOnly(req.text);
  return req.text.replace(PLACEHOLDER, (_m, name: string) => `$${paramName(name)}`);
}

function toJson(v: unknown): Json {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString("base64");
  return String(v);
}

/** The bytes a sql or files result is kept as: its columns and rows, as JSON. `rowsOfSqlRaw` reads them back. */
export function sqlRaw(columns: string[], rows: Json[][]): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ columns, rows }));
}

/** The columns and rows of a sql or files result's raw bytes; null when they are not that. Pure. */
export function rowsOfSqlRaw(bytes: Uint8Array): { columns: string[]; rows: Json[][] } | null {
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const { columns, rows } = doc as { columns?: unknown; rows?: unknown };
  if (!Array.isArray(columns) || !columns.every((c) => typeof c === "string")) return null;
  if (!Array.isArray(rows) || !rows.every((r) => Array.isArray(r) && r.length === columns.length)) return null;
  return { columns: columns as string[], rows: rows as Json[][] };
}

/** Runs one guarded statement on a database handle with bound values, stopping after max_rows. Shared by the sql and files connectors. */
export function runOnDatabase(db: Database, req: QueryRequest): QueryOutcome {
  const sql = renderSql(req);
  const bound = effectiveBound(req);
  const params: Record<string, string | number | null> = {};
  for (const name of placeholders(req.text)) {
    if (!Object.hasOwn(bound, name)) throw new ConnectorError(`no value is bound for placeholder {${name}}`);
    const key = `$${paramName(name)}`;
    if (Object.hasOwn(params, key) && params[key] !== bound[name]) {
      throw new ConnectorError(`placeholders that differ only by . and _ cannot be told apart: {${name}}`);
    }
    params[key] = bound[name]!;
  }
  let stmt;
  try {
    stmt = db.query(sql); // runs only the first statement; never exec()/run() on query text
  } catch (err) {
    throw new ConnectorError(`the source refused the query: ${(err as Error).message}`);
  }
  try {
    const columns: string[] = [...stmt.columnNames];
    const rows: Json[][] = [];
    let more = false;
    // bun reports each repeated column name once; the statement's true width, known after one step, shows the repeat
    stmt.get(params);
    if (stmt.columnTypes.length !== columns.length) throw new ConnectorError("the query returns two columns with the same name; alias one of them");
    for (const row of stmt.iterate(params) as Iterable<Record<string, unknown>>) {
      if (rows.length >= req.max_rows) { more = true; break; }
      rows.push(columns.map(c => toJson(row[c])));
    }
    const raw = sqlRaw(columns, rows);
    return {
      columns, rows, raw, media: "application/json", cost: null,
      coverage: more ? { kind: "partial", reason: "row_limit", detail: `stopped at ${req.max_rows} rows` } : { kind: "full" },
    };
  } catch (err) {
    if (err instanceof ConnectorError) throw err;
    throw new ConnectorError(`the source failed: ${(err as Error).message}`);
  } finally {
    stmt.finalize();
  }
}

export class SqliteConnector implements Connector {
  readonly kind = "sql" as const;
  private db: Database | null = null;
  private host: LocalQueryHost | null = null;

  constructor(private readonly source: SourceManifest, _ctx: ConnectorContext) {}

  /** The database file, checked to be inside the module root and to exist. */
  private path(): string {
    const path = resolve(this.source.dir, this.source.location);
    if (!staysInside(this.source.root, path)) throw new ConnectorError(`database ${this.source.location} is outside the module root`);
    if (!existsSync(path)) throw new ConnectorError(`database file not found: ${this.source.location}`);
    return path;
  }

  /** A read-only handle on this thread, opened on first use. Queries do not use it: they run in a worker. */
  get handle(): Database {
    if (this.db !== null) return this.db;
    const path = this.path();
    try {
      this.db = new Database(path, { readonly: true });
    } catch (err) {
      throw new ConnectorError(`cannot open database ${this.source.location}: ${(err as Error).message}`);
    }
    return this.db;
  }

  render(req: QueryRequest): string {
    return renderSql(req);
  }

  async estimate(_req: QueryRequest): Promise<null> {
    return null;
  }

  estimateRequest(_req: QueryRequest): null {
    return null;
  }

  readEstimate(_outcome: QueryOutcome): null {
    return null;
  }

  async run(req: QueryRequest): Promise<QueryOutcome> {
    // the guard and the path checks stay on this thread, before anything is posted
    renderSql(req);
    const path = this.path();
    this.host ??= new LocalQueryHost({ kind: "sql", path });
    return this.host.query(req);
  }

  close(): void {
    this.host?.close();
    this.host = null;
    this.db?.close();
    this.db = null;
  }
}
