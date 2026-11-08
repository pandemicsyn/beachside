---
"@beachside/cli": patch
---

`snapshot create` no longer leaves a Daytona snapshot uncertain when the capture outlives the adapter's wait: the CLI sends the pending source restart and records the snapshot. `snapshot rm` and `snapshot inspect` finish such a capture the same way, so an uncertain capture can be deleted. A profile's OCI `config.environment` now follows the same build rule as `--image`: create reuses the recorded `image build` instead of starting another build.
