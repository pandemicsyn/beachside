---
"@beachside/cli": minor
---

Report command status on terminal tabs with the Program Status Protocol (OSC 7501): inside Rex, or with `BEACHSIDE_PROGRAM_STATUS=on`, `create`, `run`, `exec`, `rm`, `gc` and other sandbox-changing commands show working, done or error. Reports go to stderr only when it is a terminal, so `--json` and piped output are unchanged.
