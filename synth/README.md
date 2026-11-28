# synth/: the overlay of a synthetic setup

Everything here is synthetic. `bun run synth build <synth> --scripted` (or `--base-url URL --model ID`) builds a self-contained setup in a
new or empty folder outside this repository: pivot's fake lake (`lake.sqlite`), a root over it, the ground truth beside them (`truth/`, never
inside the root), an empty data folder, `config.yaml` and `synth.json`.

The root is made in this order: pivot's synthetic catalogue (thirteen `fakeathena` sources, their pivots and types, the mess's quality
notes); the generic half of `sample/` (`context/`, `checks/`, `stages/`, the loops `investigation` and `improve`, `models/`), every stage
pointed at the setup's model; then `synth/root/` of this repository, copied over it. Nothing else of the sample is copied: none of its
sources, inventories, playbooks, scripts, data, memory or case types.

`synth/root/` holds:

- `case-types.yaml`: the five case types the storylines are grouped in (`suspicious-signin`, `suspicious-process`, `large-transfer`,
  `unknown-device`, `cloud-activity`).

A `--scripted` setup's stages name the scripted model `synth-run`, which is not shipped: a script holding a truth's wording does not belong in
a root, so a test or a demo writes `<synth>/root/scripts/synth-run.yaml` itself.

Every other form (`show`, `tasks`, `answer`, `seed-tasks`) takes `--config <synth>/config.yaml` and refuses a configuration with no
`synth.json` beside it, so a synthetic case is never made in a real data folder.
