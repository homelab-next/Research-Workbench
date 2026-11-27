import type { Entry, Marking, ModelChoice } from "../core/types";
import type { AgentView, BuilderSummaryView, BuilderView, CaseSummaryView, CommandResult, Custody, Difference, LoopFileView, LoopSummaryView, LoopView, Me, ModelView, NewCaseInput, Preview, Reference, RouteView, StoreView } from "../core/wire";

export type Fetcher = (req: Request) => Promise<Response>;
/**
 * `onDrop` is told "ahead" when the server says the position is ahead of the case, so what the store holds is not this case's record; "gone" when the
 * server says there is no such case (it was unloaded, or never loaded), so there is nothing to reconnect to.
 */
export interface EntrySource { open(caseId: string, after: number, onEntry: (entry: Entry) => void, onDrop: (why?: "ahead" | "gone") => void, prefix?: EntryPrefix): () => void }
/** Whose entries a stream reads: a case's (/api/cases/<id>/entries, the default) or a builder session's (/api/builders/<id>/entries). */
export type EntryPrefix = "cases" | "builders";
/** What a route of the case store answers: done, or refused in the server's words. */
export type Refusable<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; refused: string[] };
export interface Api {
  me(): Promise<Me>; cases(): Promise<CaseSummaryView[]>; reference(): Promise<Reference>; models(caseId: string): Promise<ModelView[]>;
  newCase(input: NewCaseInput): Promise<{ id: string } | { refused: string[] }>;
  command(caseId: string, name: string, args: Record<string, unknown>): Promise<CommandResult>;
  agent(caseId: string): Promise<AgentView>;
  /** The routes the finder offers (a read of the registry: no source is asked and nothing is written), cheapest first. */
  routes(q: { have: string[]; want: string; max_weight: number | null; unconfirmed: boolean }): Promise<RouteView[]>;
  /** The row-level difference behind a card's newest verification, or why there is none. */
  difference(caseId: string, card: string): Promise<Difference | { reason: string }>;
  custody(caseId: string): Promise<Custody>; preview(caseId: string): Promise<Preview>;
  blobText(caseId: string, hash: string): Promise<string>;
  blobPath(caseId: string, hash: string): string; bundlePath(caseId: string, n: number, file: string): string;
  /** The case store, read from each file's case.json; `search` matches id, title, question or an observable value ("" lists every file). */
  store(search: string): Promise<StoreView>;
  /** Packs the case into the store and takes it out of the working set. */
  unload(caseId: string): Promise<Refusable<{ file: string }>>;
  /** Loads a file of the store, by its name, into the working set. */
  load(file: string): Promise<Refusable<{ id: string }>>;
  /** Deletes a file of the store; `id` is what the person typed, which the server requires to be the file's case. */
  deleteStored(file: string, id: string): Promise<Refusable>;
  /** Saves the one setting the interface may change. */
  setSetting(key: "cases.on_complete", value: "keep" | "unload"): Promise<Refusable>;
  /** The loops the registry holds, usable or not, and one loop as an outline (slice 12). */
  loops(): Promise<LoopSummaryView[]>; loop(id: string): Promise<LoopView>;
  /** The files of the loop store, each with what an import would do now. */
  loopFiles(): Promise<LoopFileView[]>;
  /** Writes the loop's file into the loop store. */
  exportLoop(id: string): Promise<{ file: string } | { refused: string[] }>;
  /** Imports a file of the loop store, by its name, into a root that is not trusted. */
  importLoop(file: string): Promise<{ root: string; written: number; same: number } | { refused: string[] }>;
  /** Trusts an imported root; `typed` is what the person typed, which the server requires to be the root's folder name. */
  trustRoot(root: string, typed: string): Promise<{ ok: true } | { refused: string[] }>;
  /** Where a file of the loop store is downloaded from. */
  loopFilePath(file: string): string;
  /** Copies a usable loop under a new id and title, every stage inline (slice 12's forms). */
  copyLoop(id: string, to: { id: string; title: string }): Promise<{ id: string } | { refused: string[] }>;
  /** What a save of the draft would find, from the check a save makes; it writes nothing. A refusal of the request is its problems. */
  checkLoop(id: string, draft: unknown): Promise<{ ok: boolean; problems: string[] }>;
  /** Saves the draft as the loop's next version; `version` is the one the screen loaded. */
  saveLoop(id: string, draft: unknown, version: number): Promise<{ id: string; version: number; hash: string } | { refused: string[] }>;
  /** The builder sessions, newest first (slice 12, part B). */
  builders(): Promise<BuilderSummaryView[]>;
  /** Starts a builder session about a loop (null: a new loop) at the marking the person picked. */
  newBuilder(loop: string | null, marking: Marking): Promise<{ id: string } | { refused: string[] }>;
  builderView(id: string): Promise<BuilderView>;
  builderAsk(id: string, text: string): Promise<CommandResult>;
  /** The person's decision on one file of a proposed change. */
  builderDecide(id: string, change: string, file: number, accept: boolean): Promise<CommandResult>;
  /** The person's decision on a probe; `budget` for a costly one, else null. */
  builderProbe(id: string, probe: string, approve: boolean, budget: number | null): Promise<CommandResult>;
  builderModel(id: string, choice: ModelChoice): Promise<CommandResult>;
  entries: EntrySource;
}

