import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractCaseFile } from "../../src/core/casefile";
import type { Actor } from "../../src/core/types";

/** The entries a case file's ledger holds, in order: each one's type and actor. Extracted under a fresh folder that is removed. */
export async function storedEntries(file: string): Promise<{ type: string; actor: Actor }[]> {
  const dir = mkdtempSync(join(tmpdir(), "stored-"));
  try {
    await extractCaseFile(file, join(dir, "case"));
    const db = new Database(join(dir, "case", "ledger.sqlite"), { readonly: true });
    try {
      return (db.query("SELECT type, actor FROM entries ORDER BY seq").all() as { type: string; actor: string }[])
        .map((r) => ({ type: r.type, actor: JSON.parse(r.actor) as Actor }));
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
