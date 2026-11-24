// The entry of the worker a LocalQueryHost starts. It opens the database itself and answers one request at a time.
import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { buildFilesDatabase, statFiles, withNotes } from "./files";
import type { LocalSpec, WorkerReply } from "./local-host";
import { runOnDatabase } from "./sqlite";
import { ConnectorError } from "./types";
import type { QueryOutcome, QueryRequest } from "./types";

declare const self: {
  onmessage: ((ev: MessageEvent<{ id: number; spec: LocalSpec; req: QueryRequest }>) => void) | null;
  postMessage(message: WorkerReply, transfer?: Transferable[]): void;
};

let sql: { path: string; db: Database } | null = null;
let files: { stamp: string; db: Database; notes: string[] } | null = null;

function sqlDatabase(path: string): Database {
  if (sql !== null && sql.path === path) return sql.db;
  sql?.db.close();
  sql = null;
  try {
    const db = new Database(path, { readonly: true });
    sql = { path, db };
    return db;
  } catch (err) {
    throw new ConnectorError(`cannot open database ${basename(path)}: ${(err as Error).message}`);
  }
}

/** The in-memory database of the files, rebuilt when a file's size or modified time has changed. */
function filesDatabase(spec: Extract<LocalSpec, { kind: "files" }>): { db: Database; notes: string[] } {
  const stamp = statFiles(spec.files);
  if (files !== null && files.stamp === stamp) return files;
  const built = buildFilesDatabase(spec.files);
  files?.db.close();
  files = { stamp, ...built };
  return files;
}

function answer(spec: LocalSpec, req: QueryRequest): { outcome: QueryOutcome; notes: string[] } {
  if (spec.kind === "sql") return { outcome: runOnDatabase(sqlDatabase(spec.path), req), notes: [] };
  const { db, notes } = filesDatabase(spec);
  return { outcome: withNotes(runOnDatabase(db, req), notes), notes };
}

self.onmessage = (ev): void => {
  const { id, spec, req } = ev.data;
  try {
    const { outcome, notes } = answer(spec, req);
    // the raw bytes are moved, not copied
    self.postMessage({ id, outcome, notes }, [outcome.raw.buffer as ArrayBuffer]);
  } catch (err) {
    self.postMessage({ id, error: err instanceof Error ? err.message : String(err), connector: err instanceof ConnectorError });
  }
};
