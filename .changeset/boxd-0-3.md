---
"@beachside/boxd": minor
"@beachside/cli": minor
---

boxd moves to `@boxd-sh/sdk` 0.3.0 and gains blocked egress, labels and regions. `network` now defaults to `blocked`, which sets the machine's native egress allowlist to `none` before Beachside hands it out; set `network: "internet"` (or `BOXD_NETWORK=internet` in the CLI) for open egress. `create({ labels })` and `restore({ labels })` set boxd machine labels, and `sandboxes.list()` returns them. A new `region` setting (`BOXD_REGION` in the CLI) sends machine, disk and snapshot calls to that boxd region.
