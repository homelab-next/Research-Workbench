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
