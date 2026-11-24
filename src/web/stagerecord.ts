import type { BlobRef, Entry, Marking, PackItem, Where } from "../core/types";

export interface TurnRecord {
  request: string; seq: number; ts: string; actor: string; model: string; effort: string | null; where: Where; marking: Marking;
  pack: PackItem[]; left_out: PackItem[]; chars: number; messages: BlobRef;
  /** "answered" with the response; "declined" with the reason; "blocked"; "failed" (stop "error"); "interrupted" when no answer came before the run was interrupted or the ledger ends; "pending" while the run is live. */
  outcome: "answered" | "declined" | "blocked" | "failed" | "interrupted" | "pending";
  response: BlobRef | null; reasoning: BlobRef | null; served_by: string | null; reason: string | null;
  /** ok null: no tool.returned. `open` then says why: the run was interrupted, finished or began again since ("interrupted"), or it is still live ("pending"); null once it has returned. */
  calls: { call: string; tool: string; why: string; ok: boolean | null; summary: string | null; open: "interrupted" | "pending" | null }[];
}
export interface StageRecord {
  stage: string; attempts: number; turns: TurnRecord[];
  sendbacks: { from: string; to: string; reason: string; count: number; ts: string }[];
  blocked: { marking: Marking; model: string; where: Where; ts: string }[];
}

type Loose = Record<string, unknown>;
const obj = (x: unknown): Loose => (typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Loose) : {});
const text = (x: unknown): string => (typeof x === "string" ? x : "");
const blobOf = (x: unknown): BlobRef | null => { const o = obj(x); return typeof o.blob === "string" && typeof o.bytes === "number" ? (x as BlobRef) : null; };
const items = (x: unknown): PackItem[] => (Array.isArray(x) ? x.filter((i) => typeof obj(i).id === "string").map((i) => i as PackItem) : []);
/** These end whatever a run had open: nothing left open before them is going to be answered. */
const ENDS = new Set(["run.interrupted", "run.finished", "run.started"]);

/**
 * What one stage of the current run (from the latest run.started at or before `upTo`) asked its models and what came back, in the order asked.
 * Everything is read from the entries as recorded; a payload of an odd shape is read as loosely as the fold reads it and never throws.
 */
export function stageRecord(entries: readonly Entry[], stage: string, upTo?: number): StageRecord {
  const cut = entries.filter((e) => upTo === undefined || e.seq <= upTo);
  let from = 0;
  cut.forEach((e, i) => { if (e.type === "run.started") from = i; });
  const run = cut.slice(from);
  // the seq of the first entry after `seq` that ends an open request or call; Infinity when the run is still going
  const endedAt = (seq: number): number => run.find((e) => e.seq > seq && ENDS.has(e.type))?.seq ?? Number.POSITIVE_INFINITY;
  const record: StageRecord = { stage, attempts: 0, turns: [], sendbacks: [], blocked: [] };
  const turns = new Map<string, TurnRecord>();
  const calls = new Map<string, TurnRecord["calls"][number]>();

  for (const e of run) {
    const p = obj(e.payload);
    switch (e.type) {
      case "stage.started":
        if (p.stage === stage) record.attempts++;
        break;
      case "stage.sent_back":
        if (p.from === stage || p.to === stage) record.sendbacks.push({ from: text(p.from), to: text(p.to), reason: text(p.reason), count: typeof p.count === "number" ? p.count : 0, ts: e.ts });
        break;
      case "model.blocked":
        if (p.stage === stage) record.blocked.push({ marking: p.marking as Marking, model: text(p.model), where: p.where as Where, ts: e.ts });
        break;
      case "model.request": {
        const id = text(p.request);
        const messages = blobOf(p.messages);
        if (e.stage !== stage || id === "" || messages === null) break;
        const pack = items(p.pack);
        const turn: TurnRecord = {
          request: id, seq: e.seq, ts: e.ts, actor: e.actor.id, model: text(p.model), effort: typeof p.effort === "string" ? p.effort : null,
          where: p.where as Where, marking: p.marking as Marking, pack, left_out: items(p.left_out), chars: pack.reduce((n, i) => n + (typeof i.chars === "number" ? i.chars : 0), 0), messages,
          outcome: Number.isFinite(endedAt(e.seq)) ? "interrupted" : "pending", response: null, reasoning: null, served_by: null, reason: null, calls: [],
        };
        turns.set(id, turn);
        record.turns.push(turn);
        break;
      }
      case "model.response": {
        const turn = turns.get(text(p.request));
        if (turn === undefined) break;
        turn.response = blobOf(p.response);
        turn.reasoning = blobOf(p.reasoning);
        turn.served_by = text(p.served_by);
        turn.outcome = p.stop === "error" ? "failed" : "answered";
        break;
      }
      case "model.declined": {
        const turn = turns.get(text(p.request));
        if (turn === undefined) break;
        turn.outcome = "declined";
        turn.reason = text(p.reason);
        break;
      }
      case "tool.called": {
        const turn = turns.get(text(p.request));
        const call = text(p.call);
        if (turn === undefined || call === "") break;
        const open = Number.isFinite(endedAt(e.seq)) ? "interrupted" : "pending";
        const row = { call, tool: text(p.tool), why: text(p.why), ok: null, summary: null, open } as TurnRecord["calls"][number];
        calls.set(call, row);
        turn.calls.push(row);
        break;
      }
      case "tool.returned": {
        const row = calls.get(text(p.call));
        if (row === undefined) break;
        row.ok = p.ok === true;
        row.summary = text(p.summary);
        row.open = null;
        break;
      }
      default:
    }
  }
  return record;
}
