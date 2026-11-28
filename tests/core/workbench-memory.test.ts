// The workbench's shared memory store (slice 13): where it lives, and its file: export in place, load into an empty store or a fast-forward of
// the same store only.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonical } from "../../src/core/canonical";
import type { Json } from "../../src/core/canonical";
import type { LessonDraft } from "../../src/core/lessons";
import { checkMemoryFile, extractMemoryFile, MemoryFileError, memoryFileName, writeMemoryFile } from "../../src/core/memfile";
import { MemoryRefused, MemoryStore } from "../../src/core/memstore";
import { Refused } from "../../src/core/refused";
import type { Actor, Payloads } from "../../src/core/types";
import { Ledger } from "../../src/core/ledger";
import { verifyMemory } from "../../src/core/verify";
import { Workbench } from "../../src/core/workbench";
import { sha256Hex } from "../../src/core/hash";
import { fileSeeds } from "../../src/modules/seeds";
import type { SeedLesson } from "../../src/modules/seeds";

const person: Actor = { kind: "human", id: "analyst" };
const code: Actor = { kind: "system", id: "workbench" };
const draft = (title: string): LessonDraft => ({
  case_type: "unknown-device", title, text: "A device seen only on AP-3 is usually a guest in the lobby.", triggers: [], marking: "TLP:GREEN", supersedes: null,
});

let dir: string;
let wb: Workbench;
let tick = 0;
const errors: unknown[] = [];
const onError = (e: unknown) => void errors.push(e);
const now = () => new Date(Date.parse("2026-11-27T09:00:00.000Z") + tick++ * 1000).toISOString();
const openWb = (over: Parameters<typeof Workbench.open>[1] = {}): Workbench => Workbench.open(join(dir, "wb"), { store: join(dir, "store"), now, onError, ...over });
const ls = (d: string): string[] => (existsSync(d) ? readdirSync(d).sort() : []);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "wb-memory-"));
  tick = 0;
  errors.length = 0;
  wb = openWb();
});
afterEach(() => {
  try { wb.close(); } catch { /* already closed */ }
  rmSync(dir, { recursive: true, force: true });
});

test("wb.memory is the store at <data>/memory, or at the folder given, and is closed with the workbench", () => {
  const store = wb.memory;
  expect(store).toBeInstanceOf(MemoryStore);
  expect(store.dir).toBe(join(dir, "wb", "memory"));
  expect(wb.memory).toBe(store);
  expect(existsSync(join(dir, "wb", "memory", "ledger.sqlite"))).toBe(true);
  wb.close();
  expect(store.open).toBe(false);

  const other = join(dir, "elsewhere", "lessons");
  mkdirSync(join(dir, "elsewhere"));
  wb = openWb({ memory: other });
  expect(wb.memory.dir).toBe(other);
  expect(ls(join(dir, "elsewhere"))).toEqual(["lessons"]);
  const held = wb.memory;
  wb.close();
  expect(held.open).toBe(false);
  expect(errors).toEqual([]);
});

test("the store is opened on first use, not when the workbench opens", () => {
  wb.close();
  rmSync(join(dir, "wb", "memory"), { recursive: true, force: true });
  wb = openWb();
  expect(existsSync(join(dir, "wb", "memory"))).toBe(false);
  expect(wb.memory.head().seq).toBe(0);
  expect(existsSync(join(dir, "wb", "memory"))).toBe(true);
});

// ---------- export and load ----------

/** Files and shares a lesson in `wb`'s store. */
function share(w: Workbench, title: string): void {
  const l = w.memory.propose(draft(title), { kind: "person" }, person).lesson;
  w.memory.accept(l.id, { actor: person, hash: l.hash });
}
/** A second workbench beside the first, with its own data folder (and so its own store). */
const others: Workbench[] = [];
afterEach(() => {
  for (const o of others.splice(0)) { try { o.close(); } catch { /* closed */ } }
});
function another(name: string): Workbench {
  const o = Workbench.open(join(dir, name), { store: join(dir, `${name}-store`), now, onError });
  others.push(o);
  return o;
}
async function refused(p: Promise<unknown>, kind: typeof MemoryRefused | typeof MemoryFileError = MemoryRefused): Promise<string> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(kind);
    expect(err).toBeInstanceOf(Refused);
    return (err as Error).message;
  }
  throw new Error("expected a refusal");
}
const files = (): string => join(dir, "files");
const typesOf = (w: Workbench): string[] => w.chain.read().map((e) => e.type);
const storeView = (w: Workbench) => ({ origin: w.memory.origin(), head: w.memory.head(), state: w.memory.state });

