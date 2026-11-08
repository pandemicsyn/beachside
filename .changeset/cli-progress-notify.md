---
"@beachside/cli": minor
---

Inside Rex (or with `BEACHSIDE_PROGRAM_STATUS=on`), `cp` and `push` into a sandbox now show upload progress on the terminal tab, and `run`, `exec` and `sh` send a desktop notification (OSC 777) when they finish after more than 30 seconds. `BEACHSIDE_NOTIFY_AFTER=<seconds>|off` changes or turns off the notification.
