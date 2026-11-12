# @beachside/exe-dev

exe.dev VMs adapter for Beachside. Every change is tested against a simulated exe.dev API. Install with `npm install beachside @beachside/exe-dev`. Requires Node 20+ or Bun and an exe.dev API token or SSH key. Built on exe.dev's official SDK, pinned to `@exedev/sdk@0.4.1`, over the [HTTPS API](https://exe.dev/docs/https-api) only.

```ts
import { Beachside } from "beachside";
import { exeDevAdapter } from "@beachside/exe-dev";

const client = await Beachside.connect({
  adapter: exeDevAdapter,
  credentials: { token: process.env.EXE_API_KEY! },
  config: {},
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

`exeDev({ token })` binds the same definition in one object.

## Credentials

Pass `token`, `sshKey` or both:

- `token` is an exe.dev API token (`exe0.…` or `exe1.…`), used for every API call when present.
- `sshKey` is an unencrypted OpenSSH Ed25519 private key [added to your account](https://exe.dev/docs/https-api-local-key). The adapter signs short-lived tokens from it locally, so the key never leaves your process. Without a `token`, it signs one-hour account tokens limited to the commands below. Protected previews need it.

A token must be allowed to run `whoami`, `ls`, `new`, `rm`, `cp`, `ssh`, `stat`, `pause`, `resume` and `comment`. Public previews also need `share show`, `share port` and `share set-public`. Without `ssh`, a create finds the VM running but cannot run anything in it, and after the settle window it reports `OUTCOME_UNKNOWN` with the VM's reference so you can destroy it.

The scope is a one-way digest of the account email from `whoami`. A saved reference reopens with another credential of the same account only if that credential can see the VM. A key added with `ssh-key add --tag=beachside` sees only VMs tagged `beachside`, which every VM this adapter creates is.

## Setup defaults

| Setting          | Behavior                                                                                                                                                                                  |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`        | Optional; only `internet`. exe.dev VMs have internet egress; `blocked` and allowlists are refused until the SDK can set egress at create.                                         |
| `image`          | `exeuntu` (exe.dev's Ubuntu image with common tools and Python 3), or any OCI image reference.                                                                                           |
| `resources`      | 2 vCPU by default. A minimum `{ vcpus, memoryMiB }` picks the smallest whole-vCPU size, with 2 GiB per vCPU and 1 to 32 vCPUs.                                                           |
| `placement`      | `default` follows the account. `standalone` reserves capacity per VM. `{ pool: "name" }` places VMs in a team pool.                                                                       |
| `preview.access` | `protected` (default) signs a one-hour VM token sent as `X-Exedev-Authorization` and needs `sshKey`. `public` makes the VM's web port public.                                             |

## Image prerequisites

Commands, processes and files run through small helpers in the VM. The image needs `sh`, `base64`, `mktemp`, `wc`, `head`, `tr`, `setsid`, `mkfifo` and Python 3, all of which `exeuntu` has. The wrapper bounds the output a command returns to 1 MiB. While the command runs, it also frees the disk blocks past that bound with `fallocate --punch-hole`. Without `fallocate`, or on a filesystem without hole support, a noisy command can still fill the guest disk, even though the returned bytes stay bounded.

## Behavior

- **Create** sends one `new` with a name derived from the submission (`bs-…`), the `beachside` tag and `--no-email`. A lost response is found again by that name and never resent. Create waits until the VM is running and a command runs in it. Labels live in the VM comment as percent-encoded `key=value` pairs (200 bytes at most). Create-time `env` is written to `~/.beachside.env` (mode `0600`), and every command and process sources it.
- **Exec** supports argv and shell, `cwd`, `env`, finite stdin up to 1 MiB (staged to a private file first) and exact stdout and stderr bytes, bounded to 1 MiB across both streams, stdout first. Each command, with its env, must fit one 64 KB request. exe.dev documents a 30-second limit per API request, so commands with deadlines over 25 seconds (up to 1 hour) start detached in the VM. The adapter then reads the result file, waiting 0.5 to 5 seconds between reads, and kills the job's process group if it passes its deadline, reporting `OUTCOME_UNKNOWN`.
- **Processes** run as detached guest jobs with streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL` to the process group, status and reopen. There are no terminals, because the HTTPS API has no PTY.
- **Files** read and write up to 8 MiB at once, and any size as streams. They use a Python 3 helper and support no-clobber writes, copy, move, stat, listings, exists, mkdir and remove. Uploads are parallel 40 KiB positioned writes, and the staged file's size and SHA-256 are checked before it is published.
- **Suspend/resume** maps to pause (memory kept) and resume. Resume reports execution as unknown, because SDK 0.4.1 does not report a cold boot.
- **Fork** copies the VM with `cp`. The copy boots fresh, keeps the tag and takes its own labels.
- **Preview** returns `https://<vm>.exe.xyz/`, or `https://<vm>.exe.xyz:<port>/` for ports 3000 to 9999.
- **Destroy** sends `rm` and reports the VM gone only when exe.dev lists it as deleted. exe.dev's `not_found` also covers a VM this credential cannot see, so destroy reports it, and a VM missing from a later listing, as `OUTCOME_UNKNOWN` with the reference kept.
- Unsupported: terminals, snapshots, volumes and mounts, per-VM regions, lifetimes, `blocked` egress and allowlists.

exe.dev VMs have no lifetime or idle stop. Destroy what you create, or let `beachside gc` find the VMs tagged `beachside`.

## Recovery

Every mutation is sent once. The adapter re-sends a request only when exe.dev answers 429, which it does before running anything, and it waits longer each time, up to four times. A 4xx refusal (400, 401, 403, 404, 405, 413) becomes an ordinary error. A lost response, a 5xx, or a 422 (which exe.dev uses for a command that ran and failed) becomes `OUTCOME_UNKNOWN` and is never replayed. A 409 on create or fork means the name is taken; since the name belongs to this attempt, the adapter observes it by name instead of refusing.

See the [provider page](https://beachside.run/docs/providers/exe-dev/) and the [research issue](https://github.com/pandemicsyn/beachside/issues/42).
