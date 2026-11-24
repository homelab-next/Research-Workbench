import type { Entry } from "../core/types";
import type { AgentView, CaseSummaryView, CommandResult, Custody, Difference, Me, ModelView, NewCaseInput, Preview, Reference, RouteView } from "../core/wire";

export type Fetcher = (req: Request) => Promise<Response>;
/** `onDrop` is told "ahead" when the server says the position is ahead of the case, so what the store holds is not this case's record. */
export interface EntrySource { open(caseId: string, after: number, onEntry: (entry: Entry) => void, onDrop: (why?: "ahead") => void): () => void }
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
    entries,
  };
}

/** The browser's source: an EventSource on /api/cases/<id>/entries?after=N. It never reconnects by itself; the store's `follow` decides when. */
export function eventSourceEntries(win: Window, origin: string): EntrySource {
  return {
    open(caseId, after, onEntry, onDrop) {
      const Source = (win as Window & typeof globalThis).EventSource;
      const url = `${origin}/api/cases/${seg(caseId)}/entries?after=${after}`;
      const es = new Source(url);
      let done = false;
      let got = false;
      let closed = false;
      es.addEventListener("message", (event) => {
        got = true;
        try { onEntry(JSON.parse(String((event as MessageEvent).data)) as Entry); } catch { es.close(); if (!done) { done = true; onDrop(); } }
      });
      es.addEventListener("error", () => {
        es.close();
        if (done) return;
        done = true;
        if (got) { onDrop(); return; }
        // refused before any entry: an EventSource does not say why, so ask once; a 409 means this position is ahead of the case
        win.fetch(url).then((res) => { void res.body?.cancel().catch(() => {}); if (!closed) onDrop(res.status === 409 ? "ahead" : undefined); }, () => { if (!closed) onDrop(); });
      });
      return () => { done = true; closed = true; es.close(); };
    },
  };
}
