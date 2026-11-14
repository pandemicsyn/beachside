# @beachside/boat

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

- [#196](https://github.com/pandemicsyn/beachside/pull/196) [`9e3ab39`](https://github.com/pandemicsyn/beachside/commit/9e3ab396c38a718c9f26693073d6b6c93ad80972) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Previews on more providers. Daytona's `preview: { access: "public" }` now returns an expiring signed URL for one port (`preview.expiresInSeconds`, default 1 hour) instead of rejecting, and previews gain an optional `expiresAt`. Modal gets `box.preview(port)`: protected by default through a connect token sent as a bearer header, or public tunnels for `preview.ports` declared at create (public tunnels need `network: "internet"` or an allowlist, because Modal refuses open ports on a blocked network). Boat gets public previews through its host-port API.

### Patch Changes

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

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.10.0

## 0.9.0

### Minor Changes

- [#159](https://github.com/pandemicsyn/beachside/pull/159) [`d137e90`](https://github.com/pandemicsyn/beachside/commit/d137e90e8f7bc271713c8b0776605bf4996196c2) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Make provider setup consistent. Every first-party package now exports its definition as `<provider>Adapter` and a factory named after the provider: `boxd()`, `boat()`, `runloop()`, `modal()` and `vercel()` join `daytona()` and `e2b()`. Docs, examples and skills show the split form, `Beachside.connect({ adapter, credentials, config })`, which works for every adapter.

  Breaking for Vercel: the definition is now `vercelAdapter`, and `vercel` is the factory. Replace `adapter: vercel` with `adapter: vercelAdapter`, or call `Beachside.connect(vercel({ token, teamId, projectId }))`. Passing a factory where a definition belongs now fails with `INVALID_ARGUMENT` and names both forms.

### Patch Changes

- Updated dependencies [[`d137e90`](https://github.com/pandemicsyn/beachside/commit/d137e90e8f7bc271713c8b0776605bf4996196c2)]:
  - @beachside/adapter@0.9.0

## 0.8.0

### Minor Changes

- [#147](https://github.com/pandemicsyn/beachside/pull/147) [`0aa1ccf`](https://github.com/pandemicsyn/beachside/commit/0aa1ccffe036e90cc97c412a6da622239f04ce7e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Boat snapshots: `box.snapshot()` saves the disk of a running or archived sandbox as a Boat named snapshot under a unique `beachside-snapshot-*` name, and `client.snapshots` inspects, lists, restores and deletes them. References pin the captured artifact, so a name saved again outside Beachside rejects with `CONFLICT` instead of restoring or deleting the new contents. Restores boot a fresh machine of the captured type. Setup accepts `snapshots: { preserve }` and `lifecycle: { suspension: { preserve } }`: Boat keeps the disk only, so `Preserve.FILESYSTEM` is accepted and `Preserve.FILESYSTEM_AND_MEMORY` fails with `UNSUPPORTED` at connect, before any provider call.

- [#144](https://github.com/pandemicsyn/beachside/pull/144) [`a2556c0`](https://github.com/pandemicsyn/beachside/commit/a2556c0c34f5062e0f01ea78cc67524adf429f96) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stream command output on Boat. `box.processes.start({ output: { mode: "stream" } })` starts the command detached, without Boat's 600-second limit, and delivers stdout and stderr as UTF-8 text as Boat sends it, reattaching from byte offsets when Boat ends a connection after 10 minutes. `terminate()` stops the command. Byte output, callback exec, piped stdin, terminals and reopening are not supported.

- [#146](https://github.com/pandemicsyn/beachside/pull/146) [`e513d9a`](https://github.com/pandemicsyn/beachside/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#156](https://github.com/pandemicsyn/beachside/pull/156) [`47f5b61`](https://github.com/pandemicsyn/beachside/commit/47f5b617a4749bf94c7c6dee2686fc90aa487c8b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Rename the project to Beachside. Packages are `beachside` and `@beachside/*`; the exports are `Beachside`, `BeachsideClient`, `DirectBeachsideClient` and `BeachsideError`; list coverage `"sandbar-managed"` is now `"managed"`; telemetry spans and attributes use `beachside.*`. The CLI command is `beachside`, with settings in `~/.config/beachside/beachside.json` and `BEACHSIDE_*` environment variables. Labels, metadata and names written onto provider resources now use the `beachside` prefix, so resources created by earlier releases are no longer recognized.

- [#150](https://github.com/pandemicsyn/beachside/pull/150) [`e566711`](https://github.com/pandemicsyn/beachside/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/beachside/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/beachside/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/beachside/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`47f5b61`](https://github.com/pandemicsyn/beachside/commit/47f5b617a4749bf94c7c6dee2686fc90aa487c8b), [`e566711`](https://github.com/pandemicsyn/beachside/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/beachside/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @beachside/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#122](https://github.com/pandemicsyn/sandbar/pull/122) [`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept `resources: { vcpus, memoryMiB }` minimums and report the real size on inspect. boxd, Vercel and Boat pick their smallest native size that meets them and reject at connect, before any provider request, when none does; the old `size`, `vcpus` and `machine` keys stay as deprecated aliases. Daytona and E2B build OCI snapshots and templates at that size and reject a prepared snapshot or template that is smaller or does not report its size, including E2B's `base` template.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0

## 0.6.0

### Patch Changes

- Updated dependencies [[`22e06ed`](https://github.com/pandemicsyn/sandbar/commit/22e06ed1fc0275fd68fd959ea4ece091f4bed180), [`7fc61f8`](https://github.com/pandemicsyn/sandbar/commit/7fc61f8a36bd7ec7973546d630d4b567bb0cfdbc), [`3a8c047`](https://github.com/pandemicsyn/sandbar/commit/3a8c04763ad7804f689c00f355683e235bc00206)]:
  - @sandbar-sdk/adapter@0.6.0

## 0.5.0

### Minor Changes

- [#116](https://github.com/pandemicsyn/sandbar/pull/116) [`67bc9dd`](https://github.com/pandemicsyn/sandbar/commit/67bc9dd739f4f6020dfb92385bdbff4eb12d112e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/boat` adapter for Boat full-VM sandboxes: create with an idempotency key, argv/shell exec with exact output bytes and finite stdin, binary files up to 5 MiB, archive/resume, renewal and confirmed permanent delete. The CLI recognizes `--provider boat` with `BOAT_API_KEY` and `BOAT_NETWORK=internet`.

### Patch Changes

- Updated dependencies []:
  - @sandbar-sdk/adapter@0.5.0
