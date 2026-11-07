---
"@beachside/cli": patch
---

`cp` and `cat` handle files of any size: they stream where the provider streams files, and otherwise move the file in 1 MiB parts that the sandbox joins or splits. A failed download no longer truncates the local file. `exec`, `sh` and `run` stream `--stdin` and `--stdin-file` as the input arrives where the provider takes incremental stdin (Daytona, E2B, Vercel), so input has no size limit and can stay open; elsewhere input over 1 MiB fails with a hint to copy it in and redirect.
