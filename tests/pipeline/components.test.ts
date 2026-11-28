import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { Ledger } from "../../src/core/ledger";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { ComponentError, MEMORY_SOURCE, memoryItemHash, memoryManifest, memorySpecOf, parseSource, resolveComponent, rootComponents } from "../../src/pipeline/components";
import type { ResolveContext } from "../../src/pipeline/components";
import { copySample } from "../helpers/sample-root";

let dir: string;
let root: string;
let other: string;
let chain: Ledger;
let content: BlobStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "components-"));
  root = join(dir, "sample");
  other = join(dir, "other");
  copySample(root);
  mkdirSync(join(other, "sources"), { recursive: true });
  writeFileSync(join(other, "sources", "notes.yaml"), "kind: source\nid: notes\ntitle: Notes\nconnector: files\nlocation: .\nmarking: \"TLP:GREEN\"\nwhere: machine\nconfirmed: true\ntables: []\n");
  chain = Ledger.open(join(dir, "chain.db"), "workbench");
  content = new BlobStore(join(dir, "blobs"));
});
afterEach(() => {
  chain.close();
  rmSync(dir, { recursive: true, force: true });
});

type Out = ReturnType<ResolveContext["output"]>;
const load = (): Registry => loadRegistry([{ path: root, trusted: true, credentials: [] }, { path: other, trusted: false, credentials: [] }], { chain, content });
const ctxOf = (registry: Registry, over: Partial<ResolveContext> = {}, output: (loop: string, out: string) => Out = () => null): ResolveContext =>
  ({ registry, content, chain, trusted: [root], output, ...over });
const refusal = (f: () => unknown): string => {
  try { f(); } catch (err) { expect(err).toBeInstanceOf(ComponentError); return (err as Error).message; }
  throw new Error("it was not refused");
};
const PERSONA = (): string => join(root, "context", "personas", "researcher.md");

test("root resolves a trusted root's manifest and refuses one that is not loaded", () => {
  const registry = load();
  expect(registry.source("notes")).not.toBeNull();
  const ctx = ctxOf(registry);
  const got = resolveComponent(ctx, "research", "persona", "researcher", "root");
  expect(got.manifest.text).toContain("You are the researcher.");
  expect(got.item).toEqual({ stage: "research", kind: "persona", id: "researcher", title: "Researcher", source: "root", hash: registry.get("persona", "researcher")!.hash, path: "context/personas/researcher.md" });
  expect(refusal(() => resolveComponent(ctx, "research", "persona", "nobody", "root"))).toBe('persona "nobody" is not loaded');
  expect(refusal(() => resolveComponent(ctx, "research", "source", "notes", "root"))).toBe('source "notes" comes from a root that is not trusted');
  // what a pipeline with no loop reads: the trusted roots' manifests only
  const rc = rootComponents(registry);
  expect(rc.get("research", "persona", "researcher")!.hash).toBe(got.item.hash);
  expect(rc.get("research", "source", "notes")).toBeNull();
});

test("pinned resolves the content store's bytes of a hash the chain recorded for that kind and id from a trusted root", () => {
  // load, edit the persona, load again: { pinned: <first hash> } gives the first text; the item's source is "pinned" and its hash the first
  const first = load().get("persona", "researcher")!.hash;
  writeFileSync(PERSONA(), readFileSync(PERSONA(), "utf8").replace("You are the researcher.", "You are someone else."));
  const registry = load();
  expect(registry.get("persona", "researcher")!.hash).not.toBe(first);
  const got = resolveComponent(ctxOf(registry), "research", "persona", "researcher", { pinned: first });
  expect(got.manifest.text).toContain("You are the researcher.");
  expect(got.manifest.text).not.toContain("someone else");
  expect(got.item).toEqual({ stage: "research", kind: "persona", id: "researcher", title: "Researcher", source: "pinned", hash: first, path: "context/personas/researcher.md" });
});

