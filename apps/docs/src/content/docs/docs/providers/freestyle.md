---
title: Freestyle
description: Use the Freestyle adapter for Ubuntu microVMs with blocked egress, memory-keeping pause/resume and public previews.
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

| Setting                     | Default            | Notes                                                                                                                                                                                                                                     |
| --------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `network`                   | `blocked`          | `blocked` creates the VM with an empty firewall, so it can reach nothing. `internet` allows every public destination. Allowlists are unsupported.                                                                                         |
| `image`                     | `freestyle/ubuntu` | A snapshot to boot: a `sh-…` id, your own snapshot slug, or a public `owner/slug` such as `freestyle/ubuntu-sm`. OCI images and image builds are unsupported.                                                                             |
| `resources`                 | 4 vCPU, 8 GiB      | Minimum `{ vcpus, memoryMiB }`. Picks the smallest Ubuntu base: `freestyle/ubuntu-sm` (2 vCPU, 4 GiB), `freestyle/ubuntu` (4, 8 GiB), `-lg` (8, 16 GiB), `-xl` (16, 32 GiB) or `-2xl` (32, 64 GiB). Set `image` or `resources`, not both. |
| `lifecycle.lifetimeSeconds` | 900                | 60 seconds to 30 days. Freestyle deletes the VM that long after it was created, even while paused. `create({ lifecycle })` can override it per sandbox.                                                                                   |
| `lifecycle.idleSeconds`     | none               | Pause the VM after this many seconds without network activity. Traffic or `resume()` wakes it.                                                                                                                                            |
| `preview.access`            | `public`           | Freestyle previews are public `style.dev` URLs; `protected` rejects at connect.                                                                                                                                                           |
| `preview.ports`             | none               | Ports to publish. Each create claims one `<slug>-<port>.style.dev` name for your account.                                                                                                                                                 |

Labels are stored as Freestyle VM metadata (up to 64, keys and values up to 63 characters), so `sandboxes.list()` and `beachside gc` can find them. Create-time `env`, `region` and mounts are rejected.

## What works

Everything below is tested against a simulated Freestyle API on every change. **No live Freestyle run has been made yet.**

| Feature           | Support                                                                                                                                       | Live tested |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Compute lifecycle | Create, inspect, inventory, `sandboxes.list()` with labels and creation time, reference reopening, and destroy confirmed by the VM's absence. | No          |
| Commands          | argv and shell, with `cwd` and `env`; exact stdout/stderr bytes up to 1 MiB per stream; finite byte stdin up to 1 MiB.                        | No          |
| Files             | Binary read and overwrite write up to 8 MiB, sha256-verified and replaced atomically; directory listing. No-clobber writes are unsupported.   | No          |
| Suspend/resume    | `suspend()` pauses the VM with its memory; `resume()` continues the same processes. Network connections are treated as dropped.               | No          |
| Renewal           | `renew()` moves the deletion deadline to the requested time from now.                                                                         | No          |
| Previews          | `preview(port)` returns the public `style.dev` URL published for that port at create.                                                         | No          |
| Unsupported       | OCI images and image builds, snapshots, volumes, mounts, egress allowlists, create-time env, streamed processes, terminals and regions.       | —           |

## How commands keep bytes and arguments

Freestyle runs one command line through the guest shell and returns stdout/stderr as UTF-8 text, replacing invalid bytes. To keep argv as separate arguments and output as exact bytes, the adapter sends a small POSIX `sh` wrapper: arguments are single-quoted, the command's stdout and stderr go to private files under `/tmp`, and the wrapper prints one record with the exit code and byte counts. Results of 32 KiB or less come back inline as base64; larger results are downloaded as raw bytes through the filesystem API and the guest directory is removed afterwards. Finite stdin goes in Freestyle's own `stdin` field. Your image needs `sh`, `mktemp`, `base64`, `head`, `wc`, `tr` and `env`; the Ubuntu bases have them.

Deadlines run up to 24 hours on VMs whose guest agent supports long execs. Older agents refuse anything over five minutes, and that refusal is reported as `UNSUPPORTED`. A command that passes its deadline is reported as `OUTCOME_UNKNOWN`.

## Destroy and recovery

`destroy()` deletes the VM, which removes its firewall rules and preview rules with it, and waits until Freestyle no longer returns it.

Beachside sends each mutation once and the adapter adds no retries; Freestyle's SDK replays only reads. Slow calls run as Freestyle background requests, which the SDK follows until they finish. Each create carries a `beachside-<hash>` slug derived from its submission, so a create whose response was lost is found by that slug instead of being resent. A refusal Freestyle answers with a 4xx is reported as that error; a lost response, a 5xx, or a `VM_NON_RESPONSIVE` command is `OUTCOME_UNKNOWN`. Listed VMs report `ownership: "unknown"`.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/129) and the [Freestyle documentation](https://www.freestyle.sh/docs).
