---
"beachside": minor
"@beachside/adapter": minor
"@beachside/boxd": minor
"@beachside/e2b": minor
"@beachside/vercel": minor
"@beachside/modal": minor
"@beachside/runloop": minor
"@beachside/freestyle": minor
"@beachside/archil": minor
"@beachside/boat": minor
"@beachside/exe-dev": minor
"@beachside/cli": minor
---

Sandboxes now reach the internet unless you ask otherwise. boxd, E2B, Vercel, Modal, Runloop, Freestyle and Archil default to `network: "internet"` instead of `blocked`; set `network: "blocked"` or an allowlist to restrict egress. Daytona keeps its tier-managed `daytona-default`. Boat and exe.dev no longer require `network: "internet"` in setup, and the CLI no longer needs `BOAT_NETWORK` or `EXE_NETWORK`; `BOXD_NETWORK`, `RUNLOOP_NETWORK`, `FREESTYLE_NETWORK` and `ARCHIL_NETWORK` stay optional, for `blocked` or (Archil Free plan) `archil-managed`. An adapter that declares no `defaultNetworkPolicy` now defaults to `internet`, or to its only policy when `supports.network` lists one. Connections that relied on the old blocked default and reopen sandboxes created that way should set `network: "blocked"` explicitly.
