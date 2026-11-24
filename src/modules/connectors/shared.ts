import { SecretError } from "../secrets";
import type { Secrets } from "../secrets";
import { ConnectorError } from "./types";

// Below 0x20, DEL, the C1 controls and the Unicode line and paragraph separators.
export const CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/;

/** The value of a credential the registry allowed for this source, ready to send in a header. Anything unusable is a ConnectorError. */
export function loadCredential(secrets: Secrets, name: string): string {
  let value: string | null;
  try {
    value = secrets.get(name);
  } catch (err) {
    if (err instanceof SecretError) throw new ConnectorError(err.message);
    throw err;
  }
  if (value === null) throw new ConnectorError(`credential ${name} has no value in the environment or secrets file`);
  if (CONTROL.test(value)) throw new ConnectorError(`credential ${name} cannot be sent as a header value`);
  return value;
}
