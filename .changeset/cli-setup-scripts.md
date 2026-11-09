---
"@beachside/cli": minor
---

Setup scripts: `create` and `run` take `--setup <name|path>`, `--setup-cmd '<shell>'`, `--startup <path>` and `--startup-cmd '<shell>'`, which run in the new sandbox once it starts.

- **Named setups:** `setups` in `beachside.json` defines reusable setups with `extends`, `network` and `env`, and a profile's `setup` list applies by default (`--no-default-setup` skips it). `beachside setup ls` lists them.
- **Startup:** startup steps run at create and again after every `create --snapshot` restore.
- **Failures:** a failed step exits 9 with `SETUP_FAILED`. `create` keeps the sandbox, or removes it with `--rm-on-failure`; the record shows each step's outcome.
- **Rerun:** `beachside setup <sandbox>` reruns only the missing steps, and `--force` reruns everything.
- **Add-ons:** `--with` installs its servers through the same setup engine.

Setup caches: a setup with `"cache": true` (or `create --cache`) is snapshotted after setup and before startup. The next create with the same setup restores it and runs only `cache: false` steps and startup.

- **The key** covers the provider, scope, profile, image, every step and the files in `cache.files`.
- **Freshness:** caches go stale after `maxAge` (7 days by default) and are rebuilt on the next create.
- **Secrets:** a setup whose env holds secrets is refused unless it sets `secrets: "allow"`.
- **Commands:** `beachside setup cache ls|rm|prune` manages caches, and `gc` prunes stale ones. `--no-cache` and `--refresh-cache` control one create.

Setups can also come from a repository: with `"projectSetups": true` or `BEACHSIDE_PROJECT_SETUPS=1`, the CLI reads `.beachside/setup.json` (`setups` plus `default`) from the checkout. A step can be `{ "parallel": [...] }` to run several steps at once as one setup step.
