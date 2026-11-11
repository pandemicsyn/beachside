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

`connect` makes one `whoami` call. The scope is a one-way digest of the account email it returns, so a saved sandbox reference reopens with any credential of the same account.

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

Everything below is tested against a simulated exe.dev API on every change. It has not yet been run against the live service, so the adapter stays experimental and the [support page](/docs/providers/support/) lists no recorded live pass.

| Feature           | Support                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute lifecycle | Create, inspect with size, inventory, `sandboxes.list()` with labels and creation time, reference reopening, and destroy.                                                                                                                        |
| Commands          | argv and shell, with `cwd`, `env`, create-time `env` and deadlines up to 1 hour; exact stdout/stderr bytes up to 1 MiB across both streams, stdout first; finite byte stdin up to 1 MiB. Each command, with its env, must fit one 64 KB request. |
| Processes         | Streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL`, status, reopening from a saved reference, and callback `exec`.                                                                                                          |
| Files             | Binary read and write up to 8 MiB; streamed reads and writes of any size; no-clobber writes, copy, move, stat, directory listing, exists, make directory and remove.                                                                             |
| Suspend/resume    | `suspend()` pauses the VM with its memory; `resume()` restores it. exe.dev can fall back to a cold boot, and SDK 0.4.1 does not report it, so resume reports execution as unknown.                                                               |
| Fork              | `box.fork()` copies the VM's disk and configuration into a new, independent VM that boots fresh (`cp`). The fork keeps the `beachside` tag and takes its own labels.                                                                             |
| Previews          | `preview(port)` returns `https://<vm>.exe.xyz/` for the VM's web port or `https://<vm>.exe.xyz:<port>/` for ports 3000 to 9999, protected by a signed token; or, with `public`, makes that port the VM's public web port.                        |
| Unsupported       | Terminals (the HTTPS API has no PTY), snapshots, volumes and mounts, per-VM regions, lifetimes, `blocked` egress and allowlists.                                                                                                                 |

## Environment and secrets

Create-time `env` is written to `~/.beachside.env` in the VM (mode `0600`) and read by every command and process before its own `env`. It stays on the VM's disk, so it survives pause and is copied by `fork()`. The values are never saved in a Beachside reference.

exe.dev also has [integrations](https://exe.dev/docs/integrations-attach), which keep credentials on exe.dev instead of in the VM. The VM calls an integration at `https://<name>.int.exe.xyz/`, and exe.dev adds the credential on the way out:

- **[GitHub](https://exe.dev/docs/integrations-github)**: clone and push a repository with your connected GitHub account.
- **[LLM](https://exe.dev/docs/integrations-llm)**: call model providers at `llm.int.exe.xyz` with exe.dev's gateway or your own key, which the VM cannot read. Tools that insist on a key only need a placeholder.
- **[HTTP proxy](https://exe.dev/docs/integrations-http-proxy)**: forward requests to any HTTPS API with a header (such as an API key) that exe.dev adds.

Every VM this adapter creates has the `beachside` tag, so you can attach an integration to all of them with one command, `integrations attach <name> tag:beachside`, or to every VM with `auto:all`. That is the way to give an exe.dev sandbox access to a service without putting the credential in the box.

## Commands, processes and files

exe.dev runs one shell command line per `ssh <vm> <command>` request and returns stdout and stderr as separate byte frames with the exit code. It has no stdin, so the adapter stages finite stdin into a private file in the VM first, and runs each command through a small `sh` wrapper that bounds the output and returns it byte for byte. Processes run as detached jobs in the VM whose output the adapter reads back. Files use a small Python 3 helper in the VM. Every request costs a round trip, so uploads go out as 40 KiB positioned writes, sixteen at a time, and the staged file's size and SHA-256 are checked before it is published; downloads read 4 MiB ranges; your image needs `sh`, `base64` and Python 3, which `exeuntu` has.

## Destroy and recovery

`destroy()` deletes the VM and reports it gone once exe.dev confirms. exe.dev keeps a deleted VM's name for 24 hours.

Beachside sends each mutation once and the adapter adds no retries. Each create and fork uses a VM name derived from its submission (`bs-…`), so a create whose response was lost is found by that name instead of being sent again. A refusal exe.dev answers with a 4xx is reported as that error; a lost response or a 5xx is `OUTCOME_UNKNOWN`.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/42) and the [exe.dev documentation](https://exe.dev/docs).
