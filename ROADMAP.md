# Beachside roadmap

Updated November 10, 2026, at version 0.10.0. This is the only work queue. Contracts live in [specs](specs/README.md), public usage lives in [the docs](apps/docs/README.md), and live test results live on the [provider support page](apps/docs/src/content/docs/docs/providers/support.md). A merged feature and a live pass are separate facts.

## In progress

| Work                                            | Where it stands                                                                                                                                                                                                                                                                                                                                                                                                    | Tracking         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| **pi extension** (`@beachside/pi`)              | Runs pi's built-in tools in a Beachside sandbox, one sandbox per pi session, chosen by a CLI profile. The PR is open and in review. Review asks: create sandboxes through the same recorded create the CLI uses (so `maxSandboxes` and sandbox records apply), share one SDK label convention, and renew sandboxes while the session is active.                                                                    | #162, PR #176    |
| **pi branch sync**                              | Sync a GitHub branch per pi session. Starts after v1 lands.                                                                                                                                                                                                                                                                                                                                                        | #163             |
| **Servers inside sandboxes** (Rex, herdr, Orca) | `beachside create --with rex\|herdr` is in review (#184), live-verified on boxd, E2B and Freestyle. Rex runs on its own built-in Tailscale; herdr gets a userspace Tailscale SSH device. Add-ons are recorded on the sandbox (no provider label), `create` and `inspect` print how to connect, and `rm` logs each device out. Next: `--with orca`, and `--tailnet` plus `beachside ssh` for SSH without an add-on. | #166, #181, #184 |
| **Orca**                                        | Per-workspace environment recipes for every provider: `beachside orca create\|suspend\|resume\|destroy`, then an Orca plugin. Plugin defaults are a public preview URL (server mode) or SSH; Tailscale is opt-in through the add-on above.                                                                                                                                                                         | #165, #166       |
| **Archil adapter** (`@beachside/archil`)        | Experimental adapter for Archil Sandboxes, built on the research in #188: commands, processes, terminals, files, previews, pause/resume, fork-based snapshots, image builds and disk volumes. Tested against a simulated Archil API; no live pass yet.                                                                                                                                                             |
| **OpenCode 2 example**                          | A box example that runs OpenCode 2 in a sandbox.                                                                                                                                                                                                                                                                                                                                                                   | PR #155          |

## Next

- **Add-on follow-ups:** `attach` with keep-alive, `renew`, minting one Tailscale key per sandbox from an OAuth client, and hooks that bring servers back after resume and clear tailnet and pairing state before a snapshot. Deferred until the first `--with` build ships.
- **Setup scripts:** one `setup` key in the SDK and CLI for scripts and command lists run in a new sandbox, plus `startup` for every boot without processes (restore, filesystem-only resume). Named, provider-neutral `setups` in `beachside.json` (`--setup node`, `--setup ./setup.sh`, `--setup-cmd`), run by Beachside over `exec` with live output, recorded by digest so restores skip finished setup and `--if-not-exists` checks it. `--with` add-ons move onto the same engine. Later: `--cache`, which snapshots after setup and restores that snapshot for the same digest. Design only. (#185)
- **Secrets:** a `secret(value, { for: "github" })` helper backed by a pluggable credential broker, so tokens reach a sandbox without being written into it. Design only.
- **Live tests for experimental adapters:** Vercel, Boat, Runloop, Freestyle, Archil and Modal have no live passes yet. See [qualification gaps](#qualification-gaps).
- **Rebrand cleanup:** deprecate the old `@sandbar-sdk/*` npm packages and redirect the old docs domain.

## Shipped

### Rename and releases

- The project is now **Beachside**: npm `beachside` and `@beachside/*`, CLI `beachside`, docs at [beachside.run](https://beachside.run) (#156, #157). It was a clean break with no compatibility layer for old names. 0.8.0 was the first release under the new name.
- Version PRs and tag-on-merge releases are automated (#105, #119). Every package releases together.

### Providers

boxd (#82, #102), Daytona and E2B are supported and live-tested. Vercel Sandbox (#93, #103), Boat (#116, #147), Runloop (#125, #145), Modal (#126, #132, #141) and Freestyle VMs (#174) are experimental.

- **Setup is the same everywhere:** `Beachside.connect({ adapter, credentials, config })`, plus an optional factory per package (#159).
- **Portable options:** one network vocabulary (#109), `resources: { vcpus, memoryMiB }` (#122), one lifetime key and `--ttl` (#146), working defaults that match provider limits (#110), and clean create rejections with the provider's reason (#108).
- **Snapshots:** `Preserve.FILESYSTEM` and `Preserve.FILESYSTEM_AND_MEMORY`, expiry where the provider has it, and a shared snapshot suite (#136, #148), on Daytona (#134, #171), E2B, boxd (#131, #142), Modal (#132, #143), Boat (#147) and Freestyle (#174). Restore takes env, labels and lifetime like create (#150).
- **Streaming output** on every adapter (#139, #141, #144, #145).
- **Egress allowlists:** `network: { allow: [...] }` on Daytona, E2B, Vercel, Modal, Runloop, Freestyle (IPv4 ranges) and Archil, plus `internet` on Modal (#194).
- **Native fork:** `box.fork()` and `checkFork()` on boxd, Archil (#198) and E2B (#199); no snapshot-and-restore fallback.
- **Previews:** E2B protected previews on SDK 2.63 (#193); Daytona public signed links, Modal tunnels and Boat host ports (#196).
- **Provider catch-up:** Runloop labels through Devbox metadata (#195); boxd on SDK 0.3.0 with blocked egress (the default), labels and regions (#197), and egress allowlists (#201).
- **boxd is supported:** out of experimental and the landing page's default provider.
- **Files:** no SDK or CLI size limits; large transfers stream (#164). Missing parent folders are created and no temp files are left behind (#169). E2B writes into `/tmp` work (#167, #170).

### CLI

- An agent-first `beachside` CLI: create, ls, exec, run, cp, rm, doctor, `--json` and clear exit codes (#113, #114).
- Live streaming of `exec`, `sh` and `run` output (#133, #140), `cp -r` both ways and `run --push` (#137), adapters loaded at run time with `adapter add|ls|rm` (#135), sandbox listing, create-time env and `image build` (#114, #118), snapshots and `--snapshot` (#149), labels, creation time and `gc` (#152).
- **CI runners:** `--retry`, a `setup-beachside` action and a [Run CI jobs guide](apps/docs/src/content/docs/docs/cli/ci.md) (#151), plus an on-demand Live CI workflow that runs a real CI job in sandboxes (#154).
- **Rex:** command status, upload progress and finish notifications on Rex tabs, and a [Remote workspace with Rex guide](apps/docs/src/content/docs/docs/cli/rex.md) (#161, #168, #172).
- **Agent skill:** `beachside skill setup` installs a small stub that points at the installed CLI's skill, with a full install, update and remove lifecycle (#177).

### SDK foundation

Snapshots and volumes, partial outcomes and persisted identities, cleanup policy and owned scopes (#88), creation defaults, reopen and inspect, lifetime renewal, native suspend and resume, file, text and directory APIs ([filesystem DX](specs/filesystem-dx.md), #74, #75), HTTP previews, sustained text and byte processes, finite and incremental stdin ([stdin](specs/process-stdin.md), #71), signals, terminals, process reopening and diagnostics ([process I/O](specs/process-io-dx.md), #76 to #80), complete captured output (#86), bounded waits (#87, #89) and tracing. Two runnable [OpenCode examples](examples/README.md) passed live on Daytona and E2B (#83).

### Docs and site

The landing page and docs are one site, open to crawlers with a generated sitemap (#130). It has a streamlined providers section (#127), a [Write an adapter guide](apps/docs/src/content/docs/docs/guides/write-an-adapter.md) that starts with the `add-provider` skill (#128), and a CLI spotlight (#123).

## Qualification gaps

Use the existing [Bun integration suites](packages/sdk-qualification/provider-qualification/README.md). Paid live runs need a concrete, bounded plan and explicit approval.

| Priority | Remaining work                          | Completion condition                                                                                                                                                                                  |
| -------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1        | Experimental adapters                   | Vercel, Boat, Runloop, Freestyle, Archil and Modal have no live passes. Run each provider's maintained profile.                                                                                       |
| 2        | Finite exec input                       | `execution-stdin` has not run live. Qualify bytes, EOF, output and cleanup for each claimed provider configuration.                                                                                   |
| 3        | Configured creation and private ingress | Run the configured-creation scenario. Qualify E2B private-default ingress denial, including restore where claimed.                                                                                    |
| 4        | E2B network isolation                   | At `431cdaa`, blocked compute still reached `1.1.1.1:443` directly. Investigate provider and configuration evidence before rerunning. Do not claim isolation or silently change the requested policy. |
| 5        | Historical E2B volume uncertainty       | Keep the unresolved creator receipts until native evidence resolves them. A later successful cleanup does not clear an older uncertain creation.                                                      |

Daytona and E2B live passes date from October 9, 2026. Snapshot, streaming and file changes since then have deterministic coverage, and several were checked live by hand, but the maintained suites have not been rerun on them.

## Follow-ups that need a concrete use case

- **Storage:** mounted capture, memory-plus-volume restore, mounted suspension, dynamic attachment, forks with mounts, and stronger durability or locking guarantees.
- **Process and access:** durable remote transcript replay, verified remote runtime enforcement and descendant termination.
- **Timeouts:** portable remote termination at an exec deadline needs stronger native evidence and its own contract.
- **Observability:** metrics and structured events. Tracing, diagnostics and the Sentry and Datadog recipes ship today.
- **Release compatibility:** remove the deprecated empty-object restore-mount alias after its documented window ([migration rules](specs/storage-composition.md#compatibility-and-migration)).

## Provider candidates

Tensorlake (#45), Cloudflare Sandboxes (#44), Prime Intellect (#43), exe.dev (#42) and Isorun (#46) are candidates, not scheduled work. Pick the next adapter after a usability review: can an application create, run, move files, reopen, handle partial outcomes and clean up with clear ownership on it? A new adapter must cover everything its provider supports when it lands.

Accounting, a hosted service or management UI, and Rust are not planned. Completed plans live in Git history; don't start parallel backlogs.
