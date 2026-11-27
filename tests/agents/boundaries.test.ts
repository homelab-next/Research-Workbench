import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");

function files(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
  });
}
const IMPORT = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
const imports = (text: string): string[] => [...text.matchAll(IMPORT)].map((m) => m[1]!);

test("no file under src/agents/tools or src/pipeline imports from modules/connectors", () => {
  const all = [...files(join(SRC, "agents", "tools")), ...files(join(SRC, "pipeline"))];
  expect(files(join(SRC, "agents", "tools")).length).toBeGreaterThanOrEqual(4);
  for (const f of all) {
    for (const spec of imports(readFileSync(f, "utf8"))) expect(`${f}: ${spec}`).not.toMatch(/modules\/connectors/);
  }
});

test("no file under src/agents/tools imports runProposal or names a budget", () => {
  for (const f of files(join(SRC, "agents", "tools"))) {
    const text = readFileSync(f, "utf8");
    for (const spec of imports(text)) expect(`${f}: ${spec}`).not.toMatch(/modules\/proposals/);
    expect(`${f}: ${text.includes("runProposal")}`).toBe(`${f}: false`);
    expect(`${f}: ${text.match(/\bbudget\s*:/)?.[0] ?? ""}`).toBe(`${f}: `);
  }
});

test("src/agents imports nothing that writes a manifest or the configuration, and builder.ts calls neither runQuery nor runPivot", () => {
  const all = files(join(SRC, "agents"));
  expect(all.some((f) => f.endsWith(join("tools", "builder.ts")))).toBe(true);
  const WRITERS = /(?:modules\/(?:loop-write|loop-import|config-write|yaml-write)|core\/loopfile|core\/tar)(?:\.ts)?$/;
  const FS_WRITE = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|writeSync|mkdirSync|mkdir|mkdtempSync|renameSync|rename|rmSync|rm|unlinkSync|unlink|copyFileSync|copyFile|cpSync|symlinkSync|linkSync|truncateSync|chmodSync|createWriteStream|openSync)\b/;
  for (const f of all) {
    const text = readFileSync(f, "utf8");
    for (const spec of imports(text)) expect(`${f}: ${spec}`).not.toMatch(WRITERS);
    // what a file takes from node:fs (or fs) is only ever a reader
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+["'](?:node:)?fs(?:\/promises)?["']/g)) {
      expect(`${f}: ${m[1]!.match(FS_WRITE)?.[0] ?? ""}`).toBe(`${f}: `);
    }
    expect(`${f}: ${/import\s+\*\s+as\s+\w+\s+from\s+["'](?:node:)?fs/.test(text)}`).toBe(`${f}: false`);
  }
  const builder = readFileSync(join(SRC, "agents", "tools", "builder.ts"), "utf8");
  expect(builder).not.toMatch(/\brunQuery\b/);
  expect(builder).not.toMatch(/\brunPivot\b/);
  expect(builder).not.toMatch(/\brunPlaybook\b|\brunProposal\b/);
  for (const spec of imports(builder)) expect(`builder.ts: ${spec}`).not.toMatch(/modules\/(?:runner|pivots|playbook-run|proposals)$/);
});
