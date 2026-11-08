---
"@beachside/e2b": patch
"beachside": patch
---

E2B streamed writes, and buffered writes over 1 MiB, work in sticky directories such as `/tmp` again; they used to fail there with "stream completion could not be confirmed". When a streamed E2B write fails, the error now names the step that failed and keeps the provider's original error as its `cause`.