test("exportMemory writes a file that verifies, records memory.exported, and leaves the store open and unchanged", async () => {
  share(wb, "Check the lobby access point first");
  wb.memory.propose(draft("A proposal"), { kind: "person" }, person);
  const before = storeView(wb);
  const held = wb.memory;
  const r = await wb.exportMemory(files(), { actor: person });
  expect(r.file).toBe(memoryFileName("TLP:GREEN", before.head.hash));
  expect(r.path).toBe(join(files(), r.file));
  expect(ls(files())).toEqual([r.file]);
  expect(r.manifest).toMatchObject({ format: 1, origin: before.origin, head: before.head, entries: before.head.seq, marking: "TLP:GREEN",
    lessons: { proposed: 1, accepted: 1, rejected: 0, retired: 0, superseded: 0 } });
  expect(canonical((await checkMemoryFile(r.path)) as unknown as Json)).toBe(canonical(r.manifest as unknown as Json));
  const into = join(dir, "check");
  await extractMemoryFile(r.path, into);
  expect(verifyMemory(into).ok).toBe(true);
  // the store: open, the same object or not, and unchanged
  expect(wb.memory.open).toBe(true);
  expect(storeView(wb)).toEqual(before);
  expect(held.open || wb.memory !== held).toBe(true);
  const last = wb.chain.read().at(-1)!;
  expect(last).toMatchObject({ type: "memory.exported", actor: person, payload: { file: r.file, origin: before.origin, head: before.head, lessons: 2 } });
  // a second export at the same head keeps the file there, and records the export again
  const again = await wb.exportMemory(files(), { actor: person });
  expect(again.file).toBe(r.file);
  expect(ls(files())).toEqual([r.file]);
  expect(typesOf(wb).filter((t) => t === "memory.exported")).toHaveLength(2);
  expect(errors).toEqual([]);
});

test("an empty store is not exported, and code may not export", async () => {
  expect(await refused(wb.exportMemory(files(), { actor: person }))).toBe("the memory store is empty; there is nothing to export");
  share(wb, "Check the lobby access point first");
  expect(await refused(wb.exportMemory(files(), { actor: code }))).toBe("only a person exports the memory store");
  expect(ls(files())).toEqual([]);
  expect(typesOf(wb)).not.toContain("memory.exported");
  // nor into the store's own folder
  expect(await refused(wb.exportMemory(join(dir, "wb", "memory", "out"), { actor: person }))).toContain("inside the memory store's folder");
});

test("loadMemory into an empty store makes it the file's store: same origin, head and lessons; memory.loaded is on the chain", async () => {
  share(wb, "Check the lobby access point first");
  share(wb, "Read the connection message before the lease");
  const { path, file } = await wb.exportMemory(files(), { actor: person });
  const b = another("b");
  const empty = b.memory.head();
  const r = await b.loadMemory(path, { actor: person });
  expect(r).toEqual({ origin: wb.memory.origin()!, head: wb.memory.head(), lessons: 2 });
  expect(b.memory.origin()).toBe(wb.memory.origin());
  expect(b.memory.head()).toEqual(wb.memory.head());
  expect(b.memory.state).toEqual(wb.memory.state);
  expect(b.chain.read().at(-1)).toMatchObject({ type: "memory.loaded", actor: person, payload: { file, origin: r.origin, head: r.head, before: empty } });
  expect(verifyMemory(join(dir, "b", "memory")).ok).toBe(true);
  // nothing is left beside the store
  expect(ls(join(dir, "b")).filter((n) => n.startsWith(".memory-"))).toEqual([]);
  // the loaded store takes new lessons
  share(b, "A third lesson");
  expect(b.memory.state.order).toEqual(["LESSON-1", "LESSON-2", "LESSON-3"]);
  // code may not load
  expect(await refused(another("c").loadMemory(path, { actor: code }))).toBe("only a person loads a memory store");
  expect(errors).toEqual([]);
});

