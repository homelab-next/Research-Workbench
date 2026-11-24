import { Database } from "bun:sqlite";
import { readFileSync, statSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import type { SourceManifest, TableManifest } from "../manifests";
import { staysInside } from "../registry";
import { renderSql, runOnDatabase } from "./sqlite";
import { ConnectorError } from "./types";
import type { Connector, ConnectorContext, QueryOutcome, QueryRequest } from "./types";
import type { Coverage } from "../../core/types";
import { isPlainObject } from "../../core/canonical";

const MAX_FILE_BYTES = 64 * 1024 * 1024;

type Cell = string | number | boolean | null;
/** `missing`: declared columns the file does not have (a CSV header without them, or JSON lines none of which has them). */
interface Loaded { columns: string[]; rows: Cell[][]; unreadable: number; missing: string[] }

const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/** RFC 4180 style records: quoted fields, doubled quotes, commas and line breaks inside quotes. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  let touched = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === "") {
      quoted = true; touched = true;
    } else if (c === ",") {
      record.push(field); field = ""; touched = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (touched || field !== "") { record.push(field); records.push(record); } else records.push([]);
      record = []; field = ""; touched = false;
    } else { field += c; touched = true; }
  }
  if (touched || field !== "") { record.push(field); records.push(record); }
  return records;
}

function cell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  return JSON.stringify(v);
}

function loadCsv(text: string, wanted: string[] | null): Loaded {
  const records = parseCsv(text);
  let unreadable = 0;
  let header: string[] | null = null;
  const body: string[][] = [];
  for (const r of records) {
    if (header === null) { if (r.length > 0) header = r; continue; }
    if (r.length === 0) { unreadable++; continue; }
    body.push(r);
  }
  const names = wanted ?? header ?? [];
  const index = names.map(n => (header ?? []).indexOf(n));
  const rows: Cell[][] = [];
  for (const r of body) {
    if (r.length > (header ?? []).length) { unreadable++; continue; }
    rows.push(index.map(i => (i < 0 ? null : r[i] ?? null)));
  }
  const missing = header === null || wanted === null ? [] : wanted.filter(n => !header!.includes(n));
  return { columns: names, rows, unreadable, missing };
}

function loadJsonl(text: string, wanted: string[] | null): Loaded {
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  let unreadable = 0;
  const objects: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === "") { unreadable++; continue; }
    try {
      const v: unknown = JSON.parse(line);
      if (isPlainObject(v)) objects.push(v); else unreadable++;
    } catch { unreadable++; }
  }
  const names = wanted ?? (objects[0] !== undefined ? Object.keys(objects[0]) : []);
  const missing = wanted === null || objects.length === 0 ? [] : wanted.filter(n => !objects.some(o => Object.hasOwn(o, n)));
  return { columns: names, rows: objects.map(o => names.map(n => (Object.hasOwn(o, n) ? cell(o[n]) : null))), unreadable, missing };
}

function formatOf(t: TableManifest): "csv" | "jsonl" {
  if (t.format !== null) return t.format;
  const ext = extname(t.file ?? "").toLowerCase();
  if (ext === ".csv") return "csv";
  if (ext === ".jsonl" || ext === ".ndjson") return "jsonl";
  throw new ConnectorError(`table ${t.name} has no format and its file extension does not say`);
}

export class FilesConnector implements Connector {
  readonly kind = "files" as const;
  private db: Database | null = null;
  private stamp = "";
  private notes: string[] = [];

  constructor(private readonly source: SourceManifest, _ctx: ConnectorContext) {}

  private files(): { table: TableManifest; path: string; file: string }[] {
    const folder = resolve(this.source.dir, this.source.location);
    return this.source.tables.map(table => {
      if (table.file === null) throw new ConnectorError(`table ${table.name} names no file`);
      const path = resolve(folder, table.file);
      if (!staysInside(this.source.root, path)) throw new ConnectorError(`file ${table.file} is outside the module root`);
      return { table, path, file: table.file };
    });
  }

  private refresh(): Database {
    const files = this.files();
    const stats = files.map(f => {
      try {
        const s = statSync(f.path);
        if (!s.isFile()) throw new Error("not a regular file");
        if (s.size > MAX_FILE_BYTES) throw new ConnectorError(`file ${f.file} is larger than ${MAX_FILE_BYTES} bytes`);
        return `${f.path}:${s.size}:${s.mtimeMs}`;
      } catch (err) {
        if (err instanceof ConnectorError) throw err;
        throw new ConnectorError(`file ${f.file} for table ${f.table.name} cannot be read: ${(err as Error).message}`);
      }
    });
    const stamp = stats.join("\n");
    if (this.db !== null && stamp === this.stamp) return this.db;

    const db = new Database(":memory:");
    const notes: string[] = [];
    try {
      for (const f of files) {
        const wanted = f.table.columns.length > 0 ? f.table.columns.map(c => c.name) : null;
        let text: string;
        try {
          text = readFileSync(f.path, "utf8");
        } catch (err) {
          throw new ConnectorError(`file ${f.file} for table ${f.table.name} cannot be read: ${(err as Error).message}`);
        }
        const loaded = formatOf(f.table) === "csv" ? loadCsv(text, wanted) : loadJsonl(text, wanted);
        if (loaded.columns.length === 0) throw new ConnectorError(`file ${f.file} has no columns`);
        // a missing column would read as nulls with full coverage, and every lookup on it as a proven negative
        if (loaded.missing.length > 0) {
          throw new ConnectorError(`file ${f.file} for table ${f.table.name} has no column ${loaded.missing.join(", ")}, which the manifest declares`);
        }
        if (new Set(loaded.columns).size !== loaded.columns.length) throw new ConnectorError(`file ${f.file} has duplicate column names`);
        db.run(`create table ${quoteIdent(f.table.name)} (${loaded.columns.map(quoteIdent).join(", ")})`);
        const insert = db.prepare(`insert into ${quoteIdent(f.table.name)} values (${loaded.columns.map(() => "?").join(", ")})`);
        db.transaction(() => { for (const r of loaded.rows) insert.run(...r); })();
        if (loaded.unreadable > 0) notes.push(`${loaded.unreadable} unreadable line${loaded.unreadable === 1 ? "" : "s"} in ${basename(f.file)}`);
      }
      db.run("pragma query_only = on");
    } catch (err) {
      db.close();
      throw err;
    }
    this.db?.close();
    this.db = db;
    this.stamp = stamp;
    this.notes = notes;
    return db;
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
    const out = runOnDatabase(this.refresh(), req);
    if (this.notes.length === 0) return out;
    const detail = [out.coverage.kind === "partial" ? out.coverage.detail : undefined, ...this.notes].filter(x => x !== undefined).join("; ");
    const coverage: Coverage = out.coverage.kind === "partial"
      ? { ...out.coverage, detail }
      : { kind: "partial", reason: "source_error", detail };
    return { ...out, coverage };
  }

  close(): void {
    this.db?.close();
    this.db = null;
    this.stamp = "";
  }
}
