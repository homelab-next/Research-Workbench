import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore } from "../../src/core/blobs";
import { Ledger } from "../../src/core/ledger";
import type { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import { ComponentError, resolveComponent, rootComponents } from "../../src/pipeline/components";
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

test("memory is refused: memory sources arrive in slice 13", () => {
  const ctx = ctxOf(load());
  expect(refusal(() => resolveComponent(ctx, "research", "skill", "ask-the-person", { memory: "notes/latest" }))).toBe('skill "ask-the-person": memory sources arrive in slice 13');
});
