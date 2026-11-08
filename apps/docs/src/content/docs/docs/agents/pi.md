---
title: Run Pi in a sandbox
description: Install the Beachside Pi extension, choose a provider profile, and run Pi's coding tools in a sandbox.
---

`@beachside/pi` runs Pi's seven coding tools and interactive `!` and `!!` commands in one Beachside sandbox per session. Pi and its model credentials stay on your machine. Choose the sandbox provider through a Beachside profile.

## Install and configure

Use [Pi](https://pi.dev/docs/latest) 1.5 or a compatible release on a POSIX host with Node.js 22.19 or newer. This example uses E2B. Set `E2B_API_KEY` in the shell where you launch Pi.

```sh
npm install -g @beachside/cli
beachside adapter add e2b
pi install npm:@beachside/pi
```

The Pi package is available through npm after its first release.

Add an `e2b` profile to `~/.config/beachside/beachside.json`. If you already use the CLI, add this entry to the existing `profiles` object.

```json
{
  "profiles": {
    "e2b": {
      "provider": "e2b",
      "network": "internet",
      "credentials": { "apiKey": "env:E2B_API_KEY" }
    }
  }
}
```

Set `network` explicitly in each profile you use with Pi. An explicit adapter setting under `config.network` also works. Custom adapters use the same `module`, `export`, and credential settings as the CLI. See [CLI configuration](/docs/cli/configuration/) and [E2B setup](/docs/providers/e2b/).

From your project directory, start Pi and try `!pwd` to see the guest working directory.

```sh
pi --beachside e2b --beachside-sync upload
```

Use `/beachside` to see the profile, sandbox ID, and guest workdir. File paths in the coding tools resolve inside the guest.

## Choose what goes into the sandbox

| Sync mode | What it does                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `git`     | Clones the current branch from a credential-free HTTPS `origin`. This is the default in a Git checkout. The guest needs network access and an accessible remote branch.       |
| `upload`  | Sends tracked and unignored files in a Git checkout, including local edits. Outside Git, it sends the directory tree. Review what the directory contains before uploading it. |
| `none`    | Uses a guest workdir without copying the checkout. This is the default outside Git and when restoring a named snapshot.                                                       |

Use `upload` for private repositories, detached HEAD, or local changes that Git mode cannot fetch. Upload and workspace transfers require `tar` in the guest. The default guest workspace root is `/tmp/beachside-work`.

Changes reach your machine only when you request a pull.

| Pi command                         | What it does                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------- |
| `/beachside-push`                  | Overlays host files onto the guest workdir.                                       |
| `/beachside-pull ./sandbox-result` | Copies the guest workdir into a new host directory. Your checkout stays separate. |
| `/beachside-off`                   | Switches this Pi session to local tools.                                          |
| `/beachside-destroy`               | Deletes the session's sandbox.                                                    |

## Resume a session or start from a snapshot

The sandbox opens on first use. Pass `--beachside-eager` to open it on session start. Pi destroys the sandbox on quit by default. To reopen it later from the saved Pi session, start with `--beachside-exit keep`, or use `--beachside-exit suspend` with a profile that supports suspension. Resume uses the original sandbox identity and requires that the sandbox still exist. Switching sessions or reloading the extension retains the previous sandbox.

On supported profiles, `/beachside-snapshot warm-node` saves a source-preserving snapshot in the shared CLI snapshot store. Start a new Pi session from it with:

```sh
pi --beachside my-snapshot-profile --beachside-snapshot warm-node
```

Use the profile that owns the snapshot. File-backed Pi forks can also restore into independent sandboxes when capture preserves the parent and the adapter supports independent restore. If source-preserving capture is unsupported, the child starts with a fresh sandbox.

If a process exits before it can clean up, review tagged sandboxes on providers that support the labels:

```sh
beachside --profile e2b gc --label beachside.pi=1 --older-than 2h --dry-run
```

## Provider differences

The guest needs Bash for shell commands and `rg` or recursive `grep` for search. The `grep` fallback searches without ripgrep's Git ignore rules. Find skips `.git` and `node_modules` and includes other paths regardless of `.gitignore`. Depending on the adapter, Bash output streams as bytes or text, or arrives as bounded output after execution. Stopping a local wait on a finite execution may leave the guest command running.

On profiles that offer previews, Pi exposes `preview_url` for an adapter-configured port. Protected previews still require authentication. See [HTTP previews](/docs/guides/preview-access/).
