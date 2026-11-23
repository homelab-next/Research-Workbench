// Child process for the contention test: bun tests/helpers/ledger-writer.ts <path> <case> <id> <count>
import { Ledger } from "../../src/core/ledger";

const [path, caseId, id, count] = process.argv.slice(2) as [string, string, string, string];
const l = Ledger.open(path, caseId);
for (let i = 0; i < Number(count); i++) {
  l.append({ type: "setting.changed", payload: { key: `writer-${id}`, value: i }, actor: { kind: "system", id: `writer-${id}` } });
}
l.close();
