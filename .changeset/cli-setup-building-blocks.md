---
"@beachside/adapter": minor
"@beachside/cli": minor
"@beachside/boxd": patch
"@beachside/freestyle": patch
"@beachside/daytona": patch
"@beachside/e2b": patch
"@beachside/vercel": patch
"@beachside/boat": patch
"@beachside/runloop": patch
"@beachside/archil": patch
"@beachside/exe-dev": patch
"@beachside/modal": patch
---

Adapters can declare `setup`: the environment variable for each credential and config setting, a description, and a link to where a person gets it. Every official adapter now declares its own, and the CLI reads them from the installed adapter instead of keeping its own table, so third-party adapters that declare `setup` get environment-only settings too. Missing-setting errors and `beachside providers` link to where each value comes from, and `providers` lists the profiles that use each provider.

New `beachside profile ls | show | use | rm` commands list profiles, explain where each setting comes from without revealing credentials, change the default and remove profiles. `profile rm` refuses while stored sandboxes, snapshots or images use the profile, unless `--force`.

`beachside.json` has a published JSON Schema (https://beachside.run/schema/beachside.json, also printed by `beachside schema config`), and the file accepts a `$schema` key so editors can complete and check it.

`beachside doctor` now checks that the provider accepts the credentials with one read of its sandbox listing. A rejected key exits 5 (`UNAUTHENTICATED` or `FORBIDDEN`) with the profile name and where to get a new key, here and on any command that connects, instead of an internal error with an unknown outcome.

`beachside providers` no longer marks boxd and Freestyle experimental, and lists providers in the docs' order.
