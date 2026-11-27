// bun run src/cli/verify.ts <case-dir>
// bun run src/cli/verify.ts --ledger <ledger.sqlite> --blobs <blob-dir>   (for example the workbench chain)
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { formatReport, linkLines, UnreadableLedgerError, verifyLedger, verifyLinks, verifyPublished } from "../core/verify";

const USAGE = [
  "usage: bun run src/cli/verify.ts <case-dir>                          (the directory must contain ledger.sqlite)",
  "       bun run src/cli/verify.ts --ledger <ledger-file> --blobs <blob-dir>",
].join("\n");

function usage(): never {
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(args: string[]): { ledger: string; blobs: string; caseDir: string | null } {
  if (args.length === 1 && !args[0]!.startsWith("--")) return { ledger: join(args[0]!, "ledger.sqlite"), blobs: join(args[0]!, "blobs"), caseDir: args[0]! };
  const named: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]!, value = args[i + 1];
    if ((flag !== "--ledger" && flag !== "--blobs") || value === undefined || Object.hasOwn(named, flag)) usage();
    named[flag] = value;
  }
  if (named["--ledger"] === undefined || named["--blobs"] === undefined) usage();
  return { ledger: named["--ledger"], blobs: named["--blobs"], caseDir: null };
}

const target = parseArgs(process.argv.slice(2));
if (!existsSync(target.ledger) || !statSync(target.ledger).isFile()) usage();
try {
  const chain = verifyLedger(target.ledger, target.blobs);
  // a case folder has published bundles to check too; the workbench chain, given by file, has none
  const report = target.caseDir === null ? chain : (() => { const published = verifyPublished(target.caseDir); return { ...chain, ok: chain.ok && published.ok, published }; })();
  // a case's links to its children: each child is looked for beside the case, in the same cases folder
  const links = target.caseDir === null ? null : verifyLinks(target.caseDir, dirname(resolve(target.caseDir)));
  console.log([formatReport(report), ...(links === null ? [] : linkLines(links))].join("\n"));
  process.exit(report.ok && (links?.ok ?? true) ? 0 : 1);
} catch (err) {
  if (!(err instanceof UnreadableLedgerError)) throw err;
  console.log(`ledger ${target.ledger}: UNREADABLE (${err.message})`);
  process.exit(1);
}
