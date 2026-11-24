/** The request guard: who may talk to this server at all, before any handler runs. */
export const MAX_BODY_BYTES = 1_048_576;

const text = (status: number, body: string): Response => new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** Null when the request may go on; otherwise the refusal. Checks in this order: Host, Origin, Sec-Fetch-Site, method, a POST's Origin and type, size. */
export function refusal(req: Request, origin: string): Response | null {
  const host = req.headers.get("host");
  if (host !== new URL(origin).host) return text(421, `This workbench answers only at ${origin}.`);
  const from = req.headers.get("origin");
  if (from !== null && from !== origin) return text(403, "This workbench does not answer requests from another origin.");
  const site = req.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return text(403, "This workbench does not answer cross-site requests.");
  if (req.method !== "GET" && req.method !== "POST") return text(405, "Only GET and POST are answered.");
  if (req.method === "POST") {
    if (from === null) return text(403, "A POST must carry this workbench's Origin.");
    if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return text(403, "A POST must be application/json.");
  }
  const length = req.headers.get("content-length");
  if (length !== null && Number(length) > MAX_BODY_BYTES) return text(413, "The body is larger than 1 MiB.");
  return null;
}

const PAGE_POLICY = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'";
/** A file the person saves: it may never run as a page of this origin. */
const DOWNLOAD_POLICY = "default-src 'none'; sandbox";

/** The same response with the headers every answer carries. No `Access-Control-*` header survives, whatever made the response. */
export function secure(res: Response, kind: "page" | "api" | "download"): Response {
  const headers = new Headers(res.headers);
  for (const name of [...headers.keys()]) if (name.toLowerCase().startsWith("access-control-")) headers.delete(name);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  if (kind === "page") headers.set("Content-Security-Policy", PAGE_POLICY);
  if (kind === "download") headers.set("Content-Security-Policy", DOWNLOAD_POLICY);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}
