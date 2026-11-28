// A scripted investigation of a storyline of a tiny synthetic setup, for the acceptance test of slice 15. The script is written here, at test
// time, from the build's ground truth: it is never shipped in a root, since a script that holds a truth's wording does not belong in one.
// Synthetic only: the setup is built with TINY_PARAMS under a fresh temporary folder that close() removes.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TINY_PARAMS } from "pivot/synth/params";
import { readGroundTruth } from "pivot/synth/truth";
import type { GroundTruth } from "pivot/synth/truth";
import { compose } from "../../src/cli/compose";
import { Workbench } from "../../src/core/workbench";
import { loadConfig } from "../../src/modules/config";
import { loadRegistry } from "../../src/modules/registry-record";
import type { Config } from "../../src/modules/config";
import type { EngineDeps } from "../../src/pipeline/engine";
import { buildSetup, SYNTH_RUN } from "../../src/synth/build";
import { setupOf, storyLabels } from "../../src/synth/setup";
import { readIndex, synthTasks } from "../../src/synth/tasks";

/** The build's ground truth of one storyline: `<synth>/truth/<storyline>.json`. */
export function truthOf(setup: { dir: string }, storyline: string): GroundTruth {
  const truth = readGroundTruth(readFileSync(join(setup.dir, "truth", `${storyline}.json`)));
  if (truth === null || truth.storyline !== storyline) throw new Error(`there is no ground truth of ${storyline} in the setup`);
  return truth;
}

const entity = (truth: GroundTruth, role: string): string => {
  const e = truth.entities.find((x) => x.role === role);
  if (e === undefined) throw new Error(`the truth of ${truth.storyline} has no ${role}`);
  return e.value;
};

type Reply = { content: string } | { tool_calls: { tool: string; args: Record<string, unknown> }[] };
const content = (x: unknown): Reply => ({ content: JSON.stringify(x) });
const call = (tool: string, args: Record<string, unknown>): Reply => ({ tool_calls: [{ tool, args }] });

/** The turns of the password-spray investigation: who signed in from the address, and whether it is known. */
function passwordSpray(truth: GroundTruth, pivotText: (id: string) => string): { actor: string; reply: Reply }[] {
  const address = entity(truth, "attacker");
  const account = entity(truth, "victim");
  const { window } = truth.task;
  // card titles are "<pivot title>: <value>"
  const asset = `{{card:Corporate host with the address, by asset list: ${address}}}`;
  const signins = `{{card:Accounts that signed in from the address: ${address}}}`;
  const feeds = `{{card:Feed verdicts on the address: ${address}}}`;
  const have = [{ type: "address", value: address }];
  const goals = [
    { title: "Who signed in from the address", question: `Which accounts signed in from ${address}, and did any succeed?`, want: "account" },
    { title: "Is the address known", question: `Is ${address} known to the company or to the feeds?`, want: "verdict" },
  ];
  return [
    { actor: "orchestrator", reply: call("list_sources", { why: "See what may be asked before framing." }) },
    {
      actor: "orchestrator",
      reply: content({ goals, window: { from: window.from, to: window.to }, limits: { allow_unconfirmed: false, max_weight: null }, notes: "Use the task's window as given." }),
    },
    {
      actor: "planner",
      reply: content({
        goal: `Find who signed in from ${address} and whether it is known`,
        subgoals: [
          { title: "Is the address a company host", question: `Is ${address} one of the company's hosts?`, have, want: "host", route: ["address_to_asset"] },
          { title: "Who signed in from the address", question: goals[0]!.question, have, want: "account", route: ["address_to_signins"] },
          { title: "Do the feeds know the address", question: `What do the feeds say about ${address}?`, have, want: "verdict", route: ["address_to_reputation"] },
        ],
      }),
    },
    { actor: "researcher-g1", reply: call("run_step", { why: "The asset list says whether the address is a company host.", step: "s1" }) },
    { actor: "researcher-g1", reply: content({ outcome: "answered", found: [], note: `${address} is not in the asset list.` }) },
    { actor: "researcher-g2", reply: call("run_step", { why: "Find the accounts that signed in from the address.", step: "s2" }) },
    // a costly pivot is never an agent's to run (run_pivot refuses it), so the researcher asks for account_to_signins by its text, outside the
    // plan: a query of a costly source, which becomes a costly_query proposal for the person
    { actor: "researcher-g2", reply: call("run_query", { why: "Check where the account that got in signed in from.", source: "signins", text: pivotText("account_to_signins"), bound: { value: account } }) },
    { actor: "researcher-g2", reply: content({ outcome: "answered", found: [{ type: "account", value: account }], note: `Several accounts failed from ${address}; ${account} succeeded.` }) },
    { actor: "researcher-g3", reply: call("run_step", { why: "Ask the feeds about the address.", step: "s3" }) },
    { actor: "researcher-g3", reply: content({ outcome: "answered", found: [], note: "The feeds were asked about the address." }) },

    { actor: "analyst", reply: call("list_cards", { why: "See what was collected." }) },
    {
      actor: "analyst",
      reply: {
        tool_calls: [
          {
            tool: "propose_assessment",
            args: {
              why: "The account that got in answers the first goal.",
              claim: `the account ${account} signed in from ${address} after other accounts had failed from it`,
              likelihood: "very likely", confidence: "moderate",
              confidence_basis: "One sign-in log, read over the task's window.",
              cites: [signins], assumptions: ["The sign-in log is complete for the window."],
              reasoning: `The sign-ins from ${address} are failures for several accounts and one success for ${account}.`,
            },
          },
          {
            tool: "propose_assessment",
            args: {
              why: "Whether the address is ours.",
              claim: `${address} is not a corporate host`,
              likelihood: "almost certain", confidence: "high",
              confidence_basis: "The asset list is complete for the company's hosts and has no row for the address.",
              cites: [asset], assumptions: [],
              reasoning: "An address absent from a complete asset list is not a company host.",
            },
          },
          { tool: "propose_narrative", args: { why: "Summarise the judgment.", section: "summary", text: `${account} is the account that got in from ${address}, an address outside the company.`, cites: [signins] } },
          { tool: "propose_narrative", args: { why: "Say what the record does not show.", section: "gaps_and_limits", text: `What the feeds say about the address (${feeds}) was asked once and is not used as evidence.`, cites: [feeds] } },
          { tool: "propose_narrative", args: { why: "Say what else could explain it.", section: "alternatives", text: `The person behind ${account} may have signed in from a new network.`, cites: [signins] } },
          { tool: "propose_narrative", args: { why: "Set out the reasoning.", section: "assessment", text: `Failures for several accounts from one outside address, then one success, is the shape of guessed passwords.`, cites: [signins] } },
        ],
      },
    },
    { actor: "analyst", reply: content({ done: true, change_kind: "first judgment", change_detail: "on this question", assumptions: ["The sign-in log is complete for the window."], note: "First draft." }) },

    { actor: "evaluator", reply: call("list_cards", { why: "See the cards the draft cites." }) },
    { actor: "evaluator", reply: call("read_card", { why: "Read the card the main finding rests on.", card: signins }) },
    { actor: "evaluator", reply: call("verify_card", { why: "Run the asset lookup again.", card: asset }) },
    { actor: "evaluator", reply: content({ pass: true, findings: [] }) },

    { actor: "adversary", reply: call("list_cards", { why: "See the cards the draft cites." }) },
    {
      actor: "adversary",
      reply: call("raise_challenge", { why: "One log.", severity: "consider", text: "The finding rests on one sign-in log; a second source would make it firmer.", cites: [signins] }),
    },
    { actor: "adversary", reply: content({ done: true, summary: "One point to consider; nothing that must be answered." }) },

    { actor: "publisher", reply: content({ title: `Sign-ins from ${address}`, note: "Synthetic run." }) },
  ];
}

