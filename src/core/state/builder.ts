// The fold for a builder session (slice 12, part B): the changes the builder proposed, the probes it asked for, and the person's decisions on
// each. Browser-safe: no runtime imports but the shared shape checks. A case's ledger holds none of these entries and folds an empty state.
import { PROBE_KINDS, PROBE_OUTCOMES, strictest } from "../types";
import type { Entry, Marking, Payloads, ProposedFile } from "../types";
import { has, isBool, isObj, isOneOf, isStr, isStrOrNull, malformed, recordSkip } from "./guards";
import { isBlobRefShape, isCount, isObservable, isTimeWindow } from "./shapes";
import type { BuilderChange, BuilderProbe, BuilderState, CaseState } from "./types";

export function initialBuilder(): BuilderState {
  return { changes: {}, probes: {} };
}

const HASH = /^[0-9a-f]{64}$/;
const isHash = (x: unknown): x is string => isStr(x) && HASH.test(x);
const isId = (x: unknown): x is string => isStr(x) && x !== "";
const isFile = (x: unknown): x is ProposedFile =>
  isObj(x) && isId(x.path) && isId(x.kind) && isId(x.id) && (x.before === null || isHash(x.before)) && isHash(x.after);

const isProposed = (x: unknown): x is Payloads["builder.proposed"] =>
  isObj(x) && isStr(x.change) && /^chg-[1-9][0-9]*$/.test(x.change) && isStr(x.title) && isStr(x.why) && isId(x.root)
  && Array.isArray(x.files) && x.files.length > 0 && x.files.every(isFile) && isBlobRefShape(x.bundle);
/** A rejection writes nothing; an acceptance names the hash it wrote. */
const isDecided = (x: unknown): x is Payloads["builder.decided"] =>
  isObj(x) && isStr(x.change) && isCount(x.file) && isBool(x.accepted) && (x.accepted ? isHash(x.written) : x.written === null);
/** A pivot probe names a pivot and a value and no text; a query probe names text and neither. */
const isAsked = (x: unknown): x is Payloads["builder.probe_asked"] =>
  isObj(x) && isStr(x.probe) && /^probe-[1-9][0-9]*$/.test(x.probe) && isOneOf(x.kind, PROBE_KINDS) && isId(x.source) && isTimeWindow(x.window) && isStr(x.why)
  && (x.kind === "pivot" ? isId(x.pivot) && isObservable(x.value) && x.text === null : x.pivot === null && x.value === null && isId(x.text));
/** A person who rejected it sent nothing; one who approved it either ran it or met a refusal. */
const isProbeDecided = (x: unknown): x is Payloads["builder.probe_decided"] =>
  isObj(x) && isStr(x.probe) && isBool(x.approved) && isStrOrNull(x.query) && isOneOf(x.outcome, PROBE_OUTCOMES) && isStr(x.detail)
  && (x.approved ? x.outcome !== "rejected" && (x.outcome === "refused" || x.query !== null) : x.outcome === "rejected" && x.query === null);

const withBuilder = (s: CaseState, b: Partial<BuilderState>): CaseState => ({ ...s, builder: { ...s.builder, ...b } });

/**
 * builder.proposed and builder.probe_asked, from the builder agent or a person; builder.decided and builder.probe_decided, from a person only.
 * Nothing here changes the cards, the run or the counters: a probe's card is a card.created entry of its own.
 */
export function applyBuilder(s: CaseState, entry: Entry): CaseState {
  switch (entry.type) {
    case "builder.proposed": {
      const p = entry.payload as unknown;
      if (!isProposed(p)) return malformed(s, entry);
      if (entry.actor.kind === "system") return recordSkip(s, entry, "a change is proposed by the builder or a person");
      if (has(s.builder.changes, p.change)) return recordSkip(s, entry, "a change is proposed once");
      const change: BuilderChange = {
        id: p.change, title: p.title, why: p.why, root: p.root,
        files: p.files.map((f) => ({ path: f.path, kind: f.kind, id: f.id, before: f.before, after: f.after, decided: null })),
        bundle: p.bundle.media === undefined ? { blob: p.bundle.blob, bytes: p.bundle.bytes } : { blob: p.bundle.blob, bytes: p.bundle.bytes, media: p.bundle.media },
        by: entry.actor.id, seq: entry.seq,
      };
      return withBuilder(s, { changes: { ...s.builder.changes, [p.change]: change } });
    }
    case "builder.decided": {
      const p = entry.payload as unknown;
      if (!isDecided(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, "a change is decided by a person");
      if (!has(s.builder.changes, p.change)) return recordSkip(s, entry, "a decision names a change that was proposed");
      const change = s.builder.changes[p.change]!;
      if (p.file >= change.files.length) return recordSkip(s, entry, "a decision names a file of the change");
      if (change.files[p.file]!.decided !== null) return recordSkip(s, entry, "a file of a change is decided once");
      const decided = { accepted: p.accepted, written: p.written, by: entry.actor.id, seq: entry.seq };
      const files = change.files.map((f, i) => (i === p.file ? { ...f, decided } : f));
      return withBuilder(s, { changes: { ...s.builder.changes, [p.change]: { ...change, files } } });
    }
    case "builder.probe_asked": {
      const p = entry.payload as unknown;
      if (!isAsked(p)) return malformed(s, entry);
      if (entry.actor.kind === "system") return recordSkip(s, entry, "a probe is asked for by the builder or a person");
      if (has(s.builder.probes, p.probe)) return recordSkip(s, entry, "a probe is asked for once");
      const probe: BuilderProbe = {
        id: p.probe, kind: p.kind, source: p.source, pivot: p.pivot, value: p.value === null ? null : { type: p.value.type, value: p.value.value }, text: p.text,
        window: { from: p.window.from, to: p.window.to }, why: p.why, by: entry.actor.id, seq: entry.seq, decided: null,
      };
      return withBuilder(s, { probes: { ...s.builder.probes, [p.probe]: probe } });
    }
    case "builder.probe_decided": {
      const p = entry.payload as unknown;
      if (!isProbeDecided(p)) return malformed(s, entry);
      if (entry.actor.kind !== "human") return recordSkip(s, entry, "a probe is decided by a person");
      if (!has(s.builder.probes, p.probe)) return recordSkip(s, entry, "a decision names a probe that was asked for");
      const probe = s.builder.probes[p.probe]!;
      if (probe.decided !== null) return recordSkip(s, entry, "a probe is decided once");
      const decided = { approved: p.approved, query: p.query, outcome: p.outcome, detail: p.detail, by: entry.actor.id, seq: entry.seq };
      return withBuilder(s, { probes: { ...s.builder.probes, [p.probe]: { ...probe, decided } } });
    }
    default:
      return s;
  }
}

/** The session's marking: the strictest of its starting marking and of every card it holds. With no case.created, the strictest there is. */
export function builderMarking(state: Readonly<CaseState>): Marking {
  return strictest(state.meta?.marking, ...Object.values(state.cards).map((c) => c.marking));
}

/** Changes with a file not yet decided, and probes not yet decided, oldest first. */
export function builderOpen(state: Readonly<CaseState>): { changes: BuilderChange[]; probes: BuilderProbe[] } {
  const changes = Object.values(state.builder.changes).filter((c) => c.files.some((f) => f.decided === null)).sort((a, b) => a.seq - b.seq);
  const probes = Object.values(state.builder.probes).filter((p) => p.decided === null).sort((a, b) => a.seq - b.seq);
  return { changes, probes };
}
