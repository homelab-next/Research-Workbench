import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeSampleData } from "../../scripts/make-sample-data";
import { ConnectorPool } from "../../src/modules/connectors";
import { Observables } from "../../src/modules/observables";
import { Registry } from "../../src/modules/registry";
import { loadRegistry } from "../../src/modules/registry-record";
import type { RunnerDeps } from "../../src/modules/runner";
import { Secrets } from "../../src/modules/secrets";
import { cheapestSeeker } from "../../src/modules/seeker";
import type { Seeker } from "../../src/modules/seeker";
import { startReputationFixture } from "../../sample/fixture/reputation-server";

const REPO_SAMPLE = join(import.meta.dir, "..", "..", "sample");

/** A copy of the sample's manifests (without data/ and fixture/). */
export function copySample(into: string): void {
  cpSync(REPO_SAMPLE, into, { recursive: true, filter: (p) => !/[\\/]sample[\\/](?:data|fixture)(?:[\\/]|$)/.test(p) });
}

/** The sample as a trusted root in `dir`: data generated, reputation fixture running on 127.0.0.1, registry loaded. */
export function sampleRoot(dir: string): {
  root: string; registry: Registry; deps: RunnerDeps; seeker: Seeker; fixture: { url: string; stop(): void }; close(): void;
} {
  const root = join(dir, "sample");
  copySample(root);
  makeSampleData(join(root, "data"));
  const fixture = startReputationFixture(join(root, "data"), 0);
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", fixture.url));
  const registry = loadRegistry([{ path: root, trusted: true, credentials: [] }]);
  const observables = new Observables(registry.types());
  const pool = new ConnectorPool({ secrets: new Secrets({}, null), observables });
  return {
    root, registry, deps: { registry, pool, observables }, seeker: cheapestSeeker(registry), fixture,
    close(): void { pool.closeAll(); fixture.stop(); },
  };
}
