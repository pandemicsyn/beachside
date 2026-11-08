---
"@beachside/freestyle": minor
"@beachside/cli": minor
---

Add the experimental `@beachside/freestyle` adapter for Freestyle VMs, built on Freestyle's official `freestyle` SDK. It creates Ubuntu microVMs from Freestyle snapshots with blocked egress by default, runs argv and shell commands with exact output bytes and finite stdin, reads and writes binary files, lists directories, pauses and resumes VMs with their memory, renews their lifetime, publishes configured preview ports on public `style.dev` URLs, and lists VMs with their labels. A create whose response is lost is found again by its slug instead of being resent. The CLI gains a `freestyle` provider that reads `FREESTYLE_API_KEY` and an optional `FREESTYLE_NETWORK`.
