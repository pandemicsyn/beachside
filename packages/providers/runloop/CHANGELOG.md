# @beachside/runloop

## 0.12.0

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.12.0

## 0.11.0

### Minor Changes

- [#187](https://github.com/pandemicsyn/beachside/pull/187) [`ae8c05a`](https://github.com/pandemicsyn/beachside/commit/ae8c05aadf2841f734c9c66223043290d587b9ef) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Snapshots can carry labels. `snapshot({ labels })` sets them at capture where the adapter keeps them, and `snapshots.list({ labels })` keeps only matching snapshots.

  - **Adapters:** an adapter opts in with `snapshotCapture.labels: true`, and listed `SnapshotInfo` reports `labels`. Elsewhere a labelled capture is rejected before anything is captured.
  - **Capability:** `capabilities().snapshots.capture.value.labels` says whether labels are kept.
  - **Runloop:** labels are stored as snapshot metadata, next to the adapter's own `beachside_` keys, which stay reserved.
  - **Setup:** `box.runSetup()` takes `env` for every step, kept out of the digest, and `runStartup: false`, which records startup steps without running them so a snapshot can be taken in between.

  `Setup.parallel([...steps])` runs setup steps at the same time as one step; its steps' events and output carry `step.group`.

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

- [#152](https://github.com/pandemicsyn/beachside/pull/152) [`f9a0bb7`](https://github.com/pandemicsyn/beachside/commit/f9a0bb737f748b4114672fd070a4bf995e27248d) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `sandboxes.list()` items now carry `labels` (the labels set at create, without adapter markers; `null` where the provider keeps none) and `createdAt` (the provider's creation time, or `null`). Daytona, E2B, Vercel and Modal report labels; Daytona, E2B (start time), Vercel, boxd and Runloop report creation time. Adapters add them with the new `listedLabels` and `listedTime` helpers. The CLI's `ls --remote` shows both, and the new `beachside gc --label k=v [--older-than 2h] [--dry-run]` destroys provider-listed sandboxes whose labels match, such as those a killed CI job left behind, and drops their store records. Durations also accept days, like `1d`.

- [#146](https://github.com/pandemicsyn/beachside/pull/146) [`e513d9a`](https://github.com/pandemicsyn/beachside/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.

- [#156](https://github.com/pandemicsyn/beachside/pull/156) [`47f5b61`](https://github.com/pandemicsyn/beachside/commit/47f5b617a4749bf94c7c6dee2686fc90aa487c8b) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Rename the project to Beachside. Packages are `beachside` and `@beachside/*`; the exports are `Beachside`, `BeachsideClient`, `DirectBeachsideClient` and `BeachsideError`; list coverage `"sandbar-managed"` is now `"managed"`; telemetry spans and attributes use `beachside.*`. The CLI command is `beachside`, with settings in `~/.config/beachside/beachside.json` and `BEACHSIDE_*` environment variables. Labels, metadata and names written onto provider resources now use the `beachside` prefix, so resources created by earlier releases are no longer recognized.

- [#150](https://github.com/pandemicsyn/beachside/pull/150) [`e566711`](https://github.com/pandemicsyn/beachside/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - `snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.

- [#145](https://github.com/pandemicsyn/beachside/pull/145) [`6e83f0b`](https://github.com/pandemicsyn/beachside/commit/6e83f0bc04757101695536625566ff4e4198f3ee) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Stream command output on Runloop. `box.processes.start({ output: { mode: "stream" } })` delivers stdout and stderr as UTF-8 text from Runloop's server-sent log streams, reopening them from byte offsets, and `terminate()` kills the execution. Byte output, callback exec, piped stdin, terminals and reopening are not supported. Not yet tested against the live service.

- [#148](https://github.com/pandemicsyn/beachside/pull/148) [`29f6896`](https://github.com/pandemicsyn/beachside/commit/29f689625b95d054f6c291cf60f34f8c97a53484) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Accept the `snapshots: { preserve }` setup option on the Vercel and Runloop adapters, so the same setting works on every adapter with snapshots. `Preserve.FILESYSTEM` matches their filesystem-only snapshots; `Preserve.FILESYSTEM_AND_MEMORY` rejects at connect with `UNSUPPORTED` before any provider call.

### Patch Changes

- Updated dependencies [[`29f6896`](https://github.com/pandemicsyn/beachside/commit/29f689625b95d054f6c291cf60f34f8c97a53484), [`f9a0bb7`](https://github.com/pandemicsyn/beachside/commit/f9a0bb737f748b4114672fd070a4bf995e27248d), [`e513d9a`](https://github.com/pandemicsyn/beachside/commit/e513d9a81fdd57f62d85bc027e9a9db3e91b9883), [`47f5b61`](https://github.com/pandemicsyn/beachside/commit/47f5b617a4749bf94c7c6dee2686fc90aa487c8b), [`e566711`](https://github.com/pandemicsyn/beachside/commit/e56671186220a2c0345bdd8f9540af0de8b7d69e), [`4a074ab`](https://github.com/pandemicsyn/beachside/commit/4a074ab86d513b4b923a387692479f9011f0ba0e)]:
  - @beachside/adapter@0.8.0

## 0.7.0

### Minor Changes

- [#125](https://github.com/pandemicsyn/sandbar/pull/125) [`2cb4539`](https://github.com/pandemicsyn/sandbar/commit/2cb4539ee56c2c66036d91c9e6e551b4d97f82e7) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@sandbar-sdk/runloop` adapter for Runloop Devboxes: blocked egress by default through a managed deny-all network policy, argv/shell exec with exact output bytes and finite stdin, binary files, suspend/resume, disk snapshots with restore, authenticated or public previews, and portable `resources` sizing. The CLI recognizes `--provider runloop` with `RUNLOOP_API_KEY` and optional `RUNLOOP_NETWORK=internet`.

### Patch Changes

- Updated dependencies [[`43d2993`](https://github.com/pandemicsyn/sandbar/commit/43d2993dde9e28bfe068f6264670cccef5553daf)]:
  - @sandbar-sdk/adapter@0.7.0
