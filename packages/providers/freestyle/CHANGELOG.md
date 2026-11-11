# @beachside/freestyle

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
