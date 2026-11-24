import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Assets } from "../server/app";

const HERE = import.meta.dir;
/** The page is a constant: no data is ever written into it. */
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Workbench</title><link rel="stylesheet" href="/app.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>`;

/** Bundles src/web/main.ts for the browser and reads style.css. The page is a constant: no data is ever written into it. */
export async function buildInterface(): Promise<Assets> {
  const out = await Bun.build({ entrypoints: [join(HERE, "main.ts")], target: "browser", format: "esm", minify: false, throw: false });
  if (!out.success || out.outputs.length !== 1) throw new Error(`the interface did not build: ${out.logs.map((l) => l.message).join("; ")}`);
  return { html: PAGE, js: await out.outputs[0]!.text(), css: readFileSync(join(HERE, "style.css"), "utf8") };
}
