---
"@beachside/adapter": minor
"beachside": minor
"@beachside/runloop": minor
---

Snapshots can carry labels. `snapshot({ labels })` sets them at capture where the adapter keeps them, and `snapshots.list({ labels })` keeps only matching snapshots.

- **Adapters:** an adapter opts in with `snapshotCapture.labels: true`, and listed `SnapshotInfo` reports `labels`. Elsewhere a labelled capture is rejected before anything is captured.
- **Capability:** `capabilities().snapshots.capture.value.labels` says whether labels are kept.
- **Runloop:** labels are stored as snapshot metadata, next to the adapter's own `beachside_` keys, which stay reserved.
- **Setup:** `box.runSetup()` takes `env` for every step, kept out of the digest, and `runStartup: false`, which records startup steps without running them so a snapshot can be taken in between.
