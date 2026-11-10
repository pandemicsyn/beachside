---
title: Images and networking
description: Choose a sandbox environment, build reusable images, and configure networking.
---

Set the default environment and network policy in adapter setup. Your application can then use `beachside.sandboxes.create()` without repeating those choices. See [Getting started](/docs/direct-quickstart/) for connection examples.

## Start from a prepared image

`Image.prepared(value)` selects an existing provider image. It does not build an image or capture a running sandbox.

| Provider       | Prepared image                            | Connection setup                                                                                          |
| -------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| E2B            | `base`, or a ready owned template ID/name | `templateId` defaults to `base`. Set it to use your own template.                                         |
| Daytona        | Active Linux snapshot ID/name             | Set `environment: Image.prepared("your-snapshot")`. It must be available in your organization and region. |
| Vercel Sandbox | `vercel/sandbox/universal:latest`         | Default. Set `image` to a managed Node 22, 24 or 26 image instead; other images are unsupported.          |

Daytona calls its prepared images snapshots. Selecting one as an image is different from capturing a sandbox's current state. For capture and restore, use the [snapshot APIs](/docs/guides/snapshots-and-volumes/).

boxd starts directly from an OCI image instead of a prepared image. Set `image` in its adapter configuration, or omit it to use the authenticated cluster's default image. Starting from OCI does not create a separate Beachside image-build artifact. See [boxd defaults](/docs/providers/boxd/#setup).

An explicit `environment` on `create()` overrides the connection default if the adapter supports it. An invalid override fails; Beachside does not silently fall back to another image. Vercel accepts only its configured managed image.

## Build an OCI image

E2B and Daytona implement `images.build()` to turn an OCI image into a reusable prepared image. Builds are separate provider operations and may incur build and storage charges. boxd boots OCI images directly and does not implement this build API; Vercel supports neither custom OCI images nor builds. `(await client.capabilities()).imageBuild` is `true` on connections that implement the build. Check [tested provider support](/docs/providers/support/) for live coverage.

Start with an E2B or Daytona connection named `beachside`:

```ts
import { Image } from "beachside";

const built = await beachside.images.build({ source: Image.oci("node:24") });
console.log(built.retainedResources);
const box = await beachside.sandboxes.create({
  environment: Image.prepared(built.prepared),
});
try {
  console.log((await box.exec(["node", "--version"])).stdoutText());
} finally {
  await box.destroy();
}
```

Creation uses the connection's network policy. Close the connection in an outer `finally` after handling resources, as in [Getting started](/docs/direct-quickstart/). `images.submitBuild()` returns an operation handle if you need to save an operation reference and recover its result later.

Pass the full `built.prepared` value to `Image.prepared()`: it includes the provider and verified scope, so another account or scope cannot accidentally use it. Public OCI references are supported; the SDK has no shared private-registry credential option. Daytona requires a version tag or SHA-256 digest and rejects `latest`, `lts` and `stable`. Use a digest when you need an exact immutable image.

**Destroying a sandbox does not delete its built template or snapshot.** Keep `built.reference` (or `built.retainedResources`) available and delete images you own separately, including when sandbox creation fails. Borrowed prepared images are never sandbox cleanup targets.

## Inspect, list and delete images

`built.reference` is a resource reference of kind `"image"`. Its `ownership` is `"verified-created"` only when the adapter proved this build created the image; a build recovered after a lost response reports `"unknown"`. Persist the whole reference, then reopen and delete the image with it:

```ts
const image = await beachside.images.get(built.reference);
console.log(await image.inspect()); // state, visibility, source and known dependencies
await image.delete(); // or beachside.images.delete(built.reference)
```

`images.list({ limit: 20, cursor })` returns a bounded page of the provider's images with a `coverage` value, like [snapshot and volume inventory](/docs/guides/snapshots-and-volumes/). Finding an image in a list does not prove you own it, so listed items have unknown ownership. `(await beachside.capabilities()).imageManagement` reports whether inspect, list and delete are supported; a missing operation rejects with `UNSUPPORTED`.

Deletion follows the snapshot deletion rules. The reference must match the connection's provider and scope. The adapter refuses public or shared images, captured sandbox snapshots (delete those with `snapshots.delete()`) and images that sandboxes or other native resources still use, rejecting with no effect before it sends anything. Deletion sends one native request and never resends it. If the response is lost and the image is not then observed gone, `delete()` rejects with `OUTCOME_UNKNOWN`; `submitDelete()` returns an operation whose saved reference you can recover later to learn whether the image is gone.