test("pinned refuses a hash the chain never recorded, one recorded for another id, one from a root not trusted now, and one whose bytes are gone", () => {
  const registry = load();
  const ctx = ctxOf(registry);
  const hash = registry.get("persona", "researcher")!.hash;
  expect(refusal(() => resolveComponent(ctx, "research", "persona", "researcher", { pinned: "ab".repeat(32) }))).toContain("never loaded that hash");
  expect(refusal(() => resolveComponent(ctx, "research", "persona", "analyst", { pinned: hash }))).toContain("never loaded that hash");
  expect(refusal(() => resolveComponent(ctxOf(registry, { trusted: [other] }), "research", "persona", "researcher", { pinned: hash }))).toContain("never loaded that hash");
  rmSync(join(dir, "blobs", hash));
  expect(refusal(() => resolveComponent(ctx, "research", "persona", "researcher", { pinned: hash }))).toContain("the content store does not hold its bytes");
});

test("loop-output resolves a reference from the latest published loop.output and carries its marking; any other kind is refused: a loop's output may only be a reference", () => {
  const registry = load();
  const asked: string[] = [];
  const ctx = ctxOf(registry, {}, (loop, out) => {
    asked.push(`${loop}.${out}`);
    return { case: "CASE-3", head: "c".repeat(64), marking: "TLP:AMBER", hash: "d".repeat(64), text: "The account behind the address is a test account." };
  });
  const got = resolveComponent(ctx, "frame", "reference", "brief", { "loop-output": "investigation.product" });
  expect(asked).toEqual(["investigation.product"]);
  expect(got.manifest.kind).toBe("reference");
  expect(got.manifest.text).toBe("The account behind the address is a test account.");
  expect(got.manifest.body.marking).toBe("TLP:AMBER");
  expect(got.item.source).toBe("loop-output");
  expect(got.item.path).toBeNull();
  expect(got.item.origin).toEqual({ case: "CASE-3", head: "c".repeat(64), marking: "TLP:AMBER" });
  expect(content.text(got.item.hash)).toBe("The account behind the address is a test account.");
  for (const kind of ["persona", "rules", "schema", "check", "skill"]) {
    expect(refusal(() => resolveComponent(ctx, "frame", kind, "x", { "loop-output": "investigation.product" }))).toContain(kind === "check" ? "read from a trusted root" : "a loop's output may only be a reference");
  }
});

test("loop-output with no such output recorded is refused by name", () => {
  const ctx = ctxOf(load());
  expect(refusal(() => resolveComponent(ctx, "frame", "reference", "brief", { "loop-output": "triage.cards" }))).toBe('reference "brief": there is no published output "cards" of loop "triage"');
});

// ---- slice 13: memory sources

test("parseSource takes shared/unknown-device, shared/* and case/notes, and nothing else under memory", () => {
  for (const v of ["shared/unknown-device", "shared/*", "case/notes"]) expect(parseSource({ memory: v })).toEqual({ memory: v });
  for (const v of ["shared/", "shared/Unknown", "case/other", "other/x", "shared/a/b", "notes/latest", " shared/*", "shared/-x", `shared/${"a".repeat(65)}`, ""]) {
    expect(parseSource({ memory: v })).toBeNull();
    expect(MEMORY_SOURCE.test(v)).toBe(false);
  }
  expect(parseSource({ memory: "shared/*", pinned: "a".repeat(64) })).toBeNull();
  expect(parseSource({ memory: 1 })).toBeNull();
});

test("a memory source resolves a reference to a marker item: source memory, the hash of the selector, no path, and the selector on the item", () => {
  const ctx = ctxOf(load(), { caseTypes: ["unknown-device"] });
  const { manifest, item } = resolveComponent(ctx, "research", "reference", "shared-lessons", { memory: "shared/unknown-device" });
  expect(item).toEqual({ stage: "research", kind: "reference", id: "shared-lessons", title: "shared-lessons", source: "memory", hash: memoryItemHash("shared/unknown-device"), path: null, memory: "shared/unknown-device" });
  expect(memorySpecOf(manifest)).toBe("shared/unknown-device");
  expect(manifest.text).toBe("");
  expect(manifest).toEqual(memoryManifest("shared-lessons", "shared/unknown-device"));
  expect(manifest).toEqual({
    kind: "reference", id: "shared-lessons", title: "shared-lessons", hash: memoryItemHash("shared/unknown-device"), root: "", path: "", dir: "",
    body: { kind: "reference", id: "shared-lessons", title: "shared-lessons", memory: "shared/unknown-device" }, text: "",
  });
  expect(memoryItemHash("shared/unknown-device")).not.toBe(memoryItemHash("shared/*"));
  // shared/* and case/notes need no loaded case type
  expect(resolveComponent(ctx, "research", "reference", "any", { memory: "shared/*" }).item.memory).toBe("shared/*");
  expect(resolveComponent(ctxOf(load(), { caseTypes: [] }), "research", "reference", "notes", { memory: "case/notes" }).item).toMatchObject({ source: "memory", memory: "case/notes", path: null });
  // with no list of case types, any id resolves
  expect(resolveComponent(ctxOf(load()), "research", "reference", "x", { memory: "shared/phishing" }).item.memory).toBe("shared/phishing");
});

