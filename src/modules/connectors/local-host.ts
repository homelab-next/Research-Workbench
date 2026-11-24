import type { TableManifest } from "../manifests";
import { ConnectorError } from "./types";
import type { QueryOutcome, QueryRequest } from "./types";

export type LocalSpec =
  | { kind: "sql"; path: string }                                   // resolved and checked to be inside the root by the connector
  | { kind: "files"; files: { table: TableManifest; path: string; file: string }[] };

/** What the worker posts back for one request. */
export type WorkerReply =
  | { id: number; outcome: QueryOutcome; notes: string[] }
  | { id: number; error: string; connector: boolean };

const EMPTY_RESULT = new TextEncoder().encode('{"columns":[],"rows":[]}');

/**
 * Runs a local database's queries in a worker, so that a slow query cannot hold the thread the server runs on. One request at a time, in the
 * order asked. A query that has not answered by its `timeout_ms` has its worker ended and dropped (the next query starts a new one) and comes
 * back as partial coverage, as the network connectors report a timeout.
 */
export class LocalQueryHost {
  private worker: Worker | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private nextId = 1;
  private abandon: ((err: Error) => void) | null = null;

  constructor(private readonly spec: LocalSpec) {}

  query(req: QueryRequest): Promise<QueryOutcome> {
    const run = this.tail.then(() => this.post(req));
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Ends the worker. A query still waiting is refused. */
  close(): void {
    this.drop();
    const abandon = this.abandon;
    this.abandon = null;
    abandon?.(new ConnectorError("the connector was closed while a query was running"));
  }

  private drop(): void {
    const w = this.worker;
    this.worker = null;
    if (w !== null) { try { w.terminate(); } catch { /* already gone */ } }
  }

  private start(): Worker {
    const w = new Worker(new URL("./local-worker.ts", import.meta.url).href);
    (w as unknown as { unref(): void }).unref();
    return w;
  }

  private post(req: QueryRequest): Promise<QueryOutcome> {
    return new Promise<QueryOutcome>((resolve, reject) => {
      const worker = this.worker ??= this.start();
      const id = this.nextId++;
      let settled = false;
      const done = (settle: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.abandon = null;
        worker.onmessage = null;
        worker.onerror = null;
        settle();
      };
      const timer = setTimeout(() => {
        // the worker is still inside the query: it is ended, and the next query starts a new one
        if (this.worker === worker) this.drop(); else { try { worker.terminate(); } catch { /* gone */ } }
        done(() => resolve({
          columns: [], rows: [], raw: EMPTY_RESULT.slice(), media: "application/json", cost: null,
          coverage: { kind: "partial", reason: "timeout", detail: `no complete result within ${req.timeout_ms} ms` },
        }));
      }, req.timeout_ms);
      this.abandon = (err) => done(() => reject(err));
      worker.onmessage = (ev: MessageEvent<WorkerReply>): void => {
        const reply = ev.data;
        if (reply.id !== id) return;
        done(() => {
          if ("error" in reply) reject(reply.connector ? new ConnectorError(reply.error) : new Error(reply.error));
          else resolve(reply.outcome);
        });
      };
      worker.onerror = (ev: ErrorEvent): void => {
        if (this.worker === worker) this.drop();
        done(() => reject(new ConnectorError(`the local query worker failed: ${String(ev.message ?? "unknown error").split("\n")[0]}`)));
      };
      try {
        worker.postMessage({ id, spec: this.spec, req });
      } catch (err) {
        if (this.worker === worker) this.drop();
        done(() => reject(new ConnectorError(`the query could not be sent to the worker: ${(err as Error).message}`)));
      }
    });
  }
}
