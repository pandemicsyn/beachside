# @beachside/freestyle

## 0.15.0

### Minor Changes

- [#212](https://github.com/pandemicsyn/beachside/pull/212) [`6c5d263`](https://github.com/pandemicsyn/beachside/commit/6c5d2632ef0d8a6c02d35fcd826112822b4768f6) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Sandboxes now reach the internet unless you ask otherwise. boxd, E2B, Vercel, Modal, Runloop, Freestyle and Archil default to `network: "internet"` instead of `blocked`; set `network: "blocked"` or an allowlist to restrict egress. Daytona keeps its tier-managed `daytona-default`. Boat and exe.dev no longer require `network: "internet"` in setup, and the CLI no longer needs `BOAT_NETWORK` or `EXE_NETWORK`; `BOXD_NETWORK`, `RUNLOOP_NETWORK`, `FREESTYLE_NETWORK` and `ARCHIL_NETWORK` stay optional, for `blocked` or (Archil Free plan) `archil-managed`. An adapter that declares no `defaultNetworkPolicy` now defaults to `internet`, or to its only policy when `supports.network` lists one. Connections that relied on the old blocked default and reopen sandboxes created that way should set `network: "blocked"` explicitly.

### Patch Changes

- [#211](https://github.com/pandemicsyn/beachside/pull/211) [`8652541`](https://github.com/pandemicsyn/beachside/commit/86525413252c43b170eb5e086b5f859713aa2ca9) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Adapters can declare `setup`: the environment variable for each credential and config setting, a description, and a link to where a person gets it when there is one. `alternatives` lists credentials that stand in for each other (exe.dev takes an API key or an SSH key). Every official adapter now declares its own, and the CLI reads them from the installed adapter instead of keeping its own table, so third-party adapters that declare `setup` get environment-only settings too. Missing-setting errors and `beachside providers` link to where each value comes from, and `providers` lists the profiles that use each provider. Its JSON rows add `known` (false when the adapter failed to load or declares no setup, in which case `missingEnv` is empty and the text says the settings are unknown) and `needs`, with each missing value's description and link.

  New `beachside profile ls | show | use | rm` commands list profiles, explain where each setting comes from without revealing credentials, change the default and remove profiles. `profile show` reports `ready` (true, false, or null when the adapter declares no setup) and what the profile still `needs`. `use` and `rm` rewrite `beachside.json` atomically under a lock, keeping its file mode. `profile rm` refuses while stored sandboxes, snapshots or images use the profile, unless `--force`.

  `beachside.json` has a published JSON Schema (https://beachside.run/schema/beachside.json, also printed by `beachside schema config`), and the file accepts a `$schema` key so editors can complete and check it. The schema requires each profile to name a `provider` or a `module`.

  `beachside doctor` now checks that the provider accepts the credentials with one read of its sandbox listing. A rejected key exits 5 (`UNAUTHENTICATED` or `FORBIDDEN`) with the profile name and where to get a new key, here and on any command that connects, instead of an internal error with an unknown outcome.

  `beachside providers` no longer marks boxd and Freestyle experimental, and lists providers in the docs' order.

- Updated dependencies [[`8652541`](https://github.com/pandemicsyn/beachside/commit/86525413252c43b170eb5e086b5f859713aa2ca9), [`6c5d263`](https://github.com/pandemicsyn/beachside/commit/6c5d2632ef0d8a6c02d35fcd826112822b4768f6)]:
  - @beachside/adapter@0.15.0

## 0.14.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.14.0

## 0.13.0

### Minor Changes

- [#194](https://github.com/pandemicsyn/beachside/pull/194) [`f95dce3`](https://github.com/pandemicsyn/beachside/commit/f95dce3c58353ed8ea14b23c5205f1619e4e374b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Egress allowlists: set `network: { allow: ["registry.npmjs.org", "*.github.com", "10.0.0.0/8"] }` in adapter setup to let sandboxes reach only those hosts and IPv4 ranges. Supported on E2B, Vercel, Modal, Runloop, Archil (paid plans), Daytona (Tier 3+; hosts or ranges, not both) and Freestyle (IPv4 ranges only); where the provider reports the list back, the adapter checks it recorded exactly that list. Modal also gains `network: "internet"`; it previously always blocked egress.

### Patch Changes

- [#205](https://github.com/pandemicsyn/beachside/pull/205) [`d37c0c8`](https://github.com/pandemicsyn/beachside/commit/d37c0c8a0c3688c93f93d100abc71bd2d3b4273e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Freestyle is now a supported provider, out of experimental in the docs and on the landing page. `makeDirectory` on an existing file now rejects with INVALID_ARGUMENT and no effect, recursive or not, instead of an unknown outcome.
- Updated dependencies [[`f95dce3`](https://github.com/pandemicsyn/beachside/commit/f95dce3c58353ed8ea14b23c5205f1619e4e374b), [`9e3ab39`](https://github.com/pandemicsyn/beachside/commit/9e3ab396c38a718c9f26693073d6b6c93ad80972), [`f89fde4`](https://github.com/pandemicsyn/beachside/commit/f89fde43eb1e548fad65c5da7b8e2c9328b62383)]:
  - @beachside/adapter@0.13.0

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.12.0

## 0.11.0

### Patch Changes

- Updated dependencies [[`ae8c05a`](https://github.com/pandemicsyn/beachside/commit/ae8c05aadf2841f734c9c66223043290d587b9ef)]:
  - @beachside/adapter@0.11.0

## 0.10.0

### Minor Changes

- [#174](https://github.com/pandemicsyn/beachside/pull/174) [`60a6777`](https://github.com/pandemicsyn/beachside/commit/60a67770ad6c0f31f2c21279c8018bed4ea275e3) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@beachside/freestyle` adapter for Freestyle VMs, built on Freestyle's official `freestyle` SDK. It creates Ubuntu microVMs from Freestyle snapshots with blocked egress by default and create-time environment variables; runs argv and shell commands with exact output bytes and finite stdin; streams processes with byte output, piped stdin, signals, status and reopening; opens terminals on Freestyle PTY sessions; reads and writes files of any size with streams, no-clobber writes, copy, move and metadata; captures and restores memory-and-disk snapshots with expiry, and lists snapshots as images; pauses and resumes VMs with their memory; renews their lifetime; publishes preview ports on public `style.dev` URLs; and lists VMs with their labels. A create or capture whose response is lost is found again by its slug instead of being resent. The CLI gains a `freestyle` provider that reads `FREESTYLE_API_KEY` and an optional `FREESTYLE_NETWORK`.

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.10.0
