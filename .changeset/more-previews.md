---
"@beachside/adapter": minor
"beachside": minor
"@beachside/daytona": minor
"@beachside/modal": minor
"@beachside/boat": minor
---

Previews on more providers. Daytona's `preview: { access: "public" }` now returns an expiring signed URL for one port (`preview.expiresInSeconds`, default 1 hour) instead of rejecting, and previews gain an optional `expiresAt`. Modal gets `box.preview(port)`: protected by default through a connect token sent as a bearer header, or public tunnels for `preview.ports` declared at create. Boat gets public previews through its host-port API.
