import type { StageRunner } from "../engine";
import type { IMPROVE_ROLES } from "../manifests";
import { adoptRunner } from "./adopt";
import { composeRunner } from "./compose";
import { judgeRunner } from "./judge";
import { probeRunner } from "./probe";
import { proposeRunner } from "./propose";
import { reflectRunner } from "./reflect";
import { selectRunner } from "./select";

/** The runner of each of the improve loop's seven roles. */
export const IMPROVE_RUNNERS: Record<(typeof IMPROVE_ROLES)[number], StageRunner> = {
  select: selectRunner, propose: proposeRunner, probe: probeRunner, compose: composeRunner, judge: judgeRunner, reflect: reflectRunner, adopt: adoptRunner,
};
