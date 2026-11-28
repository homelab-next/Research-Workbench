// bun run src/cli/cases.ts <command> ...   (see USAGE)
// Unloads a case to the case store (or any folder), loads one back, and lists or deletes what the store holds. Only a person, here the
// configured user, runs it. `store list` and `store delete` read the store folder alone and never open the workbench, so they work
// while the server runs; `unload` and `load` take the workbench's lock, so the server must be stopped.
import { checkedListing } from "../core/case-check";
import { CaseFileError } from "../core/casefile";
import { CaseStoreFolder } from "../core/store";
import type { Actor } from "../core/types";
import { CaseNotFoundError, CaseRefused, Workbench, WorkbenchLockedError } from "../core/workbench";
import { ConfigError, loadConfig } from "../modules/config";

export interface CasesIO {
  log(line: string): void;
  error(line: string): void;
  /** Writes the prompt and reads one typed line. */
  readLine(prompt: string): Promise<string>;
}

const USAGE = [
  "usage:",
  "  bun run src/cli/cases.ts unload <case> [--to <dir>]",
  "  bun run src/cli/cases.ts load <file|case-id>",
  "  bun run src/cli/cases.ts store list [--search <text>]",
  "  bun run src/cli/cases.ts store delete <case>",
  "options for every form: --config <file>",
  "unload and load need the server stopped; store list and store delete do not.",
].join("\n");

class UsageError extends Error {}

const CASE_ID = /^CASE-[1-9][0-9]{0,8}$/;
type Form = "unload" | "load" | "store list" | "store delete";
const VALUES: Record<Form, string[]> = { unload: ["to"], load: [], "store list": ["search"], "store delete": [] };

interface Parsed { form: Form; arg: string | null; config: string | null; opts: Record<string, string> }

function parse(argv: string[]): Parsed {
  const [first, ...more] = argv;
  if (first === undefined) throw new UsageError("no command given");
  let form: Form;
  let rest: string[];
  if (first === "store") {
    const sub = more[0];
    if (sub !== "list" && sub !== "delete") throw new UsageError(sub === undefined ? "store needs list or delete" : `unknown store command: ${sub}`);
    form = `store ${sub}`;
    rest = more.slice(1);
  } else if (first === "unload" || first === "load") {
    form = first;
    rest = more;
  } else {
    throw new UsageError(`unknown command: ${first}`);
  }
  const out: Parsed = { form, arg: null, config: null, opts: {} };
  const takesArg = form !== "store list";
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) {
      if (!takesArg || out.arg !== null) throw new UsageError(`unexpected argument: ${a}`);
      out.arg = a;
      continue;
    }
    const flag = a.slice(2);
    if (flag !== "config" && !VALUES[form].includes(flag)) throw new UsageError(`unknown option for ${form}: ${a}`);
    const value = rest[++i];
    if (value === undefined) throw new UsageError(`${a} needs a value`);
    if (flag === "config") {
      if (out.config !== null) throw new UsageError("--config was given twice");
      out.config = value;
    } else {
      if (Object.hasOwn(out.opts, flag)) throw new UsageError(`--${flag} was given twice`);
      out.opts[flag] = value;
    }
  }
  if (takesArg && out.arg === null) throw new UsageError(`${form} needs ${form === "load" ? "a file or a case id" : "a case id"}`);
  if ((form === "unload" || form === "store delete") && !CASE_ID.test(out.arg!)) throw new UsageError(`${out.arg} is not a case id (CASE-1, CASE-2, ...)`);
  return out;
}

const messageOf = (err: unknown): string =>
  err instanceof CaseFileError ? err.reasons.join("\n") : err instanceof Error ? err.message : String(err);

/** Runs one command and returns the exit code: 0 done, 1 refused or failed, 2 usage. `readLine` reads the typed id for store delete. */
export async function cases(argv: string[], io: CasesIO): Promise<number> {
  let p: Parsed;
  try {
    p = parse(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.error(`${err.message}\n${USAGE}`);
    return 2;
  }
  let config;
  try {
    config = loadConfig(p.config === null ? {} : { path: p.config });
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.error(err.message);
    return 2;
  }
  const person: Actor = { kind: "human", id: config.user };
  let wb: Workbench | null = null;
  try {
    if (p.form === "store list") {
      const store = new CaseStoreFolder(config.cases.store);
      const listing = await checkedListing(store, p.opts.search, { max_bytes: config.cases.max_bytes });
      io.log(store.dir);
      for (const c of listing.cases) {
        const m = c.manifest;
        io.log(`${m.id}  ${m.marking}  ${m.status}  ${m.entries} entries  ${m.unloaded_ts}  ${m.title}`);
      }
      for (const u of listing.unreadable) io.log(`unreadable ${u.file}: ${u.reason}`);
      for (const f of listing.leftovers) io.log(`leftover ${f}`);
      return 0;
    }
    if (p.form === "store delete") {
      const store = new CaseStoreFolder(config.cases.store);
      const found = await store.find(p.arg!);
      const id = found.manifest.id;
      io.log(`${id}  ${found.manifest.title}  head ${found.manifest.head.hash}  ${found.file}`);
      const typed = (await io.readLine(`Type ${id} to delete its file: `)).trim();
      if (typed !== id) {
        io.error(`nothing was deleted: ${typed === "" ? "no id was typed" : `${typed} is not ${id}`}`);
        return 1;
      }
      await store.delete(found.file, typed, config.user, new Date().toISOString());
      io.log(`deleted ${id} (${found.file}) from ${store.dir}`);
      return 0;
    }
    wb = Workbench.open(config.data_dir, {
      store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store,
      onError: (e) => io.error(`workbench: ${e instanceof Error ? e.message : String(e)}`),
    });
    if (p.form === "unload") {
      const r = await wb.unloadCase(p.arg!, { actor: person, ...(p.opts.to === undefined ? {} : { to: p.opts.to }) });
      if (!r.ok) {
        io.error(r.reason);
        return 1;
      }
      io.log(`unloaded ${p.arg} to ${r.path} · head ${r.head.hash}`);
      return 0;
    }
    // load: a case id takes the store's file for it; anything else is a path
    const file = CASE_ID.test(p.arg!) ? (await wb.store.find(p.arg!)).file : p.arg!;
    const path = CASE_ID.test(p.arg!) ? wb.store.path(file) : file;
    const r = await wb.loadCase(path, { actor: person });
    io.log(`loaded ${r.id} from ${path}`);
    return 0;
  } catch (err) {
    if (err instanceof WorkbenchLockedError) {
      io.error(`${err.message}; stop the server or the command that holds it, then try again`);
      return 1;
    }
    if (err instanceof CaseRefused || err instanceof CaseNotFoundError || err instanceof CaseFileError || (err instanceof Error && err.name === "Refused")) {
      io.error(messageOf(err));
      return 1;
    }
    io.error(`unexpected error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    return 1;
  } finally {
    try { wb?.close(); } catch (err) { io.error(`closing the workbench failed: ${messageOf(err)}`); }
  }
}

if (import.meta.main) {
  const readLine = async (prompt: string): Promise<string> => {
    process.stdout.write(prompt);
    for await (const line of console) return line;
    return "";
  };
  process.exitCode = await cases(process.argv.slice(2), { log: (l) => console.log(l), error: (l) => console.error(l), readLine });
}
