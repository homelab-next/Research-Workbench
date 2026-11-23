import { formatReport, hasLedger, verifyCase } from "../core/verify";

const dir = process.argv[2];
if (dir === undefined || !hasLedger(dir)) {
  console.error("usage: bun run src/cli/verify.ts <case-dir>   (the directory must contain ledger.sqlite)");
  process.exit(2);
}
const report = verifyCase(dir);
console.log(formatReport(report));
process.exit(report.ok ? 0 : 1);
