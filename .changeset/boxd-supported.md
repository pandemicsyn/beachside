---
"@beachside/boxd": patch
---

boxd is now a supported provider: it is out of experimental in the docs and is the landing page's default provider.

File operations on an image without Python 3 now fail with a clear UNSUPPORTED error instead of an unknown outcome.

`makeDirectory` on an existing file now rejects with INVALID_ARGUMENT and no effect, recursive or not, instead of an unknown outcome.
