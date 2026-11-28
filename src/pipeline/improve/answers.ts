// Known answers (slice 14): what a person knows a published product of a task case should have said. An answer is an entry of the task case's
// own ledger (answer.known, answer.withdrawn), the person's only. It is judge input and nothing else: knownAnswerOf, the one reader of an
// answer's text and findings in src/pipeline and src/agents, is called by the Judge alone; answeredProducts tells Select what is answered and
// nothing of what the answer says.
import { termsOf } from "../../agents/draft";
import { redactSecrets } from "../../core/redact";
import { Refused } from "../../core/refused";
import type { CaseSession } from "../../core/session";
import { fold } from "../../core/state";
import type { CaseState } from "../../core/state";
import { ANSWER_FINDINGS_MAX, ANSWER_TEXT_MAX, CLAIM_MAX } from "../../core/state/improve";
import { CONFIDENCES, strictest } from "../../core/types";
import type { Actor, Entry, ExpectedFinding, Marking, Payloads } from "../../core/types";
import type { EngineDeps } from "../engine";

export class AnswerRefused extends Refused {
  constructor(message: string) {
    super(message);
    this.name = "AnswerRefused";
  }
}

export interface KnownAnswerInput { product: number; text: string; findings: ExpectedFinding[]; marking: Marking; actor: Actor }

const ONLY_PERSON = "only a person sets a known answer";
const NOT_HERE = "a probe child and an improve case hold no known answer";

const isText = (x: unknown, max: number): boolean => typeof x === "string" && x.trim() !== "" && x.length <= max;

/** The published product `n` of the case, with its product's marking; null when the case published no such product. */
function publishedProduct(state: Readonly<CaseState>, n: number): { draft_hash: string; marking: Marking } | null {
  const p = state.published.find((x) => x.n === n);
  if (p === undefined) return null;
  const draft = state.drafts.find((d) => d.hash === p.draft_hash);
  return draft === undefined ? null : { draft_hash: p.draft_hash, marking: draft.product.marking };
}

/** Why this is not a known answer for this case; null when it is. `likelihood` is the standard's terms when the host knows them: a term not among them is refused. */
export function answerProblem(state: Readonly<CaseState>, input: Omit<KnownAnswerInput, "actor">, likelihood: readonly string[] | null): string | null {
  if (state.improve.request !== null || state.improve.probe_of !== null) return NOT_HERE;
  const product = Number.isInteger(input.product) ? publishedProduct(state, input.product) : null;
  if (product === null) return `there is no published product ${String(input.product)} in this case`;
  if (!isText(input.text, ANSWER_TEXT_MAX)) return `a known answer's text is 1 to ${ANSWER_TEXT_MAX} characters`;
  if (!Array.isArray(input.findings) || input.findings.length > ANSWER_FINDINGS_MAX) return `a known answer has at most ${ANSWER_FINDINGS_MAX} expected findings`;
  for (const f of input.findings) {
    if (!isText(f?.claim, CLAIM_MAX)) return `an expected finding's claim is 1 to ${CLAIM_MAX} characters`;
    if (typeof f.likelihood !== "string" || f.likelihood.trim() === "") return "an expected finding names a likelihood term";
    if (likelihood !== null && !likelihood.includes(f.likelihood)) return `${f.likelihood} is not a likelihood term of this case's standard`;
    if (!(CONFIDENCES as readonly unknown[]).includes(f.confidence)) return `an expected finding's confidence is one of ${CONFIDENCES.join(", ")}`;
  }
  const floor = strictest(state.meta?.marking, product.marking);
  if (strictest(input.marking, floor) !== input.marking) return `a known answer is marked at least ${floor}, as its case and its product are`;
  return null;
}

