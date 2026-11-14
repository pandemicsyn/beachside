---
title: Command reference
description: Every beachside command, flag and exit code, generated from the CLI.
---

> Generated from `beachside schema`. Run `bun run --cwd apps/docs cli:generate` after changing a command.

## Global flags

These work with every command.

| Flag                | Description                                                                      |
| ------------------- | -------------------------------------------------------------------------------- |
| `--json`            | Print one JSON document on stdout (also BEACHSIDE_JSON=1)                        |
| `--profile <name>`  | Profile from beachside.json (also BEACHSIDE_PROFILE)                             |
| `--provider <id>`   | Official provider from environment credentials (also BEACHSIDE_PROVIDER)         |
| `--config <path>`   | Config file (default ~/.config/beachside/beachside.json, also BEACHSIDE_CONFIG)  |
| `--state-dir <dir>` | State store folder (default ~/.config/beachside/state, also BEACHSIDE_STATE_DIR) |
| `-V, --version`     | Print the CLI version                                                            |

## Output

With `--json`, stdout holds exactly one document: `{ok:true,data}` or `{ok:false,error:{code,message,retryable,outcome,hint?,known?,details?}}`. Diagnostics always go to stderr.

`exec`, `sh` and `run` exit with the remote command's exit code; their JSON data is `{exitCode,stdout,stderr,truncated}`, and run adds sandbox `{name,id,kept}`. Without --json, output streams as it arrives where the provider supports it.

## Exit codes

| Code | Meaning                                                                                                                                 |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success                                                                                                                                 |
| 1    | other failure                                                                                                                           |
| 2    | usage error; fix the command                                                                                                            |
| 3    | not found                                                                                                                               |
| 4    | unsupported by this provider or profile, adapter missing or broken, npm or a password-manager CLI not installed, or store limit reached |
| 5    | authentication or permission failure, or an unreadable password-manager secret                                                          |
| 6    | outcome unknown: an effect may have happened, inspect before retrying                                                                   |
| 7    | retryable: rate limit, capacity or unavailable before any effect                                                                        |
| 8    | partial: some steps were confirmed; read error.known                                                                                    |
| 9    | setup failed: a setup or startup step exited nonzero or timed out; error.known.sandbox names the sandbox if it was kept                 |
| 125  | exec/run: the CLI or provider failed; details in the error                                                                              |
| 130  | interrupted by SIGINT (129 for SIGHUP, 143 for SIGTERM); an interrupted run still destroys its sandbox                                  |

## telemetry

Show or change basic CLI usage telemetry (on by default; SDK sends none).

```sh
beachside telemetry [status | enable | disable]
```

Examples:

```sh
beachside telemetry status
beachside telemetry disable
```

## create

Create a sandbox and print its name.

```sh
beachside create [--name <name>] [--image <oci-ref> | --prepared <id> | --snapshot <name>] [--network <policy>] [--ttl <duration>] [--env K=V]... [--setup <name|path>]... [--setup-cmd <shell>]... [--with rex|herdr]...
```

