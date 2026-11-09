---
title: Secrets
description: Give a sandbox an API key, token or private key, and keep the value out of logs, state and, where you ask, out of the sandbox itself.
---

Wrap a credential in `secret()`. There are two kinds, and the call tells them apart:

```ts
import { secret } from "beachside";

const box = await beachside.sandboxes.create({
  network: "internet",
  env: {
    NODE_ENV: "test",
    // Plain: the sandbox gets the real value.
    TS_AUTHKEY: secret(process.env.TS_AUTHKEY!),
    // Brokered: the sandbox gets a placeholder; the provider adds the key on the way out.
    ANTHROPIC_API_KEY: secret(process.env.ANTHROPIC_API_KEY!, { for: "anthropic" }),
  },
});
```

## Plain secrets

`secret(value)` puts the real value in the sandbox environment, so any tool can use it: a Tailscale auth key, an SSH or signing key, a decryption key, a database password. Beachside never prints it, never writes it to recovery references or CLI state, and redacts it from error messages.

Where the provider has a secret store, the value goes there instead of into the sandbox definition, so it does not show up when someone reads the sandbox back from the provider. `(await beachside.capabilities()).secrets.stored` says which you get. Either way, code running in the sandbox can read the value.

## Brokered secrets

`secret(value, { for })` or `secret(value, { hosts })` keeps the value out of the sandbox. The variable holds a placeholder, and the provider's egress proxy puts the real value on HTTPS requests to the hosts you named. Code in the sandbox, an agent included, can call the API but cannot read or leak the key.

On a provider that cannot broker the secret, `create()` fails with `UnsupportedFeatureError` before anything is created. Beachside never quietly falls back to a plain secret. The compiler refuses `secret(value, {})`: a brokered secret needs `for` or `hosts`.

### Presets and hosts

`for` names a service. The preset knows its hosts and how the value is sent:

| Preset       | Hosts                          | Header                                                                |
| ------------ | ------------------------------ | --------------------------------------------------------------------- |
| `anthropic`  | `api.anthropic.com`            | `x-api-key: <value>`                                                  |
| `openai`     | `api.openai.com`               | `Authorization: Bearer <value>`                                       |
| `github-api` | `api.github.com`               | `Authorization: Bearer <value>`                                       |
| `github`     | `api.github.com`, `github.com` | Bearer for the API; Basic `x-access-token:<value>` for git over HTTPS |
| `npm`        | `registry.npmjs.org`           | `Authorization: Bearer <value>`                                       |

For anything else, list `hosts` (exact names or `*.example.com`). They default to `Authorization: Bearer <value>`; set `header` and `format` (`raw`, `bearer` or `basic` with `username`) to change that. `for` and `hosts` can be combined.

Only HTTPS traffic carries the value, and clients that pin certificates fail against brokered hosts.

## Provider support

| Provider  | Plain secrets                                               | Brokered secrets                                                                                                                         |
| --------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| E2B       | Sandbox env, part of the sandbox definition                 | Yes. Network rules set the header per host. Memory snapshot restores refuse secrets.                                                     |
| Vercel    | Sandbox env, part of the sandbox definition                 | Yes, with `network: "internet"`. The network policy sets the header per host; needs a plan with network policies.                        |
| Freestyle | A mode 0600 `/etc/beachside.env` every command loads        | Yes, with `network: "internet"`. Egress TLS rules set the header; Beachside points the common CA variables at the VM's system CA bundle. |
| Daytona   | Sandbox env, part of the sandbox definition                 | Yes. One Daytona secret per sandbox secret, limited to its hosts, deleted with the sandbox; the variable holds `dtn_secret_…`.           |
| boxd      | Stored: a private unattached boxd secret                    | Yes. A host-bound private unattached secret; the variable holds `bxds_…`.                                                                |
| Runloop   | Stored: a Runloop account secret, deleted with the devbox   | `anthropic` and `openai` only, with `network: "internet"`, through Runloop's Agent Gateway.                                              |
| Modal     | Stored: Modal sends create env as an ephemeral Modal Secret | No. The adapter blocks all network access.                                                                                               |
| Boat      | No create env                                               | No.                                                                                                                                      |

Some details worth knowing:

- **Placeholders (Daytona, boxd).** The provider swaps its placeholder wherever the tool puts it, so the tool must send the variable itself, as most do with `*_API_KEY` or `GH_TOKEN`. boxd also swaps it in URLs, request bodies and Basic auth, and scrubs it from responses. Daytona decodes Basic auth, so `for: "github"` covers git over HTTPS there too.
- **Header rules (E2B, Vercel, Freestyle).** The proxy sets the whole header for the host, so the placeholder value never matters. On Vercel and Freestyle a rule also opens its host, so `create()` refuses brokered secrets on a blocked sandbox rather than widen access.
- **boxd names.** boxd exports each secret under its own name, so the secret is named after the variable. Two sandboxes that use `GH_TOKEN` share one boxd secret, and the last value set wins. Beachside deletes it once no machine lists it. Secrets on boxd need the cluster's default image or a snapshot restore, because they ride on a machine spec.
- **Runloop gateway.** The variable holds a token bound to the devbox, and Beachside sets `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` to Runloop's gateway, which adds the real key. Clients that read those variables, including the Anthropic and OpenAI SDKs, Claude Code and Codex, work unchanged. Setting the base URL yourself is refused, since the gateway would be bypassed.

## Tokens in files and snapshots

A setup step that writes a brokered token into a file captures the placeholder, which is fine. Prefer files that read the environment at use time, such as `.npmrc` with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, and tools like `gh` that read `GH_TOKEN` on each call.

A plain secret that a setup step writes to disk is in the sandbox's files from then on, and a snapshot or setup cache captures it. Keep plain secrets in the environment, or remove the file before you snapshot.

## GitHub

Use a fine-grained personal access token limited to the repositories the sandbox needs, with an expiry. `for: "github"` brokers it for both the API and git over HTTPS on E2B, Vercel, Freestyle, Daytona and boxd.

## From the command line

The CLI reads values on your machine and passes them as `secret()`; see [Configuration](/docs/cli/configuration/#secrets).

```sh
beachside create --secret TS_AUTHKEY=op://Dev/tailscale/authkey
beachside create --network internet --secret ANTHROPIC_API_KEY=op://Dev/anthropic/api-key@anthropic
beachside create --network internet --secret GH_TOKEN=gh:@github
```

## What Beachside records

Recovery references, CLI state and error messages never contain secret values. The CLI store keeps each secret's variable name, kind and hosts, so `beachside inspect` and `beachside secret ls` can show them.
