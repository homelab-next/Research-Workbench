# A synthetic company

A synthetic setup is a workbench of its own over an invented company: a fake lake with its noise, its mess and nine planted storylines, a
root over that lake, and a ground truth for each storyline kept where no query and no model can reach it. It exists to practise
investigations and to measure loops against answers that are known. Everything in it is synthetic: its people, hosts, vendors and domains
(`*.example`) are invented, its outside addresses are in the documentation ranges, and its internal addresses are computed by the generator
and never written out. The commands are in the README's section "A synthetic company"; what keeps it apart from your own data is in
[security-notes.md](security-notes.md).

`<synth>` below is the folder a setup is built in, `<data>` its data folder (`<synth>/data`), `<repo>` this repository and `<lake>` your own
lake, which nothing here touches.

## What a setup holds

`bun run synth build <synth> --scripted` (or `--base-url URL --model ID`) builds, in a new or empty folder outside `<repo>`:

- `<synth>/lake.sqlite`: the lake, one SQLite file whose `_lake_meta` says `kind = pivot-synthetic-lake` and `format = 1`, with the
  parameters and a digest of its rows. The same parameters give the same file.
- `<synth>/root/`: pivot's synthetic catalogue (thirteen `fakeathena` sources, their pivots, ten observable types, four inventories, the
  declared mess as quality notes), the generic half of the sample (context, checks, stages, the loops `investigation` and `improve`), every
  stage pointed at the setup's model, then this repository's `synth/root/` over it: the five case types, the objective of a synthetic case
  and the seed loop `synth-seed`.
- `<synth>/truth/`: one ground-truth file a storyline (`<storyline>.json`) and `mess.json`. Never inside the root.
- `<synth>/data/`, `<synth>/config.yaml` (its own data folder, its one trusted root, port 4757) and `<synth>/synth.json`, which says the
  folder is a synthetic setup and which every other form of `bun run synth` looks for.

## The thirteen sources

One table each, all in the one lake file. Seven are costly, five are free, and one bills a fixed price a lookup.

| Source | Table | What it is for | Cost |
|---|---|---|---|
| `signins` | `signins` | Every sign-in to the company's applications: who, from where, whether it worked and whether it passed MFA. | costly |
| `groups` | `group_members` | Which directory groups each account belongs to, and since when. | free |
| `process` | `process_start` | Every program the endpoint agent saw start on a host, with its command line and hash. | costly |
| `dns` | `dns` | The names clients asked the resolvers for, on the corporate and the guest networks, and what came back. | costly |
| `proxy` | `proxy` | The web requests workstations made through the proxy: who, to where, how much each way. | costly |
| `flows` | `flows` | The connections the firewalls saw: from where, to where, on which port and how much. | costly |
| `dhcp` | `dhcp_leases` | The addresses the DHCP servers handed out, to which MAC and under which host name. | free |
| `wifi` | `wifi_events` | The WiFi controllers' connect and disconnect events, naming the device and the access point. | free |
| `email` | `email` | The mail the gateway handled: sender, recipient, subject, link, attachment and what it did. | costly |
| `cloud` | `cloud_audit` | The calls made to the company's cloud account: who, what action, on what, from where. | costly |
| `vulns` | `vuln_findings` | What the weekly vulnerability scan found on each host. | free |
| `assets` | `assets` | Every corporate host: its name, address, MAC, owner, site and role. | free |
| `reputation` | `reputation` | What third-party feeds say about outside addresses, domains and hashes. | 0.002 USD a lookup |

The event tables are guarded as a lake's are: one select, alone, whose where clause begins with the time column against the request's two
window ends. `groups` and `assets` have no time column. Every column has field notes (what it means and what else it reveals). The lake
speaks SQLite's SQL; a statement written for another engine is refused, not translated.

## The nine storylines

Each storyline is a case of one of five case types. They are listed here by id only: a storyline's title, and whether it is malicious or a
benign look-alike, are its answer.

| Storyline | Case type |
|---|---|
| `password-spray` | `suspicious-signin` |
| `vpn-travel` | `suspicious-signin` |
| `phish-chain` | `suspicious-process` |
| `crypto-miner` | `suspicious-process` |
| `it-admin` | `suspicious-process` |
| `insider-exfil` | `large-transfer` |
| `backup-job` | `large-transfer` |
| `smart-tv` | `unknown-device` |
| `cloud-key` | `cloud-activity` |

Several are look-alikes of one another on purpose: a case type holds both a harmful story and a harmless one where it can. `bun run synth
build` and `bun run synth show` print storyline ids, counts and the cases each became, never a verdict or a title. `bun run synth show
--config <synth>/config.yaml --reveal` prints each storyline's verdict and truth summary, after a warning line that this spoils the cases:
do not show it to whoever works them.

## The mess

Real logs are messy, and so is the lake. Seven rules change the noise, each recorded in `<synth>/truth/mess.json`:

- **Declared** (each a quality note in its source's manifest, so an agent can read it): a six-hour logging gap in `proxy`; a four-hour
  window of `dns` written twice; no `flows` collected at the last site (partial coverage); the WiFi controllers' clocks seven minutes fast.
- **Declared as completeness**: DNS is complete for the corporate networks and partial for the guest network. The root says so where pivot
  says completeness, with two inventories (`dns-corp`, complete, with its basis; `dns-guest`, not complete) and a pivot for each.
- **Not declared**, because finding them is the work: a workstation renamed half-way through the period (the asset list holds only its new
  name), and a device that shows a new randomised MAC each day on `dhcp` and `wifi`.

The mess never removes a storyline's own evidence, unless the storyline names the rule under `mess:` on purpose, and then its ground truth
says so.

## How a query is priced

`fakeathena` bills as a scanning lake does, by the simulated bytes a statement reads. Each day partition of a table weighs `rows * row_bytes *
scale` (scale 50000 by default). For a statement:

1. The days read are those the request's window touches, from `window.from` to the last millisecond before `window.to`; an open end reads
   every day. A table with no time column is one partition.
2. Of each table it names, the share read is the columns it names as whole words over all the table's columns (`select *` names them all;
   at least one).
3. `bytes_scanned = ceil(partition bytes * named columns / all columns)`, summed over the tables; `billed = max(bytes_scanned, 10 000 000)`.
4. `usd = round(billed * 5 / 1 000 000 000 000 * 1 000 000) / 1 000 000`: 5 USD a terabyte (10^12 bytes), at least 10 MB a query, rounded
   once to a millionth of a dollar. A source may set its own `cost.per_tb`. `reputation` costs `cost.per_lookup` (0.002 USD) a query,
   whatever it scans.

A worked example. A table has 10 columns, and each of its day partitions weighs 50 000 000 000 simulated bytes. A statement that names 4 of
its columns, over a window of 3 days, scans 3 × 50 000 000 000 × 4 / 10 = 60 000 000 000 bytes. That is over the 10 000 000 minimum, so it
is billed as it is: 60 000 000 000 × 5 / 1 000 000 000 000 = 0.3 USD. The same statement over one day costs 0.1 USD; one that scans
2 000 000 bytes is billed 10 000 000 and costs 0.00005 USD.

An estimate is a query of its own, `EXPLAIN (TYPE IO, FORMAT JSON) <statement>`, issued and recorded by the runner (purpose `estimate`) and
answered from the lake's partition list without running the statement. So a costly step at the plan gate shows its price in USD before
anything runs, a narrower window shows a lower price, and the price a result reports is the price that was estimated. Every stored result
holds what it scanned (`stats` beside its columns and rows). A step on a costly source waits for the budget you give it at the plan gate, and
a budget below the estimate runs nothing.

## Where the ground truth is kept, and who may read it

- The build writes it to `<synth>/truth/`, beside the lake and the root, never in either: no query and no root file reaches it.
- `bun run synth tasks` makes a case for each storyline's public task (its title, question, starting values and window; the title starts
  with `[synthetic] `, the marking is `TLP:GREEN` unless `--marking` says otherwise, and the case carries the setup's objective, which names no
  verdict and no storyline). It writes that storyline's truth to `<data>/synth-truth/<case>/ground-truth.json`, with the case's id and the hash
  of its first entry. That is beside the cases folder, not in the case's own folder, so the truth never travels in a case file.
- `bun run synth answer CASE-N` reads that file, checks it was written for this very case, and sets the known answer of the case's latest
  published product, as you, through the same `setKnownAnswer` that `bun run improve answer` uses.
- Only `src/synth/tasks.ts`, `answer.ts` and `seed.ts` read a ground truth, and only a person's command runs them. No stage, agent, server
  route or page imports `src/synth/`. From then on the truth is a known answer like any other: the improve loop's Judge is the one stage that
  reads it, after the choice is made.

## What a seeded task is, and why its product judges nothing

`bun run synth seed-tasks` makes, for each storyline, a case of the loop `synth-seed` (Frame, Plan, Research, Assemble, Checks, Publish) on a
scripted model whose script the build wrote from each storyline's public task alone. The plan has one free lookup on the storyline's seed
route; the command accepts the plan with no budget and approves the product, as you, through the engine calls `investigate accept-plan` and
`investigate approve` use. Then it sets the known answer from the truth. So each storyline has a published case with a known answer: a task
the improve loop can select, at once, with nothing costly run.

The product says only that the lookup was run, and judges nothing (`roughly even chance`, `low`). It is deliberately not the answer: the
improve loop's Select copies a task's published product into what Propose is told, so a product that stated the truth would hand it to a
model. The known answer alone holds the truth.

## How to add a storyline

A storyline is one YAML file in pivot's `synth/storylines/` (`kind: storyline`), and needs no code:

- `id`, `title`, `malicious`, `case_type` (one of the five), `span_days` and `start` (`earliest`, `latest` as fractions of the period, and
  an `hour`);
- a `cast` drawn from the company (`pick: user | host | site | external_address | external_domain | access_point | new_device | sha256`,
  with `where`, `count` and `distinct_from`), named by role, never by an address;
- `events`: a table, a time as an offset from the storyline's start, an optional `repeat`, and a row of templates such as
  `{{victim.account}}` (a host or new device also has `{{<member>.mac_tail}}`);
- optionally `quiet:` (a cast member and the days the noise writes no row for it in the named tables) and `mess:` (a drop rule it opts into,
  which its truth must then name);
- a `task`: what the analyst is asked (title, question, starting values, window, the type wanted, and a free `seed_route`);
- a `truth`: summary, entities and expected findings, each with a likelihood term and a confidence, within the limits of a known answer
  (600 characters, 12 findings, 300 characters a claim).

pivot checks a storyline when it loads, so an answer is never refused later. A storyline longer than the period is left out of a build and
named in its report. In the workbench its `case_type` must be one of the five of `synth/root/case-types.yaml`: a build checks that the root
has exactly those.