| Provider       | Images                      | Get, list and delete                                                                                                   |
| -------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| E2B            | Templates                   | Supported. Delete only removes a private, single-build template that no sandbox uses. See [E2B](/docs/providers/e2b/). |
| Daytona        | Native snapshots            | Supported. Delete refuses general snapshots and snapshots used by warm pools. See [Daytona](/docs/providers/daytona/). |
| boxd           | OCI images, booted directly | Unsupported: there is no provider-side image resource.                                                                 |
| Vercel Sandbox | Managed images only         | Unsupported.                                                                                                           |

Image deletion has deterministic test coverage only; no live deletion has been recorded.

## Select a network policy

Configure `network` once in adapter setup. Every adapter uses the same names, so switching providers does not change application code:

| Provider       | `network`                   | Meaning                                                                                                     |
| -------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| E2B            | `blocked` (default)         | Requests E2B's disabled-internet setting; measured strict outbound isolation has not passed.                |
| E2B            | `internet`                  | Requests internet access.                                                                                   |
| Daytona        | `blocked`                   | Requests strict block-all. Creation requires verified organization eligibility, with no automatic fallback. |
| Daytona        | `internet`                  | Unrestricted egress. Creation requires an organization without limited sandbox egress (Tier 3 and above).   |
| Daytona        | `daytona-default` (default) | Daytona-only setup value: keeps organization-managed restrictions, including essential-service access.      |
| boxd           | `internet` (required)       | Allows internet access with native peer/metadata isolation. Strict blocked egress is unsupported.           |
| Vercel Sandbox | `blocked` (default)         | Requests native `deny-all`; network isolation has no recorded live acceptance.                              |
| Vercel Sandbox | `internet`                  | Requests native `allow-all`.                                                                                |
| Modal          | `blocked` (default)         | Requests Modal's `blockNetwork`.                                                                            |
| Modal          | `internet`                  | Open egress.                                                                                                |
| Most providers | `{ allow: [...] }`          | Only the listed hosts and IPv4 ranges; see [allow only some destinations](#allow-only-some-destinations).   |

```ts
// Only the adapter setup differs between providers.
const client = await Beachside.connect({
  adapter: e2bAdapter,
  credentials: { apiKey },
  config: { network: "internet" },
});
const box = await client.sandboxes.create();
```

A requested policy is not proof of isolation. E2B's maintained test still connected by direct IPv4 TCP when `blocked` was requested, even though hostname resolution failed. Prepared-image baseline tests do not test outbound isolation. See [provider support](/docs/providers/support/#known-limits) before relying on a policy to isolate untrusted code.

Daytona's `internet` never falls back to `daytona-default`: on a Tier 1 or Tier 2 organization it rejects before allocation, because Daytona's default firewall there only reaches essential services. Choose `daytona-default` in setup when that restricted egress is acceptable. boxd's peer/metadata isolation does not block outbound internet.

Omitted create and restore policies use the connection default, so most applications never pass `network` per call. An explicit `create({ network })` or `restore({ network })` must be supported by that connection: E2B, Modal, Runloop and Freestyle accept `blocked` or `internet`, while Daytona and Vercel require a match with the configured policy. boxd accepts only `internet`. A connection configured with an allowlist accepts only `allow`; see [allow only some destinations](#allow-only-some-destinations). Empty or null policies reject rather than selecting a fallback. `client.capabilities().network` lists what the connection accepts.

The option was previously named `networkPolicy`, and Vercel used `vercel-deny-all` and `vercel-allow-all`. Those spellings still work and are deprecated; passing both `network` and `networkPolicy` with different values rejects.

`snapshot.restore()` uses the current connection's policy, not the captured sandbox's networking. Saved operations keep the policy resolved at submission when you recover them. Outbound policies do not open a public preview URL; see [Preview access](/docs/guides/preview-access/).

## Allow only some destinations

To let a sandbox reach a few services and nothing else, give `network` an allowlist in adapter setup:

```ts
const client = await Beachside.connect({
  adapter: e2bAdapter,
  credentials: { apiKey },
  config: { network: { allow: ["registry.npmjs.org", "*.github.com", "10.20.0.0/16"] } },
});
const box = await client.sandboxes.create(); // Uses the allowlist.
```

Each entry is a host name, a `*.` wildcard host or an IPv4 address or range. Host entries allow HTTPS to that name, usually matched by TLS SNI; plain HTTP, other protocols and the bare name behind a `*.` wildcard vary by provider, as the Notes column says. `*.github.com` covers subdomains; list `github.com` as well if you need the bare name, and expect it to be reachable anyway on Daytona and Modal. An IPv4 range allows any traffic to those addresses. Everything else is blocked. Entries are lowercased, ranges are written in network form, and duplicates are dropped, so equal lists are the same setting.

Leave out schemes, ports and paths. `0.0.0.0/0` and an empty list reject with `INVALID_ARGUMENT`: use `internet` or `blocked` instead. A connection with an allowlist reports `client.capabilities().network` as `["allow"]` and creates every sandbox and restore with it; a per-call `create({ network: "internet" })` rejects, so open a second connection for other policies. After each create, the adapter checks that the provider recorded exactly this list where the provider reports it back (Freestyle does not, so its list is sent but not read back), and reports `OUTCOME_UNKNOWN` instead of a ready sandbox if not.

| Provider  | Hosts | IPv4 ranges | Notes                                                                                                                                                                                                                                                                             |
| --------- | ----- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Daytona   | ≤ 100 | ≤ 10        | Hosts or ranges, not both in one list. HTTPS only, through Daytona's TLS proxy: clients with their own CA bundle or pinned certificates must trust `/etc/daytona/netleash/ca.crt`. `*.` also matches the bare name. Needs Tier 3 and above; lower tiers reject before allocation. |
| E2B       | Yes   | Yes         | Host rules match HTTP on port 80 (by `Host`) and TLS on port 443 (by SNI); other ports and UDP (QUIC/HTTP3) need an IPv4 range. Sent as E2B's `allowOut` over a deny-all `denyOut`.                                                                                               |
| Vercel    | Yes   | Yes         | Host rules match TLS SNI only; plain HTTP needs an IPv4 range. Vercel reports the policy back as `allowedDomains` and `allowedCIDRs`.                                                                                                                                             |
| Modal     | Yes   | Yes         | Host rules cover TLS only (port 443, by SNI) and `*.` also matches the bare name. Modal's domain allowlist is beta.                                                                                                                                                               |
| Runloop   | Yes   | Yes         | Host names are DNS hostnames; Runloop does not document which ports or protocols they cover. Attaches an account network policy named `beachside-allow-<digest>`, shared by equal lists.                                                                                          |
| Freestyle | No    | Yes         | Firewall rules match addresses only, so host names reject with `UNSUPPORTED`. The firewall is not read back.                                                                                                                                                                      |
| Archil    | Yes   | Yes         | A deny-by-default policy; needs a paid plan.                                                                                                                                                                                                                                      |
| boxd      | No    | No          | Rejects allowlists.                                                                                                                                                                                                                                                               |
| Boat      | No    | No          | Rejects allowlists.                                                                                                                                                                                                                                                               |

Over-limit or unsupported lists reject at connect with `UNSUPPORTED`, naming the limit. Provider DNS is usually left open, and host rules do not stop a client that sends an allowed name to a shared server for another site (domain fronting), so treat an allowlist as egress control, not a full sandbox for hostile code. No allowlist has a recorded live pass yet.

## Set environment variables

Pass `env` at creation to set variables for every command, process and terminal in the sandbox. A per-call `env` on `exec()` or `processes.start()` overrides the same name for that call only:

```ts
const box = await client.sandboxes.create({
  env: { API_TOKEN: process.env.API_TOKEN!, NODE_ENV: "production" },
});

await box.exec(["node", "app.js"]); // sees API_TOKEN and NODE_ENV=production
await box.exec({ command: { kind: "argv", argv: ["node", "app.js"] }, env: { NODE_ENV: "test" } });
```

The variables belong to the sandbox: they still apply after `sandboxes.get(reference)` reopens it in another process, without passing them again. Names match `[A-Za-z_][A-Za-z0-9_]*`; values are strings without NUL. A request holds at most 128 variables and 64 KiB of names and values. Invalid input rejects with `INVALID_ARGUMENT` before any provider call, and the message never repeats a name or value. An empty `env` asks for nothing.

Values are often secrets, so Beachside never writes them into operation references, recovery tokens, telemetry or its own error messages, and adapters redact an echoed value from provider error text. The provider still stores them with the sandbox, and any process inside it can read them.

| Provider       | Create-time `env`                                                               |
| -------------- | ------------------------------------------------------------------------------- |
| Daytona        | Native sandbox `env` on creation.                                               |
| E2B            | Native sandbox `envs` on creation.                                              |
| Vercel Sandbox | Native session `env` on creation; persistent sandboxes keep it on resume.       |
| Modal          | Native sandbox environment, sent with the single create request (experimental). |
| boxd           | Unsupported: boxd's native machine env is not established for exec sessions.    |

`client.capabilities().createEnv` reports whether the connection supports it. On a connection that does not, `checkCreate({ env })` returns `unsupported` and `create({ env })` rejects with `UnsupportedFeatureError` before allocating anything; pass the variables per call with `exec({ env })` instead. `snapshot.restore()` does not take `env`; whether a restored sandbox keeps the source's variables depends on the provider's snapshot, so pass them per call if a restored sandbox needs them. Live provider acceptance of create-time variables has not been run.