/** Writes answer.known by the person, its text and claims with every secret value redacted. Throws AnswerRefused, writing nothing. */
export function setKnownAnswer(session: CaseSession, deps: Pick<EngineDeps, "runner">, input: KnownAnswerInput, likelihood: readonly string[] | null = null): void {
  if (input.actor?.kind !== "human") throw new AnswerRefused(ONLY_PERSON);
  const secrets = deps.runner.secrets?.() ?? [];
  const clean = (t: unknown): string => (typeof t === "string" ? redactSecrets(t, secrets) : (t as string));
  // redacted before the checks, so the checks are of what is written
  const findings: ExpectedFinding[] = Array.isArray(input.findings)
    // `asks` only when true, so an answer that marks none is written as one was before
    ? input.findings.map((f) => ({ claim: clean(f?.claim), likelihood: clean(f?.likelihood), confidence: f?.confidence, ...(f?.asks === true ? { asks: true as const } : {}) }))
    : input.findings;
  const asksBad = Array.isArray(input.findings) && input.findings.some((f) => f?.asks !== undefined && typeof f.asks !== "boolean");
  if (asksBad) throw new AnswerRefused("an expected finding's asks is true or false");
  const given = { product: input.product, text: clean(input.text), findings, marking: input.marking };
  // the checks and the append in one builder, so the product and the marking checked are the ones the entry is folded against
  session.commit((state) => {
    const problem = answerProblem(state, given, likelihood);
    if (problem !== null) throw new AnswerRefused(problem);
    const draft_hash = publishedProduct(state, given.product)!.draft_hash;
    const payload: Payloads["answer.known"] = { product: given.product, draft_hash, text: given.text, findings: given.findings, marking: given.marking };
    return [{ type: "answer.known", actor: input.actor, payload }];
  });
}

/** Writes answer.withdrawn by the person, with the reason, every secret value in it redacted. Throws AnswerRefused, writing nothing. */
export function withdrawKnownAnswer(session: CaseSession, deps: Pick<EngineDeps, "runner">, given: { product: number; reason: string; actor: Actor }): void {
  if (given.actor?.kind !== "human") throw new AnswerRefused("only a person withdraws a known answer");
  // redacted here, before the checks: the caller is not trusted to have done it
  const input = { ...given, reason: typeof given.reason === "string" ? redactSecrets(given.reason, deps.runner.secrets?.() ?? []) : given.reason };
  session.commit((state) => {
    if (!Object.hasOwn(state.answers, String(input.product))) throw new AnswerRefused(`there is no known answer for product ${String(input.product)}`);
    if (typeof input.reason !== "string" || input.reason.trim() === "") throw new AnswerRefused("withdrawing a known answer needs a reason");
    return [{ type: "answer.withdrawn", actor: input.actor, payload: { product: input.product, reason: input.reason } }];
  });
}

/** The products of a case that have a known answer now, by number: no text, no findings. */
export function answeredProducts(state: Readonly<CaseState>): { product: number; draft_hash: string; marking: Marking; seq: number; hash: string }[] {
  return Object.values(state.answers)
    .map((a) => ({ product: a.product, draft_hash: a.draft_hash, marking: a.marking, seq: a.seq, hash: a.hash }))
    .sort((a, b) => a.product - b.product);
}

/** The answer the entry at `at.seq` with hash `at.hash` holds; null when the ledger holds no such answer.known. The only reader of an answer's text and findings in src/pipeline and src/agents. */
export function knownAnswerOf(entries: readonly Entry[], at: { seq: number; hash: string }): { text: string; findings: ExpectedFinding[]; marking: Marking; product: number } | null {
  const entry = entries.find((e) => e.seq === at.seq);
  if (entry === undefined || entry.type !== "answer.known" || entry.hash !== at.hash) return null;
  // the answer as the fold took it at that entry: one it skipped (an agent's, a product not published) is no answer
  const held = Object.values(fold(entries as Entry[], at.seq).answers).find((a) => a.seq === at.seq && a.hash === at.hash);
  if (held === undefined) return null;
  return {
    text: held.text, findings: held.findings.map((f) => ({ claim: f.claim, likelihood: f.likelihood, confidence: f.confidence, ...(f.asks === true ? { asks: true as const } : {}) })),
    marking: held.marking, product: held.product,
  };
}

/**
 * Whether the person withdrew the known answer of `product` after the entry at `at.seq` (the one Select named): an answer.withdrawn of that
 * product the fold took (a person's), later in the ledger. A later answer.known replacing it is not a withdrawal: Select's entry is still read.
 */
export function withdrawnSince(entries: readonly Entry[], at: { seq: number }, product: number): boolean {
  const skipped = new Set(fold(entries as Entry[]).skipped.map((x) => x.seq));
  return entries.some((e) => e.seq > at.seq && e.type === "answer.withdrawn" && e.payload.product === product && !skipped.has(e.seq));
}

/** The likelihood terms of the standard a case's bound loop reads, least likely first: the scale a known answer's terms are checked against; null when it has none. */
export function answerScale(deps: Pick<EngineDeps, "profile" | "registry" | "components">): readonly string[] | null {
  const { profile, registry, components } = deps;
  const standard = profile.standard === null ? null : components !== undefined ? components.get("*", "standard", profile.standard) : registry.get("standard", profile.standard);
  const terms = termsOf(standard?.body ?? null)?.likelihood ?? [];
  return terms.length === 0 ? null : terms;
}