test("loadMemory of this store further on replaces it; of the same head, of an older copy, of a diverged copy and of another store it is refused with its sentence and the store is what it was", async () => {
  share(wb, "Check the lobby access point first");
  const first = await wb.exportMemory(join(files(), "1"), { actor: person });
  const b = another("b");
  await b.loadMemory(first.path, { actor: person });
  share(wb, "Read the connection message before the lease");
  const second = await wb.exportMemory(join(files(), "2"), { actor: person });
  // further on: replaced
  const r = await b.loadMemory(second.path, { actor: person });
  expect(r.head).toEqual(wb.memory.head());
  expect(b.memory.state).toEqual(wb.memory.state);
  const hold = async (w: Workbench, file: string, says: string): Promise<void> => {
    const before = storeView(w);
    const chain = w.chain.head();
    expect(await refused(w.loadMemory(file, { actor: person }))).toBe(says);
    expect(storeView(w)).toEqual(before);
    expect(w.chain.head()).toEqual(chain);
    expect(ls(dirOf(w)).filter((n) => n.startsWith(".memory-"))).toEqual([]);
  };
  const dirOf = (w: Workbench): string => w.dataDir;
  // the same head
  await hold(b, second.path, "this memory store is already at the file's head");
  // an older copy
  await hold(b, first.path, "this workbench's memory store has entries the file does not hold; stores are not merged");
  // a diverged copy: b takes a lesson of its own, wb another
  share(b, "Only in b");
  share(wb, "Only in wb");
  const third = await wb.exportMemory(join(files(), "3"), { actor: person });
  await hold(b, third.path, "this workbench's memory store has entries the file does not hold; stores are not merged");
  // another store
  const c = another("c");
  share(c, "Check the lobby access point first");
  await hold(c, third.path, "this file is another workbench's memory store, and stores are not merged; to use it, start from an empty store");
  expect(errors).toEqual([]);
});

test("a file whose ledger was edited after packing, or whose memory.json counts a lesson its ledger does not hold, is refused and the store is what it was", async () => {
  share(wb, "Check the lobby access point first");
  const good = await wb.exportMemory(files(), { actor: person });
  const work = join(dir, "work");
  await extractMemoryFile(good.path, work);
  const header = { origin: good.manifest.origin, head: good.manifest.head, entries: good.manifest.entries, lessons: good.manifest.lessons, marking: good.manifest.marking, exported_ts: good.manifest.exported_ts };
  // memory.json counts a lesson more than the ledger holds; every member's hash is right
  const lie = join(dir, "lie.memory.tar.gz");
  await writeMemoryFile(work, lie, { ...header, lessons: { ...header.lessons, accepted: 2 } });
  // the ledger edited after packing: its text changed, the file re-hashed to match
  const db = new Database(join(work, "ledger.sqlite"));
  const row = db.query("SELECT seq, payload FROM entries WHERE type = 'lesson.proposed'").get() as { seq: number; payload: string };
  db.query("UPDATE entries SET payload = ? WHERE seq = ?").run(row.payload.replace("lobby", "attic"), row.seq);
  db.close();
  const edited = join(dir, "edited.memory.tar.gz");
  await writeMemoryFile(work, edited, header);
  const fresh = another("b2");
  for (const file of [lie, edited]) {
    const before = storeView(fresh);
    const msg = await refused(fresh.loadMemory(file, { actor: person }), MemoryFileError);
    expect(msg).toContain(file === lie ? "memory.json does not say what its ledger holds" : "does not verify");
    expect(storeView(fresh)).toEqual(before);
    expect(typesOf(fresh)).not.toContain("memory.loaded");
    expect(ls(join(dir, "b2")).filter((n) => n.startsWith(".memory-"))).toEqual([]);
  }
});

