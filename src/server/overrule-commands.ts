// The person overrules a finding (slice 8): its likelihood, its confidence, or whether it stays, with a note. Code holds every draft to it.
import type { Schema } from "../core/schema";
import { CONFIDENCES } from "../core/types";
import type { Finding } from "../core/types";
import { defineCommand, thenAfter } from "./commands";

const str: Schema = { type: "string" };

defineCommand("overrule_finding", {
  args: {
    type: "object",
    properties: {
      finding: str, draft_hash: str, likelihood: { type: ["string", "null"] }, confidence: { enum: [...CONFIDENCES, null] }, stays: { type: ["boolean", "null"] }, note: str,
    },
    required: ["finding", "draft_hash", "likelihood", "confidence", "stays", "note"],
    additionalProperties: false,
  },
  then: thenAfter("overrule"),
  perform: ({ engine, actor }, a) => {
    engine.overrule({
      actor, finding: a.finding as string, draft_hash: a.draft_hash as string, likelihood: a.likelihood as string | null,
      confidence: a.confidence as Finding["confidence"] | null, stays: a.stays as boolean | null, note: a.note as string,
    });
  },
});
