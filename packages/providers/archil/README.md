# @beachside/archil

Experimental Archil Sandboxes adapter for Beachside. Tested on every change against a simulated Archil API and process connection; not yet checked against the live service. Install with `npm install beachside @beachside/archil`. Requires Node 22.19+ or Bun, and an Archil API key; on the Free plan, set `network: "archil-managed"`. Built on Archil's official SDK, pinned to `disk@1.12.0`.

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

Archil does not reveal which account an API key belongs to, so the scope is a one-way fingerprint of the key, partitioned by region and control-plane URL. References hold the sandbox id and scope, never the API key, and reopen with the same key.

## Setup defaults

| Setting                         | Behavior                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `region`                        | Required: `aws-us-east-1`, `aws-us-west-2` or `aws-eu-west-1`.                                                                 |
| `network` | `blocked` (default) sends `egress.default: "deny"`; `internet` sends no policy and checks that egress is open (both need a paid plan); `archil-managed` sends no policy and checks for Archil's managed allowlist (the Free plan). |
| `image`                         | `node:24-bookworm`, always sent explicitly. Any amd64 OCI image, or a 64-hex image id from an image build.                      |
| `resources`                     | Exact `{ vcpus, memoryMiB }`; vCPUs rounded up to whole numbers, 1–32 vCPU and 256–65536 MiB. Default 1 vCPU, 2 GiB.            |
| `lifecycle.lifetimeSeconds`     | 900; 60 s to 24 h. Per powered-on session (`max_ttl_seconds`); expiry pauses the sandbox.                                       |
| `lifecycle.idleSeconds`         | Optional. Pauses after that long without a process connection; otherwise idle expiry is off (`idle_ttl_seconds: 0`).            |
| `lifecycle.suspension.preserve` | Memory and disk (pause) by default; `filesystem` stops and cold-boots.                                                         |
| `preview.access`                | `protected` (port token in `X-Archil-Token`) by default, or `public`.                                                          |
| `snapshots.preserve`            | Memory and disk by default, or `filesystem`. One mode per connection.                                                          |

## Behavior

- **Transport.** Control-plane calls go through an adapter-owned client that sends each mutation once, so the SDK's built-in retries never replay pause, stop, resume, delete or timeout. The SDK's `Sandbox` objects run on that client for processes and files, so the WebSocket protocol stays the SDK's.
- **Commands.** argv is single-quoted into Archil's command line. Raw stdout and stderr bytes are kept up to 8 MiB per stream; the rest is drained and marked truncated. A dropped connection reattaches at the last offset up to three times.
- **Processes and terminals.** Background processes record a PID file so signals reach the program; terminals use the native PTY.
- **Files.** Buffered reads use the SDK's chunked reader; writes, streams and metadata run through a Python 3 helper in the guest that publishes with an atomic rename or hard link.
- **Snapshots.** Capture pauses (or stops) the source, forks its checkpoint into a `bs-snap-…` holder, parks the holder and resumes the source. Restores fork the holder, so they depend on it: `restore()` needs `requireIndependentLifecycle: false`. Archil refuses to delete a sandbox with children, so destroying a source with snapshots reports it retained, and deleting a snapshot with live restores is a `CONFLICT`.
- **Labels** are refused before dispatch; Archil sandboxes carry none.
- **Recovery.** Each create, capture and restore has an adapter-chosen `bs-…` name; a lost response is found again by that name. A 4xx is reported as that error; a lost response or a 5xx is `OUTCOME_UNKNOWN`.

See the [provider guide](https://beachside.run/docs/providers/archil/) and the [research issue](https://github.com/pandemicsyn/beachside/issues/188).