test("a load stopped between the two renames is repaired at the next open: the old store is back", async () => {
  share(wb, "Check the lobby access point first");
  const before = { origin: wb.memory.origin(), head: wb.memory.head() };
  wb.close();
  // the store renamed away, the extracted folder not yet in place
  const data = join(dir, "wb");
  renameSync(join(data, "memory"), join(data, ".memory-replaced-00000000-0000-4000-8000-000000000000"));
  mkdirSync(join(data, ".memory-loading-00000000-0000-4000-8000-000000000001"));
  wb = openWb();
  expect(ls(data).filter((n) => n.startsWith(".memory-"))).toEqual([]);
  expect({ origin: wb.memory.origin(), head: wb.memory.head() }).toEqual(before);
  expect(errors.map((e) => String((e as Error).message))).toEqual([
    expect.stringContaining("the memory store was put back"),
    expect.stringContaining("removed .memory-loading-00000000-0000-4000-8000-000000000001"),
  ]);
});

test("after a load, wb.memory is the loaded store and the old object refuses writes", async () => {
  share(wb, "Check the lobby access point first");
  const { path } = await wb.exportMemory(files(), { actor: person });
  const b = another("b");
  const old = b.memory;
  await b.loadMemory(path, { actor: person });
  expect(b.memory).not.toBe(old);
  expect(old.open).toBe(false);
  expect(() => old.propose(draft("Late"), { kind: "person" }, person)).toThrow("the memory store is closed");
  expect(b.memory.state.order).toEqual(["LESSON-1"]);
  expect(readFileSync(path).length).toBeGreaterThan(0);
});

test("while an export packs the store, the store is refused, and is open again once the file is written", async () => {
  share(wb, "Check the lobby access point first");
  const exporting = wb.exportMemory(files(), { actor: person });
  expect(() => wb.memory).toThrow("the memory store is being exported; try again when that is done");
  expect(await refused(wb.exportMemory(join(files(), "again"), { actor: person }))).toBe("the memory store is being exported; try again when that is done");
  await exporting;
  expect(wb.memory.open).toBe(true);
  expect(wb.memory.state.order).toEqual(["LESSON-1"]);
});

// ---------- final review I4: a store of untouched seed proposals takes a file ----------

/** Two seed proposals of the sample's kind, as compose files them on a first start. */
const seeds = (): SeedLesson[] => ["l1", "l2"].map((item) => ({
  manifest: "sample-seeds", item, hash: sha256Hex(item), case_type: "unknown-device", title: `Seed ${item}`,
  text: "A device seen only on AP-3 is usually a guest in the lobby.", triggers: [], marking: "TLP:GREEN", supersedes: null,
}));

test("a store holding only seed proposals no person has decided is replaced by a load, and memory.loaded.before is its head", async () => {
  fileSeeds(wb.memory, seeds());
  wb.memory.accept("LESSON-1", { actor: person, hash: wb.memory.state.lessons["LESSON-1"]!.hash });
  const made = await wb.exportMemory(join(files(), "1"), { actor: person });
  const b = another("b");
  fileSeeds(b.memory, seeds());
  const before = b.memory.head();
  expect(before.seq).toBe(2);
  const r = await b.loadMemory(made.path, { actor: person });
  expect(r.head).toEqual(wb.memory.head());
  expect(b.memory.origin()).toBe(wb.memory.origin());
  expect(b.memory.state).toEqual(wb.memory.state);
  const loaded = b.chain.read().filter((e) => e.type === "memory.loaded");
  expect(loaded.map((e) => e.payload)).toEqual([{ file: made.file, origin: wb.memory.origin()!, head: wb.memory.head(), before }]);
  expect(errors).toEqual([]);
});

