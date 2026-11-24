import type { Coverage, Cost } from "../../core/types";
import type { Json } from "../../core/canonical";
import type { TableManifest } from "../manifests";
import { ConnectorError } from "./types";
import type { QueryOutcome, QueryRequest } from "./types";

export type LocalSpec =
  | { kind: "sql"; path: string }                                   // resolved and checked to be inside the root by the connector
  | { kind: "files"; files: { table: TableManifest; path: string; file: string }[] };

const EMPTY_RESULT = new TextEncoder().encode('{"columns":[],"rows":[]}');
const CHILD = new URL("./local-child.ts", import.meta.url).pathname;

/**
 * Runs a local database's queries in a child process of their own, so that a slow query can neither hold the thread the server runs on nor
 * outlive its time limit: a native SQLite step cannot be interrupted in a thread, but a process can be killed. One query at a time, in the
 * order asked. A query with no answer by its `timeout_ms` has its whole process group killed and comes back as partial coverage, as the network
 * connectors report a timeout.
 */
export class LocalQueryHost {
  private tail: Promise<unknown> = Promise.resolve();
  private killCurrent: (() => void) | null = null;
  private closed = false;

  constructor(private readonly spec: LocalSpec) {}

  query(req: QueryRequest): Promise<QueryOutcome> {
    const run = this.tail.then(() => this.perform(req));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Kills the query that is running, if any; it is refused. Later queries start a new process. */
  close(): void {
    this.closed = true;
    this.killCurrent?.();
  }

  private async perform(req: QueryRequest): Promise<QueryOutcome> {
    this.closed = false;
    const proc = Bun.spawn([process.execPath, CHILD], {
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" }, stdin: "pipe", stdout: "pipe", stderr: "ignore", detached: true,
    });
    const kill = (): void => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { /* the group is gone */ }
      try { proc.kill("SIGKILL"); } catch { /* so is the process */ }
    };
    this.killCurrent = kill;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; kill(); }, req.timeout_ms);
    try {
      try {
        proc.stdin.write(JSON.stringify({ spec: this.spec, req }));
        void Promise.resolve(proc.stdin.end()).catch(() => {});
      } catch { /* a process that is gone is reported below */ }
      const text = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
      await proc.exited;
      if (timedOut) {
        return {
          columns: [], rows: [], raw: EMPTY_RESULT.slice(), media: "application/json", cost: null,
          coverage: { kind: "partial", reason: "timeout", detail: `no complete result within ${req.timeout_ms} ms` },
        };
      }
      if (this.closed) throw new ConnectorError("the connector was closed while a query was running");
      let reply: { ok: true; coverage: Coverage; media: string; cost: Cost | null; raw: string } | { ok: false; error: string; connector: boolean };
      try {
        reply = JSON.parse(text.trim().split("\n").pop() ?? "") as typeof reply;
      } catch {
        throw new ConnectorError("the local query process ended without an answer");
      }
      if (!reply.ok) throw reply.connector ? new ConnectorError(reply.error) : new Error(reply.error);
      const raw = new Uint8Array(Buffer.from(reply.raw, "base64"));
      const body = JSON.parse(new TextDecoder().decode(raw)) as { columns: string[]; rows: Json[][] };
      return { columns: body.columns, rows: body.rows, raw, media: reply.media, cost: reply.cost, coverage: reply.coverage };
    } finally {
      clearTimeout(timer);
      this.killCurrent = null;
      kill();
    }
  }
}
