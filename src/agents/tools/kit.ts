import type { Json } from "../../core/canonical";
import type { Schema } from "../../core/schema";

/** A tool's own failure. It becomes a result with ok false; it is never thrown past execTool. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

/** The one place every tool's parameter schema is built, so each has `why` and refuses unknown arguments. */
export function params(properties: Record<string, Schema> = {}, required: string[] = []): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["why", ...required],
    properties: { why: { type: "string", minLength: 1, description: "why you are doing this, in a sentence" }, ...properties },
  };
}

export const json = (x: unknown): Json => x as Json;
export const str = (v: Json | undefined): string => (typeof v === "string" ? v : "");

export const TOOL_VIEW_CHARS = 6000;
export const VIEW_ROWS = 20;
