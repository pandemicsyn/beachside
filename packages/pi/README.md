# Beachside for Pi

`@beachside/pi` runs Pi's seven coding tools and interactive `!` and `!!` commands in one Beachside sandbox per Pi session. Pi and its model credentials stay on the host. Requires Pi 1.5 or compatible, Node.js 22.19 or newer, and a POSIX host.

```sh
pi install npm:@beachside/pi
beachside adapter add e2b
pi --beachside e2b --beachside-sync upload
```

Use a named profile in `~/.config/beachside/beachside.json`, the same file the Beachside CLI reads. For example:

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

Set `network` explicitly in the profile. An explicit adapter setting under `config.network` also works. Adapter defaults and provider environment fallbacks do not select the policy for Pi. Third-party profiles use the same `module` and `export` fields as the CLI. Profile credentials and secret references are resolved on the host. Adapter modules execute on the host and should come from trusted sources.

## Workspace

- `--beachside-sync git` clones the checked-out branch from a credential-free HTTPS origin using guest network access. It is the default in a Git checkout. It needs an accessible remote branch and does not include uncommitted or unpushed work. Use upload for private repositories, detached HEAD, or blocked network access.
- `--beachside-sync upload` sends the current directory with the CLI's tar transfer. In Git worktrees it sends tracked and unignored files. Outside Git it sends the directory tree. Review files before uploading them.
- `--beachside-sync none` uses a guest workdir without copying the checkout. It is the default outside Git and when restoring a named snapshot. The workspace root is `/tmp/beachside-work`.

`/beachside` shows status. `/beachside-push` overlays host files on the guest workdir. `/beachside-pull <new-host-directory>` copies guest files into a fresh directory and leaves the checkout untouched. Both directions require `tar` in the guest. `/beachside-off` switches the current Pi session to local tools. `/beachside-destroy` explicitly deletes the sandbox.

## Lifecycle and provider support

The sandbox opens on first use. Set `--beachside-eager` to open it on session start. By default Pi destroys the sandbox on quit. Use `--beachside-exit suspend` or `--beachside-exit keep` for later resumption. Switching Pi sessions and reloading the extension retain the old sandbox. Resumption uses the verified saved reference and fails if the sandbox is gone or the adapter cannot reopen it. Renewal follows the observed provider deadline when available. Pi starts writing a new session file after its first user or assistant message. Before then, an interrupted Pi process can leave a sandbox to clean up via labels or expiry.

`/beachside-snapshot <name>` saves a source-preserving snapshot to the shared CLI snapshot store on supported profiles. `--beachside-snapshot <name>` restores from that store. File-backed Pi forks restore into a new sandbox where the configured capture preserves the source and restore provides an independent lifecycle. Unsupported capture starts the child with a fresh sandbox. A failed or uncertain capture stops the child from allocating until addressed.

The guest image needs `bash` for Bash commands and `rg` or recursive `grep` for search. Missing directory hooks use guest shell tools. Find uses portable glob matching, excludes `.git` and `node_modules`, and includes other paths regardless of `.gitignore`. The `grep` fallback supports basic glob filtering and POSIX extended regular expressions. It searches without ripgrep's Git ignore rules. Process output streams as bytes when supported, as text on text-only providers, or as bounded output from finite exec. In finite mode, stopping the local wait may leave guest work running. Pi 1.5 buffers file reads within adapter limits. Hosts with a streaming read factory can use the adapter's stream.

`preview_url` appears when the adapter offers previews. Configure ingress on the adapter. Protected preview credentials stay out of tool results. Where the adapter accepts the portable label keys, Beachside labels the sandbox for CLI cleanup. Use `beachside --profile <profile> gc --label beachside.pi=1 --older-than 2h --dry-run` to review candidates. Providers that cannot apply those labels rely on explicit cleanup and their native expiry.

## Embed in a Pi SDK app

```ts
import { createBeachsideTools } from "@beachside/pi";

const tools = createBeachsideTools(box, "/tmp/beachside-work");
// Pass Object.values(tools) as Pi's customTools. Your app owns box and its lifetime.
```
