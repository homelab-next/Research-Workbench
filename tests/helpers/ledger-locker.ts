// Child process for the verifier's busy-timeout test: bun tests/helpers/ledger-locker.ts <path> <hold-ms>
// Takes an exclusive lock on the ledger file, says "locked", holds it, then releases it.
import { Database } from "bun:sqlite";

const [path, holdMs] = process.argv.slice(2) as [string, string];
const db = new Database(path);
db.exec("BEGIN EXCLUSIVE");
process.stdout.write("locked\n");
Bun.sleepSync(Number(holdMs));
db.exec("ROLLBACK");
db.close();
