---
title: Secrets
description: Give a sandbox an API key or token without putting the real value inside it.
---

Wrap a credential in `secret()` and Beachside keeps the real value out of the sandbox. The sandbox environment variable holds a placeholder, and the provider's egress proxy adds the real value to HTTPS requests for the hosts you name. Code in the sandbox, an agent included, can call the API but cannot read or leak the key.

```ts
import { secret } from "beachside";

const box = await beachside.sandboxes.create({
  network: "internet",
  env: {
    NODE_ENV: "test",
    ANTHROPIC_API_KEY: secret(process.env.ANTHROPIC_API_KEY!, { for: "anthropic" }),
    NPM_TOKEN: secret(process.env.NPM_TOKEN!, { hosts: ["registry.npmjs.org"] }),
  },
});
```

The same code works on every provider that can broker secrets. On one that cannot, `create()` fails with `UnsupportedFeatureError` before anything is created. Beachside never quietly falls back to putting the value in the environment.

## Presets and hosts

`for` names a service. The preset knows its hosts and how the value is sent:

| Preset       | Hosts                          | Header                                                                |
| ------------ | ------------------------------ | --------------------------------------------------------------------- |
| `anthropic`  | `api.anthropic.com`            | `x-api-key: <value>`                                                  |
| `openai`     | `api.openai.com`               | `Authorization: Bearer <value>`                                       |
| `github-api` | `api.github.com`               | `Authorization: Bearer <value>`                                       |
| `github`     | `api.github.com`, `github.com` | Bearer for the API; Basic `x-access-token:<value>` for git over HTTPS |
| `npm`        | `registry.npmjs.org`           | `Authorization: Bearer <value>`                                       |

For anything else, list `hosts` (exact names or `*.example.com`). They default to `Authorization: Bearer <value>`; set `header` and `format` (`raw`, `bearer` or `basic` with `username`) to change that. `for` and `hosts` can be combined.

Only HTTPS request headers carry the value. Request bodies, query strings and plain HTTP do not, and clients that pin certificates fail against brokered hosts.

## Exposed secrets

Some tools need the real value, for example to sign something locally. `secret.exposed(value)` puts it in the sandbox environment, like plain `env`, and works on every provider with create-time environment. Beachside still never prints or saves it. Choose this deliberately: anything running in the sandbox can read it.

## Provider support

`(await beachside.capabilities()).secrets` reports what a connection can broker, or `null`.

| Provider  | Brokered secrets | How                                                                                                                                                                       |
| --------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E2B       | Yes              | Network rules set the header for each host. Filesystem snapshot restores rebind them; memory snapshot restores refuse secrets.                                            |
| Vercel    | Yes, `internet`  | The network policy sets the header for each host. Needs a plan with network policies, and `network: "internet"`.                                                          |
| Freestyle | Yes, `internet`  | Egress TLS rules set the header. Beachside points `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE` and `SSL_CERT_FILE` at the system CA bundle, which trusts Freestyle's edge. |
| Daytona   | Yes              | One Daytona secret per sandbox secret, limited to its hosts, deleted when the sandbox is removed. The variable holds Daytona's `dtn_secret_` placeholder.                 |
| boxd      | No               | boxd secrets apply to every machine in their scope, not one sandbox. Set host-bound secrets in boxd directly to reach all your machines, or use `secret.exposed()`.       |
| Modal     | No               | The adapter blocks all network access.                                                                                                                                    |
| Runloop   | No               | Runloop's gateway changes the client's base URL rather than adding a header.                                                                                              |
| Boat      | No               | Nothing documented.                                                                                                                                                       |

On Vercel and Freestyle a header rule also allows its host, so brokered secrets need `network: "internet"`; on a blocked sandbox `create()` refuses them rather than widen access.

Daytona swaps its placeholder wherever the tool puts it in a header, so the tool must send the variable itself (most read `*_API_KEY` or `GH_TOKEN`). Header-rule providers set the whole header for the host, so the placeholder value never matters.

## Tokens in config files

A setup step that writes a token into a file captures whatever the variable holds, which is a placeholder. Prefer files that read the environment at use time, such as `.npmrc` with `//registry.npmjs.org/:_authToken=${NPM_TOKEN}`, and tools like `gh` that read `GH_TOKEN` on each call.

## GitHub

Use a fine-grained personal access token limited to the repositories the sandbox needs, with an expiry. `for: "github"` brokers it for both the API and git over HTTPS on E2B, Vercel and Freestyle. On Daytona, git over HTTPS works as well, because Daytona decodes Basic auth to swap its placeholder.

## From the command line

The CLI reads values on your machine and passes them as `secret()`; see [Configuration](/docs/cli/configuration/#secrets).

```sh
beachside create --network internet --secret ANTHROPIC_API_KEY=op://Dev/anthropic/api-key@anthropic
beachside create --network internet --secret GH_TOKEN=gh:@github
```

## What Beachside records

Recovery references, CLI state and error messages never contain secret values. The CLI store keeps each secret's variable name, mode and hosts, so `beachside inspect` and `beachside secret ls` can show them.
