import type { Json } from "../../core/canonical";
import type { Payloads } from "../../core/types";
import type { SourceManifest } from "../manifests";
import { rowsOfHttp } from "./http";
import { rowsOfSqlRaw } from "./sqlite";
import { rowsOfTrino } from "./trino";

/**
 * The columns and rows a stored result's raw bytes hold, by the connector that made them: the same reading that connector's own `run` uses
 * to make its rows, so what is read back is what was read first. Pure: it touches no source, only the manifest and the bytes.
 * Null when the bytes cannot be read back (not what that connector keeps, or its endpoint is no longer in the source).
 */
export function rowsOfBlob(source: SourceManifest, issued: Payloads["query.issued"], bytes: Uint8Array): { columns: string[]; rows: Json[][] } | null {
  const max = source.limits.max_rows;
  switch (issued.connector) {
    case "sql":
    case "files": {
      const read = rowsOfSqlRaw(bytes);
      return read === null ? null : { columns: read.columns, rows: read.rows.slice(0, max) };
    }
    case "http": return rowsOfHttp(source, issued, bytes, max);
    case "trino": return rowsOfTrino(bytes, max);
    default: return null;
  }
}
