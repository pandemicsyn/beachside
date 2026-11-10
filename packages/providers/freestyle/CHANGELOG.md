# @beachside/freestyle

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
