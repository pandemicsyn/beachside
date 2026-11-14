---
title: Command line
description: Create, use and clean up sandboxes on any Beachside provider from your shell or your agent.
---

`beachside` creates and manages sandboxes from the command line, on any provider with a Beachside adapter. It is built for coding agents first: it never prompts for input, every command has a stable `--json` form, and exit codes clearly indicate what to do next. People get readable output by default.

## Install

Install the CLI, then the adapter for each provider you use. Adapters live in their own folder so a project you happen to be in can't supply one:

```sh
npm install -g @beachside/cli
beachside adapter add e2b
```

The CLI runs on Node.js or Bun; `beachside adapter` uses npm to install. `beachside adapter add` takes one or more provider ids (`boxd`, `freestyle`, `daytona`, `e2b`, `vercel`, `modal`, `runloop`, `archil`, `exe-dev`, `boat`) and installs each official adapter at the same version as the CLI, so the two always match. It then imports the package to check that the adapter is there. Running it again with nothing to change skips npm, so it is safe in CI setup steps. `beachside adapter ls` shows what is installed and flags an official adapter whose version differs from the CLI's; `beachside adapter rm e2b` removes one.

`beachside providers` lists the official adapters, whether each is installed and which credentials are missing.

## Quick start

Pick a provider with environment variables, check the setup, then work:

```sh
export BEACHSIDE_PROVIDER=e2b E2B_API_KEY=...
beachside doctor                                  # checks config and credentials; creates nothing

beachside create --name web
beachside cp ./app.py web:/home/user/app.py
beachside exec web --cwd /home/user -- python3 app.py
beachside sh web 'ls -la /home/user | head'
beachside rm web
```

To test a checkout in a throwaway sandbox, send it with `run --push`, and copy results out with `cp -r`:

```sh
beachside run --push . --timeout 15m -- sh -c 'npm ci && npm test'

beachside create --name ci --ttl 30m
beachside push ci                                  # prints /home/user/work
beachside exec ci --cwd /home/user/work -- npm test
beachside cp -r ci:/home/user/work/coverage ./coverage
beachside rm ci
```

For one command in a throwaway sandbox, `run` creates it, runs the command and always destroys it, even when the command fails or you press Ctrl-C (it then exits 130):

```sh
beachside run -- python3 -c 'print(2 + 2)'
```

To keep provider settings in one place instead of environment variables, see [Configuration](/docs/cli/configuration/). To run CI jobs in sandboxes, see [Run CI jobs](/docs/cli/ci/).

## Naming sandboxes

`create` prints the sandbox's name: the `--name` you gave, or a generated one such as `sb-1a2b3`. Every other command takes that name. The CLI also accepts a provider's own sandbox ID if the sandbox is in its list, or `@file.json` for a file holding a saved sandbox reference (the `reference` field of `beachside inspect --json`).

`beachside ls` shows every sandbox the CLI knows about with its live state (`running`, `gone`, `unreachable` and so on). `beachside ls --offline` skips the provider calls.

`beachside ls --remote` asks the selected profile's provider instead, so it also shows sandboxes created elsewhere. It prints whether the provider listed every sandbox in the account scope or only ones created through Beachside. The `NAME` column shows the store name for sandboxes the CLI already knows. To work with a listed sandbox by name, record it with `beachside adopt <id> --name <name>`; adopt reopens it first and fails if the provider cannot give a verifiable reference. The CLI did not create adopted sandboxes, so `rm --all` skips them and `rm <name>` needs `--force`. The listing also shows each sandbox's creation time and labels where the provider reports them.

## Cleaning up after killed jobs

A job that is killed or cancelled can leave its sandbox running, and its store may be gone with the runner. Label every sandbox a job creates, then collect by label from the provider's own listing:

```sh
beachside create --name ci --label run=$GITHUB_RUN_ID --ttl 1h
# later, from any machine with the same profile
beachside gc --label run=$GITHUB_RUN_ID
beachside gc --label ci=true --older-than 2h --dry-run
```

`gc` destroys every listed sandbox whose labels match all the `--label` pairs, and drops any store record for it. `--older-than` keeps sandboxes the provider says are younger than that, and skips ones without a reported creation time. `--dry-run` shows what would go. At least one `--label` is required, so `gc` never sweeps an account by age alone. Sandboxes the provider lists without a reopenable reference (Modal) and sandboxes adopted into the store are skipped and reported. Boat keeps no labels, so `gc` finds nothing there. On every provider, `--ttl` stays the backstop: the provider removes a sandbox when its lifetime ends even if nothing runs `gc`.

## Commands and arguments

