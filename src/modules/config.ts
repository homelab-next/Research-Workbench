import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPlainObject } from "../core/canonical";
import type { Schema } from "../core/schema";
import { validate } from "../core/schema";
import { MARKINGS, WHERES } from "../core/types";
import type { Marking, Where } from "../core/types";

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
export interface RootConfig { path: string; trusted: boolean; credentials: string[] }

export interface Config {
  /** The file the settings came from, or null when the defaults were used. */
  path: string | null;
  data_dir: string;
  user: string;
  role: "analyst" | "requester" | "leader";
  roots: RootConfig[];
  secrets_file: string | null;
  seeker: string;
  marking_policy: Record<Marking, Where[]>;
  server: { port: number };
  research: { parallel: number };
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
  },
};

/** Least restrictive two markings may go anywhere; the next two stay off hosted models; the most restrictive stays on this machine. */
const DEFAULT_POLICY = Object.fromEntries(MARKINGS.map((m, i): [Marking, Where[]] => [m, i < 2 ? ["machine", "network", "hosted"] : i < 4 ? ["machine", "network"] : ["machine"]])) as Record<Marking, Where[]>;

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
    server?: { port?: number }; research?: { parallel?: number };
  };

  const base = path === null ? process.cwd() : dirname(path);
  const place = (p: string): string => resolve(base, expandHome(p, home));
  const defaultSecrets = join(home, ".config/research-workbench/secrets.yaml");

  return {
    path,
    data_dir: given.data_dir !== undefined ? place(given.data_dir)
      : join(env.XDG_DATA_HOME ? env.XDG_DATA_HOME : join(home, ".local/share"), "research-workbench"),
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
  };
}
