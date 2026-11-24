---
kind: readme
id: sample
title: Sample module root
---
# Sample module root

Synthetic data with one planted story, for tests and demos. Everything here is invented: reserved
example addresses (192.0.2.x, 198.51.100.x, 203.0.113.x), example.com/.net/.org names and made-up accounts.

- Generate the data (written to `sample/data/`, not committed): `bun run sample:data`
- Start the stand-in reputation service on 127.0.0.1:4801: `bun run sample:fixture`

The story: account `j.doe` signs in to `ws-17.example.net` from an address it has never used, and minutes
later that workstation starts calling `198.51.100.77` every ten minutes. Start from that address.
