---
title: Set up a sandbox
description: Run setup scripts and commands when a sandbox starts, name reusable setups in beachside.json, and run startup steps after every restore.
---

A setup is a list of steps the CLI runs in a sandbox right after it starts: install tools, clone a repository, warm a cache. Steps are shell lines or script files, and they work the same on every provider.

```sh
beachside create --name web --setup-cmd 'npm i -g pnpm' --setup-cmd 'pnpm --version'
beachside create --name web --setup ./setup.sh
```

Each step's output streams to stderr as it runs, under a header such as `setup [2/3] ./setup.sh`. stdout keeps the usual result, so scripts that read the sandbox name still work. `--quiet-setup` shows only the step headers and any failure.

## Named setups

Put setups you reuse under `setups` in `beachside.json` and pick them with `--setup <name>`:

```json
{
  "setups": {
    "node": {
      "setup": ["curl -fsSL https://fnm.vercel.app/install | bash", "fnm install 22"],
      "network": "internet"
    },
    "web": {
      "extends": ["node"],
      "setup": ["./scripts/install-web.sh", { "run": "pnpm install", "cwd": "app" }],
      "startup": ["pnpm --dir app dev > /tmp/dev.log 2>&1 &"],
      "env": { "NPM_TOKEN": "op://Dev/npm/token" }
    }
  }
}
```

```sh
beachside create --name web --setup web
beachside create --name api --setup node,./scripts/api.sh --setup-cmd 'make deps'
```

A setup's steps can be:

- a shell line: `"pnpm install"`
- an argv array: `["make", "deps"]`
- a script path starting with `./`, `../` or `~/`, relative to the file that names it. It is uploaded and run with its shebang (`sh` when it has none).
- an object with exactly one of `run`, `script` (inline text) or `file`, plus any of `name`, `cwd` (created if missing), `env`, `timeout` (like `90s` or `10m`, default 10m), `user: "root"` and `cache: false`.

A setup can also say what it needs:

- `extends` lists setups whose steps run first. A setup reached twice runs once.
- `network` becomes the create's default network. An explicit `--network` that disagrees is an error, before anything is created.
- `env` joins the sandbox environment, under `--env`. Values can be `env:NAME` or password-manager references, as in [credentials](/docs/cli/configuration/#credentials).

`--setup` takes a comma-separated list and can repeat. Named setups and files run in the order given, then every `--setup-cmd`. `beachside setup ls` lists the setups the config defines.

### Defaults per profile

A profile can name setups every sandbox it creates gets first:

```json
{
  "profiles": {
    "e2b": { "provider": "e2b", "setup": ["node"] }
  }
}
```

`--no-default-setup` skips them for one create. Restores from a snapshot never apply them, since the snapshot already holds its setup.

## Startup steps

Setup runs once. **Startup** steps run each time the sandbox comes up without its processes: at create, after `create --snapshot`, and after a resume that started fresh. Use them for servers and daemons that a snapshot does not keep running.

```sh
beachside create --name web --setup web --startup-cmd 'redis-server --daemonize yes'
beachside create --name web --startup ./start.sh
```

The sandbox records its startup steps, so a restore runs them again without being told. A restore that passes its own `--startup` or `--startup-cmd` runs those instead.

## When a step fails

A failed step stops setup. The CLI exits with code **9** and says which step failed, with the end of its output:

```text
beachside: web: setup step 2/3 "pnpm install" failed (exit 1):
ERR_PNPM_FETCH_404  GET https://registry.npmjs.org/@acme%2Fmissing: Not Found
hint: look around with `beachside sh web '...'`, rerun the missing steps with `beachside setup web`, or remove it with `beachside rm web`
```

`create` keeps the sandbox so you can look around, and records its setup as `failed`. With `--json`, `error.known.sandbox` names it. Pass `--rm-on-failure` to remove it instead. `run` always removes its sandbox unless `--keep`, and exits 125 like any other CLI-side failure.

Every step has a 10 minute limit, and setup plus startup have 30 minutes together. Change them with a step's `timeout` and with `--setup-timeout 45m`.

## Run setup again

`beachside setup <sandbox>` runs what the sandbox recorded. Steps that already finished are skipped, so after a failure it continues from the failed step:

```sh
beachside setup web             # finish what failed
beachside setup web --force     # run every step again
beachside setup web --setup playwright --setup-cmd 'npx playwright install'
```

Flags add to what the sandbox already has. A setup whose env the sandbox was created without gets it for its steps.

The sandbox keeps its setup state in `~/.beachside/setup/` inside the sandbox, so it travels with snapshots. The CLI's store keeps the setup names, the digest and each step's outcome, never script contents; `beachside inspect` shows them.

## In `run` and CI

`run` takes the same flags. Setup runs after `--push`, in the pushed folder, so a lockfile is there:

```sh
beachside run --push . --setup-cmd 'npm ci' -- npm test
```

## What each step sees

Steps run through the provider's exec, as the sandbox's default user, from its home folder unless `cwd` says otherwise. `user: "root"` runs a step with `sudo -n -E` where the default user is not root. Each step gets the sandbox's environment plus its own `env`; secrets belong in the sandbox env (`--env` or a setup's `env`), not in a step's text.

Beachside records a digest of each step's command, working folder, user and env names, never env values. Two creates with the same steps get the same digest, so a rotated token does not count as a different setup.
