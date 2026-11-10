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

| Setting                         | Default            | Notes                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `region`                        | required           | `aws-us-east-1`, `aws-us-west-2` or `aws-eu-west-1`. Each region has its own control plane, and a connection only sees its own region's sandboxes.                                                                                                                                                                                                                                                                             |
| `network`                       | `blocked`          | `blocked` denies all egress, `internet` leaves it open and `{ allow: [...] }` denies everything except those hosts and IPv4 ranges ([allowlists](/docs/guides/images-and-networking/#allow-only-some-destinations)); all three are custom network policies that need a paid plan. `archil-managed` sends no policy and uses Archil's managed allowlist, which is what the Free plan gives every sandbox (see [plans](#plans)). |
| `image`                         | `node:24-bookworm` | Any public OCI image (amd64), or a 64-hex image id from `beachside image build` / `client.images.build()`. The default is always sent explicitly.                                                                                                                                                                                                                                                                              |
| `resources`                     | 1 vCPU, 2 GiB      | Minimum `{ vcpus, memoryMiB }`, rounded up to whole vCPUs: 1 to 32 vCPU and 256 MiB to 64 GiB.                                                                                                                                                                                                                                                                                                                                 |
| `lifecycle.lifetimeSeconds`     | 900                | 60 seconds to 24 hours. Counts each powered-on session, not the sandbox's whole life: when it runs out, Archil **pauses** the sandbox rather than deleting it. `renew()` restarts the count.                                                                                                                                                                                                                                   |
| `lifecycle.idleSeconds`         | none               | Pause after this long without a process connection. Detached processes do not count as activity.                                                                                                                                                                                                                                                                                                                               |
| `lifecycle.suspension.preserve` | memory and disk    | `Preserve.FILESYSTEM_AND_MEMORY` pauses; `Preserve.FILESYSTEM` stops the sandbox and cold-boots it on resume.                                                                                                                                                                                                                                                                                                                  |
| `preview.access`                | `protected`        | `protected` mints a port token sent as the `X-Archil-Token` header. `public` opens the port to anyone with the URL.                                                                                                                                                                                                                                                                                                            |
| `snapshots.preserve`            | memory and disk    | What capture keeps; see [snapshots](#snapshots). One mode per connection.                                                                                                                                                                                                                                                                                                                                                      |
| `credentials.registry`          | none               | `{ username, password }` for private images in image builds. Sent once with the build and never stored.                                                                                                                                                                                                                                                                                                                        |

Labels are refused with `UNSUPPORTED` before anything is created, because Archil sandboxes carry no labels or metadata. Listed sandboxes report `labels: null` and `ownership: "unknown"`. Create-time `env` is stored by Archil and applies to every command, process and terminal.

### Plans

Archil's Free plan allows 5 concurrent sandboxes, 30-minute sessions and one vCPU-hour a month. It cannot set a network policy, so `blocked` and `internet` are refused with `UNSUPPORTED`; instead, every Free sandbox gets Archil's managed egress allowlist (package registries, Git hosts and model APIs). Use `network: "archil-managed"` on the Free plan. The adapter reads each sandbox's network back after create and only reports it ready when it matches the request: a managed allowlist never passes as `internet`, and open egress (what a paid plan gives a sandbox created without a policy) never passes as `archil-managed`. Archil bills compute only while a sandbox runs, but storage continues while it is paused or stopped, so delete sandboxes you no longer need. Archil sandboxes carry no labels, so `beachside gc` cannot match them; list them with `client.sandboxes.list()` (or `beachside ls`) and destroy the ones you are done with.

## What works

Everything below is tested against a simulated Archil API and process connection on every change. It was also checked by hand against the live service in November 2026, on the Free plan in `aws-us-east-1` with `network: "archil-managed"` and the default image: commands, files, processes and reopening, terminals, protected previews, renewal, pause/resume, snapshot capture and restore, and volumes all passed. That check has not run through Beachside's provider qualification suite, so the adapter stays experimental and the [support page](/docs/providers/support/) lists no recorded live pass. Not yet checked live: `blocked`, `internet` and allowlists on a paid plan, public previews, `Preserve.FILESYSTEM` suspension and snapshots, image builds, and how long a snapshot holder runs its captured processes before it is paused.

| Feature           | Support                                                                                                                                                                                                                                                                                        |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compute lifecycle | Create, inspect, inventory, `sandboxes.list()` with creation time, reference reopening, and destroy confirmed by the sandbox's absence.                                                                                                                                                        |
| Commands          | argv and shell, with `cwd`, `env`, create-time `env` and deadlines up to the SDK's 1 hour; exact stdout/stderr bytes up to the SDK's 1 MiB capture limit; finite byte stdin up to 1 MiB. Longer work runs as a process. Output past the bound is drained and the result is marked `truncated`. |
| Processes         | Streamed text or byte output, piped stdin with EOF, `SIGTERM`/`SIGKILL`, status, reopening from a saved reference, and callback `exec`.                                                                                                                                                        |
| Terminals         | Archil's native PTY (`TERM=xterm-256color`) with input, resize, `SIGKILL` and reopening.                                                                                                                                                                                                       |
| Files             | Buffered binary read and write up to 32 MiB; streamed reads and writes of any size; no-clobber writes, copy, move, stat, directory listing, exists, make directory and remove.                                                                                                                 |
| Fork              | `box.fork()` copies a running sandbox's memory, disk and processes into a dependent child; see [Fork](#fork).                                                                                                                                                                                  |
| Snapshots         | Capture memory and disk (default) or disk only; restore into a new sandbox with the snapshot's own network policy; inspect, list and delete. Restores depend on their snapshot; see below.                                                                                                     |
| Images            | `images.build()` from an OCI reference (with registry credentials for private images), polled until ready, and `images.inspect()`.                                                                                                                                                             |
| Volumes           | Archil disks: create, inspect, list and delete, mounted at create read-write or read-only, with a subpath.                                                                                                                                                                                     |
| Suspend/resume    | `suspend()` pauses with memory and `resume()` continues the same processes, or stops and cold-boots with `Preserve.FILESYSTEM`. Process connections drop while paused and reattach afterwards.                                                                                                 |
| Renewal           | `renew()` sets the current session's deadline to the requested time from now.                                                                                                                                                                                                                  |
| Previews          | `preview(port)` returns a protected URL with an `X-Archil-Token` header, or a public URL.                                                                                                                                                                                                      |
| Unsupported       | Labels, and resizing or changing env, labels, lifetime or mounts on restore.                                                                                                                                                                                                                   |

## Snapshots

Archil has no standalone snapshot. It keeps a checkpoint when a sandbox pauses or stops, and only the two most recent checkpoints can be forked into a new sandbox. To keep a snapshot restorable, capture forks the checkpoint into a parked **holder** sandbox named `bs-snap-…`:

1. Pause the source (or stop it, for `Preserve.FILESYSTEM`).
2. Fork its checkpoint into the holder, then pause or stop the holder.
3. Resume the source if it was running.

Restore forks the holder. With memory, the restored sandbox resumes the captured processes; with `Preserve.FILESYSTEM`, it cold-boots from the captured disk. The holder briefly runs the captured processes between the fork and the pause.

Forks are children of what they fork, and Archil refuses to delete a sandbox that has children. So a source cannot be deleted while it has snapshots, and a snapshot cannot be deleted while sandboxes restored from it exist. `destroy()` on such a source stops it and reports it as retained. Archil does not report a sandbox's fork parent, so each restore's name ends with a tag of its snapshot, and `snapshot.delete()` with live restores fails with `CONFLICT` before anything changes. One race remains: a restore started between that check and the delete makes Archil refuse the delete only after the adapter has stopped the snapshot, which discards its memory; that delete reports `OUTCOME_UNKNOWN`, and later restores of the snapshot cold-boot its filesystem. Delete restores first, then the snapshot, then the source. Because of this, `snapshot.restore()` rejects by default; pass `requireIndependentLifecycle: false` to accept the dependency:

```ts
const { snapshot } = await box.snapshot();
const restored = await snapshot.restore({ requireIndependentLifecycle: false });
```

Archil can only fork a sandbox with mounted disks once it is stopped, so capturing a sandbox with volumes is refused. Restores keep the source's resources, env and lifetime; asking to change them is refused.

## Fork

`box.fork()` uses the same native fork without a holder: it pauses the running source, forks its checkpoint into a new running sandbox that resumes the source's processes, then resumes the source. The fork keeps the source's network policy, size and env; Archil applies no labels or lifetime to a fork, so those options are refused before anything changes. Archil forks a sandbox with mounted disks only once it is stopped, and `box.fork()` forks running sandboxes, so a sandbox with volumes can't be forked.

The fork is a child of its source, so the source can't be deleted while the fork exists: `destroy()` on the source stops it and reports it as retained. Destroy forks first. See [Fork a running sandbox](/docs/guides/snapshots-and-volumes/#fork-a-running-sandbox).

## Commands, processes and files

Archil runs one shell command line per process over a WebSocket and streams raw stdout and stderr bytes. argv is single-quoted into that command line, so arguments with quotes, newlines or `$` arrive unchanged. A process keeps running when its connection drops, and reattaches by id at the byte offset it last read; a lost `exec` connection reattaches up to three times before reporting `OUTCOME_UNKNOWN`. Background processes record a PID file, so `signal()` reaches the program's process group. Archil reports a signalled process as exit code `-1`; when the signal came from that handle, the adapter reports the shell convention instead (`143` for `SIGTERM`, `137` for `SIGKILL`), and otherwise no exit code. A command that passes its deadline reports `exitCode: null`.

Archil has no file API for sandboxes. Buffered reads use the official SDK's chunked reader; writes, streamed transfers and metadata run through a small Python 3 helper in the sandbox that writes beside the target and publishes with an atomic rename, or a hard link when the target must not be replaced. Your image needs `sh`, `dd` and Python 3; the default `node:24-bookworm` has them.

## Destroy and recovery

`destroy()` stops the sandbox, deletes it, and waits until Archil no longer returns it. Disks mounted on it survive. Archil does not confirm that a mounted disk's last writes are durable when its sandbox stops, so destroying a sandbox with mounts needs `destroy({ storage: "allow-unconfirmed" })`. Archil would delete a disk out from under a sandbox that mounts it, so `volume.delete()` is refused with `CONFLICT` until no sandbox mounts it.

Beachside sends each mutation once and the adapter adds no retries; the SDK's own retries are bypassed by an adapter-owned single-attempt client. Each create, capture and restore carries an adapter-chosen `bs-…` name derived from its submission, so a create whose response was lost is found by that name instead of being resent. A refusal Archil answers with a 4xx is reported as that error; a lost response or a 5xx is `OUTCOME_UNKNOWN`.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/188) and the [Archil documentation](https://docs.archil.com/compute/sandboxes/introduction).