const seg = encodeURIComponent;

export function makeApi(fetcher: Fetcher, origin: string, entries: EntrySource): Api {
  const get = (path: string): Promise<Response> => fetcher(new Request(`${origin}${path}`));
  const post = (path: string, body: unknown): Promise<Response> =>
    fetcher(new Request(`${origin}${path}`, { method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body) }));
  const read = async <T>(path: string): Promise<T> => {
    const res = await get(path);
    if (!res.ok) throw new Error(`${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  };
  /** The refusal the server gave, in its words; plain text from the guard counts as one reason. */
  const refusedOf = async (res: Response): Promise<string[]> => {
    const text = await res.text();
    try {
      const body = JSON.parse(text) as { refused?: unknown };
      if (Array.isArray(body.refused) && body.refused.every((r) => typeof r === "string")) return body.refused as string[];
    } catch { /* not JSON */ }
    return [text.slice(0, 300) || `the server answered ${res.status}`];
  };
  /** A POST whose answer is `{ ok: true, ... }` or a refusal; a server that does not answer is a refusal too, so the control can say so. */
  const refusable = async <T extends object>(path: string, body: unknown): Promise<Refusable<T>> => {
    let res: Response;
    try { res = await post(path, body); } catch { return { ok: false, refused: ["The server did not answer."] }; }
    if (res.ok) return (await res.json()) as Refusable<T>;
    return { ok: false, refused: await refusedOf(res) };
  };
  /** A POST answered with `T`, or the refusal in the server's words; a server that does not answer is a refusal too. */
  const answered = async <T extends object>(path: string, body: unknown): Promise<T | { refused: string[] }> => {
    let res: Response;
    try { res = await post(path, body); } catch { return { refused: ["The server did not answer."] }; }
    if (res.ok) return (await res.json()) as T;
    return { refused: await refusedOf(res) };
  };
  return {
    me: () => read<Me>("/api/me"),
    cases: () => read<CaseSummaryView[]>("/api/cases"),
    reference: () => read<Reference>("/api/reference"),
    models: (id) => read<ModelView[]>(`/api/cases/${seg(id)}/models`),
    async newCase(input) {
      const res = await post("/api/cases", input);
      if (res.ok) return (await res.json()) as { id: string };
      return { refused: await refusedOf(res) };
    },
    async command(id, name, args) {
      const res = await post(`/api/cases/${seg(id)}/commands`, { command: name, args });
      if (res.ok) return (await res.json()) as CommandResult;
      return { ok: false, refused: await refusedOf(res) };
    },
    agent: (id) => read<AgentView>(`/api/cases/${seg(id)}/agent`),
    routes(q) {
      const params = new URLSearchParams();
      for (const t of q.have) params.append("have", t);
      params.set("want", q.want);
      if (q.max_weight !== null) params.set("max_weight", String(q.max_weight));
      params.set("unconfirmed", q.unconfirmed ? "1" : "0");
      return read<RouteView[]>(`/api/routes?${params.toString()}`);
    },
    difference: (id, card) => read<Difference | { reason: string }>(`/api/cases/${seg(id)}/cards/${seg(card)}/difference`),
    custody: (id) => read<Custody>(`/api/cases/${seg(id)}/custody`),
    preview: (id) => read<Preview>(`/api/cases/${seg(id)}/preview`),
    async blobText(id, hash) {
      const res = await get(`/api/cases/${seg(id)}/blobs/${seg(hash)}`);
      if (!res.ok) throw new Error(`blob ${hash.slice(0, 12)}: ${res.status}`);
      return res.text();
    },
    blobPath: (id, hash) => `/api/cases/${seg(id)}/blobs/${seg(hash)}`,
    bundlePath: (id, n, file) => `/api/cases/${seg(id)}/published/${n}/${seg(file)}`,
    store: (search) => read<StoreView>(`/api/store?${new URLSearchParams({ search }).toString()}`),
    unload: (id) => refusable(`/api/cases/${seg(id)}/unload`, {}),
    load: (file) => refusable("/api/store/load", { file }),
    deleteStored: (file, id) => refusable("/api/store/delete", { file, id }),
    setSetting: (key, value) => refusable("/api/settings", { key, value }),
    loops: () => read<LoopSummaryView[]>("/api/loops"),
    loop: (id) => read<LoopView>(`/api/loops/${seg(id)}`),
    loopFiles: () => read<LoopFileView[]>("/api/loop-files"),
    exportLoop: (id) => answered<{ file: string }>(`/api/loops/${seg(id)}/export`, {}),
    importLoop: (file) => answered<{ root: string; written: number; same: number }>(`/api/loop-files/${seg(file)}/import`, {}),
    trustRoot: (root, typed) => answered<{ ok: true }>("/api/roots/trust", { root, typed }),
    loopFilePath: (file) => `/api/loop-files/${seg(file)}`,
    copyLoop: (id, to) => answered<{ id: string }>(`/api/loops/${seg(id)}/copy`, { id: to.id, title: to.title }),
    async checkLoop(id, draft) {
      const r = await answered<{ ok: boolean; problems: string[] }>(`/api/loops/${seg(id)}/check`, { draft });
      return "refused" in r ? { ok: false, problems: r.refused } : r;
    },
    builders: () => read<BuilderSummaryView[]>("/api/builders"),
    newBuilder: (loop, marking) => answered<{ id: string }>("/api/builders", { loop, marking }),
    builderView: (id) => read<BuilderView>(`/api/builders/${seg(id)}/view`),
    builderAsk: (id, text) => refusable<{ seq: number }>(`/api/builders/${seg(id)}/ask`, { text }) as Promise<CommandResult>,
    builderDecide: (id, change, file, accept) => refusable<{ seq: number }>(`/api/builders/${seg(id)}/decide`, { change, file, accept }) as Promise<CommandResult>,
    builderProbe: (id, probe, approve, budget) => refusable<{ seq: number }>(`/api/builders/${seg(id)}/probe`, { probe, approve, budget }) as Promise<CommandResult>,
    builderModel: (id, choice) => refusable<{ seq: number }>(`/api/builders/${seg(id)}/model`, { choice }) as Promise<CommandResult>,
    saveLoop: (id, draft, version) => answered<{ id: string; version: number; hash: string }>(`/api/loops/${seg(id)}/save`, { draft, version }),
    entries,
  };
}

/** The browser's source: an EventSource on /api/<prefix>/<id>/entries?after=N (cases unless told builders). It never reconnects by itself; the store's `follow` decides when. */
export function eventSourceEntries(win: Window, origin: string): EntrySource {
  return {
    open(caseId, after, onEntry, onDrop, prefix = "cases") {
      const Source = (win as Window & typeof globalThis).EventSource;
      const url = `${origin}/api/${prefix}/${seg(caseId)}/entries?after=${after}`;
      const es = new Source(url);
      let done = false;
      let got = false;
      let closed = false;
      es.addEventListener("message", (event) => {
        got = true;
        try { onEntry(JSON.parse(String((event as MessageEvent).data)) as Entry); } catch { es.close(); if (!done) { done = true; onDrop(); } }
      });
      // the case was unloaded: the stream's last word, so there is nothing to reconnect to
      es.addEventListener("unloaded", () => { es.close(); if (done) return; done = true; onDrop("gone"); });
      es.addEventListener("error", () => {
        es.close();
        if (done) return;
        done = true;
        if (got) { onDrop(); return; }
        // refused before any entry: an EventSource does not say why, so ask once; a 409 means this position is ahead of the case, a 404 that it is not loaded
        win.fetch(url).then((res) => {
          void res.body?.cancel().catch(() => {});
          if (!closed) onDrop(res.status === 409 ? "ahead" : res.status === 404 ? "gone" : undefined);
        }, () => { if (!closed) onDrop(); });
      });
      return () => { done = true; closed = true; es.close(); };
    },
  };
}
