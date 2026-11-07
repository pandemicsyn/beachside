---
"@beachside/adapter": minor
"beachside": minor
"@beachside/daytona": minor
"@beachside/e2b": minor
"@beachside/boxd": minor
"@beachside/boat": minor
"@beachside/runloop": minor
"@beachside/modal": minor
"@beachside/vercel": minor
"@beachside/cli": minor
---

Set the sandbox lifetime the same way everywhere. Every adapter now takes `lifecycle: { lifetimeSeconds }` in setup, defaulting to 900 seconds; E2B, Vercel and Modal `timeoutSeconds`, Daytona `ttlMinutes` and boxd's top-level `lifetimeSeconds` still work but are deprecated. `create({ lifecycle: { lifetimeSeconds } })` overrides it for one sandbox, and `capabilities().lifetime` reports the accepted range. The CLI adds `create --ttl` and `run --ttl`.
