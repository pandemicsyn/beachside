# @beachside/archil

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
