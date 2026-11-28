// The Adopt stage of an improve loop (slice 14): it offers what Compose chose and nothing more. The offer is the whole candidate: its change,
// the number of that change's files and the hash of the staged version its probes ran, since a candidate is adopted all or nothing and only a
// version that was probed can be. The stage writes nothing: the adopt gate is the engine's (nextStep waits there while a file of the change is
// undecided), each decision is the person's through the server's builderDecide, and only a person passes the gate.
import { adoptOffer } from "../../core/state";
import type { Json } from "../../core/canonical";
import type { StageEnd, StageRunner } from "../engine";

const pass = (output: Json): StageEnd => ({ kind: "finished", outcome: "pass", draft_hash: null, output, reason: null });

export const adoptRunner: StageRunner = async ({ session }) => {
  const { state } = session;
  const offer = adoptOffer(state);
  if (offer === null) return pass({ candidate: null });
  // adoptOffer names a change of this case's builder and a staged candidate (Compose chooses only a staged one)
  const files = state.builder.changes[offer.change]!.files.length;
  const loop_hash = state.improve.candidates[offer.candidate]!.loop_hash;
  return pass({ candidate: offer.candidate, change: offer.change, files, loop_hash });
};
