---
"@beachside/boxd": minor
---

boxd egress allowlists: `network: { allow: [...] }` takes up to 256 host names, `*.` wildcards and public IPv4 addresses or ranges, through boxd's native egress allowlist. Restores now carry their egress in the machine spec, so `blocked` or the allowlist is in force from first boot, and creates, restores and forks write their expiry together with the machine. A list boxd refuses leaves the machine reaching nothing.
