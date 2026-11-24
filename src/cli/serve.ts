// bun run src/cli/serve.ts [--config <file>] [--port <n>] [--sample-fixture [port]]
// Opens the workbench on its data directory and answers on 127.0.0.1 only. One person, one machine: there is no sign-in.
import { join } from "node:path";
import { Workbench, WorkbenchLockedError } from "../core/workbench";
import { ConfigError, loadConfig } from "../modules/config";
import { startServer } from "../server/app";
import { buildInterface } from "../web/build";
import { ensureSampleData } from "../../scripts/make-sample-data";
import { startReputationFixture } from "../../sample/fixture/reputation-server";
import { compose, ComposeError } from "./compose";

const USAGE = "usage: bun run src/cli/serve.ts [--config <file>] [--port <n>] [--sample-fixture [port]]";
const DEFAULT_FIXTURE_PORT = 4801;

/** The command line is wrong. The process exits 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(`${message}\n${USAGE}`);
    this.name = "UsageError";
  }
}

interface Parsed { config: string | null; port: number | null; fixture: number | null }

function port(text: string, flag: string): number {
  if (!/^\d{1,5}$/.test(text) || Number(text) > 65535) throw new UsageError(`${flag} wants a port from 0 to 65535, not ${text}`);
  return Number(text);
}

function parseArgs(argv: string[]): Parsed {
  const out: Parsed = { config: null, port: null, fixture: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--sample-fixture") {
      if (out.fixture !== null) throw new UsageError("--sample-fixture was given twice");
      const next = argv[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) {
        const p = port(next, "--sample-fixture");
        if (p < 1) throw new UsageError("--sample-fixture wants a port from 1 to 65535");
        out.fixture = p;
        i++;
      } else out.fixture = DEFAULT_FIXTURE_PORT;
    } else if (a === "--config" || a === "--port") {
      const value = argv[++i];
      if (value === undefined) throw new UsageError(`${a} needs a value`);
      if (a === "--config") {
        if (out.config !== null) throw new UsageError("--config was given twice");
        out.config = value;
      } else {
        if (out.port !== null) throw new UsageError("--port was given twice");
        out.port = port(value, "--port");
      }
    } else throw new UsageError(`unexpected argument: ${a}`);
  }
  return out;
}

const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Resolves once the server is listening. Throws UsageError, ConfigError, WorkbenchLockedError or ComposeError, with nothing left open.
 * `stop()` (and SIGINT or SIGTERM) stops the server, then closes the connector pool, the workbench and the fixture, each even if the one before failed.
 */
export async function serve(argv: string[], out: { log(line: string): void; error(line: string): void }): Promise<{ origin: string; stop(): Promise<void> }> {
  const p = parseArgs(argv);
  const config = loadConfig(p.config === null ? {} : { path: p.config });
  let fixture: { stop(): void } | null = null;
  let wb: Workbench | null = null;
  let composed: ReturnType<typeof compose> | null = null;
  let running: Awaited<ReturnType<typeof startServer>> | null = null;
  let closed: Promise<void> | null = null;
  const onSignal = (): void => { void stop().finally(() => process.exit(0)); };
  const stop = (): Promise<void> => (closed ??= (async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    const problems: unknown[] = [];
    const attempt = async (fn: (() => unknown) | undefined): Promise<void> => {
      try { await fn?.(); } catch (err) { problems.push(err); }
    };
    await attempt(running === null ? undefined : () => running!.stop());
    await attempt(composed === null ? undefined : () => composed!.close());
    await attempt(wb === null ? undefined : () => wb!.close());
    await attempt(fixture === null ? undefined : () => fixture!.stop());
    if (problems.length > 0) throw problems[0];
  })());
  try {
    // the lock first: a second serve on this data directory writes nothing and starts nothing, the sample and its fixture included
    wb = Workbench.open(config.data_dir, { onError: (e) => out.error(`workbench: ${reason(e)}`) });
    if (p.fixture !== null) {
      const root = config.roots[0];
      if (root === undefined) throw new ConfigError("--sample-fixture needs a root in the configuration");
      ensureSampleData(root.path);
      fixture = startReputationFixture(join(root.path, "data"), p.fixture);
    }
    // the server's own address, known once it is listening; every source and model endpoint is checked against it when it is used
    let host: string | null = null;
    composed = compose(config, wb, { refuse_hosts: () => (host === null ? [] : [host]) });
    for (const problem of composed.problems) out.error(`problem: ${problem}`);
    const assets = await buildInterface();
    running = startServer({ config, wb, deps: composed.deps, problems: composed.problems, assets, onError: (e) => out.error(`server: ${reason(e)}`) }, p.port ?? config.server.port);
    host = new URL(running.origin).host;
  } catch (err) {
    try { await stop(); } catch { /* the first failure is the one to report */ }
    throw err;
  }
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  out.log(`Workbench: ${running.origin}/`);
  return { origin: running.origin, stop };
}

if (import.meta.main) {
  try {
    await serve(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l) });
  } catch (err) {
    if (err instanceof UsageError || err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    if (err instanceof WorkbenchLockedError || err instanceof ComposeError) {
      console.error(err.message);
      process.exit(1);
    }
    console.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  }
}
