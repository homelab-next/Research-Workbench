// bun run src/cli/verify.ts <case-dir>
// bun run src/cli/verify.ts --ledger <ledger.sqlite> --blobs <blob-dir>   (for example the workbench chain)
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatReport, UnreadableLedgerError, verifyLedger } from "../core/verify";

const USAGE = [
  "usage: bun run src/cli/verify.ts <case-dir>                          (the directory must contain ledger.sqlite)",
  "       bun run src/cli/verify.ts --ledger <ledger-file> --blobs <blob-dir>",
].join("\n");

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(args: string[]): { ledger: string; blobs: string } {
  if (args.length === 1 && !args[0]!.startsWith("--")) return { ledger: join(args[0]!, "ledger.sqlite"), blobs: join(args[0]!, "blobs") };
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if ((flag !== "--ledger" && flag !== "--blobs") || value === undefined || Object.hasOwn(named, flag)) usage();
    named[flag] = value;
  }
  if (named["--ledger"] === undefined || named["--blobs"] === undefined) usage();
  return { ledger: named["--ledger"], blobs: named["--blobs"] };
}

const target = parseArgs(process.argv.slice(2));
if (!existsSync(target.ledger) || !statSync(target.ledger).isFile()) usage();
try {
  const report = verifyLedger(target.ledger, target.blobs);
  console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  if (!(err instanceof UnreadableLedgerError)) throw err;
  console.log(`ledger ${target.ledger}: UNREADABLE (${err.message})`);
  process.exit(1);
}
