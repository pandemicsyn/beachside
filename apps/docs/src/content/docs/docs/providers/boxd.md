---
title: boxd
description: Use the boxd adapter for microVMs booted from OCI images, with suspend/resume, independent disks and public previews.
---

The `@beachside/boxd` package implements the public Beachside adapter interface for [boxd](https://docs.boxd.sh) microVMs. Install it with `npm install beachside @beachside/boxd`; it is experimental, because only the basic workflows have run live. Use Node 20+ or Bun. Native SDK version: `@boxd-sh/sdk@0.3.0`.

```ts
import { Beachside } from "beachside";
import { boxdAdapter } from "@beachside/boxd";

const client = await Beachside.connect({
  adapter: boxdAdapter,
  credentials: { apiKey: process.env.BOXD_API_KEY! },
  config: { org: "my-org", network: "internet" },
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

Use a member API key. `connect` checks that `org` is the key's authenticated default org (by ID or slug) and reads the cluster zone; everything is scoped to that org. Userless org keys and custom endpoints are not supported.

The package also exports `boxd()`, which takes credentials and config in one object and returns an adapter you pass straight to `Beachside.connect`: `Beachside.connect(boxd({ apiKey, org: "my-org", network: "internet" }))`. It is the same setup; use whichever reads better.

## Setup

| Setting                         | Default                          | Notes                                                                                                                                                                                                                                                                            |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `org`                           | required                         | The authenticated default org's ID (`org-…`) or slug; `boxd auth` shows your org context. The CLI reads it from `BOXD_ORG`.                                                                                                                                                      |
| `network`                       | `blocked`                        | `blocked` lets machines reach nothing outside; `internet` leaves egress open; `{ allow: [...] }` reaches only the listed hosts and public IPv4 ranges (see [Egress](#egress)). Machines are always isolated from peers and metadata services. Deprecated alias: `networkPolicy`. |
| `region`                        | the org's home region            | A boxd region such as `fra` (Frankfurt) or `nyc` (New York) that is enabled for your org. Machines, disks and snapshots stay in it. The CLI reads it from `BOXD_REGION`.                                                                                                         |
| `image`                         | cluster default image            | An OCI image reference. boxd boots it directly.                                                                                                                                                                                                                                  |
| `resources`                     | account default size             | Minimum `{ vcpus, memoryMiB }`. Picks the smallest of 1, 2, 4 or 8 vCPUs with 4, 8, 16 or 32 GiB RAM. Deprecated alias: `size` (a vCPU count). The private disk is fixed at 100 GB.                                                                                              |
| `lifecycle.lifetimeSeconds`     | 900                              | No maximum; values under 60 become 60. Also the default `renew()` window. `create({ lifecycle })` can override it per sandbox. Deprecated alias: top-level `lifetimeSeconds`.                                                                                                    |
| `preview.access`                | `public`                         | `public` creates routes and turns off boxd's browser protection. `protected` keeps protection on and creates no routes. See [Public previews](#public-previews).                                                                                                                 |
| `preview.ports`                 | `[3000]`                         | 1 to 16 distinct ports to route when `access` is `public`.                                                                                                                                                                                                                       |
| `volumes.sizeBytes`             | 10 GiB                           | Size of each new disk, from 1 GiB to 1 TiB, subject to your quota.                                                                                                                                                                                                               |
| `snapshots.preserve`            | `Preserve.FILESYSTEM_AND_MEMORY` | Snapshots always keep memory. `Preserve.FILESYSTEM` is rejected at connect.                                                                                                                                                                                                      |
| `lifecycle.suspension.preserve` | `Preserve.FILESYSTEM_AND_MEMORY` | `suspend()` always keeps memory. `Preserve.FILESYSTEM` is rejected at connect.                                                                                                                                                                                                   |

`create({ labels })` and `restore({ labels })` set boxd machine labels, which `sandboxes.list()` returns. Keys are 1 to 63 characters of `a-z 0-9 . _ / -`, start and end with a letter or digit, and cannot use the `boxd/` prefix; values are up to 256 characters, and a machine holds at most 64. A restore merges its labels over the ones the snapshot captured. `create({ region })` must match the configured `region`; to use another region, connect with that `region`. A reference made in one region does not open from a connection to another.

## Egress

`network: { allow: [...] }` uses boxd's native egress allowlist: up to 256 host names, `*.` wildcards (subdomains only) and public IPv4 addresses or ranges, mixed in one list. Private, shared and loopback ranges such as `10.0.0.0/8` reject at connect. boxd admits HTTP and HTTPS by host name and other traffic by address, learning the addresses of listed names as the machine resolves them, and refuses DNS lookups of names that are not listed. The hosts of any boxd secret bound to the machine are always reachable.

boxd sets the allowlist on a machine created from an image once the machine exists, so Beachside applies it (or `blocked`) right after create, before the machine is handed to you; the image's own startup can run for that moment with open egress. A restore sends its allowlist in the machine spec, so it is in force from the first boot. boxd checks entries only when they are applied and refuses provider-wide wildcards such as `*.amazonaws.com`; if it refuses the list, the machine is set to reach nothing and the create reports a partial outcome you can destroy.

Create-time `env` is rejected with `UnsupportedFeatureError` before allocation, because boxd machine variables are not known to reach commands. Pass variables per call with `exec({ env })`; see [environment variables](/docs/guides/images-and-networking/#set-environment-variables).

## What works

| Feature                      | Support                                                                           | Live tested |
| ---------------------------- | --------------------------------------------------------------------------------- | ----------- |
| Sandbox lifecycle            | Create, inspect and destroy.                                                      | Yes         |
| Reconnect later              | Reopen a saved reference with credentials for the same org.                       | Yes         |
| Lifetime renewal             | `renew()` resets the expiry; at least 60 seconds, no maximum.                     | No          |
| Pause and resume             | Keeps memory, processes and sockets.                                              | No          |
| Commands                     | argv and shell, with `cwd` and `env`; exact output bytes, up to 1 MiB combined.   | Yes         |
| Streaming output             | Live stdout/stderr as text or exact bytes; stop with `terminate()`. No terminals. | No          |
| Command input                | Finite stdin up to 1 MiB.                                                         | No          |
| Files                        | Binary read and overwrite write up to 1 MiB; no-clobber writes; streams.          | Yes         |
| Directories                  | List, stat, exists, mkdir, remove, copy and move. Most need Python 3.             | No          |
| HTTP previews                | Public routes on configured ports. Protected previews are not supported.          | No          |
| Images                       | Boots OCI images. Image builds and image get, list and delete are not supported.  | No          |
| Network controls             | `blocked` (the default) and `internet`. Allowlists are not supported yet.         | No          |
| Labels and regions           | Labels on create and restore, returned by listing. One region per connection.     | No          |
| Snapshots                    | Memory and disk capture, restore into a new machine, inspect, list and delete.    | No          |
| Fork                         | `box.fork()` copies a running machine's memory, disk and processes.               | No          |
| Volumes and mounts           | Independent disks: create, inspect, list, delete and whole-disk mounts at create. | No          |
| Listing sandboxes and images | Lists every machine in the org, with no ownership claim. Images: not supported.   | No          |

Live results cover the tested image, region and network setting; see [Provider support](/docs/providers/support/).

## Files and Python

Native reads, overwrite writes, `readDirectory()` and command input need nothing in the image. `listFiles()`, stat/exists, no-clobber writes, mkdir/remove, copy/move and file streams need **Python 3 in your Linux image**; Beachside does not install it. Each helper call has a 30-second deadline.

Use streams for files over 1 MiB; they move 64 KiB chunks with no default size limit, and a streamed read can see concurrent changes. Directory listings are complete or fail with `OUTPUT_CAPACITY`.

Copies and streamed writes without overwrite need hard links in the destination filesystem, and moves without overwrite need Linux `renameat2`. Moves across filesystems fail without touching the source. A failed streamed write can leave a `.beachside-<uuid>` temporary file beside the destination, named in the error; an interrupted no-clobber buffered write can leave partial contents. See [files and output](/docs/guides/files-and-output/).

## Public previews

Public previews are the default. To route more ports, set `preview: { access: "public", ports: [3000, 8080] }` when connecting. **These routes are open to anyone with the URL.** After starting a server, `box.preview(3000)` returns `{ access: "public", url }`. It only looks up the existing route on a running machine; it does not create routes or wake the machine, and the URL does not prove your server is ready.

With `preview: { access: "protected" }`, preview lookup fails as unsupported. This does not make boxd's own ingress private: native traffic can still reach or wake a machine. See [preview access](/docs/guides/preview-access/).

## Snapshots

`box.snapshot()` always saves memory and disk together; boxd has no filesystem-only capture, so `snapshots: { preserve: Preserve.FILESYSTEM }` fails at connect. boxd pauses the machine briefly and it keeps running; a restored machine resumes the captured processes under a new ID, with its own name, URL and private IP. Processes that cached the old hostname or address keep the stale value.

boxd keeps only the latest version under a snapshot name, so every capture gets its own name and the reference remembers the captured version. If someone saves that snapshot again outside Beachside, `inspect()`, `restore()` and `delete()` fail with `CONFLICT` before changing anything. A restore keeps the captured size, applies the requested network policy, your configured lifetime and preview settings, and cannot attach disks. Snapshots do not expire, so delete them when you are done. See [snapshots and volumes](/docs/guides/snapshots-and-volumes/).

## Fork

`box.fork()` uses boxd's native fork. The source pauses for a fraction of a second to hand over its memory and keeps running; the fork is a new machine that continues the source's processes, with its own name, URL and private IP. It keeps the source's size, egress and copy-on-write disk, so later writes on either machine don't reach the other. `labels` merge over the source's labels, and `lifetimeSeconds` replaces the configured lifetime. boxd pauses the automations a fork inherits, so nothing runs twice. Destroying either machine leaves the other running.

A source whose egress no longer matches the connection's `blocked`, `internet` or allowlist (for example, changed outside Beachside) is refused, because the fork would inherit it. See [Fork a running sandbox](/docs/guides/snapshots-and-volumes/#fork-a-running-sandbox).

## Storage and recovery

`suspend()` uses boxd's native pause, and `resume()` wakes the machine under the same ID. Inspecting or reopening does not wake it; inbound traffic can.

A disk attaches to one machine at a time, including read-only mounts, with no subpaths. Disks survive destroy and must be deleted explicitly; they have no expiry. Persistence and locking on mounted disks are not established, so destroying a machine with mounts fails with `UNSUPPORTED` unless you pass `storage: "allow-unconfirmed"` (or set `cleanup: { storage: "allow-unconfirmed" }` when connecting). Flush writers first. Cleanup reports the retained disk IDs.

A refused create carries a matching code and boxd's reason, for example `CAPACITY` for a quota. boxd writes the expiry together with the machine, on creates, restores and forks. If egress, preview setup or the first readiness check is unconfirmed, you get a partial create whose `outcome.sandbox` you can reopen and destroy. A disk whose create response was lost is not tracked; check your boxd disks and confirm it is yours before deleting it. See [recovery](/docs/guides/recovery/#partial-and-unknown-outcomes).

## Limits

- boxd sets egress on a machine created from an image once it exists, so the image's own startup can run for a moment with open egress before `blocked` or the allowlist applies. Restores carry their egress from the first boot.
- Public previews are reachable by anyone with the URL, and protected previews are unsupported.
- Snapshots of machines with mounted disks are rejected, and restores cannot attach disks or change the captured size.
- Create-time `env`, image builds and image management are unsupported. Each connection works in one region.
- Buffered command output, stdin and file transfers are limited to 1 MiB; most filesystem operations need Python 3.
- Disks survive destroy and must be deleted explicitly. Closing the client destroys nothing.

See the [provider research issue](https://github.com/pandemicsyn/beachside/issues/41), [live test evidence](https://github.com/pandemicsyn/beachside/blob/main/packages/providers/boxd/qualification/live-qualification.md) and the [boxd TypeScript SDK docs](https://docs.boxd.sh/reference/typescript-sdk).
