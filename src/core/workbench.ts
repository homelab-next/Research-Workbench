import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BlobStore } from "./blobs";
import { Ledger } from "./ledger";
import { CaseSession } from "./session";
import type { RunState } from "./state";
import type { Actor, Marking, Observable, Window } from "./types";

export class CaseNotFoundError extends Error {
  constructor(id: string) {
    super(`case ${id} not found`);
    this.name = "CaseNotFoundError";
  }
}

export interface NewCase { title: string; asked: string; why: string; starting: Observable[]; window: Window; objective: string | null; marking: Marking }
export interface CaseSummary { id: string; title: string; marking: Marking; created_ts: string; run_status: RunState["status"]; phase: string | null; incoming: number; kept: number }

const CASE_ID = /^CASE-[1-9][0-9]*$/;

export class Workbench {
  readonly dataDir: string;
  readonly chain: Ledger;
  private readonly now: (() => string) | undefined;
  private readonly sessions: Record<string, CaseSession> = Object.create(null) as Record<string, CaseSession>;

  private constructor(dataDir: string, chain: Ledger, now: (() => string) | undefined) {
    this.dataDir = dataDir;
    this.chain = chain;
    this.now = now;
  }

  static open(dataDir: string, opts: { now?: () => string } = {}): Workbench {
    mkdirSync(join(dataDir, "cases"), { recursive: true });
    mkdirSync(join(dataDir, "blobs"), { recursive: true });
    const chain = Ledger.open(join(dataDir, "workbench.sqlite"), "workbench", opts.now ? { now: opts.now } : {});
    return new Workbench(dataDir, chain, opts.now);
  }

  createCase(input: NewCase, actor: Actor): CaseSession {
    const id = `CASE-${this.nextNumber()}`;
    const session = this.load(id, true);
    try {
      session.commit(() => [{ type: "case.created", payload: { id, ...input }, actor }]);
    } catch (err) {
      delete this.sessions[id];
      throw err;
    }
    return session;
  }

  session(id: string): CaseSession {
    if (typeof id !== "string" || !CASE_ID.test(id)) throw new CaseNotFoundError(String(id));
    if (Object.hasOwn(this.sessions, id)) return this.sessions[id]!;
    if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) throw new CaseNotFoundError(id);
    return this.load(id, false);
  }

  listCases(): CaseSummary[] {
    const ids = this.caseNumbers().sort((a, b) => b - a).map((n) => `CASE-${n}`);
    const out: CaseSummary[] = [];
    for (const id of ids) {
      if (!existsSync(join(this.dataDir, "cases", id, "ledger.sqlite"))) continue;
      const s = this.session(id).state;
      if (s.meta === null) continue;
      out.push({
        id,
        title: s.meta.title,
        marking: s.meta.marking,
        created_ts: this.session(id).entries(0)[0]?.ts ?? "",
        run_status: s.run.status,
        phase: s.phase,
        incoming: s.incoming.length,
        kept: s.lanes.reduce((n, l) => n + l.cards.length, 0),
      });
    }
    return out;
  }

  close(): void {
    for (const s of Object.values(this.sessions)) s.close();
    for (const id of Object.keys(this.sessions)) delete this.sessions[id];
    this.chain.close();
  }

  private load(id: string, create: boolean): CaseSession {
    const dir = join(this.dataDir, "cases", id);
    if (create) mkdirSync(join(dir, "published"), { recursive: true });
    const ledger = Ledger.open(join(dir, "ledger.sqlite"), id, this.now ? { now: this.now } : {});
    const session = new CaseSession({ id, dir, ledger, blobs: new BlobStore(join(dir, "blobs")) });
    this.sessions[id] = session;
    return session;
  }

  private caseNumbers(): number[] {
    const dir = join(this.dataDir, "cases");
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter((n) => CASE_ID.test(n)).map((n) => Number(n.slice(5)));
  }

  private nextNumber(): number {
    return Math.max(0, ...this.caseNumbers()) + 1;
  }
}
