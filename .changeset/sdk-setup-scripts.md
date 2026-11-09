---
"beachside": minor
---

Sandboxes can now be set up as they start. `sandboxes.create()`, `sandboxes.with()` and `snapshot.restore()` take `setup` (steps that run once per sandbox: shell lines, argv arrays, inline scripts or `Setup.file()` scripts) and `startup` (steps that run whenever the sandbox comes up without its processes, including after a fresh `resume()`). `Setup.define()` makes named setups that compose. Beachside runs the steps over `exec` on every provider, streams their output through `onSetupOutput`, records progress in the sandbox so a restored snapshot skips setup it already holds, and throws `SetupFailedError` naming the failed step. A sandbox whose setup fails is destroyed unless `onSetupFailure: "keep"`. `box.runSetup()` runs setup on an existing sandbox.