- `exec` passes the command after `--` as separate arguments, with no shell. Use `sh` when you need pipes, redirects or `&&`.
- `exec`, `sh` and `run` exit with the remote command's own exit code, so `beachside exec web -- test -f /x && echo yes` works as expected. Failures of the CLI itself exit 125.
- `exec`, `sh` and `run` print output as it arrives on every provider, so long builds and test runs show progress. Boat and Runloop stream it as UTF-8 text; the others pass the exact bytes through. With `--json` or `--no-stream`, the output is printed when the command ends; `--max-output` limits only that captured output. `--timeout` (default 5 minutes) applies either way: a streaming command that runs past it, or that you stop with Ctrl-C, is asked to terminate before the CLI exits.
- `create --env K=V` (repeatable) and `--env-file <path>` set environment variables for every command in the sandbox; `exec --env` overrides a name for one command. `--env NAME` without a value copies `NAME` from your shell, which keeps secrets out of history. `.env` files hold `NAME=VALUE` lines; `#` comments (also after a value, following a space), blank lines and `export` are allowed. Unquoted values are trimmed; `"..."` values understand `\n`, `\"` and `\\`, and `'...'` values are literal. Multi-line values are not supported. Values are never written to the store, `--json` output or messages. Providers without sandbox-wide variables (boxd) reject `--env` on `create` before creating anything. On `exec`, `sh` and `run`, the same flags apply to that one command.
- `cp` copies a file in either direction; the sandbox side is written `<name>:/absolute/path`. `cat <name>:/path` prints a file. Files of any size work: they stream where the provider streams files, and otherwise travel in 1 MiB parts. With `-r` it copies a directory too, like `cp -r`: an existing destination folder receives a child of the same name. `--exclude <glob>` (repeatable) skips matching paths; a pattern without `/`, such as `node_modules` or `*.log`, matches a name at any depth.
- `push <name>[:/dir] [path]` sends a local folder (default `.`) into the sandbox, by default to `work` under the sandbox user's home, and prints where it landed. In a git work tree it sends what git would: tracked files plus untracked files that are not ignored, so `.git`, `node_modules` and build output stay behind. `--include-ignored` sends every file. `run --push <path>` does the same in its new sandbox and runs the command in that folder unless you pass `--cwd`.
- Directory copies keep file modes and symlinks. They move one tar archive and unpack it with one command, so the sandbox needs `tar` (without it they fail with exit 4 and `UNSUPPORTED` before anything is sent). Copying out never writes through a symlink, never leaves the destination folder, and drops setuid bits. Files deleted locally are not deleted from an earlier copy in the sandbox.
- `--image <oci-ref>` boots an OCI image on boxd and Modal. E2B and Daytona need it built once with `beachside image build <oci-ref>`; until then `--image` fails before creating anything, and `--build` builds it during the command instead. `--prepared <id>` picks a provider template or snapshot. `beachside image ls`, `inspect`, `rm` and `forget` manage the recorded builds: `rm` deletes the template or snapshot on the provider and drops the record (only builds this CLI created, unless you pass `--force`), while `forget` only drops the record and lists what the provider still holds. `beachside image ls --remote` lists the provider's own images. If `image rm` exits 6, the outcome is unknown; running it again asks the provider how the delete ended without resending it.

## Snapshots

A snapshot saves a sandbox's state so new sandboxes can start from it, for example a checkout with its dependencies already installed:

```sh
beachside create --name base --network internet
beachside sh base 'git clone https://github.com/acme/app /work/app && cd /work/app && npm ci'
beachside snapshot create base --name deps
beachside rm base

beachside run --snapshot deps --cwd /work/app -- npm test
```

`snapshot create <sandbox>` captures a sandbox from the store and records the snapshot under `--name` (default `<sandbox>-snap`). What it keeps, files only or memory too, and whether the source pauses during capture depend on the provider and the profile's `snapshots.preserve`; the command prints both. A provider that cannot capture fails with exit 4 before anything happens.

`create --snapshot <name>` and `run --snapshot <name>` start a sandbox from a recorded snapshot, on the profile that captured it. The snapshot fixes the image, so `--image`, `--prepared` and `--build` do not apply. `--env`, `--label` and `--ttl` work as on any create, for example to pass a CI job its secrets. A provider that can't apply one of them on restore fails with exit 4 before anything is created: Boat and boxd take only `--ttl`, Runloop takes `--env`, `--label` and `--ttl` (`--ttl` only when the profile sets no `idleSeconds`), and Daytona and E2B take `--env` only for filesystem snapshots, because a memory snapshot resumes its processes with the environment they had.

To refresh a snapshot, capture it again with `snapshot create <sandbox> --name <name> --replace`. The record keeps the old snapshot until the new one exists, then the old one is deleted. A snapshot still in use by a running sandbox can't be deleted; the command says so and leaves it on the provider.

`snapshot ls` lists the recorded snapshots and `snapshot ls --remote` the provider's own. `snapshot inspect <name>` shows a snapshot's state. `snapshot rm <name>` deletes it on the provider and drops the record (only snapshots this CLI captured, unless you pass `--force`), while `snapshot forget <name>` only drops the record. Snapshots are kept until you delete them, and some providers charge for storage. If `snapshot create` or `snapshot rm` exits 6, the outcome is unknown: `snapshot inspect` or running `snapshot rm` again checks how it ended without sending it twice.

