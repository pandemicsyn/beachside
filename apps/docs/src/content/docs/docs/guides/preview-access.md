---
title: Preview access
description: Access an HTTP service running inside a sandbox.
---

Use `await box.preview(3000)` to get access to an HTTP service on port 3000 inside a running sandbox. Choose public or protected access when configuring the adapter. The available modes depend on the provider, and each adapter defaults to the mode it can serve: Daytona and Modal default to protected (Daytona's public mode signs expiring per-port links); E2B, boxd, Vercel and Boat default to public, and Boat offers public only. boxd publishes port 3000 by default; Vercel publishes only the `ports` you configure.

This example uses Daytona's default protected access. Replace `existing-server-snapshot` with a prepared image whose startup configuration launches an HTTP server on port 3000:

```ts
import { Beachside, Image } from "beachside";
import { daytonaAdapter } from "@beachside/daytona";

const client = await Beachside.connect({
  adapter: daytonaAdapter,
  credentials: { apiKey: process.env.DAYTONA_API_KEY! },
  config: {
    target: "us",
    network: "daytona-default",
    preview: { access: "protected" }, // default
  },
});
try {
  const box = await client.sandboxes.create({
    environment: Image.prepared("existing-server-snapshot"),
  });
  try {
    const preview = await box.preview(3000);
    const response = await fetch(preview.url, {
      headers: preview.access === "protected" ? preview.headers : undefined,
      redirect: "error",
    });
    if (!response.ok) throw new Error("Service unavailable or not ready");
    console.log(await response.text());
  } finally {
    await box.destroy();
  }
} finally {
  await client.close();
}
```

## Service readiness and cancellation

`preview()` does not start a server or wait for it to be ready. Start your service through the image's startup configuration or the [process API](/docs/guides/text-streaming/). A preview URL can be available before the service starts listening, so handle failed HTTP requests and check readiness in your application.

Preview lookup also does not resume a suspended sandbox, extend its lifetime, replace it, or change its outbound network policy. Outbound network policy and inbound preview access are separate settings.

Ports must be integers from **1 through 65535**. Lookup has a **30-second deadline**. Pass `preview(port, { signal })` to cancel local waiting. Cancellation does not stop the remote service, and the signal does not apply to later `fetch()` calls; pass a signal to those separately if needed.

## Protected access with Daytona

A protected result contains `url` and `headers`. Send those headers from your own HTTP client, as shown above. Merely opening the URL in a browser does not supply them.

**Daytona's preview token grants access across the sandbox, including terminal/toolbox command execution and filesystem access.** Treat it as a sandbox credential. Do not share it as a read-only viewing link or expose it to an untrusted client.

Requests carrying preview headers must use `redirect: "error"`. Otherwise, a redirect to a different host can forward custom authentication headers and disclose the token.

Daytona's standard tokens cannot be revoked individually. Native stop/start rotates them; native pause/resume retains them. Looking up access can activate the requested preview route. Beachside verifies the sandbox's identity, running state and private visibility first, and does not change visibility during lookup.

## Expiring public links with Daytona

With `preview: { access: "public" }`, Daytona returns a signed URL for that one port that anyone holding it can open, with no headers. The sandbox itself stays private, and the link stops working after `preview.expiresInSeconds` (default **3600**, from 1 second to 24 hours). The result reports when that is:

```ts
const client = await Beachside.connect({
  adapter: daytonaAdapter,
  credentials: { apiKey: process.env.DAYTONA_API_KEY! },
  config: { target: "us", preview: { access: "public", expiresInSeconds: 900 } },
});
// ...
const preview = await box.preview(3000); // { access: "public", url, expiresAt }
```

Each call signs a new URL; earlier ones keep working until they expire, and they survive a stop and start. Use this for links you hand to people; keep protected access for your own server-side calls. Signed public access has not been live-tested yet.

## Modal connect tokens and tunnels

Modal defaults to protected access: each `preview(port)` mints a Modal connect token for that port and returns it as an `Authorization: Bearer` header. For public links, set `preview: { access: "public", ports: [3000] }`; Modal publishes those ports as HTTPS tunnels when the sandbox is created, and cannot add more later. Neither mode has been live-tested. See the [Modal adapter README](https://github.com/pandemicsyn/beachside/tree/main/packages/providers/modal#previews).

Some providers' previews carry an `expiresAt` timestamp. When it is present, ask for a new preview before it passes.

## Public and protected access with E2B

E2B defaults to public preview access, matching E2B's native default. Setting it explicitly is equivalent:

```ts
import { e2bAdapter } from "@beachside/e2b";

const client = await Beachside.connect({
  adapter: e2bAdapter,
  credentials: { apiKey: process.env.E2B_API_KEY! },
  config: { preview: { access: "public" } },
});
```

This setting exposes the sandbox's HTTP services to anyone who can reach their URLs. Exposure begins when a sandbox is created or restored, before you call `preview()`. Lookup requires confirmed public visibility, the native `e2b.app` domain and auto-resume disabled. Connecting alone does not change the visibility of existing sandboxes.

Select `preview: { access: "protected" }` to keep new sandboxes closed to inbound traffic: creation and restore disable public traffic and verify visibility before reporting success. If visibility cannot be confirmed, the operation remains uncertain and retains its confirmed resource identity for recovery and cleanup. Live tests have not yet qualified denial of incoming traffic in protected mode.

With protected access, `preview()` returns E2B's traffic token as an `e2b-traffic-access-token` header; requests without it get `403`. E2B hands that token out only from its connect call, so `preview()` first checks that the sandbox is running, private and has auto-resume off, then connects with the sandbox's observed remaining lifetime as the timeout, so the lifetime stays as it was. If the sandbox paused between the check and the call, E2B resumes it with that remaining lifetime and `preview()` fails with `CONFLICT` instead of returning access; inspect it and ask again. Like Daytona's preview token, the header is a credential: send it with `redirect: "error"` and don't log it. Protected access has not been tested live yet.

Recovery preserves an operation's original visibility setting. Older create references without preview metadata, and version-1 restore references without a visibility field, used public access. Recovering those operations requires confirmed native public visibility, even if the current connection selects protected access.

## Reuse sandbox identity, not access details

URLs and headers are temporary access information. Do not log them or use them as a saved sandbox identity. Save `box.reference` for reopening, then request preview access again. Sandbox deletion or expiry makes the service unavailable; Beachside does not promise a shared URL expiry or revocation policy across providers.

Beachside validates that response URLs use HTTPS and contain no username, password, query or fragment. It excludes returned access details from diagnostics and recovery state.

The complete [preview recipe](https://github.com/pandemicsyn/beachside/blob/main/apps/docs/examples/sandbox-preview.ts) uses an image that starts its own server. Offline tests cover the SDK and provider boundaries. Daytona protected access and E2B explicit public access passed live tests at `3188e33`, with sandbox cleanup confirmed. See [tested provider support](/docs/providers/support/) for the exact scope and remaining gaps.
