---
"@beachside/adapter": minor
"beachside": minor
"@beachside/daytona": minor
"@beachside/e2b": minor
"@beachside/vercel": minor
"@beachside/modal": minor
"@beachside/runloop": minor
"@beachside/freestyle": minor
"@beachside/archil": minor
---

Egress allowlists: set `network: { allow: ["registry.npmjs.org", "*.github.com", "10.0.0.0/8"] }` in adapter setup to let sandboxes reach only those hosts and IPv4 ranges. Supported on Daytona (Tier 3+), E2B, Vercel, Modal, Runloop, Archil (paid plans) and Freestyle (IPv4 ranges only); each adapter checks the provider recorded exactly that list. Modal also gains `network: "internet"`; it previously always blocked egress.
