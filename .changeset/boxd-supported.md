---
"@beachside/boxd": patch
---

boxd is now a supported provider: it is out of experimental in the docs and is the landing page's default provider.

File operations on an image without Python 3 now fail with a clear UNSUPPORTED error instead of an unknown outcome.

`makeDirectory` on an existing file now rejects with INVALID_ARGUMENT and no effect, recursive or not, instead of an unknown outcome.

Destroying a machine with writable disks now flushes and freezes them first, so the next machine can mount them (read-only mounts used to fail after an unclean stop). The docs explain that boxd ends background processes with the command that started them.

Commands, file calls and processes on a suspended machine now fail with UNAVAILABLE instead of silently waking it, and `readDirectory()` reports symlinks exactly when the image has Python.

File streams move 1 MiB pieces through boxd's native upload and download instead of 64 KiB through command output.
