---
"@beachside/e2b": minor
---

E2B: upgrade to `e2b@2.63.0` and support protected previews. With `preview: { access: "protected" }`, `box.preview(port)` now returns the sandbox's traffic token as an `e2b-traffic-access-token` header instead of rejecting.

The connect call that returns the token uses the sandbox's observed remaining lifetime as its timeout, so a running sandbox's lifetime is unchanged; if the sandbox paused after the running check, E2B resumes it with that remaining lifetime and `preview()` rejects with `CONFLICT`.

**Compatibility:** `e2b@2.63.0` requires Node 22.19 or newer, so `@beachside/e2b` now declares `engines.node >=22.19` (previously Node 20 worked).
