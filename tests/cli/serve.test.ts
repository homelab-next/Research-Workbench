import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SAMPLE_START, SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { memory } from "../../src/cli/memory";
import { afterSignal, serve } from "../../src/cli/serve";
import { Workbench, WorkbenchLockedError } from "../../src/core/workbench";
import { cleanEnv } from "../helpers/clean-env";
import { copySample } from "../helpers/sample-root";

const REPO = join(import.meta.dir, "..", "..");
const dirs: string[] = [];
const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (stops.length > 0) await stops.pop()!().catch(() => {});
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freePort(): number {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
  const port = s.port!;
  void s.stop(true);
  return port;
}

/** A configuration whose only root is a copy of the sample; `reputation` is the location its reputation source is given. */
function setup(reputation?: (serverPort: number, fixturePort: number) => string): { config: string; data: string; serverPort: number; fixturePort: number } {
  const dir = mkdtempSync(join(tmpdir(), "cli-serve-"));
  dirs.push(dir);
  const root = join(dir, "sample");
  copySample(root);
  const serverPort = freePort(), fixturePort = freePort();
  const rep = join(root, "sources", "reputation.yaml");
  writeFileSync(rep, readFileSync(rep, "utf8").replace("http://127.0.0.1:4801", reputation?.(serverPort, fixturePort) ?? `http://127.0.0.1:${fixturePort}`));
  const data = join(dir, "data");
  const config = join(dir, "config.yaml");
  writeFileSync(config, [`data_dir: ${data}`, "user: analyst", "roots:", `  - { path: ${root}, trusted: true }`, ""].join("\n"));
  return { config, data, serverPort, fixturePort };
}

const quiet = { log: (): void => {}, error: (): void => {} };

test("serve listens on 127.0.0.1, prints its address, serves the page and stops cleanly", async () => {
  const e = setup();
  const lines: string[] = [];
  const running = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], { log: (l) => lines.push(l), error: () => {} });
  stops.push(() => running.stop());
  expect(lines[0]).toMatch(/^Workbench: http:\/\/127\.0\.0\.1:\d+\/$/);
  expect(lines[0]).toBe(`Workbench: ${running.origin}/`);
  const page = await fetch(`${running.origin}/`);
  expect(page.status).toBe(200);
  expect(page.headers.get("content-security-policy")).toContain("require-trusted-types-for 'script'");
  // another name for the same port is refused: one origin only
  expect((await fetch(`http://localhost:${new URL(running.origin).port}/`)).status).toBe(421);
  await running.stop();
  Workbench.open(e.data, { onError: () => {} }).close(); // the lock was released
  await expect(fetch(`${running.origin}/`)).rejects.toThrow();
});

test("serve uses --port, and the configuration's port when none is given", async () => {
  const e = setup();
  const running = await serve(["--config", e.config, "--port", String(e.serverPort), "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => running.stop());
  expect(running.origin).toBe(`http://127.0.0.1:${e.serverPort}`);
  await running.stop();
  writeFileSync(e.config, readFileSync(e.config, "utf8") + `server: { port: ${e.serverPort} }\n`);
  const again = await serve(["--config", e.config, "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => again.stop());
  expect(again.origin).toBe(`http://127.0.0.1:${e.serverPort}`);
});

test("manifest problems are printed to the error stream as problem: lines", async () => {
  const e = setup();
  const root = join(e.config, "..", "sample");
  writeFileSync(join(root, "sources", "broken.yaml"), "kind: source\nid: broken\n");
  const errors: string[] = [];
  const running = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], { log: () => {}, error: (l) => errors.push(l) });
  stops.push(() => running.stop());
  expect(errors.length).toBeGreaterThan(0);
  expect(errors.every((l) => l.startsWith("problem: "))).toBe(true);
  expect(errors.some((l) => l.includes("broken"))).toBe(true);
});

test("a second serve on the same data directory is refused", async () => {
  const e = setup();
  const first = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => first.stop());
  const err = await serve(["--config", e.config, "--port", "0"], quiet).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(WorkbenchLockedError);
  // and the first is still answering
  expect((await fetch(`${first.origin}/`)).status).toBe(200);
});

test("a repeated serve --sample-fixture on the same data directory is refused by the lock before the fixture starts", async () => {
  const e = setup();
  const first = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => first.stop());
  const err = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], quiet).catch((x: unknown) => x);
  expect(err).toBeInstanceOf(WorkbenchLockedError);
  const r = Bun.spawnSync(["bun", "run", join(REPO, "src", "cli", "serve.ts"), "--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], {
    cwd: REPO, timeout: 60_000, stdout: "pipe", stderr: "pipe", env: cleanEnv(dirname(e.config)),
  });
  expect(r.exitCode).toBe(1);
  const out = r.stderr.toString();
  expect(out).toContain("is in use by");
  expect(out).not.toContain("Failed to start server");
  expect(out).not.toContain("unexpected error");
  // the first is still answering, fixture included
  expect((await fetch(`${first.origin}/`)).status).toBe(200);
});

test("the process exits 1 on a locked data directory and 2 on a configuration error or usage error", async () => {
  const e = setup();
  const first = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => first.stop());
  const run = (args: string[]) => {
    const r = Bun.spawnSync(["bun", "run", join(REPO, "src", "cli", "serve.ts"), ...args], { cwd: REPO, timeout: 60_000, stdout: "pipe", stderr: "pipe", env: cleanEnv(dirname(e.config)) });
    return { code: r.exitCode, err: r.stderr.toString() };
  };
  const locked = run(["--config", e.config, "--port", "0"]);
  expect(locked.code).toBe(1);
  expect(locked.err).toContain("is in use by");
  expect(run(["--config", join(e.config, "..", "missing.yaml")]).code).toBe(2);
  expect(run(["--bogus"]).code).toBe(2);
  expect(run(["--port", "70000"]).code).toBe(2);
});

