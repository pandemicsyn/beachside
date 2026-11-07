---
"@beachside/adapter": minor
"beachside": minor
"@beachside/cli": minor
"@beachside/daytona": minor
"@beachside/e2b": minor
"@beachside/modal": minor
"@beachside/vercel": minor
"@beachside/runloop": minor
"@beachside/boxd": minor
---

`sandboxes.list()` items now carry `labels` (the labels set at create, without adapter markers; `null` where the provider keeps none) and `createdAt` (the provider's creation time, or `null`). Daytona, E2B, Vercel and Modal report labels; Daytona, E2B (start time), Vercel, boxd and Runloop report creation time. Adapters add them with the new `listedLabels` and `listedTime` helpers. The CLI's `ls --remote` shows both, and the new `beachside gc --label k=v [--older-than 2h] [--dry-run]` destroys provider-listed sandboxes whose labels match, such as those a killed CI job left behind, and drops their store records. Durations also accept days, like `1d`.
