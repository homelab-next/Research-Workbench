import type { Json } from "../../core/canonical";
import type { Coverage, Cost, TimeWindow } from "../../core/types";
import type { Observables } from "../observables";
import type { Secrets } from "../secrets";

export type Bound = Record<string, string | number | null>;

export interface QueryRequest {
  text: string;
  bound: Bound;
  window: TimeWindow;
  max_rows: number;
  timeout_ms: number;
  budget: number | null;
}

export interface QueryOutcome {
  columns: string[];
  rows: Json[][];
  raw: Uint8Array;
  media: string;
  coverage: Coverage;
  cost: Cost | null;
}

/**
 * A source's connector. Only the runner calls run, estimate and estimateRequest, so every contact is in the record.
 * `budget` on a request is in the source's cost unit; a connector that can count in that unit stops at it.
 */
export interface Connector {
  readonly kind: "sql" | "files" | "http" | "trino";
  render(req: QueryRequest): string;
  /** A cost known without contacting the source (a fixed price per request), or null. Never contacts anything. */
  estimate(req: QueryRequest): Promise<Cost | null>;
  /** When pricing the query means asking the source, the request that asks it; the runner issues it as a query. Else null. */
  estimateRequest(req: QueryRequest): QueryRequest | null;
  /** The cost read from the outcome of estimateRequest's query, or null when it says none. */
  readEstimate(outcome: QueryOutcome): Cost | null;
  run(req: QueryRequest): Promise<QueryOutcome>;
  close(): void;
}

export interface ConnectorContext {
  secrets: Secrets;
  observables: Observables;
  /** `host:port` of this workbench's own server, asked each time: a source may not point at it. */
  refuse_hosts?: () => readonly string[];
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const MIN_TS = "0001-01-01T00:00:00.000Z";
export const MAX_TS = "9999-12-31T23:59:59.999Z";
