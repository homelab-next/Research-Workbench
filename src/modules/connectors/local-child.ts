// The program a LocalQueryHost runs, one process per query: JSON { spec, req } on standard input, one JSON line on standard output.
import { Database } from "bun:sqlite";
import { basename } from "node:path";
import { buildFilesDatabase, statFiles, withNotes } from "./files";
import type { LocalSpec } from "./local-host";
import { runOnDatabase } from "./sqlite";
import { ConnectorError } from "./types";
import type { QueryOutcome, QueryRequest } from "./types";

function answer(spec: LocalSpec, req: QueryRequest): QueryOutcome {
  if (spec.kind === "sql") {
    let db: Database;
    try {
      db = new Database(spec.path, { readonly: true });
    } catch (err) {
      throw new ConnectorError(`cannot open database ${basename(spec.path)}: ${(err as Error).message}`);
    }
    return runOnDatabase(db, req);
  }
  statFiles(spec.files);
  const { db, notes } = buildFilesDatabase(spec.files);
  return withNotes(runOnDatabase(db, req), notes);
}

const input = JSON.parse(await Bun.stdin.text()) as { spec: LocalSpec; req: QueryRequest };
let line: string;
try {
  const out = answer(input.spec, input.req);
  // the raw bytes are the result: columns and rows are read back from them by the host, so what is stored is byte-identical to what was produced
  line = JSON.stringify({ ok: true, coverage: out.coverage, media: out.media, cost: out.cost, raw: Buffer.from(out.raw).toString("base64") });
} catch (err) {
  line = JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), connector: err instanceof ConnectorError });
}
process.stdout.write(line + "\n", () => process.exit(0));
