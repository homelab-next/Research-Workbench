// The improve loop's host over a workbench (slice 14): the tasks it reads, the staging stores of its candidates, and its probe children.
import { rmSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BlobStore } from "../../core/blobs";
import type { CaseSession } from "../../core/session";
import { CaseNotFoundError, CaseRefused } from "../../core/workbench";
import type { ChildLink, NewCase, ProbeMark, Workbench } from "../../core/workbench";
import type { Actor } from "../../core/types";
import type { Config } from "../../modules/config";
import { checkCandidate, snapshotRegistry, stageCandidate } from "../../modules/loop-stage";
import { SEEKERS } from "../../modules/seeker";
import type { ChangeCheck, ManifestFile } from "../../modules/loop-write";
import type { Engine, EngineDeps } from "../engine";
import { notTheChild, readChild } from "../subloop";
import type { ChildRef } from "../subloop";
import type { ImproveHost, ProbeRef, TaskRef, TaskView } from "./host";
import { driveProbe } from "./probe";
import { SNAPSHOTS, inProgress, keepSnapshot, markStaged, nextSnapshot, stagedFolder } from "./staging";

export { STAGED_MARK, markStaged, stagedFolder, sweepStaged } from "./staging";

/** Who makes a probe child: the engine, as for any child case. */
const ENGINE: Actor = { kind: "system", id: "engine" };
/** Who stands for the case type a probe child takes: the task's, not a person's choice. */
const TASK_TYPE: Actor = { kind: "system", id: "improve-task" };
const gone = (error: unknown): boolean => error instanceof CaseNotFoundError || error instanceof CaseRefused;

/** The session of a loaded case, or null when there is none here. */
function sessionOf(wb: Workbench, id: string): CaseSession | null {
  try {
    return wb.session(id);
  } catch (error) {
    if (gone(error)) return null;
    throw error;
  }
}

const viewOf = (session: CaseSession, origin: string): TaskView => ({
  ref: { case: session.id, origin }, state: session.state, head: session.head(), entries: (from, to) => session.entries(from, to),
});

/** A root a change names by its folder's name (as builder.proposed records it), as a path: the trusted root whose folder has that name; null when none has. */
function rootPath(config: Config, root: string): string | null {
  return config.roots.find((r) => r.trusted && basename(resolve(r.path)) === root)?.path ?? null;
}
const notARoot = (root: string): string => `the root ${basename(root)} is not a trusted root here`;

export function improveHost(opts: { wb: Workbench; deps: () => EngineDeps; engine: (id: string) => Engine; secrets: () => readonly string[]; onError: (e: unknown) => void }): ImproveHost {
  const { wb } = opts;
  const folder = (improve: { case: string; origin: string | null }): string => join(opts.deps().config.improve.staged, stagedFolder(improve));
  /** What the save's check and staging read, as they are now. */
  const saveDeps = () => {
    const d = opts.deps();
    if (d.loops === undefined) throw new Error("the loops are not loaded");
    return { config: d.config, chain: wb.chain, content: wb.chainBlobs, secrets: opts.secrets(), registry: d.registry, loops: d.loops };
  };
  const read = (ref: ChildRef) => {
    const session = sessionOf(wb, ref.id);
    return session === null ? null : readChild(session, ref);
  };
  const host: ImproveHost = {
    tasks: (caseType: string) => {
      const out: TaskView[] = [];
      // newest first, as listCases gives them; only a loaded case of the type, and one that has published
      for (const c of wb.listCases()) {
        if (c.type !== caseType) continue;
        const session = sessionOf(wb, c.id);
        const origin = session?.entries(0, 1)[0]?.hash ?? null;
        if (session === null || origin === null || session.state.published.length === 0) continue;
        out.push(viewOf(session, origin));
      }
      return out;
    },
    task: (ref: TaskRef) => {
      if (wb.loadedOrigin(ref.case) !== ref.origin) return null;
      const session = sessionOf(wb, ref.case);
      return session === null ? null : viewOf(session, ref.origin);
    },
    staged: (improve) => new BlobStore(join(folder(improve), "blobs")),
    stage: (improve, root, files: ManifestFile[], target) => {
      const deps = saveDeps();
      const path = rootPath(deps.config, root);
      if (path === null) return { ok: false, problems: [notARoot(root)] };
      const at = folder(improve);
      markStaged(at, improve);
      let made: ReturnType<typeof stageCandidate> = { ok: false, problems: [] };
      try {
        made = stageCandidate(deps, path, files, target, host.staged(improve), { keep: join(nextSnapshot(at), "root") });
      } finally {
        keepSnapshot(at, made.ok && made.snapshot, made.ok ? made.loop.pipeline.hash : "", resolve(path));
      }
      return made.ok ? { ok: true, loop: made.loop } : made;
    },
    registryFor: (improve, lock) => {
      const d = opts.deps();
      const registry = snapshotRegistry(d.config, join(folder(improve), SNAPSHOTS), lock);
      if (typeof registry === "string") return registry;
      const makeSeeker = Object.hasOwn(SEEKERS, d.config.seeker) ? SEEKERS[d.config.seeker] : undefined;
      if (makeSeeker === undefined) return `the seeker "${d.config.seeker}" is not one this build has`;
      return { registry, runner: { ...d.runner, registry }, seeker: makeSeeker(registry) };
    },
    check: (root, files: ManifestFile[], target): ChangeCheck => {
      const deps = saveDeps();
      const path = rootPath(deps.config, root);
      if (path === null) return { ok: false, problems: [notARoot(root)], files: [] };
      return checkCandidate(deps, path, files, target);
    },
    clear: (improve) => {
      try {
        rmSync(folder(improve), { recursive: true, force: true });
      } catch (error) {
        try { opts.onError(error); } catch { /* a failing reporter must not stop the run */ }
      }
    },
    probes: {
      find: (link: ChildLink) => {
        const id = wb.findChild(link);
        const origin = id === null ? null : wb.loadedOrigin(id);
        return id === null || origin === null ? null : { id, origin };
      },
      create: (input: NewCase, link: ChildLink, mark: ProbeMark, type: string) => {
        const made = wb.createCase(input, ENGINE, { loop: link.loop, link, probe: mark, type, type_by: TASK_TYPE });
        return { id: made.id, origin: made.entries(0, 1)[0]!.hash };
      },
      drive: async (ref: ProbeRef, o) => {
        // never a run on a case that is not this child: ids repeat across workbenches
        if (read(ref) === null) throw new CaseRefused(notTheChild(ref));
        return driveProbe(opts.engine(ref.id), wb.session(ref.id), o.loop);
      },
      read,
      end: (ref: ProbeRef, reason: string) => {
        const view = read(ref);
        if (view === null || !inProgress(view.state.run.status)) return;
        opts.engine(ref.id).endProbe(reason);
      },
    },
  };
  return host;
}
