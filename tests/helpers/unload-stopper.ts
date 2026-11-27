// Child process for the stopped-unload test: bun tests/helpers/unload-stopper.ts <dataDir> <store> <case> <step>
// Opens the workbench and unloads the case, and the process kills itself with SIGKILL the moment the unload reaches <step>: a real stop,
// not a failure, so nothing after it runs, no catch, no exit handler, no reopen and no close. Exits 1 when the unload ends without reaching it.
import { Workbench } from "../../src/core/workbench";
import type { UnloadStep } from "../../src/core/workbench";

const [dataDir, store, id, step] = process.argv.slice(2) as [string, string, string, UnloadStep];
const wb = Workbench.open(dataDir, { onError: () => {}, store, beforeUnloadStep: (at) => { if (at === step) process.kill(process.pid, "SIGKILL"); } });
await wb.unloadCase(id, { actor: { kind: "human", id: "analyst" } });
wb.close();
process.exit(1);
