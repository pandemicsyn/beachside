---
"@beachside/e2b": patch
---

E2B overwrites of an existing file directly in a sticky directory such as `/tmp` now succeed. They used to fail with an HTTP 500 from the sandbox because the kernel refuses to let E2B reopen a file there that belongs to the sandbox user; the adapter now uploads a fresh copy beside the file and copies it over as the sandbox user.
