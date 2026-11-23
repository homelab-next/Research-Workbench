// Child process for the lock tests: bun tests/helpers/open-workbench.ts <dataDir>
// Opens the workbench and closes it (exit 0); exits 3 on WorkbenchLockedError and 1 on anything else.
import { Workbench, WorkbenchLockedError } from "../../src/core/workbench";

try {
  Workbench.open(process.argv[2]!, { onError: () => {} }).close();
} catch (err) {
  process.exit(err instanceof WorkbenchLockedError ? 3 : 1);
}