| Flag                         | Description                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`              | Store name (default: generated, like sb-1a2b3)                                                                                          |
| `--image <oci-ref>`          | OCI image, e.g. python:3.12; default is the profile's image                                                                             |
| `--prepared <id>`            | Provider-prepared image id (template, snapshot name)                                                                                    |
| `--network <policy>`         | blocked or internet; default is the profile's policy                                                                                    |
| `--label <k=v>`              | Label to set (repeatable)                                                                                                               |
| `--env <K=V>`                | Environment variable for every command in the sandbox (repeatable; K alone copies it from here)                                         |
| `--env-file <path>`          | Read K=V lines into the sandbox environment (repeatable; --env wins)                                                                    |
| `--build`                    | Build --image now if this provider needs a build and none is recorded                                                                   |
| `--ttl <duration>`           | Destroy the sandbox after this long even if nothing removes it, e.g. 30m or 2h; default is the profile's lifetime                       |
| `--snapshot <name>`          | Restore a snapshot recorded by `beachside snapshot create` instead of an image                                                          |
| `--retry <duration>`         | Keep retrying for up to this long when the provider refuses before creating anything (rate limit, capacity), e.g. 5m                    |
| `--setup <name\|path>`       | Run a named setup from beachside.json or a local script once the sandbox starts (repeatable, comma-separated)                           |
| `--setup-cmd <shell>`        | Run a shell line as a setup step, after --setup (repeatable)                                                                            |
| `--startup <path>`           | Run a local script every time the sandbox comes up without its processes, such as after a restore (repeatable)                          |
| `--startup-cmd <shell>`      | Run a shell line as a startup step (repeatable)                                                                                         |
| `--no-default-setup`         | Skip the setups the profile lists by default                                                                                            |
| `--quiet-setup`              | Show setup step names and failures, not their output                                                                                    |
| `--setup-timeout <duration>` | Overall limit for setup and startup, e.g. 45m (default 30m; each step 10m)                                                              |
| `--cache`                    | Cache this setup as a snapshot and restore it next time, even if no named setup asks for it                                             |
| `--no-cache`                 | Neither use nor build a setup cache for this sandbox                                                                                    |
| `--refresh-cache`            | Build the setup cache again now, replacing the current one                                                                              |
| `--if-not-exists`            | Return the named sandbox if it is still alive instead of failing                                                                        |
| `--rm-on-failure`            | Remove the sandbox if its setup fails, instead of keeping it to look at                                                                 |
| `--with <server>`            | Install and start a server reachable over your tailnet: rex or herdr (repeatable; needs TAILSCALE_AUTH_KEY, implies --network internet) |

Examples:

```sh
beachside create --name web --network internet
beachside create --name job-42 --if-not-exists --json
beachside create --name ci --env-file .env --env API_TOKEN
beachside create --name job-42 --ttl 1h
beachside create --name job-42 --retry 5m --json
beachside create --name web --with rex
beachside create --name web --setup node --setup-cmd 'npm i -g pnpm'
beachside create --name web --setup ./setup.sh --startup-cmd 'pnpm dev > /tmp/dev.log 2>&1 &'
beachside create --name web --setup node --cache
```

## ls

List sandboxes in the store with their current state.

```sh
beachside ls [--offline | --remote]
```

| Flag        | Description                                                         |
| ----------- | ------------------------------------------------------------------- |
| `--offline` | Show stored records without asking providers                        |
| `--remote`  | List the profile's sandboxes from the provider instead of the store |

Examples:

```sh
beachside ls
beachside ls --json
beachside ls --remote --provider daytona
```

## adopt

Add a sandbox from the provider's listing to the store so other commands reach it.

```sh
beachside adopt <id> [--name <name>]
```

| Flag            | Description                                    |
| --------------- | ---------------------------------------------- |
| `--name <name>` | Store name (default: generated, like sb-1a2b3) |

Examples:

```sh
beachside ls --remote
beachside adopt 4f1c2a --name worker
```

## inspect

Show a sandbox's state, expiry and reference.

```sh
beachside inspect <sandbox>
```

Examples:

```sh
beachside inspect web --json
```

## rm

Destroy sandboxes and remove their records.

```sh
beachside rm <sandbox>... | --all [--force]
```

| Flag      | Description                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `--all`   | Every sandbox in this store                                                 |
| `--force` | Also destroy sandboxes this CLI did not create, or drop unreachable records |

Examples:

```sh
beachside rm web
beachside rm --all
```

## gc

Destroy the provider's sandboxes that carry the given labels, such as a killed job's, and prune stale setup caches.

```sh
beachside gc --label k=v... [--older-than <duration>] [--dry-run]
```

| Flag                      | Description                                                                   |
| ------------------------- | ----------------------------------------------------------------------------- |
| `--label <k=v>`           | Only sandboxes with this label set at create (repeatable; all must match)     |
| `--older-than <duration>` | Only sandboxes the provider says were created at least this long ago, e.g. 2h |
| `--dry-run`               | List what would be destroyed and change nothing                               |

Examples:

```sh
beachside gc --label run=$GITHUB_RUN_ID
beachside gc --label ci=true --older-than 2h --dry-run
```

## exec

Run a command in a sandbox; exits with the command's exit code.

```sh
beachside exec <sandbox> [--cwd <dir>] [--env K=V]... [--stdin] -- <command> [args...]
```

| Flag                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--cwd <dir>`          | Working directory in the sandbox                                                |
| `--env <K=V>`          | Environment variable for this command (repeatable; K alone copies it from here) |
| `--env-file <path>`    | Read K=V lines into this command's environment (repeatable; --env wins)         |
| `--stdin`              | Send this process's stdin to the command                                        |
| `--stdin-file <path>`  | Send a local file as the command's stdin                                        |
| `--timeout <duration>` | Execution deadline, e.g. 90s or 10m (default 300s)                              |
| `--max-output <size>`  | Captured output limit for buffered and --json output, e.g. 1m                   |
| `--no-stream`          | Print the output when the command ends instead of as it arrives                 |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
beachside exec web -- ls -la /
beachside exec web --cwd /work --env CI=1 -- npm test
```

## sh

Run a shell script in a sandbox; exits with its exit code.

```sh
beachside sh <sandbox> '<script>' | beachside sh <sandbox> -- '<script>'
```

| Flag                   | Description                                                                     |
| ---------------------- | ------------------------------------------------------------------------------- |
| `--cwd <dir>`          | Working directory in the sandbox                                                |
| `--env <K=V>`          | Environment variable for this command (repeatable; K alone copies it from here) |
| `--env-file <path>`    | Read K=V lines into this command's environment (repeatable; --env wins)         |
| `--stdin`              | Send this process's stdin to the command                                        |
| `--stdin-file <path>`  | Send a local file as the command's stdin                                        |
| `--timeout <duration>` | Execution deadline, e.g. 90s or 10m (default 300s)                              |
| `--max-output <size>`  | Captured output limit for buffered and --json output, e.g. 1m                   |
| `--no-stream`          | Print the output when the command ends instead of as it arrives                 |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
beachside sh web 'cd /work && make test'
beachside sh web -- '-n is fine here'
```

