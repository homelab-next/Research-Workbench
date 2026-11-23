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

export interface Connector {
  readonly kind: "sql" | "files" | "http" | "trino";
  render(req: QueryRequest): string;
  estimate(req: QueryRequest): Promise<Cost | null>;
  run(req: QueryRequest): Promise<QueryOutcome>;
  close(): void;
}

export interface ConnectorContext {
  secrets: Secrets;
  observables: Observables;
}

export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

export const MIN_TS = "0001-01-01T00:00:00.000Z";
export const MAX_TS = "9999-12-31T23:59:59.999Z";
