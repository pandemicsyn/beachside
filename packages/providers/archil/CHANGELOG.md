# @beachside/archil

## 0.12.0

### Minor Changes

- [#190](https://github.com/pandemicsyn/beachside/pull/190) [`3560e72`](https://github.com/pandemicsyn/beachside/commit/3560e722369b48b64d3a689b784c200e0229f85e) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@beachside/archil` adapter for Archil Sandboxes, built on Archil's official `disk` SDK. It creates persistent Firecracker microVMs from OCI images or built image ids in a chosen region, with blocked egress by default (or Archil's managed allowlist on the Free plan), exact sizes and create-time environment variables; runs argv and shell commands with exact output bytes, finite stdin and a truncation bound; streams processes with byte output, piped stdin, signals, status and reopening; opens terminals on Archil's native PTY; reads and writes files of any size with streams, no-clobber writes, copy, move and metadata; pauses and resumes sandboxes with their memory, or stops and cold-boots them; renews the session deadline; captures memory-and-disk or disk-only snapshots as forks of a retained holder sandbox; builds images; manages Archil disks as volumes and mounts them at create; and returns protected previews with a token header or public previews. A create whose response is lost is found again by its name instead of being resent. The CLI gains an `archil` provider that reads `ARCHIL_API_KEY`, `ARCHIL_REGION` and an optional `ARCHIL_NETWORK` (`internet` or `archil-managed`).

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.12.0
