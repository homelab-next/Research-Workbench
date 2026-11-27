import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { sha256Hex } from "../../src/core/hash";
import { Ledger } from "../../src/core/ledger";
import type { RootConfig } from "../../src/modules/config";
import { Registry } from "../../src/modules/registry";
import { loadRegistry, recordedAs } from "../../src/modules/registry-record";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "rw-content-"));
  dirs.push(d);
  return d;
};
const ledgers: Ledger[] = [];
afterEach(() => {
  for (const l of ledgers.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function root(files: Record<string, string>, trusted = true): RootConfig {
  const dir = tmp();
  for (const [name, text] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  }
  return { path: dir, trusted, credentials: [] };
}
function chain(): Ledger {
  const l = Ledger.open(join(tmp(), "ledger.sqlite"), "WORKBENCH");
  ledgers.push(l);
  return l;
}

const SOURCE = `kind: source
id: dns-logs
title: DNS logs
connector: files
location: data
marking: "TLP:GREEN"
where: machine
tables:
  - name: dns
    file: dns.jsonl
    format: jsonl
    columns:
      - { name: client, type: null }
`;
const TYPES = "kind: types\ntypes:\n  - { id: address, title: Address, pattern: '^(?:\\\\d{1,3}\\\\.){3}\\\\d{1,3}$' }\n";
const PERSONA = "---\nkind: persona\nid: planner\ntitle: Planner\n---\nYou plan.\n";
const LOOP = "kind: loop\nid: triage\ntitle: Triage\nversion: 1\nstages: [plan]\n";

test("loadRegistry with content puts every loaded manifest's bytes in it under the manifest's hash", () => {
  const content = new BlobStore(join(tmp(), "blobs"));
  const r = root({ "sources/dns-logs.yaml": SOURCE, "types.yaml": TYPES, "context/planner.md": PERSONA, "loops/triage.yaml": LOOP });
  const c = chain();
  const registry = loadRegistry([r], { chain: c, content });
  expect(registry.manifests().map((m) => m.kind).sort()).toEqual(["loop", "persona", "source", "type"]);
  for (const m of registry.manifests()) expect(sha256Hex(content.get(m.hash))).toBe(m.hash);
  for (const m of registry.manifests()) expect(content.get(m.hash)).toEqual(new Uint8Array(readFileSync(m.path)));
  // every module.loaded the chain holds names bytes that are in the store
  for (const e of c.read()) if (e.type === "module.loaded") expect(content.has(e.payload.hash)).toBe(true);
});

test("loadRegistry with content refuses a file changed since it was read, and puts nothing in the store or on the chain", () => {
  const content = new BlobStore(join(tmp(), "blobs"));
  const r = root({ "sources/dns-logs.yaml": SOURCE, "context/planner.md": PERSONA });
  const c = chain();
  const real = Registry.load;
  Registry.load = (...args: Parameters<typeof Registry.load>) => {
    const reg = real(...args);
    writeFileSync(join(r.path, "sources/dns-logs.yaml"), SOURCE + "quality: later\n");
    return reg;
  };
  try {
    expect(() => loadRegistry([r], { chain: c, content })).toThrow(/is not the workbench's own sha256/);
  } finally {
    Registry.load = real;
  }
  expect(content.has(sha256Hex(SOURCE))).toBe(false);
  expect(content.has(sha256Hex(PERSONA))).toBe(false);
  expect(c.read()).toHaveLength(0);
});

test("recordedAs is true for a hash the chain recorded from a trusted root with that kind and id, false for another kind, another id, or a root that is not trusted now", () => {
  const trusted = root({ "context/planner.md": PERSONA, "sources/dns-logs.yaml": SOURCE });
  const other = root({ "sources/dns-logs.yaml": SOURCE.replace("DNS logs", "DNS logs, copied") }, false);
  const c = chain();
  const registry = loadRegistry([trusted], { chain: c });
  loadRegistry([other], { chain: c });
  const persona = registry.get("persona", "planner")!;
  expect(recordedAs(c, persona.hash, "persona", "planner", [trusted.path])).toBe(true);
  expect(recordedAs(c, persona.hash, "skill", "planner", [trusted.path])).toBe(false);
  expect(recordedAs(c, persona.hash, "persona", "writer", [trusted.path])).toBe(false);
  // the same hash from a root the configuration no longer trusts
  expect(recordedAs(c, persona.hash, "persona", "planner", [])).toBe(false);
  expect(recordedAs(c, persona.hash, "persona", "planner", [other.path])).toBe(false);
  // a hash recorded only from the untrusted root does not count because the id matches
  const copied = sha256Hex(readFileSync(join(other.path, "sources/dns-logs.yaml")));
  expect(recordedAs(c, copied, "source", "dns-logs", [trusted.path])).toBe(false);
  expect(recordedAs(c, copied, "source", "dns-logs", [trusted.path, other.path])).toBe(true);
  expect(recordedAs(c, "0".repeat(64), "persona", "planner", [trusted.path])).toBe(false);
});

test("a refused manifest's bytes are not put in the content store", () => {
  const content = new BlobStore(join(tmp(), "blobs"));
  const untrusted = root({ "context/planner.md": PERSONA, "loops/triage.yaml": LOOP, "sources/dns-logs.yaml": SOURCE }, false);
  const broken = "kind: source\nid: broken\ntitle: B\nconnector: files\n";
  const r2 = root({ "sources/broken.yaml": broken });
  const registry = loadRegistry([untrusted, r2], { content });
  expect(registry.problems.map((p) => p.path).sort()).toEqual([join(untrusted.path, "context/planner.md"), join(untrusted.path, "loops/triage.yaml"), join(r2.path, "sources/broken.yaml")].sort());
  expect(content.has(sha256Hex(PERSONA))).toBe(false);
  expect(content.has(sha256Hex(LOOP))).toBe(false);
  expect(content.has(sha256Hex(broken))).toBe(false);
  expect(content.has(sha256Hex(SOURCE))).toBe(true);
});
