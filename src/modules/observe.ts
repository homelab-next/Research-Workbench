// What a pivot's result observed: the values it found and when, read once from every row (design 6b §5.2-§5.4).
import type { Json } from "../core/canonical";
import { MAX_POINTS, MAX_SIGHTINGS } from "../core/types";
import type { Observed, Sighting, Span } from "../core/types";
import type { PivotManifest } from "./manifests";
import type { Observables } from "./observables";

export { MAX_POINTS, MAX_SIGHTINGS };

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;
const SPACED = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?: ?(UTC|Z|[+-]\d{2}:\d{2}))?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NORMAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The instant a cell names, in epoch milliseconds, or null. Fields must round-trip, so 30 February and hour 25 are refused. */
function readInstant(v: Json): number | null {
  if (typeof v !== "string") return null;
  const m = ISO.exec(v) ?? SPACED.exec(v);
  const d = m === null ? DATE.exec(v) : null;
  if (m === null && d === null) return null;
  const f = (m ?? d)!;
  const [y, mo, day] = [Number(f[1]), Number(f[2]), Number(f[3])];
  const [h, mi, s] = m === null ? [0, 0, 0] : [Number(m[4]), Number(m[5]), Number(m[6])];
  const ms = m === null || m[7] === undefined ? 0 : Number(m[7].slice(0, 3).padEnd(3, "0"));
  const at = new Date(Date.UTC(y, mo - 1, day, h, mi, s, ms));
  at.setUTCFullYear(y, mo - 1, day); // Date.UTC reads years 0-99 as 1900-1999
  if (at.getUTCFullYear() !== y || at.getUTCMonth() !== mo - 1 || at.getUTCDate() !== day || at.getUTCHours() !== h || at.getUTCMinutes() !== mi || at.getUTCSeconds() !== s) return null;
  const zone = m === null ? undefined : m[8];
  let offset = 0;
  if (zone !== undefined && zone !== "Z" && zone !== "UTC") {
    const oh = Number(zone.slice(1, 3));
    const om = Number(zone.slice(4, 6));
    if (oh > 23 || om > 59) return null;
    offset = (zone[0] === "-" ? -1 : 1) * (oh * 60 + om) * 60000;
  }
  const t = at.getTime() - offset;
  if (!Number.isFinite(t) || Math.abs(t) > 8.64e15) return null;
  return NORMAL.test(new Date(t).toISOString()) ? t : null;
}

/** A cell as a UTC timestamp with milliseconds, by the three forms of design §5.2; null for anything else. */
export function readTime(v: Json): string | null {
  const t = readInstant(v);
  return t === null ? null : new Date(t).toISOString();
}

/** A count cell: a whole non-negative number, or a string of digits that is one; null for anything else. */
function readCount(v: Json): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** A merge of rows: earliest first, latest last, summed count (unknown once any row's is), and the count at each time. */
interface Acc { first: number | null; last: number | null; count: number | null; rows: number; at: Map<number, number> | null }
const acc = (points: boolean): Acc => ({ first: null, last: null, count: 0, rows: 0, at: points ? new Map() : null });

/** What one row says: when (a span, a point, or nothing readable) and how many times. */
interface RowTime { first: number | null; last: number | null; count: number | null }

/** A point's count past the safe integers is held at the largest one, so one source-controlled count cannot make the card malformed. */
const capped = (n: number): number => Math.min(n, Number.MAX_SAFE_INTEGER);

function add(a: Acc, r: RowTime): void {
  a.rows++;
  const sum = a.count === null || r.count === null ? null : a.count + r.count;
  a.count = sum !== null && Number.isSafeInteger(sum) ? sum : null;
  if (r.first === null || r.last === null) return;
  if (a.first === null || r.first < a.first) a.first = r.first;
  if (a.last === null || r.last > a.last) a.last = r.last;
  if (a.at !== null && r.count !== null) a.at.set(r.first, capped((a.at.get(r.first) ?? 0) + r.count));
}

const iso = (t: number | null): string | null => (t === null ? null : new Date(t).toISOString());

function spanOf(a: Acc): Span {
  return { first: iso(a.first), last: iso(a.last), count: a.rows === 0 ? null : a.count };
}

/** The points of a sighting in time order; more than MAX_POINTS distinct times are merged into equal slices of its own span. */
function pointsOf(a: Acc): [string, number][] {
  if (a.at === null || a.first === null || a.last === null) return [];
  const times = [...a.at.keys()].sort((x, y) => x - y);
  if (times.length <= MAX_POINTS) return times.map((t) => [new Date(t).toISOString(), a.at!.get(t)!]);
  const first = a.first;
  const width = a.last - first + 1;
  const slice = (t: number): number => Math.min(MAX_POINTS - 1, Math.floor(((t - first) * MAX_POINTS) / width));
  const startOf = (i: number): number => first + Math.floor((i * width) / MAX_POINTS);
  const sums = new Map<number, number>();
  for (const t of times) sums.set(slice(t), capped((sums.get(slice(t)) ?? 0) + a.at.get(t)!));
  return [...sums.keys()].sort((x, y) => x - y).map((i) => [new Date(startOf(i)).toISOString(), sums.get(i)!]);
}

/** What a pivot's result observed, from every row (design §5.3, §5.4). */
export function observe(pivot: PivotManifest, value: string, columns: string[], rows: Json[][], observables: Observables): Observed {
  const t = pivot.times;
  const col = (name: string | null): number => (name === null ? -2 : columns.indexOf(name));
  const [firstCol, lastCol] = t === null ? [-2, -2] : t.kind === "span" ? [col(t.first), col(t.last)] : [col(t.at), col(t.at)];
  const countCol = t === null ? -2 : col(t.count);
  const yieldCols = columns.flatMap((c, i) => (Object.hasOwn(pivot.yields, c) ? [{ i, type: pivot.yields[c]! }] : []));
  const points = t?.kind === "points";

  const span = acc(points);
  const found = new Map<string, { type: string; value: string; acc: Acc }>();
  let more = 0;
  let unread = 0;
  for (const raw of rows) {
    const row: Json[] = Array.isArray(raw) ? raw : [];
    let rt: RowTime = { first: null, last: null, count: null };
    if (t !== null) {
      const first = firstCol < 0 ? null : readInstant(row[firstCol] ?? null);
      const last = lastCol < 0 ? null : readInstant(row[lastCol] ?? null);
      const count = t.count === null ? (points ? 1 : null) : countCol < 0 ? null : readCount(row[countCol] ?? null);
      if (first === null || last === null || first > last) unread++;
      else rt = { first, last, count };
      rt.count = count;
    }
    add(span, rt);
    const inRow = new Set<string>();
    for (const { i, type } of yieldCols) {
      const v = row[i];
      if (typeof v !== "string" || !observables.matches(type, v)) continue;
      const key = `${type}|${v}`;
      if (inRow.has(key)) continue;
      inRow.add(key);
      let f = found.get(key);
      if (f === undefined) {
        if (found.size >= MAX_SIGHTINGS) { more++; found.set(key, { type, value: v, acc: acc(points) }); continue; }
        f = { type, value: v, acc: acc(points) };
        found.set(key, f);
      }
      add(f.acc, rt);
    }
  }
  const listed: Sighting[] = [...found.values()].slice(0, MAX_SIGHTINGS).map((f) => ({ type: f.type, value: f.value, ...spanOf(f.acc), points: pointsOf(f.acc) }));
  return { pivot: pivot.id, from: { type: pivot.from, value }, span: spanOf(span), found: listed, more, unread };
}
