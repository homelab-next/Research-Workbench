// Child process for the lock tests: bun tests/helpers/workbench-opener.ts <dataDir> <go-file> <release-file>
// Says "ready", waits for <go-file> to exist, tries to open the workbench and says "held <pid>" or
// "locked <pid named by the error>", then (if it holds the lock) waits for <release-file> and closes.
// With <go-file> "-" it opens at once, and with <release-file> "-" it holds until killed.
import { existsSync } from "node:fs";
import { Workbench, WorkbenchLockedError } from "../../src/core/workbench";

const [dataDir, go, release] = process.argv.slice(2) as [string, string, string];
const waitFor = (path: string): void => {
  while (!existsSync(path)) Bun.sleepSync(1);
};
process.stdout.write("ready\n");
if (go !== "-") waitFor(go);
let wb: Workbench;
try {
  wb = Workbench.open(dataDir, { onError: () => {} });
} catch (err) {
  if (!(err instanceof WorkbenchLockedError)) throw err;
  process.stdout.write(`locked ${err.pid}\n`);
  process.exit(0);
}
process.stdout.write(`held ${process.pid}\n`);
if (release === "-") for (;;) Bun.sleepSync(1000);
waitFor(release);
wb.close();
