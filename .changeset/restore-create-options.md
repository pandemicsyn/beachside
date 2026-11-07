---
"@beachside/adapter": minor
"beachside": minor
"@beachside/cli": minor
"@beachside/daytona": minor
"@beachside/e2b": minor
"@beachside/modal": minor
"@beachside/vercel": minor
"@beachside/runloop": minor
"@beachside/boat": minor
"@beachside/boxd": minor
---

`snapshot.restore()` takes the create options `env`, `labels` and `lifecycle: { lifetimeSeconds }`. Adapters declare which they apply in `snapshotRestore.options` (shown in `capabilities().snapshots.restore`); anything else rejects before allocation. The CLI now accepts `--env`, `--label` and `--ttl` with `--snapshot`.
