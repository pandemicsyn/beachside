---
"@beachside/e2b": minor
---

E2B: upgrade to `e2b@2.63.0` and support protected previews. With `preview: { access: "protected" }`, `box.preview(port)` now returns the sandbox's traffic token as an `e2b-traffic-access-token` header instead of rejecting.