test("a memory source for rules, a persona, a procedure, a skill, a gate, a schema, a standard, a framework, a profile, a check or a check script is refused: memory may only be a reference", () => {
  const ctx = ctxOf(load(), { caseTypes: ["unknown-device"] });
  for (const kind of ["rules", "persona", "procedure", "skill", "gate", "schema", "standard", "framework", "profile", "check", "check-script"]) {
    for (const memory of ["shared/unknown-device", "shared/*", "case/notes"]) {
      expect(refusal(() => resolveComponent(ctx, "research", kind, "x", { memory })))
        .toBe(`${kind} "x": memory may only be a reference: a lesson is a note, never rules, a persona, a procedure, a skill, a gate guide, a schema or a check`);
    }
  }
});

test("shared/<type> for a case type that is not loaded is refused: there is no case type", () => {
  const ctx = ctxOf(load(), { caseTypes: ["unknown-device"] });
  expect(refusal(() => resolveComponent(ctx, "research", "reference", "shared-lessons", { memory: "shared/phishing" }))).toBe('reference "shared-lessons": there is no case type "phishing"');
  expect(refusal(() => resolveComponent(ctxOf(load(), { caseTypes: [] }), "research", "reference", "shared-lessons", { memory: "shared/unknown-device" }))).toBe('reference "shared-lessons": there is no case type "unknown-device"');
});

test("resolving a memory source puts nothing in the content store and reads no store", () => {
  const registry = load();
  const held = readdirSync(join(dir, "blobs")).sort();
  const touched: string[] = [];
  const watch = <T extends object>(name: string, o: T): T => new Proxy(o, { get: (t, k) => { touched.push(`${name}.${String(k)}`); return Reflect.get(t, k) as unknown; } });
  const ctx: ResolveContext = {
    registry: watch("registry", registry), content: watch("content", content), chain: watch("chain", chain), trusted: [root], caseTypes: ["unknown-device"],
    output: () => { touched.push("output"); return null; },
  };
  for (const memory of ["shared/unknown-device", "shared/*", "case/notes"]) resolveComponent(ctx, "research", "reference", "m", { memory });
  expect(touched).toEqual([]);
  expect(readdirSync(join(dir, "blobs")).sort()).toEqual(held);
});

test("memorySpecOf is null for a root reference, a loop output and a manifest whose body has memory: 1", () => {
  writeFileSync(join(root, "context", "lessons-ref.md"), "---\nkind: reference\nid: lessons-ref\ntitle: Lessons\nmemory: shared/*\n---\nA hand-written reference.\n");
  const registry = load();
  const ctx = ctxOf(registry, {}, () => ({ case: "CASE-3", head: "c".repeat(64), marking: "TLP:GREEN", hash: "d".repeat(64), text: "An output." }));
  const rootRef = resolveComponent(ctx, "research", "reference", "lessons-ref", "root").manifest;
  expect(rootRef.body.memory).toBe("shared/*");
  expect(memorySpecOf(rootRef)).toBeNull();
  expect(memorySpecOf(resolveComponent(ctx, "frame", "reference", "brief", { "loop-output": "investigation.product" }).manifest)).toBeNull();
  const marker = memoryManifest("m", "shared/*");
  expect(memorySpecOf({ ...marker, body: { ...marker.body, memory: 1 } })).toBeNull();
  expect(memorySpecOf({ ...marker, kind: "skill" })).toBeNull();
  expect(memorySpecOf(marker)).toBe("shared/*");
});
