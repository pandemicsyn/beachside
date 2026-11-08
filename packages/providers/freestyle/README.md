# @beachside/freestyle

Experimental Freestyle VMs adapter for Beachside. Implementation and offline fixtures are available; no live Freestyle run has been made yet. Install with `npm install beachside @beachside/freestyle`. Requires Node 20+ or Bun and a Freestyle API key. Built on Freestyle's official SDK, pinned to `freestyle@0.2.21` (public API v5).

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

Freestyle does not reveal which account an API key belongs to, so the scope is a one-way fingerprint of the key plus the fixed `https://api.freestyle.sh` endpoint. References hold the VM id and scope, never the API key, and reopen with the same key.

## Setup defaults

| Setting                     | Behavior                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `network`                   | `blocked` (default) sends an empty Freestyle firewall; `internet` allows every public destination.                                                                                                |
| `image`                     | `freestyle/ubuntu` (4 vCPU, 8 GiB). Any Freestyle snapshot: a `sh-…` id, your slug, or a public `owner/slug`. No OCI images.                                                                     |
| `resources`                 | Optional minimum `{ vcpus, memoryMiB }`; picks the smallest Ubuntu base from `freestyle/ubuntu-sm` (2, 4 GiB) to `freestyle/ubuntu-2xl` (32, 64 GiB). Set `image` or `resources`, not both.      |
| `lifecycle.lifetimeSeconds` | 900; 60 s to 30 days. Freestyle deletes the VM that long after creation (`ttlSeconds`).                                                                                                           |
| `lifecycle.idleSeconds`     | Optional. Pauses the VM after that long without network activity (`idleTimeoutSeconds`).                                                                                                          |
| `preview`                   | `{ access: "public", ports: [] }`. Listed ports are published at create on `<slug>-<port>.style.dev`, others on first `preview(port)`; `protected` rejects at connect.                            |
| `snapshots`                 | `preserve` must be memory and disk (Freestyle's only capture); `retentionSeconds` deletes each snapshot that long after capture.                                                                  |

## Behavior

- **Create** boots one VM with a `beachside-<hash>` slug derived from the submission, so a lost response is found by slug and never resent, and waits for `running`. Labels become VM metadata. Create-time `env` is written to `/etc/beachside.env`, which every command, process and terminal reads before its own `env`.
- **Exec** supports argv and shell, `cwd`, `env`, finite stdin up to 1 MiB (Freestyle's `stdin` field) and deadlines up to 24 hours on current guest agents. A small `sh` wrapper keeps arguments quoted and returns stdout/stderr as base64, or as raw files for large output, so bytes survive Freestyle's lossy UTF-8 text channel. Output is bounded to 1 MiB per stream.
- **Processes** run as detached guest jobs whose stdout, stderr and exit status go to private files the adapter polls (base64, byte exact), with FIFO stdin, process-group signals, status and reopen. **Terminals** are named Freestyle PTY sessions (WebSocket) with input, resize, `SIGKILL` and reopen.
- **Files** read and overwrite up to 8 MiB in one sha256-verified request; larger files stream through 1 MiB range reads and staged writes published by rename (or hard link for no-clobber). Copy, move, stat, mkdir, remove and exists use a small Python 3 helper in the VM.
- **Snapshots** capture memory and disk from a running or paused VM under a per-attempt slug; restore boots a new VM from the snapshot id and resumes the captured processes. Inspect, list, delete and expiry (`ttlSeconds`) are supported, and `images.list()` lists the account's snapshots as prepared images.
- **Suspend/resume** maps to Freestyle pause (memory kept) and start (same processes).
- **Renew** sets `ttlSeconds` to the VM's age plus the requested window.
- **Preview** returns the `style.dev` URL for a port, publishing it on first use; the rule names the VM, so Freestyle deletes it with the VM.
- **Destroy** deletes the VM and waits until Freestyle no longer returns it.
- Unsupported: OCI images and builds, volumes, mounts and regions (Freestyle has none). Protected previews (Freestyle offers forward auth through your own service) and egress allowlists are not wired yet.

Every mutation is sent once. The SDK replays only bodyless reads, follows Freestyle background requests for slow calls, and this adapter adds no retries. 4xx refusals become ordinary errors; lost responses, 5xx and `VM_NON_RESPONSIVE` become `OUTCOME_UNKNOWN` and are never replayed.

See the [provider page](https://beachside.run/docs/providers/freestyle/) and the [research issue](https://github.com/pandemicsyn/beachside/issues/129).
