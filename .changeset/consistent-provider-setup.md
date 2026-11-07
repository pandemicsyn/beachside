---
"beachside": minor
"@beachside/adapter": minor
"@beachside/boxd": minor
"@beachside/boat": minor
"@beachside/runloop": minor
"@beachside/modal": minor
"@beachside/vercel": minor
"@beachside/cli": minor
"@beachside/daytona": minor
"@beachside/e2b": minor
---

Make provider setup consistent. Every first-party package now exports its definition as `<provider>Adapter` and a factory named after the provider: `boxd()`, `boat()`, `runloop()`, `modal()` and `vercel()` join `daytona()` and `e2b()`. Docs, examples and skills show the split form, `Beachside.connect({ adapter, credentials, config })`, which works for every adapter.

Breaking for Vercel: the definition is now `vercelAdapter`, and `vercel` is the factory. Replace `adapter: vercel` with `adapter: vercelAdapter`, or call `Beachside.connect(vercel({ token, teamId, projectId }))`. Passing a factory where a definition belongs now fails with `INVALID_ARGUMENT` and names both forms.
