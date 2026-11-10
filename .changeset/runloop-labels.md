---
"@beachside/runloop": minor
---

Runloop: `create({ labels })` and `restore({ labels })` are now stored as Devbox metadata and returned by `sandboxes.list()`, so `beachside gc --label` works on Runloop. Keys starting with `beachside_` stay reserved.
