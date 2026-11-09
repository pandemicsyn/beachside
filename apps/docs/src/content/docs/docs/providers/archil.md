---
title: Archil
description: Use the Archil adapter for persistent Firecracker microVMs on durable disks, with pause/resume, fork-based snapshots, volumes, image builds and protected previews.
---

The `@beachside/archil` package implements the public Beachside adapter interface for [Archil Sandboxes](https://docs.archil.com/compute/sandboxes/introduction). Install it with `npm install beachside @beachside/archil`; it is experimental. Use Node 22.19+ or Bun. It uses Archil's official TypeScript SDK, [`disk`](https://www.npmjs.com/package/disk), pinned to 1.12.0.

```ts
import { Beachside } from "beachside";
import { archilAdapter } from "@beachside/archil";

const client = await Beachside.connect({
  adapter: archilAdapter,
  credentials: { apiKey: process.env.ARCHIL_API_KEY! },
  config: { region: "aws-us-east-1", network: "blocked" },
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

Create an API key in the [Archil console](https://console.archil.com). `connect` checks it with one read-only `GET /api/sandboxes` in the chosen region. Archil does not tell an API key which account it belongs to, so the scope is a one-way fingerprint of the key: a saved sandbox reference reopens with the same key, not with a rotated one.

The package also exports `archil()`, which takes credentials and config in one object and returns an adapter you pass straight to `Beachside.connect`: `Beachside.connect(archil({ apiKey, region: "aws-us-east-1" }))`. It is the same setup; use whichever reads better.

## Setup

| Setting                         | Default            | Notes                                                                                                                                                                                        |
| ------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `region`                        | required           | `aws-us-east-1`, `aws-us-west-2` or `aws-eu-west-1`. Each region has its own control plane, and a connection only sees its own region's sandboxes.                                           |
| `network`                       | `blocked`          | `blocked` denies all egress. `internet` leaves egress open. Both are custom network policies, which need a paid Archil plan (see [plans](#plans)).                                           |
| `image`                         | `node:24-bookworm` | Any public OCI image (amd64), or a 64-hex image id from `beachside image build` / `client.images.build()`. The default is always sent explicitly.                                            |
| `resources`                     | 1 vCPU, 2 GiB      | Minimum `{ vcpus, memoryMiB }`, rounded up to whole vCPUs: 1 to 32 vCPU and 256 MiB to 64 GiB.                                                                                               |
| `lifecycle.lifetimeSeconds`     | 900                | 60 seconds to 24 hours. Counts each powered-on session, not the sandbox's whole life: when it runs out, Archil **pauses** the sandbox rather than deleting it. `renew()` restarts the count. |
| `lifecycle.idleSeconds`         | none               | Pause after this long without a process connection. Detached processes do not count as activity.                                                                                             |
| `lifecycle.suspension.preserve` | memory and disk    | `Preserve.FILESYSTEM_AND_MEMORY` pauses; `Preserve.FILESYSTEM` stops the sandbox and cold-boots it on resume.                                                                                |
| `preview.access`                | `protected`        | `protected` mints a port token sent as the `X-Archil-Token` header. `public` opens the port to anyone with the URL.                                                                          |
| `snapshots.preserve`            | memory and disk    | What capture keeps; see [snapshots](#snapshots). One mode per connection.                                                                                                                    |
| `credentials.registry`          | none               | `{ username, password }` for private images in image builds. Sent once with the build and never stored.                                                                                      |

Labels are refused with `UNSUPPORTED` before anything is created, because Archil sandboxes carry no labels or metadata. Listed sandboxes report `labels: null` and `ownership: "unknown"`. Create-time `env` is stored by Archil and applies to every command, process and terminal.

### Plans

Archil's Free plan allows 5 concurrent sandboxes, 30-minute sessions and one vCPU-hour a month, and gives every sandbox Archil's managed egress allowlist (package registries, Git hosts and model APIs). It cannot set a network policy, so a create with either `blocked` or `internet` is refused with `UNSUPPORTED`. That managed allowlist is neither of Beachside's policies, so the adapter never reports it as `internet`: after a create with `internet`, the adapter reads the sandbox's network back and fails if Archil reports a managed policy. Use a Developer plan or higher. Archil bills compute only while a sandbox runs, but storage continues while it is paused or stopped, so delete sandboxes you no longer need; `beachside gc` finds paused ones too.

## What works

Everything below is tested against a simulated Archil API and process connection on every change. It has not been checked against the live service yet, so the adapter stays experimental and the [support page](/docs/providers/support/) lists no live pass.

| Feature           | Support                                                                                                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Compute lifecycle | Create, inspect, inventory, `sandboxes.list()` with creation time, reference reopening, and destroy confirmed by the sandbox's absence.                                                                                                    |
| Commands          | argv and shell, with `cwd`, `env`, create-time `env` and deadlines up to 24 hours; exact stdout/stderr bytes up to 8 MiB per stream; finite byte stdin up to 8 MiB. Output past the bound is drained and the result is marked `truncated`. |
| Processes         | Streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL`, status, reopening from a saved reference, and callback `exec`.                                                                                                    |
| Terminals         | Archil's native PTY (`TERM=xterm-256color`) with input, resize, `SIGKILL` and reopening.                                                                                                                                                   |
| Files             | Buffered binary read and write up to 32 MiB; streamed reads and writes of any size; no-clobber writes, copy, move, stat, directory listing, exists, make directory and remove.                                                             |
| Snapshots         | Capture memory and disk (default) or disk only; restore into a new sandbox with `network`; inspect, list and delete. Restores depend on their snapshot; see below.                                                                         |
| Images            | `images.build()` from an OCI reference (with registry credentials for private images), polled until ready, and `images.inspect()`.                                                                                                         |
| Volumes           | Archil disks: create, inspect, list and delete, mounted at create read-write or read-only, with a subpath.                                                                                                                                 |
| Suspend/resume    | `suspend()` pauses with memory and `resume()` continues the same processes, or stops and cold-boots with `Preserve.FILESYSTEM`. Process connections drop while paused and reattach afterwards.                                             |
| Renewal           | `renew()` sets the current session's deadline to the requested time from now.                                                                                                                                                              |
| Previews          | `preview(port)` returns a protected URL with an `X-Archil-Token` header, or a public URL.                                                                                                                                                  |
| Unsupported       | Labels, egress allowlists, and resizing or changing env, labels, lifetime or mounts on restore.                                                                                                                                            |

## Snapshots

Archil has no standalone snapshot. It keeps a checkpoint when a sandbox pauses or stops, and only the two most recent checkpoints can be forked into a new sandbox. To keep a snapshot restorable, capture forks the checkpoint into a parked **holder** sandbox named `bs-snap-…`:

1. Pause the source (or stop it, for `Preserve.FILESYSTEM`).
2. Fork its checkpoint into the holder, then pause or stop the holder.
3. Resume the source if it was running.

Restore forks the holder. With memory, the restored sandbox resumes the captured processes; with `Preserve.FILESYSTEM`, it cold-boots from the captured disk. The holder briefly runs the captured processes between the fork and the pause.

Forks are children of what they fork, and Archil refuses to delete a sandbox that has children. So a source cannot be deleted while it has snapshots, and a snapshot cannot be deleted while sandboxes restored from it exist. `destroy()` on such a source stops it and reports it as retained; `snapshot.delete()` with live restores fails with `CONFLICT`. Delete restores first, then the snapshot, then the source. Because of this, `snapshot.restore()` rejects by default; pass `requireIndependentLifecycle: false` to accept the dependency:

```ts
const { snapshot } = await box.snapshot();
const restored = await snapshot.restore({ requireIndependentLifecycle: false });
```

Archil can only fork a sandbox with mounted disks once it is stopped, so capturing a sandbox with volumes is refused. Restores keep the source's resources, env and lifetime; asking to change them is refused.

## Commands, processes and files

Archil runs one shell command line per process over a WebSocket and streams raw stdout and stderr bytes. argv is single-quoted into that command line, so arguments with quotes, newlines or `$` arrive unchanged. A process keeps running when its connection drops, and reattaches by id at the byte offset it last read; a lost `exec` connection reattaches up to three times before reporting `OUTCOME_UNKNOWN`. Background processes record a PID file, so `signal()` reaches the program itself and the exit code reflects the signal (`143` for `SIGTERM`, `137` for `SIGKILL`). A command that passes its deadline reports `exitCode: null`.

Archil has no file API for sandboxes. Buffered reads use the official SDK's chunked reader; writes, streamed transfers and metadata run through a small Python 3 helper in the sandbox that writes beside the target and publishes with an atomic rename, or a hard link when the target must not be replaced. Your image needs `sh`, `dd` and Python 3; the default `node:24-bookworm` has them.

## Destroy and recovery

`destroy()` stops the sandbox, deletes it, and waits until Archil no longer returns it. Disks mounted on it survive.

Beachside sends each mutation once and the adapter adds no retries; the SDK's own retries are bypassed by an adapter-owned single-attempt client. Each create, capture and restore carries an adapter-chosen `bs-…` name derived from its submission, so a create whose response was lost is found by that name instead of being resent. A refusal Archil answers with a 4xx is reported as that error; a lost response or a 5xx is `OUTCOME_UNKNOWN`.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/188) and the [Archil documentation](https://docs.archil.com/compute/sandboxes/introduction).