## run

Create a sandbox, run one command, and always destroy it.

```sh
beachside run [create flags] [exec flags] [--keep] [--push <path>] -- <command> [args...]
```

| Flag                         | Description                                                                                                          |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `--name <name>`              | Store name (default: generated, like sb-1a2b3)                                                                       |
| `--image <oci-ref>`          | OCI image, e.g. python:3.12; default is the profile's image                                                          |
| `--prepared <id>`            | Provider-prepared image id (template, snapshot name)                                                                 |
| `--network <policy>`         | blocked or internet; default is the profile's policy                                                                 |
| `--label <k=v>`              | Label to set (repeatable)                                                                                            |
| `--env <K=V>`                | Environment variable for this command (repeatable; K alone copies it from here)                                      |
| `--env-file <path>`          | Read K=V lines into this command's environment (repeatable; --env wins)                                              |
| `--build`                    | Build --image now if this provider needs a build and none is recorded                                                |
| `--ttl <duration>`           | Destroy the sandbox after this long even if nothing removes it, e.g. 30m or 2h; default is the profile's lifetime    |
| `--snapshot <name>`          | Restore a snapshot recorded by `beachside snapshot create` instead of an image                                       |
| `--retry <duration>`         | Keep retrying for up to this long when the provider refuses before creating anything (rate limit, capacity), e.g. 5m |
| `--setup <name\|path>`       | Run a named setup from beachside.json or a local script once the sandbox starts (repeatable, comma-separated)        |
| `--setup-cmd <shell>`        | Run a shell line as a setup step, after --setup (repeatable)                                                         |
| `--startup <path>`           | Run a local script every time the sandbox comes up without its processes, such as after a restore (repeatable)       |
| `--startup-cmd <shell>`      | Run a shell line as a startup step (repeatable)                                                                      |
| `--no-default-setup`         | Skip the setups the profile lists by default                                                                         |
| `--quiet-setup`              | Show setup step names and failures, not their output                                                                 |
| `--setup-timeout <duration>` | Overall limit for setup and startup, e.g. 45m (default 30m; each step 10m)                                           |
| `--cache`                    | Cache this setup as a snapshot and restore it next time, even if no named setup asks for it                          |
| `--no-cache`                 | Neither use nor build a setup cache for this sandbox                                                                 |
| `--refresh-cache`            | Build the setup cache again now, replacing the current one                                                           |
| `--cwd <dir>`                | Working directory in the sandbox                                                                                     |
| `--stdin`                    | Send this process's stdin to the command                                                                             |
| `--stdin-file <path>`        | Send a local file as the command's stdin                                                                             |
| `--timeout <duration>`       | Execution deadline, e.g. 90s or 10m (default 300s)                                                                   |
| `--max-output <size>`        | Captured output limit for buffered and --json output, e.g. 1m                                                        |
| `--no-stream`                | Print the output when the command ends instead of as it arrives                                                      |
| `--keep`                     | Keep the sandbox and print its name on stderr                                                                        |
| `--push <path>`              | Send a local folder to ~/work first and run the command there                                                        |
| `--exclude <glob>`           | Skip matching paths (repeatable; a pattern without / matches any name)                                               |
| `--include-ignored`          | Send every file, not only git-tracked and unignored ones                                                             |

