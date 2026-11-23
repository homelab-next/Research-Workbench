import { formatReport, hasLedger, UnreadableLedgerError, verifyCase } from "../core/verify";

const dir = process.argv[2];
if (dir === undefined || !hasLedger(dir)) {
  console.error("usage: bun run src/cli/verify.ts <case-dir>   (the directory must contain ledger.sqlite)");
  process.exit(2);
}
try {
  const report = verifyCase(dir);
  console.log(formatReport(report));
  process.exit(report.ok ? 0 : 1);
} catch (err) {
  if (!(err instanceof UnreadableLedgerError)) throw err;
  console.log(`case ${dir}: UNREADABLE (${err.message})`);
  process.exit(1);
}
