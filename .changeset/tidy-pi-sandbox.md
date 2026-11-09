---
"@beachside/pi": minor
"@beachside/cli": patch
"@beachside/freestyle": patch
"@beachside/vercel": patch
"beachside": minor
"@beachside/adapter": minor
---

Add the Beachside Pi extension and share profile resolution, adapter loading, snapshot records, and workspace transfers with the CLI. Expose preview, process streaming, and portable creation label support for host integrations.

CLI create and snapshot restore accept a top-level profile `network` default, which `--network` can override for one command. Pi requires the profile to set that default explicitly.

Freestyle advertises create-time labels, and Vercel accepts dotted application labels while preserving its reserved correlation tag. The SDK can prune entry names at every depth during a filesystem walk.
