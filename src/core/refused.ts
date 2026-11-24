/**
 * The one base class of every refusal the workbench throws for a request it will not carry out (a command to the engine, an edit, a publish, a
 * feedback). `reasons` is what a caller may show a person; it defaults to the message.
 */
export class Refused extends Error {
  readonly reasons: string[];
  constructor(message: string, reasons?: string[]) {
    super(message);
    this.name = "Refused";
    this.reasons = reasons ?? [message];
  }
}
