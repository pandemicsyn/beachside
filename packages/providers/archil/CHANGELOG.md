# @beachside/archil

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

- [#198](https://github.com/pandemicsyn/beachside/pull/198) [`f89fde4`](https://github.com/pandemicsyn/beachside/commit/f89fde43eb1e548fad65c5da7b8e2c9328b62383) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add `box.fork()`, `box.submitFork()` and `box.checkFork()`. A fork copies a running sandbox with the provider's native fork; adapters without one reject with `UNSUPPORTED`, and Beachside never emulates a fork with a snapshot and restore. `capabilities().fork` reports what a fork keeps, how the source is interrupted, whether processes resume and whether the fork's lifecycle is independent. boxd, E2B and Archil fork natively with memory and running processes. Adapters declare a fork with the new `sandboxFork` session hook; uncertain forks recover through operation kind `sandbox_fork`.

### Patch Changes

- Updated dependencies [[`f95dce3`](https://github.com/pandemicsyn/beachside/commit/f95dce3c58353ed8ea14b23c5205f1619e4e374b), [`9e3ab39`](https://github.com/pandemicsyn/beachside/commit/9e3ab396c38a718c9f26693073d6b6c93ad80972), [`f89fde4`](https://github.com/pandemicsyn/beachside/commit/f89fde43eb1e548fad65c5da7b8e2c9328b62383)]:
  - @beachside/adapter@0.13.0

## 0.12.0

### Minor Changes

- [#190](https://github.com/pandemicsyn/beachside/pull/190) [`3560e72`](https://github.com/pandemicsyn/beachside/commit/3560e722369b48b64d3a689b784c200e0229f85e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@beachside/archil` adapter for Archil Sandboxes, built on Archil's official `disk` SDK. It creates persistent Firecracker microVMs from OCI images or built image ids in a chosen region, with blocked egress by default (or Archil's managed allowlist on the Free plan), exact sizes and create-time environment variables; runs argv and shell commands with exact output bytes, finite stdin and a truncation bound; streams processes with byte output, piped stdin, signals, status and reopening; opens terminals on Archil's native PTY; reads and writes files of any size with streams, no-clobber writes, copy, move and metadata; pauses and resumes sandboxes with their memory, or stops and cold-boots them; renews the session deadline; captures memory-and-disk or disk-only snapshots as forks of a retained holder sandbox; builds images; manages Archil disks as volumes and mounts them at create; and returns protected previews with a token header or public previews. A create whose response is lost is found again by its name instead of being resent. The CLI gains an `archil` provider that reads `ARCHIL_API_KEY`, `ARCHIL_REGION` and an optional `ARCHIL_NETWORK` (`internet` or `archil-managed`).

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.12.0
