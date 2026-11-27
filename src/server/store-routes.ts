// The routes that unload a case, read and change the case store, and save the on-complete setting (slice 11). They are routes of their own,
// not commands: a command answers with the session's head, and an unloaded case has no session. Each sits in app.ts's route table, behind
// the same guard and role check as every other; the server names the actor, so no body may.
import { isPlainObject } from "../core/canonical";
import { Refused } from "../core/refused";
import { STORE_FILE } from "../core/store";
import type { StoredCase } from "../core/store";
import type { Actor } from "../core/types";
import type { Workbench } from "../core/workbench";
import type { StoredCaseView, StoreView } from "../core/wire";
import type { Config } from "../modules/config";
import { saveOnComplete } from "../modules/config-write";
import type { CaseHub } from "./hub";

export interface StoreRouteDeps {
  config: Config; wb: Workbench; hub: CaseHub; human: () => Extract<Actor, { kind: "human" }>;
  /** A reason as the person may see it (app.ts's `shown`). */
  shown: (text: string) => string;
}

const json = (status: number, body: unknown): Response => Response.json(body, { status });
const refused = (status: number, ...reasons: string[]): Response => json(status, { ok: false, refused: reasons });
const SETTING = "cases.on_complete";

/** The body as an object with only the given fields, or why it is refused. */
function fieldsOf(body: unknown, allowed: string[]): Record<string, unknown> | string {
  if (!isPlainObject(body)) return "the body must be a JSON object";
  if (Object.hasOwn(body, "actor")) return "the server names the actor";
  const extra = Object.keys(body).find((k) => !allowed.includes(k));
  if (extra !== undefined) return `the body has a field it should not have: ${extra.slice(0, 40)}`;
  return body;
}

/** A refusal of the workbench or the store (CaseRefused, CaseFileError, ConfigWriteError) is 409 here; anything else is the caller's to answer. */
async function refusing(d: StoreRouteDeps, work: () => Promise<Response>): Promise<Response> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof Refused) return refused(409, ...error.reasons.map(d.shown));
    throw error;
  }
}

/** Whether the case a file holds is in the working set now: its id is loaded and its first entry is the file's. */
function loadedNow(wb: Workbench, c: StoredCase): boolean {
  try {
    return wb.session(c.manifest.id).entries(0, 1)[0]?.hash === c.manifest.origin;
  } catch {
    return false;
  }
}

function viewOf(wb: Workbench, c: StoredCase): StoredCaseView {
  const m = c.manifest;
  return {
    file: c.file, bytes: c.bytes, id: m.id, title: m.title, asked: m.asked, marking: m.marking, starting: m.starting, status: m.status,
    outcome: m.outcome, published: m.published.length, head: m.head.hash, entries: m.entries, unloaded_ts: m.unloaded_ts, workbench: m.workbench,
    loaded: loadedNow(wb, c),
  };
}

/** POST /api/cases/:id/unload {}: the case's file is written to the store and the case leaves the working set. */
export async function unloadRoute(d: StoreRouteDeps, id: string, body: unknown): Promise<Response> {
  const fields = fieldsOf(body, []);
  if (typeof fields === "string") return refused(400, fields);
  d.hub.read(id); // an unknown case is 404
  return refusing(d, async () => {
    const result = await d.hub.unload(id, d.human());
    return result.ok ? json(200, { ok: true, file: result.file }) : refused(409, d.shown(result.reason));
  });
}

/** GET /api/store?search=<text>: the store from each file's case.json, each checked against the file's own ledger. */
export function storeRoute(d: StoreRouteDeps, url: URL): Promise<Response> {
  return refusing(d, async () => {
    // each file is checked against its own ledger: one whose case.json says otherwise is listed as unreadable
    const listing = await d.wb.checkedStore(url.searchParams.get("search") ?? "");
    const view: StoreView = {
      store: d.wb.store.dir, cases: listing.cases.map((c) => viewOf(d.wb, c)), unreadable: listing.unreadable, leftovers: listing.leftovers.length,
    };
    return json(200, view);
  });
}

const fileOf = (fields: Record<string, unknown>): string | null => (typeof fields.file === "string" && STORE_FILE.test(fields.file) ? fields.file : null);

/** POST /api/store/load { file }: a file in the store, by its name, is loaded. */
export async function loadRoute(d: StoreRouteDeps, body: unknown): Promise<Response> {
  const fields = fieldsOf(body, ["file"]);
  if (typeof fields === "string") return refused(400, fields);
  const file = fileOf(fields);
  if (file === null) return refused(400, "file must be a case file's name");
  return refusing(d, async () => {
    const { id } = await d.hub.load(file, d.human());
    return json(200, { ok: true, id });
  });
}

/** POST /api/store/delete { file, id }: the file is removed only when the id typed is its case's; deleted.log names the person. */
export async function deleteRoute(d: StoreRouteDeps, body: unknown): Promise<Response> {
  const fields = fieldsOf(body, ["file", "id"]);
  if (typeof fields === "string") return refused(400, fields);
  const file = fileOf(fields);
  if (file === null) return refused(400, "file must be a case file's name");
  if (typeof fields.id !== "string") return refused(400, "id must be text");
  const typed = fields.id;
  return refusing(d, async () => {
    await d.hub.inStore(() => d.wb.store.delete(file, typed, d.human().id, new Date().toISOString()));
    return json(200, { ok: true });
  });
}

/** POST /api/settings { key: "cases.on_complete", value }: saved to the configuration file, then recorded on the workbench chain. */
export async function settingsRoute(d: StoreRouteDeps, body: unknown): Promise<Response> {
  const fields = fieldsOf(body, ["key", "value"]);
  if (typeof fields === "string") return refused(400, fields);
  if (fields.key !== SETTING) return refused(400, `the only setting is ${SETTING}`);
  const value = fields.value;
  if (value !== "keep" && value !== "unload") return refused(400, `${SETTING} is "keep" or "unload"`);
  return refusing(d, async () => {
    saveOnComplete(d.config, value);
    d.wb.chain.append({ type: "setting.changed", payload: { key: SETTING, value }, actor: d.human() });
    return json(200, { ok: true });
  });
}
