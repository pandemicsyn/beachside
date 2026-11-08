# Beachside

**[Read the docs →](https://beachside.run/docs/)**

Beachside is a TypeScript SDK for creating sandboxes, running commands, and moving files across providers. Daytona, E2B, boxd, Boat, Runloop, Freestyle and Vercel are separately installed adapters; custom providers use the same adapter API. Run it in Node.js or Bun.

Create a sandbox, run a command, and clean up:

```ts
import { Image, Beachside } from "beachside";
import { e2bAdapter } from "@beachside/e2b";

const apiKey = process.env.E2B_API_KEY;

if (!apiKey) throw new Error("Set E2B_API_KEY before running this example");

const beachside = await Beachside.connect({
  adapter: e2bAdapter,
  credentials: { apiKey },
  config: {},
});

try {
  const box = await beachside.sandboxes.create({
    environment: Image.prepared("base"),
    network: "blocked",
  });

  try {
    const output = await box.exec(["printf", "Hello from Beachside!\n"]);
    console.log(output.stdoutText());
  } finally {
    await box.destroy();
  }
} finally {
  await beachside.close();
}
```

Install with `npm install beachside @beachside/e2b` and set `E2B_API_KEY` to run this example. See [Getting started](https://beachside.run/docs/direct-quickstart/) for other providers.

Using a coding agent? `npx skills add pandemicsyn/beachside --skill beachside -g` teaches it the SDK; see [Agent skills](https://beachside.run/docs/agents/skills/).

[Vercel setup and limits](https://beachside.run/docs/providers/vercel/) · [Provider support](https://beachside.run/docs/providers/support/) · [API reference](https://beachside.run/docs/reference/typescript/) · [Roadmap](ROADMAP.md) · [License](LICENSE)

Repository validation and release rehearsal coverage are documented in [CI.md](CI.md).