## JSON output for agents and scripts

Add `--json`, or set `BEACHSIDE_JSON=1`, and stdout holds exactly one JSON document:

```json
{ "ok": true, "data": { "name": "web", "provider": "e2b", "status": "created" } }
```

```json
{
  "ok": false,
  "error": {
    "code": "OUTCOME_UNKNOWN",
    "message": "...",
    "retryable": false,
    "outcome": "unknown",
    "hint": "...",
    "known": { "sandbox": "web" }
  }
}
```

`outcome` says whether anything happened: `rejected` means nothing did, `unknown` means it might have, and `partial` means some steps did. **Never repeat a create after `unknown` (exit 6).** Run `beachside ls` first: the CLI keeps the name so you can inspect or remove whatever was created.

The [command reference](/docs/cli/reference/) lists every exit code, and `beachside schema` prints all commands, flags and exit codes as JSON.

## Servers in a sandbox

`--with` installs a server in a new sandbox and puts it on your [Tailscale](https://tailscale.com) tailnet, so you can open it from your own machine without a public port:

```sh
export TAILSCALE_AUTH_KEY=...   # reusable, ephemeral, tagged tag:beachside
beachside create --name web --with rex
beachside create --name dev --with herdr
```

| Server  | What you get                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `rex`   | A [Rex](https://www.superlogical.com/rex/docs) server on Rex's own Tailscale. Add its `https://` address in Rex.   |
| `herdr` | A Tailscale SSH device for [herdr](https://herdr.dev). Run the printed `herdr --remote ssh://…` command to attach. |

`create` prints how to connect when it finishes, and `inspect` shows it again. `--with` implies `--network internet`, because the sandbox downloads the server and reaches Tailscale. The tailnet setup is the same for both: see [Set up Tailscale once](/docs/cli/rex/#set-up-tailscale-once). Devices are named `beachside-<sandbox>`, and `rm` logs each device out of your tailnet before the sandbox goes, so it doesn't linger offline. If setup fails after the sandbox exists, `create` exits 8 and keeps the sandbox, so you can look inside or remove it.

herdr connects over Tailscale SSH, so it also needs an `ssh` rule in your tailnet policy:

```json
"ssh": [
  {
    "action": "accept",
    "src": ["autogroup:member"],
    "dst": ["tag:beachside"],
    "users": ["autogroup:nonroot", "root"]
  }
]
```

On the first connect, herdr asks you to accept the device's SSH host key and to install its server in the sandbox.

## Status on terminal tabs

Inside [Rex](https://www.superlogical.com/rex/docs/build/program-status), commands that create, change or wait on sandboxes (`create`, `run`, `exec`, `sh`, `rm`, `gc`, `cp`, `push`, `image build`, `snapshot create`, and others) show their progress on the terminal tab: a spinner while they work, then done or failed. `run` also says which step it is on: pushing files, running the command, or destroying the sandbox. `cp` and `push` into a sandbox show a progress bar while the files upload. When `run`, `exec` or `sh` finishes after more than 30 seconds, you also get a desktop notification.

The CLI reports this with the Program Status Protocol (OSC 7501), written to stderr only when stderr is a terminal, so `--json` and piped output are unchanged. Set `BEACHSIDE_PROGRAM_STATUS=on` to report in other terminals that support the protocol, or `off` to turn it off in Rex. Notifications use OSC 777. Set `BEACHSIDE_NOTIFY_AFTER` to a number of seconds to change when they appear, or to `off` to stop them.

To run a Rex server inside a sandbox and open it from your Mac, see [Remote workspace with Rex](/docs/cli/rex/).

## Cleaning up

`rm` destroys a sandbox and forgets it. It only destroys sandboxes this CLI created; add `--force` for others. `rm --all` removes everything the CLI created and reports what it skipped. If some removals fail, `rm` keeps going and exits 8 with a list of what was removed, skipped and failed.

Sandboxes cost money while they run. `run` and `rm` are the tools for keeping that bounded; `beachside ls` shows anything left behind.

As a backstop for a job that is killed before it can clean up, `create --ttl <duration>` and `run --ttl <duration>` (like `30m` or `2h`) set how long the provider keeps that sandbox before removing it. Without `--ttl`, the profile's `lifecycle.lifetimeSeconds` applies, 15 minutes by default. Keep it longer than `--timeout` for long commands. A provider that cannot apply the value rejects it before creating anything.

## Privacy

**The Beachside SDK does not track your usage.** Only the CLI sends basic usage telemetry, enabled by default outside CI. You can turn it off with `beachside telemetry disable` or `BEACHSIDE_TELEMETRY=0`. See [Privacy](/docs/privacy/) for what is collected and the available controls.
