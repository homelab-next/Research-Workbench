import type { SourceManifest } from "../manifests";
import { FilesConnector } from "./files";
import { HttpConnector } from "./http";
import { SqliteConnector } from "./sqlite";
import { TrinoConnector } from "./trino";
import { ConnectorError } from "./types";
import type { Connector, ConnectorContext } from "./types";

const FACTORIES: Partial<Record<SourceManifest["connector"], (s: SourceManifest, c: ConnectorContext) => Connector>> = {
  sql: (s, c) => new SqliteConnector(s, c),
  files: (s, c) => new FilesConnector(s, c),
  http: (s, c) => new HttpConnector(s, c),
  trino: (s, c) => new TrinoConnector(s, c),
};

export function makeConnector(source: SourceManifest, ctx: ConnectorContext): Connector {
  const factory = FACTORIES[source.connector];
  if (factory === undefined) throw new ConnectorError(`unknown connector kind: ${source.connector}`);
  return factory(source, ctx);
}

/** One connector per source id, rebuilt when the source's hash changes. */
export class ConnectorPool {
  private readonly pool = new Map<string, { hash: string; connector: Connector }>();

  constructor(private readonly ctx: ConnectorContext) {}

  for(source: SourceManifest): Connector {
    const have = this.pool.get(source.id);
    if (have !== undefined && have.hash === source.hash) return have.connector;
    have?.connector.close();
    const connector = makeConnector(source, this.ctx);
    this.pool.set(source.id, { hash: source.hash, connector });
    return connector;
  }

  closeAll(): void {
    for (const { connector } of this.pool.values()) connector.close();
    this.pool.clear();
  }
}

export * from "./types";
export { placeholders, effectiveBound } from "./placeholders";
export { isUtcTimestamp } from "./shared";
