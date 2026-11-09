---
title: CLI configuration
description: Profiles, credentials, password managers, limits and where the beachside CLI keeps its state.
---

The CLI works with environment variables alone. For anything more, it reads `~/.config/beachside/beachside.json` (or `$XDG_CONFIG_HOME/beachside/beachside.json`). Point it elsewhere with `--config` or `BEACHSIDE_CONFIG`.

## Environment-only setup

Set `BEACHSIDE_PROVIDER` (or pass `--provider`) and the provider's own variables:

| Provider    | Variables                                                                     |
| ----------- | ----------------------------------------------------------------------------- |
| `daytona`   | `DAYTONA_API_KEY`, `DAYTONA_TARGET`                                           |
| `e2b`       | `E2B_API_KEY`                                                                 |
| `boxd`      | `BOXD_API_KEY`, `BOXD_ORG`, `BOXD_NETWORK=internet`                           |
| `boat`      | `BOAT_API_KEY`, `BOAT_NETWORK=internet`                                       |
| `runloop`   | `RUNLOOP_API_KEY`; optional `RUNLOOP_NETWORK=internet` (experimental)         |
| `freestyle` | `FREESTYLE_API_KEY`; optional `FREESTYLE_NETWORK=internet` (experimental)     |
| `vercel`    | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`                         |
| `modal`     | `MODAL_TOKEN_ID`, `MODAL_TOKEN_SECRET`, `MODAL_APP_NAME`, `MODAL_ENVIRONMENT` |

`beachside providers` shows which of these are missing. boxd and Boat always allow internet egress, so their adapters ask you to choose that explicitly with `BOXD_NETWORK=internet` or `BOAT_NETWORK=internet` (or `"network": "internet"` in a profile's config).

## Profiles

A profile is one adapter's setup under a name. Its `config` and `credentials` are that adapter's own settings, as described on each [provider page](/docs/providers/support/):

```json
{
  "default": "e2b",
  "profiles": {
    "e2b": {
      "provider": "e2b",
      "credentials": { "apiKey": "env:E2B_API_KEY" }
    },
    "daytona-us": {
      "provider": "daytona",
      "credentials": { "apiKey": "op://Dev/Daytona/credential" },
      "config": { "target": "us", "network": "daytona-default" }
    },
    "local": {
      "module": "./my-adapter.js",
      "export": "myAdapter",
      "config": {},
      "credentials": {}
    }
  },
  "limits": { "maxSandboxes": 10 }
}
```

The CLI picks a profile from `--profile`, then `BEACHSIDE_PROFILE`, then `--provider`, then `BEACHSIDE_PROVIDER`, then `default`. Environment variables fill in an official provider's settings, and values in the profile override them.

`provider` names an official adapter (`@beachside/<provider>`). `module` and `export` load any other adapter, either an adapter definition or an already configured adapter; a relative path is relative to `beachside.json`.

Each sandbox remembers the profile that created it, so later commands on it use the same profile whatever is selected now.

## Credentials

A credential can be written three ways:

- **Directly** in `beachside.json`. Keep the file private (`chmod 600`).
- **`env:NAME`**, read from an environment variable when the profile is used.
- **A password-manager reference**, read through that manager's own CLI only when the profile connects. The value is never written anywhere.

| Reference               | Read with                                    | Sign-in                                                            |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| `op://vault/item/field` | `op read` (1Password CLI)                    | Desktop app integration, `op signin` or `OP_SERVICE_ACCOUNT_TOKEN` |
| `bws://<secret-id>`     | `bws secret get` (Bitwarden Secrets Manager) | `BWS_ACCESS_TOKEN`                                                 |
| `pass://path/to/entry`  | `pass show`, first line of the entry         | Your GPG agent                                                     |

References also work in a provider's environment variable, for example `E2B_API_KEY=op://Dev/E2B/credential`. If the manager's CLI is not installed the command exits 4; if it can't read the secret it exits 5 and shows the manager's own message.

## Limits

`limits.maxSandboxes` (or `BEACHSIDE_MAX_SANDBOXES`) caps how many sandboxes the CLI will keep at once. A `create` or `run` over the cap exits 4 before contacting the provider. There is no cap unless you set one. The check is a safety net, not a guarantee: two creates started at the same moment can both pass it.

## Image builds

E2B and Daytona build an OCI image into a provider template or snapshot before a sandbox can start from it. By default `create --image` and `run --image` use only builds recorded with `beachside image build`, and fail before creating anything otherwise. A profile whose `config.environment` names an OCI image follows the same rule when you pass neither flag. `"images": { "autoBuild": true }` builds a missing image on demand instead, once per reference and profile. Leave it off for agents that run `--image` in a loop unattended: each new reference starts a slow build that may cost money and leaves a provider-side resource.

## Where adapters are loaded from

Adapters receive your credentials, so the CLI loads them only from `~/.config/beachside/adapters` or from its own installation. `beachside adapter add` installs into that folder, which is its own small npm project with a `package.json`.

Third-party adapters install the same way, by package name: `beachside adapter add @acme/beachside-adapter@1.2.0`, or `npm:acme-beachside` for a package without a scope. A bare name that is not an official provider is refused, so a typo never installs an unrelated package that would then receive your credentials. Point a profile at the package with `"module": "@acme/beachside-adapter"` and the export that holds the adapter (`adapter add` prints the names it found). To use adapters installed in the current project's `node_modules`, opt in with `"adapters": { "searchProject": true }` in `beachside.json` or `BEACHSIDE_PROJECT_ADAPTERS=1`.

## State

The CLI remembers each sandbox as a small JSON file in `~/.config/beachside/state/sandboxes/<name>.json`. The file holds the provider's reference to the sandbox, never credentials.

Use a different folder with `--state-dir` or `BEACHSIDE_STATE_DIR` (relative to the current directory), or `"state": { "kind": "fs", "dir": "..." }` in `beachside.json` (relative to that file). A separate folder per project or per CI job keeps their sandboxes apart.

The name is recorded before the provider is called. If a create fails in a way that may still have made a sandbox, the record stays with status `unknown`, so `beachside ls` shows it. The record also keeps the SDK's recovery reference for that create, so `beachside rm <name>` and `beachside inspect <name>` first ask the provider how the original request ended, without sending it again. If the sandbox exists, `rm` destroys it. If the provider still cannot say, check it yourself; `beachside rm --force <name>` then drops the record.

Concurrent `beachside` processes on one machine can share a state folder safely.

The [Beachside Pi extension](/docs/agents/pi/) reads these same profiles. A profile-level `network` sets the sandbox policy for creation and snapshot restore. The CLI accepts `--network` to override it for one command.
