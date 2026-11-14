---
"@beachside/cli": patch
---

Prevent macOS tar from adding AppleDouble metadata entries that can break recursive downloads. Directory copies preserve file contents, permission bits and links without host-specific extended metadata.
