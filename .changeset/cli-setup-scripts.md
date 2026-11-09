---
"@beachside/cli": minor
---

Setup scripts: `create` and `run` take `--setup <name|path>`, `--setup-cmd '<shell>'`, `--startup <path>` and `--startup-cmd '<shell>'`, which run in the new sandbox once it starts.

- **Named setups:** `setups` in `beachside.json` defines reusable setups with `extends`, `network` and `env`, and a profile's `setup` list applies by default (`--no-default-setup` skips it). `beachside setup ls` lists them.
- **Startup:** startup steps run at create and again after every `create --snapshot` restore.
- **Failures:** a failed step exits 9 with `SETUP_FAILED`. `create` keeps the sandbox, or removes it with `--rm-on-failure`; the record shows each step's outcome.
- **Rerun:** `beachside setup <sandbox>` reruns only the missing steps, and `--force` reruns everything.
- **Add-ons:** `--with` installs its servers through the same setup engine.
