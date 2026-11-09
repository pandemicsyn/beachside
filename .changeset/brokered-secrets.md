---
"beachside": minor
"@beachside/adapter": minor
"@beachside/cli": minor
"@beachside/e2b": minor
"@beachside/vercel": minor
"@beachside/freestyle": minor
"@beachside/daytona": minor
---

Give a sandbox a credential without putting the real value inside it. Wrap an env value in `secret(value, { for: "anthropic" })` (or `hosts: [...]`): the sandbox sees a placeholder, and the provider's egress proxy adds the value to HTTPS requests for those hosts.

- **Providers:** E2B, Vercel and Freestyle set the header from a network rule; Daytona mounts a per-sandbox Daytona secret and deletes it with the sandbox. Other adapters refuse brokered secrets before creating anything, and `capabilities().secrets` says which can.
- **Presets:** `anthropic`, `openai`, `github` (API and git over HTTPS), `github-api` and `npm`.
- **Exposed:** `secret.exposed(value)` puts the real value in env when a tool needs it, still redacted everywhere Beachside prints or saves.
- **CLI:** `--secret NAME=<named secret>` or `NAME=<source>@<preset|host>[:exposed]` on `create` and `run`, a `secrets` block in `beachside.json`, the `gh:` source for your `gh` login, and `beachside secret ls`. Values are never stored.
- **Adapter authors:** `supports.secrets` declares delivery, Basic auth, wildcard hosts and a limit; `CreateInput.secrets` and restore `secrets` carry the bindings.
