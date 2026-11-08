---
title: Freestyle
description: Use the Freestyle adapter for Ubuntu microVMs with blocked egress, memory snapshots, pause/resume, terminals and public previews.
---

The `@beachside/freestyle` package implements the public Beachside adapter interface for [Freestyle VMs](https://www.freestyle.sh). Install it with `npm install beachside @beachside/freestyle`; it is experimental. Use Node 20+ or Bun. It uses Freestyle's official TypeScript SDK, [`freestyle`](https://www.npmjs.com/package/freestyle), pinned to 0.2.21.

```ts
import { Beachside } from "beachside";
import { freestyleAdapter } from "@beachside/freestyle";

const client = await Beachside.connect({
  adapter: freestyleAdapter,
  credentials: { apiKey: process.env.FREESTYLE_API_KEY! },
  config: { network: "blocked" },
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

Create an API key in the [Freestyle dashboard](https://dash.freestyle.sh). `connect` checks it with one read-only `GET /v5/vms`. Freestyle does not tell an API key which account it belongs to, so the scope is a one-way fingerprint of the key: a saved sandbox reference reopens with the same key, not with a rotated one.

The package also exports `freestyle()`, which takes credentials and config in one object and returns an adapter you pass straight to `Beachside.connect`: `Beachside.connect(freestyle({ apiKey }))`. It is the same setup; use whichever reads better.

## Setup

| Setting                      | Default            | Notes                                                                                                                                                                                                                                     |
| ---------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                    | `blocked`          | `blocked` creates the VM with an empty firewall, so it can reach nothing. `internet` allows every public destination. Allowlists are not wired yet.                                                                                       |
| `image`                      | `freestyle/ubuntu` | A snapshot to boot: a `sh-…` id, your own snapshot slug, or a public `owner/slug` such as `freestyle/ubuntu-sm`. OCI images and image builds are unsupported.                                                                             |
| `resources`                  | 4 vCPU, 8 GiB      | Minimum `{ vcpus, memoryMiB }`. Picks the smallest Ubuntu base: `freestyle/ubuntu-sm` (2 vCPU, 4 GiB), `freestyle/ubuntu` (4, 8 GiB), `-lg` (8, 16 GiB), `-xl` (16, 32 GiB) or `-2xl` (32, 64 GiB). Set `image` or `resources`, not both. |
| `lifecycle.lifetimeSeconds`  | 900                | 60 seconds to 30 days. Freestyle deletes the VM that long after it was created, even while paused. `create({ lifecycle })` can override it per sandbox.                                                                                   |
| `lifecycle.idleSeconds`      | none               | Pause the VM after this many seconds without network activity. Traffic or `resume()` wakes it.                                                                                                                                            |
| `preview.access`             | `public`           | Freestyle previews are public `style.dev` URLs; `protected` rejects at connect.                                                                                                                                                           |
| `preview.ports`              | none               | Ports to publish at create. Any other port is published the first time you call `preview(port)`. Each port claims one `<slug>-<port>.style.dev` name for your account.                                                                    |
| `snapshots.preserve`         | memory and disk    | Freestyle snapshots always keep memory and disk, so `Preserve.FILESYSTEM` rejects at connect.                                                                                                                                             |
| `snapshots.retentionSeconds` | none               | Delete each snapshot this long after capture (`0` keeps it). Without it, snapshots stay until deleted unless your Freestyle plan removes unused ones sooner.                                                                              |

An `image` given as a `sh-…` snapshot id is checked at connect, and `connect` fails with `NOT_FOUND` if your API key cannot see it. Freestyle has no lookup for a snapshot slug or a public `owner/slug` base, so those are checked when the first VM is created.

Labels are stored as Freestyle VM metadata (up to 64, keys and values up to 63 characters), so `sandboxes.list()` and `beachside gc` can find them. Create-time `env` applies to every command, process and terminal; Freestyle only takes environment variables per command, so the adapter writes them to `/etc/beachside.env` in the VM, with mode `0600` and owned by the VM's default user `ubuntu`, which runs every command, so other users in the VM cannot read it (the command user can, as it can read its own environment), and each command reads that file before its own `env`. The values are never saved in references or recovery records. They stay in the creating process's memory until the file is written, so a create whose response was lost, or a VM that boots slower than the create waits, still finishes in that process. A different process that recovers the same create cannot write the values, so it reports `OUTCOME_UNKNOWN`; destroy that VM and create another. `region` and mounts are rejected.

## What works

Everything below is tested against a simulated Freestyle API on every change. It has also been checked by hand against the live service, on the `freestyle/ubuntu` base with `network: "internet"`, in November 2026. Those checks have not yet run through Beachside's provider qualification suite, so the adapter stays experimental and the [support page](/docs/providers/support/) lists no recorded live pass.

| Feature           | Support                                                                                                                                                                                                                                                                                                                                               | Checked live                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Compute lifecycle | Create, inspect, inventory, `sandboxes.list()` with labels and creation time, reference reopening, and destroy confirmed by the VM's absence.                                                                                                                                                                                                         | Partly: create, inspect, reopen, renew and destroy; not `sandboxes.list()` |
| Commands          | argv and shell, with `cwd`, `env` and create-time `env`; exact stdout/stderr bytes up to 1 MiB across both streams, stdout first; finite byte stdin up to 1 MiB.                                                                                                                                                                                      | Partly: not finite stdin                                                   |
| Processes         | Streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL`, status, reopening from a saved reference, and callback `exec`.                                                                                                                                                                                                               | Partly: not byte output or callback `exec`                                 |
| Terminals         | Named Freestyle PTY sessions with input, resize, `SIGKILL` and reopening.                                                                                                                                                                                                                                                                             | Partly: input and exit; not resize or reopen                               |
| Files             | Buffered binary read and write up to 8 MiB; streamed reads and writes of any size; no-clobber writes, copy, move, stat, directory listing, exists, make directory and remove. Reads, listings, `stat` and `exists` also work on a paused or stopped VM; writes need it running.                                                                       | Yes                                                                        |
| Snapshots         | Capture memory and disk from a running or paused VM; restore into a new VM that resumes the captured processes, with `network`, `env`, labels and lifetime; inspect, list, delete and expiry.                                                                                                                                                         | Partly: capture, restore and delete; not expiry                            |
| Images            | `images.list()` and inspect over your account's snapshots, which boot as prepared images.                                                                                                                                                                                                                                                             | No                                                                         |
| Suspend/resume    | `suspend()` pauses the VM with its memory; `resume()` continues the same processes. Network connections are treated as dropped. Process output stops while the VM is paused, because watching a process runs commands in the VM and would wake it. Freestyle may limit pause and snapshots by plan; a plan refusal surfaces as Freestyle's own error. | Yes                                                                        |
| Renewal           | `renew()` moves the deletion deadline to the requested time from now.                                                                                                                                                                                                                                                                                 | Yes                                                                        |
| Previews          | `preview(port)` returns a public `style.dev` URL, publishing the port on first use.                                                                                                                                                                                                                                                                   | Partly: public URL; not refusal while paused                               |
| Unsupported       | OCI images and image builds, volumes, mounts and regions, which Freestyle lacks. Protected previews (Freestyle offers forward auth through your own service) and egress allowlists are not wired yet.                                                                                                                                                 | —                                                                          |

## How commands keep bytes and arguments

Freestyle runs one command line through the guest shell and returns stdout/stderr as UTF-8 text, replacing invalid bytes. To keep argv as separate arguments and output as exact bytes, the adapter sends a small POSIX `sh` wrapper: arguments are single-quoted, the command's stdout and stderr go to private files under `/tmp`, and the wrapper prints one record with the exit code and byte counts. Results of 32 KiB or less come back inline as base64; larger results are downloaded as raw bytes through the filesystem API and the guest directory is removed afterwards. Finite stdin goes in Freestyle's own `stdin` field. Your image needs `sh`, `mktemp`, `base64`, `head`, `wc` and `tr`; the Ubuntu bases have them. Capture keeps at most 1 MiB across stdout and stderr, stdout first. While a command runs, output past that bound in each stream is released from disk every 200 ms with `fallocate` hole punching, so a long noisy command keeps disk use near the bound. A burst faster than that, or a filesystem without hole punching, can still use disk up to the full output size until the command ends.

## Processes, terminals and files

`exec` returns once a command ends, so a process runs as a detached job in the VM: its stdout and stderr go to private files under `/tmp`, its exit status is written last, and the adapter reads new bytes from both files (base64, so bytes stay exact) until the exit status appears and both are drained. Piped stdin is a FIFO held open by a small guest process, which stops when you call `closeStdin()` or when the job exits or is killed. A stdin write that the process does not read within 10 seconds fails, and part of it may already have been written. Signals go to the job's own process group. A reopened process reports output written after it reattached. Expect a quarter second of latency between output and delivery.

Terminals use Freestyle's own PTY sessions over a WebSocket, so output arrives as it is written. Freestyle terminals take `SIGKILL` only; `SIGTERM` rejects. A reopened terminal skips the scrollback Freestyle replays and reports only new output.

Buffered files go through Freestyle's filesystem API as one sha256-verified upload. Before it, a short root command reads the current owner of the target, because Freestyle's upload hands a replaced file to root; after it, a small Python 3 helper running as root gives the file back to its previous owner. Python 3 is needed only for that repair: on an image without it, new files and root-owned files still write, and replacing a file another user owns is refused with `UNSUPPORTED` before anything is written. Streamed reads use 1 MiB range requests. Streamed writes over 8 MiB, and every no-clobber write, are staged beside the target 1 MiB at a time and published with an atomic rename, or a hard link when the target must not be replaced. Copy, move, make directory and remove, and `stat`, `exists` and directory listings on a running VM, run through a Python 3 helper in the VM (the Ubuntu bases ship Python 3.12). Commands and that helper run as the VM's default user, `ubuntu`; new files written through Freestyle's filesystem API belong to that user too.

On a paused or stopped VM, reads, streamed reads, listings, `stat` and `exists` go through Freestyle's own read-only file API, which does not wake the VM. `stat` there follows symlinks, reports no modification time, and reports only the permission bits of `mode` (no setuid, setgid or sticky bit); asking for a link's own metadata (`followSymlinks: false`) needs a running VM. Writes, commands, processes and previews need a running VM and are refused with `CONFLICT` while it is paused, rather than waking it.

Deadlines run up to 24 hours on VMs whose guest agent supports long execs. Older agents refuse anything over five minutes, and that refusal is reported as `UNSUPPORTED`. A command that passes its deadline is reported as `OUTCOME_UNKNOWN`.

## Destroy and recovery

`destroy()` deletes the VM, which removes its firewall rules and preview rules with it, and waits until Freestyle no longer returns it.

Beachside sends each mutation once and the adapter adds no retries; Freestyle's SDK replays only reads. Slow calls run as Freestyle background requests, which the SDK follows until they finish. Each create and each snapshot carries a `beachside-<hash>` slug derived from its submission, so a create or capture whose response was lost is found by that slug instead of being resent. A refusal Freestyle answers with a 4xx is reported as that error; a lost response, a 5xx, or a `VM_NON_RESPONSIVE` command is `OUTCOME_UNKNOWN`. Listed VMs report `ownership: "unknown"`.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/129) and the [Freestyle documentation](https://www.freestyle.sh/docs).
