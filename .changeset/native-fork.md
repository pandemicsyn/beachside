---
"beachside": minor
"@beachside/adapter": minor
"@beachside/boxd": minor
"@beachside/archil": minor
"@beachside/e2b": minor
---

Add `box.fork()`, `box.submitFork()` and `box.checkFork()`. A fork copies a running sandbox with the provider's native fork; adapters without one reject with `UNSUPPORTED`, and Beachside never emulates a fork with a snapshot and restore. `capabilities().fork` reports what a fork keeps, how the source is interrupted, whether processes resume and whether the fork's lifecycle is independent. boxd, E2B and Archil fork natively with memory and running processes. Adapters declare a fork with the new `sandboxFork` session hook; uncertain forks recover through operation kind `sandbox_fork`.
