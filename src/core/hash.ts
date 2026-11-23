export const GENESIS: string = "0".repeat(64);

export function sha256Hex(data: string | Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}