Exits with the remote command's exit code; failures of the CLI itself exit 125.

Examples:

```sh
beachside run -- python3 -c 'print(2 + 2)'
beachside run --network internet -- curl -sI https://example.com
beachside run --push . --timeout 15m --ttl 30m -- sh -c 'npm ci && npm test'
beachside run --push . --setup-cmd 'npm ci' -- npm test
```

## image

Build OCI images for providers that need it, and list, delete or forget the builds.

```sh
beachside image build <oci-ref> [--name <name>] [--refresh] | ls [--remote] | inspect <name> | rm <name> [--force] | forget <name>
```

| Flag            | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `--name <name>` | Record name for a build (default: from the reference, like python-3-12) |
| `--refresh`     | Build again even if this reference is recorded                          |
| `--remote`      | List the images on the provider for this profile, not the local records |
| `--force`       | Delete a recorded image this CLI did not verifiably create              |

Examples:

```sh
beachside image build python:3.12 --provider e2b
beachside create --image python:3.12 --provider e2b
beachside image ls
beachside image ls --remote --provider e2b
beachside image rm python-3-12
beachside image forget python-3-12
```

## snapshot

Capture a sandbox as a snapshot, and list, inspect, delete or forget snapshots.

```sh
beachside snapshot create <sandbox> [--name <name> [--replace]] | ls [--remote] | inspect <name> | rm <name> [--force] | forget <name>
```

| Flag            | Description                                                                |
| --------------- | -------------------------------------------------------------------------- |
| `--name <name>` | Record name for a capture (default: <sandbox>-snap)                        |
| `--replace`     | Capture --name again; the old snapshot is deleted once the new one exists  |
| `--remote`      | List the snapshots on the provider for this profile, not the local records |
| `--force`       | Delete a recorded snapshot this CLI did not verifiably capture             |

Examples:

```sh
beachside snapshot create web --name deps
beachside create --snapshot deps --name web-2
beachside run --snapshot deps -- npm test
beachside snapshot create web --name deps --replace
beachside snapshot ls
beachside snapshot rm deps
```

## setup

Run setup in an existing sandbox, or list the named setups.

```sh
beachside setup <sandbox> [--setup <name|path>]... [--setup-cmd <shell>]... [--force] | setup ls | setup cache ls|rm <setup>|prune [--dry-run]
```

