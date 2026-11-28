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

/** What a signal does once the server has been asked to stop: exit 0 after a clean shutdown; else print every closer's error and exit 1. */
export async function afterSignal(stop: () => Promise<void>, out: { error(line: string): void }, exit: (code: number) => void): Promise<void> {
  try {
    await stop();
  } catch (err) {
    for (const e of err instanceof AggregateError ? err.errors : [err]) out.error(`shutdown: ${reason(e)}`);
    exit(1);
    return;
  }
  exit(0);
}

/**
 * Resolves once the server is listening. Throws UsageError, ConfigError, WorkbenchLockedError or ComposeError, with nothing left open. A default
 * loop that is not usable does not stop it: it is printed as a problem, and the Loops page shows it.
 * `stop()` (and SIGINT or SIGTERM) stops the server, then closes the connector pool, the workbench and the fixture, each even if the one before failed;
 * several failures are thrown together as an AggregateError. On a signal, a failed shutdown prints every error and exits 1.
 */
export async function serve(argv: string[], out: { log(line: string): void; error(line: string): void }): Promise<{ origin: string; stop(): Promise<void> }> {
  const p = parseArgs(argv);
  const config = loadConfig(p.config === null ? {} : { path: p.config });
  let fixture: { stop(): void } | null = null;
  let wb: Workbench | null = null;
  let composed: ReturnType<typeof compose> | null = null;
  let running: Awaited<ReturnType<typeof startServer>> | null = null;
  let closed: Promise<void> | null = null;
  const onSignal = (): void => { void afterSignal(stop, out, (code) => process.exit(code)); };
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
    // one failure is thrown as itself; several together, so none is lost
    if (problems.length === 1) throw problems[0];
    if (problems.length > 1) throw new AggregateError(problems, `${problems.length} closers failed`);
  })());
  try {
    // the lock first: a second serve on this data directory writes nothing and starts nothing, the sample and its fixture included
    wb = Workbench.open(config.data_dir, { onError: (e) => out.error(`workbench: ${reason(e)}`), store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store });
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
    const made = composed;
    // a save, a copy, an import or a trust on the Loops page loads the roots again in place; an export and a save are searched for every secret held
    running = startServer({
      config, wb, deps: composed.deps, problems: composed.problems, assets, onError: (e) => out.error(`server: ${reason(e)}`),
      reload: () => made.reload(), secrets: () => made.secrets(),
    }, p.port ?? config.server.port);
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
