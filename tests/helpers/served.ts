import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  newCase(over?: Partial<NewCase> & { loop?: string; type?: string }): Promise<string>;
  entries(id: string): Entry[];
  command(id: string, name: string, args?: Record<string, unknown>): Promise<{ status: number; body: CommandResult }>;
  /** start_run, then wait for the server to drive the run to the plan gate. */
  toPlanGate(id: string): Promise<void>;
  /** toPlanGate, accept_plan with a budget for the costly step, then wait for the run to reach the publish gate. */
  toPublishGate(id: string): Promise<void>;
  /** Loads the roots again, as the server does after a save (compose's reload); returns the new problems. */
  reload(): string[];
  close(): Promise<void>;
}

/** The sample as a trusted root, a workbench, compose and an app, all in process; requests go straight to app.handle with the right Host and Origin. */
export async function served(opts: { role?: Role; listen?: boolean; onError?: (error: unknown) => void; credential?: { name: string; value: string }; before?: (root: string) => void; config?: Partial<Omit<Config, "cases">> & { cases?: Partial<Config["cases"]> } } = {}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), "served-"));
  const sample = sampleRoot(dir);
  const cred = opts.credential;
  if (cred !== undefined) {
    appendFileSync(join(sample.root, "sources", "reputation.yaml"), `credential: ${cred.name}\n`);
    process.env[cred.name] = cred.value;
  }
  opts.before?.(sample.root);
  const loaded = loadConfig({ env: {}, home: dir, repoRoot: dir });
  const { cases: casesGiven, ...rest } = opts.config ?? {};
  const dataDir = rest.data_dir ?? join(dir, "wb");
  const config: Config = {
    ...loaded,
    data_dir: join(dir, "wb"), role: opts.role ?? "analyst",
    roots: [{ path: sample.root, trusted: true, credentials: cred === undefined ? [] : [cred.name] }],
    ...rest,
    // the loop store and the imports folder follow this data folder unless the test names them
    loops: { ...loaded.loops, store: join(rest.data_dir ?? join(dir, "wb"), "loops"), imports: join(rest.data_dir ?? join(dir, "wb"), "imported"), ...rest.loops },
    // the store follows this data folder unless the test names one
    cases: { ...loaded.cases, store: join(rest.data_dir ?? join(dir, "wb"), "store"), ...casesGiven },
    // the memory store and its files are in this data folder unless the test names them
    memory: { ...loaded.memory, store: join(dataDir, "memory"), files: join(dataDir, "memory-files"), ...rest.memory },
  };
  const wb = Workbench.open(config.data_dir, { onError: () => {}, store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store });
  let host = `127.0.0.1:${PRETEND_PORT}`;
  let composed: ReturnType<typeof compose> | undefined;
  let running: Running | undefined;
  let app: App;
  let origin = `http://${host}`;
  try {
    composed = compose(config, wb, { refuse_hosts: () => [host] });
    const made = composed;
    const base = {
      config, wb, deps: composed.deps, problems: composed.problems, assets: await interfaceAssets(), onError: opts.onError ?? (() => {}),
      reload: () => made.reload(), secrets: () => made.secrets(),
    };
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
      const input: NewCase & { loop?: string; type?: string } = { title: "Sample", asked: "Who is behind the traffic to 198.51.100.77?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN", ...over };
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
    reload: () => composed!.reload(),
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

/** Two case types of the sample's own kind of question. */
export const CASE_TYPES = "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device, about: A device on the network that no inventory names. }\n  - { id: phishing, title: Phishing, about: A message that tries to take a person's credentials. }\n";

/**
 * The sample's root with what slice 13 brings: two case types, a profile whose Plan and Research list memory references, and a loop "memo"
 * (the investigation loop's stages, with an inline Frame that may propose a case type and names unknown-device) that reads the shared lessons
 * of the case's type and the case's notes at Plan and Research. The investigation loop, its stages, schema and script are as they were.
 */
export function withMemoryLoop(root: string, opts: { case_type?: string } = {}): void {
  // these case types in place of the sample's own (one is the same id), and none of the sample's seed lessons: a test files its own
  writeFileSync(join(root, "case-types.yaml"), CASE_TYPES);
  // and not slice 14's device-check type, with the loop of that type
  rmSync(join(root, "case-types-device-check.yaml"), { force: true });
  rmSync(join(root, "loops", "device-check.yaml"), { force: true });
  rmSync(join(root, "memory"), { recursive: true, force: true });
  const profile = readFileSync(join(root, "context", "profile.yaml"), "utf8").replace("id: investigation", "id: memory-test")
    .replace("    skills: [ask-the-person]\n  research:", "    skills: [ask-the-person]\n    references: [shared-lessons, case-notes]\n  research:")
    .replace("    procedure: research-sop\n", "    procedure: research-sop\n    references: [shared-lessons, case-notes]\n");
  writeFileSync(join(root, "context", "memory-profile.yaml"), profile);
  const loopBody = Bun.YAML.parse(readFileSync(join(root, "loops", "investigation.yaml"), "utf8")) as Record<string, unknown>;
  const reads = { "reference:shared-lessons": { memory: "shared/*" }, "reference:case-notes": { memory: "case/notes" } };
  const frame = Bun.YAML.parse(readFileSync(join(root, "stages", "frame.yaml"), "utf8")) as Record<string, unknown>;
  const { kind: _kind, ...frameBody } = frame;
  const typedFrame = { ...frameBody, schema: "frame-typed", model: { provider: "scripted", model: "memo-frame", effort: null } };
  const stages = (loopBody.stages as string[]).map((x) => (x === "frame" ? typedFrame : x));
  writeFileSync(join(root, "loops", "memo.yaml"), JSON.stringify({
    ...loopBody, id: "memo", title: "Memo", profile: "memory-test", stages, components: { plan: reads, research: reads },
    ...(opts.case_type === undefined ? {} : { case_type: opts.case_type }),
  }));
  const from = `"notes": {"type": "string"}}}`;
  const schema = readFileSync(join(root, "context", "schemas", "frame-output.yaml"), "utf8").replace("id: frame-output", "id: frame-typed");
  if (!schema.includes(from)) throw new Error("the frame-output schema is not the one this helper edits");
  writeFileSync(join(root, "context", "schemas", "frame-typed.yaml"), schema.replace(from, `"notes": {"type": "string"}, "case_type": {"type": ["string", "null"]}}}`));
  type Turn = { actor: string; reply: { content?: string } };
  const script = Bun.YAML.parse(readFileSync(join(root, "scripts", "sample-run.yaml"), "utf8")) as { turns: Turn[] };
  const framing = script.turns.filter((t) => t.actor === "orchestrator").map((t) => (t.reply.content === undefined ? t : { ...t, reply: { content: JSON.stringify({ ...JSON.parse(t.reply.content) as object, case_type: "unknown-device" }) } }));
  writeFileSync(join(root, "scripts", "memo-frame.yaml"), JSON.stringify({ kind: "script", id: "memo-frame", title: "Memo Frame", turns: [...framing, ...framing, ...framing] }));
}

const IMPROVE_ROLES = ["select", "propose", "probe", "compose", "judge", "reflect", "adopt"] as const;
const IMPROVE_TITLES: Record<string, string> = { select: "Select", propose: "Propose", probe: "Probe", compose: "Compose", judge: "Judge", reflect: "Reflect", adopt: "Adopt" };

/**
 * The sample's root with an improve loop: the loop `improve` of seven inline stages, one of each improve role in order (Probe accepts its
 * children's plan gate; Adopt waits at the adopt gate), and its profile. The sample's own loops, stages and profile are as they were.
 */
export function withImproveLoop(root: string): void {
  const stages = IMPROVE_ROLES.map((role, i) => {
    const agent = role === "propose" || role === "compose" || role === "reflect";
    return {
      id: role, title: IMPROVE_TITLES[role]!, order: i + 1, runs: agent ? "agent" : role === "adopt" ? "human" : "script", role, gate: role === "adopt" ? "adopt" : null, reviews: false,
      tools: [], schema: null, model: agent ? { provider: "scripted", model: "sample-device", effort: null } : null, on_pass: IMPROVE_ROLES[i + 1] ?? null, on_fail: null,
      ...(role === "probe" ? { probe: { plan_gate: "accept" } } : {}),
    };
  });
  writeFileSync(join(root, "loops", "improve.yaml"), JSON.stringify({ kind: "loop", id: "improve", title: "Improve", version: 1, profile: "improve-test", entry: "select", stages }, null, 2));
  writeFileSync(join(root, "context", "improve-test-profile.yaml"), JSON.stringify({
    kind: "profile", id: "improve-test", title: "Improve (test)", rules: "base-rules", framework: "intel-cycle", standard: "icd203",
    stages: Object.fromEntries(["propose", "compose", "reflect"].map((id) => [id, { agent: "analyst", persona: "analyst", goal: `The ${id} stage of the test.` }])),
  }, null, 2));
}
