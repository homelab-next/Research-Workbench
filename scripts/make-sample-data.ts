// Writes the synthetic sample data: a small network with one planted story. Deterministic: seeded, never reads the clock.
// Only reserved addresses (RFC 5737) and example.com/.net/.org names appear, and every account and person is invented.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Observable, TimeWindow } from "../src/core/types";

export const SAMPLE_WINDOW: TimeWindow = { from: "2026-11-17T00:00:00.000Z", to: "2026-11-24T00:00:00.000Z" };
export const SAMPLE_START: Observable = { type: "address", value: "198.51.100.77" };

const SEED = 20261123;
const BEACON_FROM = "2026-11-20T03:20:00.000Z";
const BEACON_TARGET = "198.51.100.77";
const MINUTE = 60_000;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (ms: number): string => new Date(ms).toISOString();

interface Host { address: string; asset: string; owner: string; role: string }
const OWNERS = ["Avery Quill", "Blair Mott", "Casey Fenn", "Drew Hale", "Ellis Penn", "Finley Rowe", "Gray Vale", "Harper Linden", "Indigo Marsh", "Jules Ashby", "Kit Wren"];

function hosts(): Host[] {
  const out: Host[] = [];
  for (let n = 10; n <= 30; n++) {
    const workstation = n < 20;
    out.push({
      address: `192.0.2.${n}`, asset: `${workstation ? "ws" : "srv"}-${n}.example.net`,
      owner: workstation ? OWNERS[n - 10]! : "Infrastructure Team", role: workstation ? "workstation" : "server",
    });
  }
  return out;
}

const ACCOUNTS: { account: string; host: string }[] = [
  { account: "j.doe", host: "ws-17.example.net" },
  { account: "a.smith", host: "ws-12.example.net" },
  { account: "m.jones", host: "ws-14.example.net" },
  { account: "r.patel", host: "ws-11.example.net" },
  { account: "k.lee", host: "ws-19.example.net" },
];
const SERVICES = ["203.0.113.10", "203.0.113.20", "203.0.113.30", "203.0.113.40"];
const NAMES = ["www", "mail", "files", "wiki", "chat", "intranet", "updates", "time", "print", "git"].map(l => `${l}.example.com`);
const DPORTS = [22, 53, 80, 443, 443, 443, 445, 8080];

const jsonl = (rows: object[]): string => rows.map(r => JSON.stringify(r)).join("\n") + "\n";
const csvText = (header: string[], rows: string[][]): string => [header, ...rows].map(r => r.join(",")).join("\n") + "\n";

export function makeSampleData(dir: string): void {
  mkdirSync(dir, { recursive: true });
  const rand = mulberry32(SEED);
  const int = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const t0 = Date.parse(SAMPLE_WINDOW.from!);
  const t1 = Date.parse(SAMPLE_WINDOW.to!);
  const all = hosts();
  const nameAnswer = new Map(NAMES.map((n, i) => [n, SERVICES[i % SERVICES.length]!]));

  // flows
  const flows: { ts: string; src: string; dst: string; dport: number; bytes: number }[] = [];
  for (let i = 0; i < 3000; i++) {
    const src = pick(all).address;
    let dst = rand() < 0.35 ? pick(all).address : pick(SERVICES);
    if (dst === src) dst = pick(SERVICES);
    flows.push({ ts: iso(t0 + Math.floor(rand() * (t1 - t0))), src, dst, dport: pick(DPORTS), bytes: int(200, 90000) });
  }
  for (let t = Date.parse(BEACON_FROM); t < t1; t += 10 * MINUTE) {
    flows.push({ ts: iso(t), src: "192.0.2.17", dst: BEACON_TARGET, dport: 443, bytes: int(480, 520) });
  }
  flows.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const dbPath = join(dir, "flows.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });
  const db = new Database(dbPath, { create: true });
  try {
    db.run("create table flows (ts text, src text, dst text, dport integer, bytes integer)");
    db.run("create index flows_dst on flows (dst)");
    const insert = db.prepare("insert into flows values (?, ?, ?, ?, ?)");
    db.transaction(() => { for (const f of flows) insert.run(f.ts, f.src, f.dst, f.dport, f.bytes); })();
  } finally {
    db.close();
  }

  // dns: routine lookups, duplicated by the resolver on 2026-11-18 and 2026-11-19, plus the planted lookups
  const dns: { ts: string; client: string; name: string; answer: string }[] = [];
  const dupFrom = Date.parse("2026-11-18T00:00:00.000Z");
  const dupTo = Date.parse("2026-11-20T00:00:00.000Z");
  for (let i = 0; i < 1500; i++) {
    const t = t0 + Math.floor(rand() * (t1 - t0));
    const name = pick(NAMES);
    const row = { ts: iso(t), client: pick(all).address, name, answer: nameAnswer.get(name)! };
    dns.push(row);
    if (t >= dupFrom && t < dupTo) dns.push({ ...row });
  }
  for (let t = Date.parse("2026-11-20T03:16:00.000Z"); t < t1; t += 6 * 60 * MINUTE) {
    dns.push({ ts: iso(t), client: "192.0.2.17", name: "cdn-update.example.org", answer: BEACON_TARGET });
  }
  dns.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  writeFileSync(join(dir, "dns.jsonl"), jsonl(dns));

  // sign-ins: weekday working hours from each person's own workstation, plus the one from an address never used
  const signins: { ts: string; account: string; host: string; from_address: string; result: string }[] = [];
  const addressOf = new Map(all.map(h => [h.asset, h.address]));
  for (let day = 0; day < 7; day++) {
    for (const a of ACCOUNTS) {
      const t = t0 + day * 24 * 60 * MINUTE + int(8 * 60, 17 * 60) * MINUTE + int(0, 59) * 1000;
      signins.push({ ts: iso(t), account: a.account, host: a.host, from_address: addressOf.get(a.host)!, result: rand() < 0.1 ? "failure" : "success" });
    }
  }
  signins.push({ ts: "2026-11-20T03:12:00.000Z", account: "j.doe", host: "ws-17.example.net", from_address: "203.0.113.50", result: "success" });
  signins.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  writeFileSync(join(dir, "signins.jsonl"), jsonl(signins));

  // assets: every internal host, so absence is proof; leases: deliberately missing 192.0.2.17
  writeFileSync(join(dir, "assets.csv"), csvText(["asset", "address", "owner", "role"], all.map(h => [h.asset, h.address, h.owner, h.role])));
  writeFileSync(join(dir, "leases.csv"), csvText(["address", "asset", "since"], all.filter(h => h.address !== "192.0.2.17").map((h, i) => [h.address, h.asset, `2026-0${1 + (i % 9)}-0${1 + (i % 8)}`])));

  const reputation: Record<string, { verdict: string; first_seen: string }> = { [BEACON_TARGET]: { verdict: "suspicious", first_seen: "2026-11-19" } };
  for (const s of SERVICES) reputation[s] = { verdict: "benign", first_seen: "2025-03-02" };
  writeFileSync(join(dir, "reputation.json"), JSON.stringify(reputation, null, 2) + "\n");
}

/** Generates the data only when flows.sqlite is missing. */
export function ensureSampleData(sampleRoot: string): void {
  if (!existsSync(join(sampleRoot, "data", "flows.sqlite"))) makeSampleData(join(sampleRoot, "data"));
}

if (import.meta.main) {
  const out = resolve(import.meta.dir, "..", "sample", "data");
  makeSampleData(out);
  console.log(`sample data written to ${out}`);
}
