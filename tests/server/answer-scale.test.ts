// Final review I6 (T19): the known-answer form offers the case's own standard's likelihood terms, which the server checks a term against.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SAMPLE_WINDOW } from "../../scripts/make-sample-data";
import { served } from "../helpers/served";
import type { Served } from "../helpers/served";

const TERMS = ["remote", "unlikely", "even", "likely", "certain"];
let s: Served;
beforeAll(async () => {
  s = await served({
    before: (root) => {
      // the device-check profile reads a standard of its own, whose terms are not the default profile's
      const std = readFileSync(join(root, "context", "standards", "icd203.yaml"), "utf8");
      const own = std.replace("id: icd203", "id: five-terms").replace(/likelihood:\n(?:  - .*\n)+/, `likelihood:\n${TERMS.map((t, i) => `  - { term: ${t}, range: [${i * 20}, ${i * 20 + 20}] }\n`).join("")}`);
      if (own === std || !own.includes("term: remote")) throw new Error("the sample's standard changed");
      writeFileSync(join(root, "context", "standards", "five-terms.yaml"), own);
      const p = join(root, "context", "device-check-profile.yaml");
      writeFileSync(p, readFileSync(p, "utf8").replace("standard: icd203", "standard: five-terms"));
    },
  });
});
afterAll(async () => { const d = s.dir; await s.close(); rmSync(d, { recursive: true, force: true }); });

test("a case's answer scale is its own loop's standard's terms, not the default profile's", async () => {
  expect(s.problems).toEqual([]);
  const id = await s.newCase({ loop: "device-check", title: "Device at 192.0.2.14", asked: "Which device held 192.0.2.14?", why: "sample", starting: [{ type: "address", value: "192.0.2.14" }], window: SAMPLE_WINDOW, objective: "sample-objective", marking: "TLP:GREEN" });
  const ref = (await (await s.get("/api/reference")).json()) as { likelihood: string[] };
  expect(ref.likelihood).not.toEqual(TERMS);
  const res = await s.get(`/api/cases/${id}/answer-scale`);
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ likelihood: TERMS });
  const other = await s.newCase({});
  expect(await (await s.get(`/api/cases/${other}/answer-scale`)).json()).toEqual({ likelihood: ref.likelihood });
}, 120_000);