/** A scripted investigation of one storyline of a built setup, as a kind: script manifest of id synth-run: written from the build's truth for that storyline, for the loop `investigation`. Test code: it is the one place outside src/synth that reads a truth file. */
export function investigationScript(setup: { dir: string }, storyline: string): string {
  if (storyline !== "password-spray") throw new Error(`there is no scripted investigation of ${storyline}`);
  const truth = truthOf(setup, storyline);
  const registry = loadRegistry([{ path: join(setup.dir, "root"), trusted: true, credentials: [] }]);
  const pivotText = (id: string): string => {
    const p = registry.pivot(id);
    if (p === null) throw new Error(`the setup's root has no pivot ${id}`);
    return p.query;
  };
  return [
    "kind: script",
    `id: ${SYNTH_RUN}`,
    `title: Scripted investigation of the synthetic storyline ${storyline}`,
    "# Synthetic. Written by a test from the build's ground truth; never shipped in a root.",
    "turns:",
    ...passwordSpray(truth, pivotText).map((t) => `  - ${JSON.stringify(t)}`),
    "",
  ].join("\n");
}

/** A tiny --scripted setup with that script in its root, a case of the storyline made by synth tasks, its workbench opened and composed. */
export function synthRun(storyline: string): { dir: string; config: Config; wb: Workbench; deps: EngineDeps; truth: GroundTruth; close(): void } {
  const tmp = mkdtempSync(join(tmpdir(), "synth-run-"));
  try {
    mkdirSync(join(tmp, "home"));
    const built = buildSetup(join(tmp, "setup"), { params: TINY_PARAMS, model: "scripted" }, null);
    writeFileSync(join(built.dir, "root", "scripts", `${SYNTH_RUN}.yaml`), investigationScript(built, storyline));
    // the setup's own configuration, read with nothing of the person's: no environment, a home of the test's own
    const config = loadConfig({ path: built.config, env: {}, home: join(tmp, "home") });
    // the case, made as the person's `synth tasks --only <storyline>` makes it. synthTasks awaits nothing, so its body has run when the call
    // returns; the index is read to be sure, so a change that made it wait would fail here and not later
    const { setup } = setupOf(config);
    const said: string[] = [];
    const io = { log: (l: string) => said.push(l), error: (l: string) => said.push(`error: ${l}`) };
    void synthTasks({ config, dir: built.dir, setup, human: { kind: "human", id: config.user }, io }, { only: [storyLabels(setup).get(storyline)!], marking: "TLP:GREEN" });
    if (!readIndex(config).cases.some((c) => c.storyline === storyline && c.made_by === "tasks")) throw new Error(`synth tasks made no case of ${storyline}: ${said.join("; ")}`);
    const wb = Workbench.open(config.data_dir, { store: config.cases.store, max_case_bytes: config.cases.max_bytes, memory: config.memory.store, onError: () => {} });
    const composed = compose(config, wb);
    let closed = false;
    return {
      dir: built.dir, config, wb, deps: composed.deps, truth: truthOf(built, storyline),
      close(): void {
        if (closed) return;
        closed = true;
        try { composed.close(); } finally {
          try { wb.close(); } finally { rmSync(tmp, { recursive: true, force: true }); }
        }
      },
    };
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
}
