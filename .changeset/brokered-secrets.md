---
"beachside": minor
"@beachside/adapter": minor
"@beachside/cli": minor
"@beachside/e2b": minor
"@beachside/vercel": minor
"@beachside/freestyle": minor
"@beachside/daytona": minor
"@beachside/boxd": minor
"@beachside/runloop": minor
"@beachside/modal": minor
---

Secrets for sandboxes. Wrap an env value in `secret()` and Beachside never prints it, saves it or puts it in an error message.

- **Plain:** `secret(value)` gives the sandbox the real value, for Tailscale, SSH, signing or decryption keys. Runloop, boxd and Modal keep it in their secret store rather than the sandbox definition; `capabilities().secrets.stored` says so.
- **Brokered:** `secret(value, { for: "anthropic" })` (or `hosts: [...]`) keeps the value out of the sandbox. The sandbox sees a placeholder, and the provider adds the value to HTTPS requests for those hosts. E2B, Vercel and Freestyle set the header from a network rule; Daytona and boxd swap a placeholder; Runloop routes `anthropic` and `openai` through its Agent Gateway. Other adapters refuse before creating anything. The type requires `for` or `hosts`.
- **Presets:** `anthropic`, `openai`, `github` (API and git over HTTPS), `github-api` and `npm`.
- **CLI:** `--secret NAME=<named secret>`, `NAME=<source>` (plain) or `NAME=<source>@<preset|host>` (brokered) on `create` and `run`, a `secrets` block in `beachside.json`, the `gh:` source for your `gh` login, and `beachside secret ls`. Values are never stored.
- **boxd:** moves to `@boxd-sh/sdk` 0.3.0 for machine specs.
- **Adapter authors:** `supports.secrets` declares brokered delivery (`header`, `placeholder` or `gateway`), Basic auth, wildcard hosts, hosts and a limit; `supports.secretStore` declares a store for plain secrets; `CreateInput.secrets` and `CreateInput.secretEnv` carry them, on create and restore.