test("a store of seeds a person has accepted, rejected or retired one of, or holding a proposal that is not a seed's, is not replaced: stores are not merged", async () => {
  share(wb, "Check the lobby access point first");
  const made = await wb.exportMemory(join(files(), "1"), { actor: person });
  const touched: [string, (w: Workbench) => void][] = [
    ["accepted", (w) => w.memory.accept("LESSON-1", { actor: person, hash: w.memory.state.lessons["LESSON-1"]!.hash })],
    ["rejected", (w) => w.memory.reject("LESSON-1", { actor: person, reason: "not here" })],
    ["retired", (w) => { w.memory.accept("LESSON-1", { actor: person, hash: w.memory.state.lessons["LESSON-1"]!.hash }); w.memory.retire("LESSON-1", { actor: person, reason: "old" }); }],
    ["a person's proposal", (w) => w.memory.propose(draft("A person's own"), { kind: "person" }, person)],
    ["a Feedback proposal", (w) => w.memory.propose(draft("From a case"), {
      kind: "case", case: "CASE-1", origin: "a".repeat(64), run: "run-1", head: { seq: 4, hash: "b".repeat(64) }, product: null, stage: "feedback", model: true,
    }, { kind: "system", id: "feedback" })],
  ];
  for (const [name, touch] of touched) {
    const o = another(`t-${name.replace(/[^a-z]/g, "")}`);
    fileSeeds(o.memory, seeds());
    touch(o);
    const before = { origin: o.memory.origin(), head: o.memory.head(), state: o.memory.state };
    expect(await refused(o.loadMemory(made.path, { actor: person })), name).toBe("this file is another workbench's memory store, and stores are not merged; to use it, start from an empty store");
    expect({ origin: o.memory.origin(), head: o.memory.head(), state: o.memory.state }, name).toEqual(before);
    expect(o.chain.read().some((e) => e.type === "memory.loaded"), name).toBe(false);
  }
});

// ---------- final review Minor 4: a blob no entry names ----------

test("a file holding a blob no entry of the store names is refused at load, and nothing of it lands in the store", async () => {
  share(wb, "Check the lobby access point first");
  const made = await wb.exportMemory(join(files(), "1"), { actor: person });
  const m = await checkMemoryFile(made.path);
  const src = join(dir, "junk-store");
  await extractMemoryFile(made.path, src);
  mkdirSync(join(src, "blobs"), { recursive: true });
  writeFileSync(join(src, "blobs", "junk.bin"), "junk");
  const junk = join(dir, "junk.memory.tar.gz");
  await writeMemoryFile(src, junk, { origin: m.origin, head: m.head, entries: m.entries, lessons: m.lessons, marking: m.marking, exported_ts: m.exported_ts });
  expect((await checkMemoryFile(junk)).files.map((f) => f.path)).toEqual(["blobs/junk.bin", "ledger.sqlite"]);
  const b = another("b");
  expect(await refused(b.loadMemory(junk, { actor: person }), MemoryFileError)).toBe("blobs/junk.bin is a blob no entry of the memory store names; this file cannot be loaded");
  expect(b.memory.head().seq).toBe(0);
  expect(ls(join(dir, "b", "memory", "blobs"))).toEqual([]);
  expect(ls(join(dir, "b")).filter((n) => n.startsWith(".memory-"))).toEqual([]);
});

test("a store whose ledger holds a seed's proposal written by a person (a ledger other code wrote) is not a store of untouched seeds", async () => {
  share(wb, "Check the lobby access point first");
  const made = await wb.exportMemory(join(files(), "1"), { actor: person });
  const o = another("raw");
  fileSeeds(o.memory, seeds());
  const ledger = Ledger.open(join(dir, "raw", "memory", "ledger.sqlite"), "memory");
  try {
    const [first] = ledger.read(0, 1);
    ledger.append({ type: "lesson.proposed", actor: person, payload: { ...(first!.payload as Payloads["lesson.proposed"]), lesson: "LESSON-3", title: "A seed by a person" } });
  } finally {
    ledger.close();
  }
  expect(o.memory.state.skipped.map((k) => k.reason)).toEqual(["a lesson's origin is recorded by who filed it"]);
  expect(await refused(o.loadMemory(made.path, { actor: person }))).toBe("this file is another workbench's memory store, and stores are not merged; to use it, start from an empty store");
});
