# @beachside/runloop

Experimental external Runloop adapter for Beachside. Runloop sign-ups are currently by invitation only. Implementation and offline fixtures are available; no live Runloop run has been made yet. Install with `npm install beachside @beachside/runloop`. Requires Node 20+ or Bun and a Runloop API key. Calls the Runloop REST API v1 directly, with no native SDK dependency.

```ts
import { Beachside } from "beachside";
import { runloopAdapter } from "@beachside/runloop";

const client = await Beachside.connect({
  adapter: runloopAdapter,
  credentials: { apiKey: process.env.RUNLOOP_API_KEY! },
  config: { network: "blocked" },
});
try {
  const box = await client.sandboxes.create();
  try {
    console.log((await box.exec(["/bin/sh", "-c", "printf ready"])).stdoutText());
  } finally { await box.destroy(); }
} finally { await client.close(); }
```

Scope is the account id from `GET /v1/accounts/me` plus the fixed `https://api.runloop.ai` endpoint. References hold the Devbox id and scope, never the API key.

## Setup defaults

| Setting | Behavior |
| --- | --- |
| `network` | `blocked` (default) attaches a managed deny-all network policy named `beachside-blocked`; `internet` attaches none. |
| `image` | `runloop-default` (no blueprint), or a blueprint id or name. No OCI images. |
| `resources` | Optional minimum `{ vcpus, memoryMiB }`; picks the smallest Runloop size from `X_SMALL` (0.5 vCPU, 1 GiB) to `XX_LARGE` (8, 32 GiB), then a custom 16 vCPU size with 32 or 64 GiB. `inspect().resources` reports the size. |
| `lifecycle.lifetimeSeconds` | 900; 60 s to 48 h. Expiry shuts the Devbox down. |
| `lifecycle.idleSeconds` | Suspend after this idle time instead of a fixed lifetime. Not combined with `lifetimeSeconds`. |
| `preview.access` | `protected` (default) previews need the returned auth header; `public` URLs are open. |

## Secrets

A plain `secret(value)` becomes a Runloop account secret named for the create attempt and is mapped into the devbox with `secrets`, so the value is not part of the devbox definition. A brokered secret for `api.anthropic.com` or `api.openai.com` (the `anthropic` and `openai` presets) also becomes an account secret, plus a gateway config for that endpoint: the devbox variable holds a token bound to the devbox, and the adapter sets `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to `https://gateway.labs.runloop.ai`, where Runloop adds the real key. Other hosts, more than one host per secret, Basic auth, a caller-set base URL and `network: "blocked"` (whose policy denies the gateway) are refused before any call. The devbox metadata records the secrets and gateway configs, and destroy deletes them; any that remain are reported in `retainedResources`.

## Behavior

- **Create** sends `beachside_operation`/`beachside_submission` metadata, a tunnel and create-time `env`, then waits for `running`. A lost response is recovered by finding the marker, never by resending.
- **Exec** supports argv and shell, `cwd`, `env`, finite stdin and deadlines up to an hour. A small `sh` wrapper keeps arguments quoted; results up to 32 KiB return inline as base64 and larger ones are downloaded as bytes. Output is bounded to 1 MiB per stream. Deadline overruns kill the execution and report `OUTCOME_UNKNOWN`.
- **Streaming processes** run through `execute` with no deadline and follow Runloop's server-sent log streams (`stream_stdout_updates`, `stream_stderr_updates`), reopening from byte offsets; exit comes from `wait_for_status`. Output is UTF-8 text only, so `format: "bytes"` and callback exec are unsupported. `terminate()` kills the execution. Piped stdin, terminals, signals and reopen are unsupported. Offset semantics and stream closing at exit are taken from Runloop's API reference and are untested against the live service.
- **Files** read and overwrite up to 64 MiB. No-clobber writes are unsupported.
- **Suspend/resume** keeps the disk only; resume starts fresh processes.
- **Snapshots** capture the disk asynchronously while the Devbox keeps running; restore creates a new Devbox. List, inspect and delete are supported. Setup accepts `snapshots: { preserve: Preserve.FILESYSTEM }` (the default); `Preserve.FILESYSTEM_AND_MEMORY` rejects `UNSUPPORTED` at connect.
- **Preview** returns the tunnel URL for a port.
- **Destroy** shuts the Devbox down and confirms the `shutdown` status. Snapshots survive.
- Unsupported: OCI images and image builds, volumes, mounts, egress allowlists, renewal, interactive processes, directory operations, regions and labels.

Every mutation is sent once. 4xx refusals become ordinary errors; lost responses and 5xx become `OUTCOME_UNKNOWN` and are never replayed.

See the [provider page](https://beachside.run/docs/providers/runloop/) and the [research issue](https://github.com/pandemicsyn/beachside/issues/47).
