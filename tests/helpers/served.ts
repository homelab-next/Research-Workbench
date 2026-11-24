import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compose } from "../../src/cli/compose";
import type { CommandResult } from "../../src/core/wire";
import type { Entry } from "../../src/core/types";
import type { CaseState } from "../../src/core/state";
import { Workbench } from "../../src/core/workbench";
import type { NewCase } from "../../src/core/workbench";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { loadConfig } from "../../src/modules/config";
import type { Config } from "../../src/modules/config";
import { createApp, startServer } from "../../src/server/app";
import type { App, Assets, Running } from "../../src/server/app";
import { buildInterface } from "../../src/web/build";
import { sampleRoot } from "./sample-root";

type Role = Config["role"];
let built: Promise<Assets> | undefined;
/** The real interface, built once per process. */
const interfaceAssets = (): Promise<Assets> => (built ??= buildInterface());
/** The port an in-process (not listening) server pretends to have. Nothing binds it. */
const PRETEND_PORT = 47474;

export interface Served {
  dir: string; app: App; origin: string; config: Config; wb: Workbench; problems: string[];
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  post(path: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
  newCase(over?: Partial<NewCase>): Promise<string>;
  entries(id: string): Entry[];
  command(id: string, name: string, args?: Record<string, unknown>): Promise<{ status: number; body: CommandResult }>;
  /** start_run, then wait for the server to drive the run to the plan gate. */
  toPlanGate(id: string): Promise<void>;
  /** toPlanGate, accept_plan with a budget for the costly step, then wait for the run to reach the publish gate. */
  toPublishGate(id: string): Promise<void>;
  close(): Promise<void>;
}

/** The sample as a trusted root, a workbench, compose and an app, all in process; requests go straight to app.handle with the right Host and Origin. */
export async function served(opts: { role?: Role; listen?: boolean; credential?: { name: string; value: string }; before?: (root: string) => void } = {}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "served-"));
  const sample = sampleRoot(dir);
  const cred = opts.credential;
  if (cred !== undefined) {
    appendFileSync(join(sample.root, "sources", "reputation.yaml"), `credential: ${cred.name}\n`);
    process.env[cred.name] = cred.value;
  }
  opts.before?.(sample.root);
  const config: Config = {
    ...loadConfig({ env: {}, home: dir, repoRoot: dir }),
    data_dir: join(dir, "wb"), role: opts.role ?? "analyst",
    roots: [{ path: sample.root, trusted: true, credentials: cred === undefined ? [] : [cred.name] }],
  };
  const wb = Workbench.open(config.data_dir, { onError: () => {} });
  let host = `127.0.0.1:${PRETEND_PORT}`;
  let composed: ReturnType<typeof compose> | undefined;
  let running: Running | undefined;
  let app: App;
  let origin = `http://${host}`;
  try {
    composed = compose(config, wb, { refuse_hosts: () => [host] });
    const base = { config, wb, deps: composed.deps, problems: composed.problems, assets: await interfaceAssets(), onError: () => {} };
    if (opts.listen === true) {
      running = startServer(base, 0);
      app = running.app;
      origin = running.origin;
      host = new URL(origin).host;
    } else {
      app = createApp({ ...base, origin });
    }
  } catch (err) {
    composed?.close();
    wb.close();
    sample.close();
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const hostHeader = new URL(origin).host;
  const send = (path: string, init: RequestInit, headers: Record<string, string>): Promise<Response> =>
    app.handle(new Request(`${origin}${path}`, { ...init, headers: { host: hostHeader, ...headers } }));
  let closed = false;
  const s: Served = {
    dir, app, origin, config, wb, problems: composed.problems,
    get: (path, headers = {}) => send(path, {}, headers),
    post: (path, body, headers = {}) =>
      send(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }, { origin, "content-type": "application/json", ...headers }),
    async newCase(over = {}) {
      const input: NewCase = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN", ...over };
      const res = await s.post("/api/cases", input);
      if (res.status !== 200) throw new Error(`creating the case failed: ${res.status} ${await res.text()}`);
      return ((await res.json()) as { id: string }).id;
    },
    entries: (id) => app.hub.read(id).entries(),
    async command(id, name, args = {}) {
      // A gate command must name what the person was shown; the helper shows it the current plan or draft unless the test says otherwise.
      if (name === "accept_plan" || name === "approve") {
        let state: CaseState | null = null;
        try { state = app.hub.read(id).state; } catch { /* no such case: the server says so */ }
        if (state !== null && name === "accept_plan" && args.plan === undefined) args = { plan: state.plan.current?.id ?? "", ...args };
        if (state !== null && name === "approve" && args.draft_hash === undefined) args = { draft_hash: state.drafts.length > 0 ? state.drafts[state.drafts.length - 1]!.hash : "", ...args };
      }
      const res = await s.post(`/api/cases/${id}/commands`, { command: name, args });
      return { status: res.status, body: (await res.json()) as CommandResult };
    },
    async toPlanGate(id) {
      const r = await s.command(id, "start_run");
      if (r.status !== 200) throw new Error(`start_run failed: ${JSON.stringify(r)}`);
      await app.hub.idle();
    },
    async toPublishGate(id) {
      await s.toPlanGate(id);
      const r = await s.command(id, "accept_plan", { budgets: { s3: 1 } });
      if (r.status !== 200) throw new Error(`accept_plan failed: ${JSON.stringify(r)}`);
      await app.hub.idle();
    },
    async close() {
      if (closed) return;
      closed = true;
      const errors: unknown[] = [];
      const attempt = async (fn: () => unknown): Promise<void> => { try { await fn(); } catch (e) { errors.push(e); } };
      if (running !== undefined) await attempt(() => running!.stop()); else await attempt(() => app.close());
      await attempt(() => wb.close());
      await attempt(() => composed!.close());
      await attempt(() => sample.close());
      if (cred !== undefined) delete process.env[cred.name];
      rmSync(dir, { recursive: true, force: true });
      if (errors.length > 0) throw errors[0];
    },
  };
  return s;
}

/** A model manifest for a local provider at `base_url`, written into the root. */
export function writeLocalModel(root: string, id: string, where: string, base_url: string): void {
  mkdirSync(join(root, "models"), { recursive: true });
  writeFileSync(join(root, "models", `${id}.yaml`), `kind: model\nid: ${id}\ntitle: ${id}\nprovider: local\nwhere: ${where}\nbase_url: ${base_url}\n`);
}
