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

Rename the project to Beachside. Packages are `beachside` and `@beachside/*`; the exports are `Beachside`, `BeachsideClient`, `DirectBeachsideClient` and `BeachsideError`; list coverage `"sandbar-managed"` is now `"managed"`; telemetry spans and attributes use `beachside.*`. The CLI command is `beachside`, with settings in `~/.config/beachside/beachside.json` and `BEACHSIDE_*` environment variables. Labels, metadata and names written onto provider resources now use the `beachside` prefix, so resources created by earlier releases are no longer recognized.
