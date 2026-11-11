---
title: exe.dev
description: Use the exe.dev adapter for persistent Linux VMs with pause/resume, VM copies as forks, and protected or public HTTPS previews.
---

The `@beachside/exe-dev` package implements the public Beachside adapter interface for [exe.dev](https://exe.dev) VMs. Install it with `npm install beachside @beachside/exe-dev`; it is experimental. Use Node 20+ or Bun. It uses exe.dev's official TypeScript SDK, [`@exedev/sdk`](https://www.npmjs.com/package/@exedev/sdk), pinned to 0.4.1, and talks only to the [HTTPS API](https://exe.dev/docs/https-api).

```ts
import { Beachside } from "beachside";
import { exeDevAdapter } from "@beachside/exe-dev";

const client = await Beachside.connect({
  adapter: exeDevAdapter,
  credentials: { token: process.env.EXE_API_KEY! },
  config: { network: "internet" },
});
try {
  const box = await client.sandboxes.create();
  try {
    console.log((await box.exec(["/bin/sh", "-c", "printf ready"])).stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

The package also exports `exeDev()`, which takes credentials and config in one object: `Beachside.connect(exeDev({ token, network: "internet" }))`.

## Credentials

Pass at least one of these; you can pass both.

| Credential | What it is                                                                                                                                                                                                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`    | An exe.dev API token (`exe0.…` or `exe1.…`), for example from `ssh exe.dev token`. Used for every API call when present.                                                                                                                                                                      |
| `sshKey`   | An unencrypted OpenSSH Ed25519 private key that is [added to your account](https://exe.dev/docs/https-api-local-key). The adapter signs short-lived tokens from it locally, so the key never leaves your process. Without a `token`, it signs account tokens limited to the commands it runs. |

Protected previews need `sshKey`, because they are signed for one VM's HTTPS proxy. A key added with `ssh-key add --tag=beachside` can only reach VMs that carry the `beachside` tag, which every VM this adapter creates has.

`connect` makes one `whoami` call. The scope is a one-way digest of the account email it returns, so a saved sandbox reference reopens with another credential of the same account, as long as that credential can see the VM. A tag-scoped key sees only VMs with its tag.

A token must be allowed to run `whoami`, `ls`, `new`, `rm`, `cp`, `ssh`, `stat`, `pause`, `resume` and `comment`; public previews also need the `share` commands. Without `ssh`, a create finds the VM running but cannot use it, and reports `OUTCOME_UNKNOWN` with the VM's reference after the settle window.

## Setup

| Setting          | Default     | Notes                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`        | required    | Must be `internet`. exe.dev VMs have internet egress, and this adapter cannot yet set exe.dev's egress policy at create, so it asks you to choose this explicitly. `blocked` and allowlists are refused.                                                                                              |
| `image`          | `exeuntu`   | Any OCI image reference. `exeuntu` is exe.dev's Ubuntu image with common tools and Python 3.                                                                                                                                                                                                          |
| `resources`      | 2 vCPU      | Minimum `{ vcpus, memoryMiB }`; picks the smallest whole-vCPU size with 2 GiB per vCPU (1 to 32 vCPU) that meets it.                                                                                                                                                                                  |
| `placement`      | `default`   | `default` follows your account (a Personal plan's shared capacity or a team's default pool). `standalone` reserves capacity for each VM, billed by the second. `{ pool: "name" }` places VMs in a team pool.                                                                                          |
| `preview.access` | `protected` | `protected` signs a one-hour token sent as the `X-Exedev-Authorization` header and needs `sshKey`. `public` makes the VM's web port public, which needs a token allowed to run `share show`, `share port` and `share set-public`. Protected previews of ports 3000 to 9999 make no share call at all. |

exe.dev VMs live until they are deleted; exe.dev has no lifetime or idle stop. Every VM the adapter creates is tagged `beachside`, and labels are kept in the VM's comment as percent-encoded `key=value` pairs (`beachside: team=core`, 200 bytes at most, since exe.dev refuses quotes and other HTML characters in comments), so `client.sandboxes.list()` reads them back and `beachside gc` can find and remove the VMs you are done with.

## What works

Everything below is tested against a simulated exe.dev API on every change. It was also checked by hand against the live service in November 2026, with the default `exeuntu` image and an API token. Create with labels and env, commands, files, processes, suspend/resume, fork and destroy all passed. In Beachside's provider qualification suite, streaming output and process termination passed, along with most of the sandbox workflow. The sandbox run then hit exe.dev's request rate limit before it finished, so the adapter stays experimental, and the [support page](/docs/providers/support/) lists no recorded live pass. Not yet checked live: previews (protected previews need an SSH key credential, and public previews need a token allowed to run `share`), commands longer than 25 seconds as guest jobs, and the latest rate-limit handling.

| Feature           | Support                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute lifecycle | Create, inspect with size, inventory, `sandboxes.list()` with labels and creation time, reference reopening, and destroy.                                                                                                                                                                              |
| Commands          | argv and shell, with `cwd`, `env`, create-time `env` and deadlines up to 1 hour (commands over 25 seconds run as detached guest jobs); exact stdout/stderr bytes up to 1 MiB across both streams, stdout first; finite byte stdin up to 1 MiB. Each command, with its env, must fit one 64 KB request. |
| Processes         | Streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL`, status, reopening from a saved reference, and callback `exec`.                                                                                                                                                                |
| Files             | Binary read and write up to 8 MiB; streamed reads and writes of any size; no-clobber writes, copy, move, stat, directory listing, exists, make directory and remove.                                                                                                                                   |
| Suspend/resume    | `suspend()` pauses the VM with its memory; `resume()` restores it. exe.dev can fall back to a cold boot, and SDK 0.4.1 does not report it, so resume reports execution as unknown.                                                                                                                     |
| Fork              | `box.fork()` copies the VM's disk and configuration into a new, independent VM that boots fresh (`cp`). The fork keeps the `beachside` tag and takes its own labels.                                                                                                                                   |
| Previews          | `preview(port)` returns `https://<vm>.exe.xyz/` for the VM's web port or `https://<vm>.exe.xyz:<port>/` for ports 3000 to 9999, protected by a signed token; or, with `public`, makes that port the VM's public web port.                                                                              |
| Unsupported       | Terminals (the HTTPS API has no PTY), snapshots, volumes and mounts, per-VM regions, lifetimes, `blocked` egress and allowlists.                                                                                                                                                                       |

## Environment and secrets

Create-time `env` is written to `~/.beachside.env` in the VM (mode `0600`) and read by every command and process before its own `env`. It stays on the VM's disk, so it survives pause and is copied by `fork()`. The values are never saved in a Beachside reference.

exe.dev also has [integrations](https://exe.dev/docs/integrations-attach), which keep credentials on exe.dev instead of in the VM. The VM calls an integration at `https://<name>.int.exe.xyz/`, and exe.dev adds the credential on the way out:

- **[GitHub](https://exe.dev/docs/integrations-github)**: clone and push a repository with your connected GitHub account.
- **[LLM](https://exe.dev/docs/integrations-llm)**: call model providers at `llm.int.exe.xyz` with exe.dev's gateway or your own key, which the VM cannot read. Tools that insist on a key only need a placeholder.
- **[HTTP proxy](https://exe.dev/docs/integrations-http-proxy)**: forward requests to any HTTPS API with a header (such as an API key) that exe.dev adds.

Every VM this adapter creates has the `beachside` tag, so you can attach an integration to all of them with one command, `integrations attach <name> tag:beachside`, or to every VM with `auto:all`. That is the way to give an exe.dev sandbox access to a service without putting the credential in the box.

## Commands, processes and files

exe.dev runs one shell command line per `ssh <vm> <command>` request and returns stdout and stderr as separate byte frames with the exit code. exe.dev documents a 30-second limit for one API request, so a command whose deadline is over 25 seconds starts detached in the VM, and the adapter reads its result file with growing waits (0.5 to 5 seconds) until it finishes; one that passes its deadline is killed with its process group and reported as `OUTCOME_UNKNOWN`. It has no stdin, so the adapter stages finite stdin into a private file in the VM first, and runs each command through a small `sh` wrapper that bounds the output and returns it byte for byte. Processes run as detached jobs in the VM whose output the adapter reads back. Files use a small Python 3 helper in the VM. Every request costs a round trip, so uploads go out as 40 KiB positioned writes, sixteen at a time, and the staged file's size and SHA-256 are checked before it is published; downloads read 4 MiB ranges; your image needs `sh`, `base64`, `mktemp`, `wc`, `head`, `tr`, `setsid`, `mkfifo` and Python 3, which `exeuntu` has. While a command runs, `fallocate --punch-hole` frees disk past the output bound; without it, or on a filesystem without holes, a noisy command can still fill the guest disk even though the returned output stays bounded.

## Destroy and recovery

`destroy()` deletes the VM and reports it gone only when exe.dev lists it as deleted. exe.dev's `not_found` also means "not visible to this token", so that answer, or a VM missing from a later listing, is `OUTCOME_UNKNOWN` with the reference kept. exe.dev keeps a deleted VM's name for 24 hours.

Beachside sends each mutation once. The adapter sends a request again only when exe.dev answers 429, which it does before running anything, waiting longer each time (up to four times). Each create and fork uses a VM name derived from its submission (`bs-…`), so a create whose response was lost is found by that name instead of being sent again. A refusal exe.dev answers with 400, 401, 403, 404, 405 or 413 is reported as that error. A lost response, a 5xx or a 422 (which exe.dev uses for a command that ran and failed) is `OUTCOME_UNKNOWN`. A 409 on this attempt's own name is observed by name instead of refused.

## Limits

- Not yet through a complete live provider qualification run, so it stays experimental.
- Internet egress only. `blocked` and allowlists are refused until exe.dev's SDK can set egress at create.
- VMs have no lifetime or idle stop: they run and bill until destroyed. Destroy what you create, or find leftovers by their `beachside` tag with `beachside gc`.
- No terminals (the HTTPS API has no PTY), snapshots, volumes, mounts or per-VM regions. `fork()` copies a VM and boots the copy fresh; memory and processes do not carry over.
- Every command, with its env, must fit one 64 KB request. Captured output stops at 1 MiB across both streams, and stdin at 1 MiB. Upload long scripts as files first.
- Commands longer than 25 seconds run as guest jobs that the adapter polls, so they cost a few extra requests and finish up to 5 seconds after the command does.
- Every guest call is at least one exe.dev request (about 0.7 seconds each). exe.dev rate-limits busy accounts. The adapter retries a 429 up to four times and then reports `RATE_LIMIT`, so spread out heavy file or command loops.
- Uploads are slow: a 10 MiB streamed upload measured about 0.3 MiB/s live with eight writes in flight (the adapter now sends sixteen), and downloads about 2 MiB/s. With the SDK's default 30-second transfer timeouts that 10 MiB upload timed out, so raise `transfers.setupTimeoutMs` and `inactivityTimeoutMs` for large files.
- Labels share the VM comment, limited to 200 bytes in total.
- Resume reports execution as unknown, because SDK 0.4.1 does not say whether exe.dev fell back to a cold boot.
- The image needs `sh`, core utilities and Python 3. Without `fallocate`, the output bound limits what is returned but not what a command writes to disk.
- Tokens are per-command: a token without `ssh` cannot run anything in a VM, and one without `share` cannot make public previews. A tag-scoped key sees only VMs with its tag.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/42) and the [exe.dev documentation](https://exe.dev/docs).
