import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../core/canonical";
import type { Schema } from "../core/schema";
import { validate } from "../core/schema";
import { MARKINGS, WHERES } from "../core/types";
import type { Marking, Where } from "../core/types";
import type { RootConfig } from "pivot/catalogue/roots";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A module root and what the owner grants it. Only a trusted root may define observable types, network sources
 * (http, trino) and sources that name a credential, and a trusted root's source may name only the credentials
 * listed here. An untrusted root may supply sql and files sources, pivots, and kinds this plan does not validate.
 */
export type { RootConfig } from "pivot/catalogue/roots";

export interface Config {
  /** The file the settings came from, or null when the defaults were used. */
  path: string | null;
  /** The file a setting is written to: `path`, or the home configuration file when the defaults were used. */
  write_path: string;
  data_dir: string;
  user: string;
  role: "analyst" | "requester" | "leader";
  roots: RootConfig[];
  secrets_file: string | null;
  seeker: string;
  marking_policy: Record<Marking, Where[]>;
  server: { port: number };
  research: { parallel: number };
  /** At most this many unanswered questions to the person in a run; 0 turns asking off. */
  questions: { max_open: number };
  /** At most this many times in a run Research sends the work back to Plan for values the workbench extracted (slice 9); 0 turns it off. */
  glean: { max_sendbacks: number };
  cases: {
    /** The case store folder. */
    store: string;
    /** The default of "Unload after publishing". */
    on_complete: "keep" | "unload";
    /** The largest case a load accepts, in bytes. */
    max_bytes: number;
  };
  loops: {
    /** The loop a case is for when nothing names one. */
    default: string;
    /** The most levels of sub-loop below a case no case started; 0 means no sub-loops. */
    max_depth: number;
    /** The most sub-loops one case may start, over all its runs. */
    max_children: number;
    /** The folder loop files are exported into, listed from and imported from by name. */
    store: string;
    /** The folder imports land in, one folder each; every folder there is a root that is not trusted unless `roots` lists it. */
    imports: string;
  };
  memory: {
    /** The shared store's folder. */
    store: string;
    /** The folder memory files are exported into, listed from and loaded from by name. */
    files: string;
    /** The most lessons one run is given. */
    max_lessons: number;
    /** The most notes a case's notebook holds at once. */
    max_notes: number;
  };
}

const whereList: Schema = { type: "array", items: { type: "string", enum: [...WHERES] } };
const CONFIG_SCHEMA: Schema = {
  type: "object",
  additionalProperties: false,
  properties: {
    data_dir: { type: "string", minLength: 1 },
    user: { type: "string", minLength: 1 },
    role: { type: "string", enum: ["analyst", "requester", "leader"] },
    roots: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path"],
        properties: {
          path: { type: "string", minLength: 1 }, trusted: { type: "boolean" },
          credentials: { type: "array", items: { type: "string", minLength: 1 } },
        },
      },
    },
    secrets_file: { type: "string", minLength: 1 },
    seeker: { type: "string", minLength: 1 },
    marking_policy: {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(MARKINGS.map(m => [m, whereList])),
    },
    server: { type: "object", additionalProperties: false, properties: { port: { type: "integer", minimum: 0, maximum: 65535 } } },
    research: { type: "object", additionalProperties: false, properties: { parallel: { type: "integer", minimum: 1 } } },
    questions: { type: "object", additionalProperties: false, properties: { max_open: { type: "integer", minimum: 0 } } },
    glean: { type: "object", additionalProperties: false, properties: { max_sendbacks: { type: "integer", minimum: 0 } } },
    cases: {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string", minLength: 1 },
        on_complete: { type: "string", enum: ["keep", "unload"] },
        max_bytes: { type: "integer", minimum: 1 },
      },
    },
    loops: {
      type: "object",
      additionalProperties: false,
      properties: {
        default: { type: "string", minLength: 1 },
        max_depth: { type: "integer", minimum: 0 },
        max_children: { type: "integer", minimum: 1 },
        store: { type: "string", minLength: 1 },
        imports: { type: "string", minLength: 1 },
      },
    },
    memory: {
      type: "object",
      additionalProperties: false,
      properties: {
        store: { type: "string", minLength: 1 },
        files: { type: "string", minLength: 1 },
        max_lessons: { type: "integer", minimum: 1 },
        max_notes: { type: "integer", minimum: 1 },
      },
    },
  },
};

/** Least restrictive two markings may go anywhere; the next two stay off hosted models; the most restrictive stays on this machine. */
const DEFAULT_POLICY = Object.fromEntries(MARKINGS.map((m, i): [Marking, Where[]] => [m, i < 2 ? ["machine", "network", "hosted"] : i < 4 ? ["machine", "network"] : ["machine"]])) as Record<Marking, Where[]>;

/** The default of questions.max_open (the same number as the tools' DEFAULT_MAX_OPEN; modules do not import the agents). */
const DEFAULT_MAX_OPEN_QUESTIONS = 3;
/** The default of glean.max_sendbacks (the same number as the pipeline's DEFAULT_GLEAN_SENDBACKS; modules do not import the pipeline). */
const DEFAULT_GLEAN_SENDBACKS = 2;
/** The default of cases.max_bytes (the same number as the case file's DEFAULT_MAX_CASE_BYTES). */
const DEFAULT_MAX_CASE_BYTES = 2147483648;
/** The default of loops.default: today's pipeline, as a loop. */
const DEFAULT_LOOP = "investigation";

