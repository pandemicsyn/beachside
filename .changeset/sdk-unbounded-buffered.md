---
"beachside": minor
---

Buffered `readFile`/`writeFile` (and the text variants) have no default size limit: files larger than the adapter's buffered limit move through its file streams underneath. `maxBytes` stays as an optional guard and the 16 MiB ceiling is gone. Adapters without file streams keep their own limit, and the error names it. `capabilities().maxFileBytes` now reports the adapter's buffered limit. `exec` `stdin` also accepts an `AsyncIterable<Uint8Array>` or `ReadableStream<Uint8Array>`, and byte or text input over 1 MiB. These are streamed to the command as it runs on adapters with incremental process stdin (Daytona, E2B, Vercel), with `deadlineSeconds` enforced locally.