| Flag                         | Description                                                                                                    |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--setup <name\|path>`       | Run a named setup from beachside.json or a local script once the sandbox starts (repeatable, comma-separated)  |
| `--setup-cmd <shell>`        | Run a shell line as a setup step, after --setup (repeatable)                                                   |
| `--startup <path>`           | Run a local script every time the sandbox comes up without its processes, such as after a restore (repeatable) |
| `--startup-cmd <shell>`      | Run a shell line as a startup step (repeatable)                                                                |
| `--no-default-setup`         | Skip the setups the profile lists by default                                                                   |
| `--quiet-setup`              | Show setup step names and failures, not their output                                                           |
| `--setup-timeout <duration>` | Overall limit for setup and startup, e.g. 45m (default 30m; each step 10m)                                     |
| `--force`                    | Run every step, even ones the sandbox already has                                                              |
| `--dry-run`                  | setup cache rm and prune: list what would be deleted and change nothing                                        |

Examples:

```sh
beachside setup ls
beachside setup web
beachside setup web --setup playwright
beachside setup web --setup node --force
beachside setup cache ls
beachside setup cache rm node
beachside setup cache prune --dry-run
```

## cp

Copy files or directories to or from a sandbox.

```sh
beachside cp [-r] <src> <dst>   (one side is <sandbox>:/path)
```

| Flag               | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `--no-clobber`     | Fail instead of overwriting an existing file                           |
| `-r, --recursive`  | Copy directories as one tar archive (needs tar in the sandbox)         |
| `--exclude <glob>` | Skip matching paths (repeatable; a pattern without / matches any name) |

Examples:

```sh
beachside cp ./app.py web:/work/app.py
beachside cp web:/work/out.json ./out.json
beachside cp -r ./src web:/work --exclude node_modules
beachside cp -r web:/work/coverage ./coverage
```

## push

Send a local folder's git-tracked and unignored files into a sandbox.

```sh
beachside push <sandbox>[:/dir] [path]   (default: . to ~/work in the sandbox)
```

| Flag                | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `--exclude <glob>`  | Skip matching paths (repeatable; a pattern without / matches any name) |
| `--include-ignored` | Send every file, not only git-tracked and unignored ones               |

Examples:

```sh
beachside push ci
beachside push ci:/srv/app ./app --exclude '*.log'
beachside exec ci --cwd /srv/app -- npm test
```

## cat

Print a file from a sandbox.

```sh
beachside cat <sandbox>:/path
```

Examples:

```sh
beachside cat web:/etc/os-release
```

## doctor

Check config, the provider connection and that the provider accepts the credentials, without creating anything.

```sh
beachside doctor
```

Examples:

```sh
beachside doctor --provider e2b
```

## adapter

Install, list or remove the adapters the CLI loads, in ~/.config/beachside/adapters.

```sh
beachside adapter add <provider|package>[@version]... | ls | rm <provider|package>...
```

Examples:

```sh
beachside adapter add e2b
beachside adapter add daytona vercel --json
beachside adapter add @acme/beachside-adapter@1.2.0
beachside adapter ls
beachside adapter rm e2b
```

## profile

List profiles, show where a profile's settings come from, pick the default or remove one.

```sh
beachside profile ls | show [<name>] | use <name> | rm <name> [--force]
```

| Flag      | Description                                                                     |
| --------- | ------------------------------------------------------------------------------- |
| `--force` | rm: remove the profile even though stored sandboxes, snapshots or images use it |

Examples:

```sh
beachside profile ls
beachside profile show e2b --json
beachside profile use boxd
beachside profile rm old-daytona
```

## providers

List official providers, whether their adapter is installed and their credentials set.

```sh
beachside providers
```

Examples:

```sh
beachside providers --json
```

## skill

Print the agent skill for this CLI, or set it up for your coding agents.

```sh
beachside skill [show | setup | status | remove] [--agent <name>]... [--project]
```

| Flag             | Description                                                                           |
| ---------------- | ------------------------------------------------------------------------------------- |
| `--agent <name>` | Only this agent: claude, codex, opencode or pi (repeatable; default: detected agents) |
| `--project`      | Use this folder's .agents/skills (and .claude/skills) instead of your home            |
| `--dry-run`      | Report what setup or remove would change without changing anything                    |
| `--force`        | Let setup replace a beachside-cli skill that beachside did not install                |

Examples:

```sh
beachside skill
beachside skill setup
beachside skill setup --project --dry-run
beachside skill status --json
beachside skill remove --agent claude
```

## completion

Print a shell completion script for zsh, bash or fish.

```sh
beachside completion <zsh|bash|fish>
```

Examples:

```sh
source <(beachside completion zsh)   # in ~/.zshrc
source <(beachside completion bash)  # in ~/.bashrc
beachside completion fish > ~/.config/fish/completions/beachside.fish
```
