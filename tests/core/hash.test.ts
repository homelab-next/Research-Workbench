import { expect, test } from "bun:test";
import { GENESIS, sha256Hex } from "../../src/core/hash";

test("hashes a known vector", () => {
  expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
});
test("hashes bytes and text the same", () => {
  expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
});
test("genesis is 64 zeros", () => {
  expect(GENESIS).toBe("0".repeat(64));
});
