# @beachside/exe-dev

## 0.14.0

### Minor Changes

- [#204](https://github.com/pandemicsyn/beachside/pull/204) [`6f3a1fc`](https://github.com/pandemicsyn/beachside/commit/6f3a1fc4a66eed9d078b5bb6075c837b754e4113) Thanks [@pandemicsyn](https://github.com/pandemicsyn)! - Add the experimental `@beachside/exe-dev` adapter for exe.dev VMs, built on exe.dev's official `@exedev/sdk`. It connects with an API token, an Ed25519 SSH key that signs short-lived tokens locally, or both; creates tagged VMs from OCI images (default `exeuntu`) with whole-vCPU sizes, the account's default placement, standalone VMs or a named pool, labels kept in the VM comment and create-time environment variables; runs argv and shell commands with exact output bytes, finite stdin and a truncation bound; streams processes with byte output, piped stdin, signals, status and reopening; reads and writes files of any size with streams, no-clobber writes, copy, move and metadata; pauses and resumes VMs with their memory; forks a VM with `cp`; and returns protected previews with a signed token header or public previews. A create whose response is lost is found again by its name instead of being resent. The CLI gains an `exe-dev` provider that reads `EXE_API_KEY` and `EXE_NETWORK=internet`.

### Patch Changes

- Updated dependencies []:
  - @beachside/adapter@0.14.0