const expandHome = (p: string, home: string): string => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/** Reads the file and returns its top-level keys; a key with nothing after it counts as not given. */
function readFile(path: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`${path}: cannot be read as YAML: ${(err as Error).message.split("\n")[0]}`);
  }
  if (parsed === null || parsed === undefined) return {};
  if (!isPlainObject(parsed)) throw new ConfigError(`${path}: must be a mapping of settings`);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed)) if (v !== null) out[k] = v;
  return out;
}

export function loadConfig(opts: { path?: string; env?: Record<string, string | undefined>; home?: string; repoRoot?: string } = {}): Config {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const repoRoot = opts.repoRoot ?? resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const homeFile = join(home, ".config/research-workbench/config.yaml");

  let path: string | null = null;
  if (opts.path !== undefined) path = resolve(expandHome(opts.path, home));
  else if (env.RESEARCH_WORKBENCH_CONFIG) path = resolve(expandHome(env.RESEARCH_WORKBENCH_CONFIG, home));
  else if (existsSync(homeFile)) path = homeFile;
  if (path !== null && !existsSync(path)) throw new ConfigError(`${path}: no such configuration file`);

  const raw = path === null ? {} : readFile(path);
  const errors = validate(CONFIG_SCHEMA, raw);
  if (errors.length > 0) throw new ConfigError(`${path}: ${errors.map(e => `${e.path} ${e.message}`).join("; ")}`);
  const given = raw as {
    data_dir?: string; user?: string; role?: Config["role"]; roots?: { path: string; trusted?: boolean; credentials?: string[] }[];
    secrets_file?: string; seeker?: string; marking_policy?: Partial<Record<Marking, Where[]>>;
    server?: { port?: number }; research?: { parallel?: number }; questions?: { max_open?: number }; glean?: { max_sendbacks?: number };
    cases?: { store?: string; on_complete?: "keep" | "unload"; max_bytes?: number };
    loops?: { default?: string; max_depth?: number; max_children?: number; store?: string; imports?: string };
    memory?: { store?: string; files?: string; max_lessons?: number; max_notes?: number };
  };

  const base = path === null ? process.cwd() : dirname(path);
  const place = (p: string): string => resolve(base, expandHome(p, home));
  const defaultSecrets = join(home, ".config/research-workbench/secrets.yaml");

  const data_dir = given.data_dir !== undefined ? place(given.data_dir)
    : join(env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, ".local/share"), "research-workbench");

  return {
    path,
    write_path: path ?? homeFile,
    data_dir,
    user: given.user ?? (env.USER || "analyst"),
    role: given.role ?? "analyst",
    roots: given.roots !== undefined
      ? given.roots.map(r => ({ path: place(r.path), trusted: r.trusted ?? false, credentials: [...(r.credentials ?? [])] }))
      : [{ path: join(repoRoot, "sample"), trusted: true, credentials: [] }],
    secrets_file: given.secrets_file !== undefined ? place(given.secrets_file) : existsSync(defaultSecrets) ? defaultSecrets : null,
    seeker: given.seeker ?? "cheapest",
    marking_policy: { ...DEFAULT_POLICY, ...given.marking_policy },
    server: { port: given.server?.port ?? 4747 },
    research: { parallel: given.research?.parallel ?? 3 },
    questions: { max_open: given.questions?.max_open ?? DEFAULT_MAX_OPEN_QUESTIONS },
    glean: { max_sendbacks: given.glean?.max_sendbacks ?? DEFAULT_GLEAN_SENDBACKS },
    cases: {
      store: given.cases?.store !== undefined ? place(given.cases.store) : join(data_dir, "store"),
      on_complete: given.cases?.on_complete ?? "keep",
      max_bytes: given.cases?.max_bytes ?? DEFAULT_MAX_CASE_BYTES,
    },
    loops: {
      default: given.loops?.default ?? DEFAULT_LOOP,
      max_depth: given.loops?.max_depth ?? 2,
      max_children: given.loops?.max_children ?? 8,
      store: given.loops?.store !== undefined ? place(given.loops.store) : join(data_dir, "loops"),
      imports: given.loops?.imports !== undefined ? place(given.loops.imports) : join(data_dir, "imported"),
    },
    memory: {
      store: given.memory?.store !== undefined ? place(given.memory.store) : join(data_dir, "memory"),
      files: given.memory?.files !== undefined ? place(given.memory.files) : join(data_dir, "memory-files"),
      max_lessons: given.memory?.max_lessons ?? 12,
      max_notes: given.memory?.max_notes ?? 40,
    },
  };
}

/** A root as the workbench loads it: `staged` marks an imported folder the configuration does not list, which supplies nothing until it is trusted. */
export type WorkbenchRoot = RootConfig & { staged?: true };

/**
 * config.roots, then each folder of loops.imports that roots does not list, as a staged root that is not trusted and has no credentials; names
 * sorted with `<`. A file there, a link and a folder whose name starts with "." are not roots. No imports folder is no imported root;
 * one that cannot be read is a ConfigError.
 */
export function rootsOf(config: Config): WorkbenchRoot[] {
  const listed = new Set(config.roots.map((r) => resolve(r.path)));
  let names: string[];
  try {
    names = readdirSync(config.loops.imports, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
  } catch (err) {
    if ((err as { code?: unknown }).code !== "ENOENT") throw new ConfigError(`${config.loops.imports}: the loops imports folder cannot be read: ${(err as Error).message.split("\n")[0]}`);
    names = [];
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const imported = names.map((n) => join(config.loops.imports, n)).filter((p) => !listed.has(resolve(p)));
  return [...config.roots, ...imported.map((path): WorkbenchRoot => ({ path, trusted: false, credentials: [], staged: true }))];
}
