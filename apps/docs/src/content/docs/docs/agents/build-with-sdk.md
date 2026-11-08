---
title: Build with the SDK
description: A copyable prompt to get your coding agent building an application with Beachside.
---

Replace the bracketed fields, then copy the prompt into your coding agent. Give it access to your project and the Beachside documentation. Provider credentials belong in your environment, not in the prompt.

```text wrap title="Application prompt"
Build [describe the feature] in this project using the Beachside TypeScript SDK.
Use [Daytona, E2B, boxd or Vercel] as the sandbox provider.
Read that provider's setup guide and supported operations before choosing a workflow.

Read these docs first:
- https://beachside.run/docs/direct-quickstart/
- https://beachside.run/docs/providers/support/
- https://beachside.run/docs/reference/typescript/
- https://beachside.run/docs/guides/recovery/
- https://beachside.run/docs/guides/runnable-agent-examples/
- https://github.com/pandemicsyn/beachside/blob/main/examples/README.md

Inspect the project and installed package versions before changing code.
Install "beachside" and the selected adapter package from npm. Do not
substitute the unrelated npm package named "beachside".

Use Beachside and Image from "beachside", and the adapter definition from
the selected package: e2bAdapter from "@beachside/e2b", daytonaAdapter from
"@beachside/daytona", boxdAdapter from "@beachside/boxd", or vercelAdapter
from "@beachside/vercel". Connect with
Beachside.connect({ adapter, credentials, config }) for every provider.
Run the SDK on the server and read credentials from environment variables.

Start from an existing prepared image. E2B can use the "base" template;
use /home/user for E2B file examples. For Daytona, use an active Linux
snapshot in the verified region and configure "daytona-default" at connection
setup unless strict blocked networking is explicitly required and supported. Do not treat provider-default access as isolation.

Vercel defaults to disposable Node 24 in iad1 with blocked networking. It supports
bounded byte output and overwrite-only files, without stdin, process streams,
snapshots or volumes; cleanup stops compute and retains named metadata.
boxd requires an explicit internet policy and also requires overwrite:true.
Neither provider inherits Daytona/E2B streaming or storage guarantees.

Use argument arrays for commands. Use the explicit shell form only when
shell syntax is needed. Preserve byte output, check truncation, and handle
nonzero exits. Keep files and captured output within the documented bounds.

Destroy each owned sandbox in a finally block and close the client in an
outer finally block. Closing a client or aborting a wait does not stop
compute. Save recovery references for uncertain operations and observe
them without resubmitting the mutation.

Implement the feature with focused tests using deterministic fixtures.
Before live provider calls or image builds, get approval for the exact
resource budget and cleanup plan. Never log keys or recovery references.

Finish by explaining what changed, how to run it, which checks passed,
and any provider limitations or behavior that remains untested.
```

Need a new provider rather than an application? Use the [provider integration prompt](/docs/agents/build-a-provider/).
