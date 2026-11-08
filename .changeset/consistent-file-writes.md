---
"@beachside/daytona": patch
"@beachside/e2b": patch
"@beachside/boxd": patch
"@beachside/vercel": patch
---

Writing to a path whose folder does not exist yet now creates the missing folders on Daytona, boxd and Vercel, as E2B and Modal already did. This covers `writeFile`, `writeFileStream` and `copyFile`.

Daytona no longer leaves `.beachside-exec-*` and `.beachside-write-*` folders in `/tmp` after commands and writes succeed. E2B also removes its command capture files and write stages once an interrupted operation is recovered.