test("serve wires refuse_hosts: a source that points at the server is refused when it is queried", async () => {
  const e = setup((serverPort) => `http://localhost:${serverPort}`);
  const running = await serve(["--config", e.config, "--port", String(e.serverPort), "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => running.stop());
  const post = (path: string, body: unknown) => fetch(`${running.origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: running.origin }, body: JSON.stringify(body) });
  const made = await post("/api/cases", { title: "Sample", asked: "Who is behind the traffic?", why: "test", starting: [SAMPLE_START], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" });
  expect(made.status).toBe(200);
  const id = ((await made.json()) as { id: string }).id;
  const waitFor = async (what: () => boolean): Promise<void> => { for (let i = 0; i < 200 && !what(); i++) await Bun.sleep(50); };
  const texts = (): string => {
    const db = new Database(join(e.data, "cases", id, "ledger.sqlite"), { readonly: true });
    try { return JSON.stringify(db.query("select * from entries").all()); } finally { db.close(); }
  };
  expect((await post(`/api/cases/${id}/commands`, { command: "start_run", args: {} })).status).toBe(200);
  await waitFor(() => texts().includes("plan.proposed"));
  const row = (): { payload: string } | null => {
    const db = new Database(join(e.data, "cases", id, "ledger.sqlite"), { readonly: true });
    try { return db.query("select payload from entries where type = 'plan.proposed'").get() as { payload: string } | null; } finally { db.close(); }
  };
  const plan = (JSON.parse(row()!.payload) as { plan: { id: string } }).plan;
  const accepted = await post(`/api/cases/${id}/commands`, { command: "accept_plan", args: { plan: plan.id, budgets: { s3: 1 } } });
  expect(accepted.status).toBe(200);
  await waitFor(() => texts().includes("own server"));
  expect(texts()).toContain("points at this service's own server");
});

test("on a signal, a clean shutdown exits 0 and a failed one prints every closer's error and exits 1", async () => {
  const printed: string[] = [];
  const out = { log: (): void => {}, error: (l: string): void => { printed.push(l); } };
  const codes: number[] = [];
  await afterSignal(async () => {}, out, (c) => { codes.push(c); });
  expect(codes).toEqual([0]);
  expect(printed).toEqual([]);
  await afterSignal(async () => { throw new AggregateError([new Error("the server would not stop"), new Error("the workbench would not close")], "shutdown failed"); }, out, (c) => { codes.push(c); });
  await afterSignal(async () => { throw new Error("the pool would not close"); }, out, (c) => { codes.push(c); });
  expect(codes).toEqual([0, 1, 1]);
  expect(printed).toEqual(["shutdown: the server would not stop", "shutdown: the workbench would not close", "shutdown: the pool would not close"]);
});

test("SIGTERM stops a spawned serve cleanly: exit 0 and the lock released", async () => {
  const e = setup();
  const child = Bun.spawn(["bun", "run", join(REPO, "src", "cli", "serve.ts"), "--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], {
    cwd: REPO, stdout: "pipe", stderr: "pipe", env: cleanEnv(dirname(e.config)),
  });
  stops.push(async () => { child.kill("SIGKILL"); await child.exited; });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("Workbench: ")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  expect(seen).toMatch(/Workbench: http:\/\/127\.0\.0\.1:\d+\//);
  child.kill("SIGTERM");
  expect(await child.exited).toBe(0);
  expect(await new Response(child.stderr).text()).toBe("");
  Workbench.open(e.data, { onError: () => {} }).close();
}, 60_000);

test("serve reads the memory store the configuration names, not <data>/memory", async () => {
  const e = setup();
  const root = join(dirname(e.config), "sample");
  writeFileSync(join(root, "case-types.yaml"), "kind: case-types\nid: sample-types\ntypes:\n  - { id: unknown-device, title: Unknown device, about: A device on the network that no inventory names. }\n");
  // the sample's own seed lessons are left out: the store holds only the one lesson proposed here
  rmSync(join(root, "memory"), { recursive: true, force: true });
  const store = join(dirname(e.config), "elsewhere", "memory");
  writeFileSync(e.config, readFileSync(e.config, "utf8") + `memory: { store: ${store} }\n`);
  const args = ["--title", "Check the lobby access point first", "--text", "Read the lease table of AP-3 first.", "--type", "unknown-device", "--marking", "TLP:GREEN"];
  expect(await memory(["propose", ...args, "--config", e.config], quiet)).toBe(0);
  expect(existsSync(join(store, "ledger.sqlite"))).toBe(true);
  expect(existsSync(join(e.data, "memory"))).toBe(false);
  const running = await serve(["--config", e.config, "--port", "0", "--sample-fixture", String(e.fixturePort)], quiet);
  stops.push(() => running.stop());
  const view = await (await fetch(`${running.origin}/api/memory`)).json() as { groups: { lessons: { title: string }[] }[] };
  expect(view.groups.flatMap((g) => g.lessons.map((l) => l.title))).toEqual(["Check the lobby access point first"]);
  expect(existsSync(join(e.data, "memory", "ledger.sqlite"))).toBe(false);
});
