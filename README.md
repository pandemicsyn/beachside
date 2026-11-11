# Beachside

**One SDK. Every sandbox.**

A TypeScript API to create, run code in, and tear down sandboxes on providers like Daytona, E2B, boxd, Boat, Runloop, Freestyle, Archil, exe.dev and Vercel (and more). Keep application workflows consistent while configuring each provider explicitly.

**[Get started →](https://beachside.run/docs/)** · [Run an agent](https://beachside.run/docs/guides/runnable-agent-examples/) · [beachside.run](https://beachside.run/)

## Providers

Each provider is a separately installed adapter, and you can bring your own.

| Provider | Package |
| --- | --- |
| Daytona | `@beachside/daytona` |
| E2B | `@beachside/e2b` |
| boxd (exp) | `@beachside/boxd` |
| Boat (exp) | `@beachside/boat` |
| Runloop (exp) | `@beachside/runloop` |
| Freestyle (exp) | `@beachside/freestyle` |
| Archil (exp) | `@beachside/archil` |
| exe.dev (exp) | `@beachside/exe-dev` |
| Vercel (exp) | `@beachside/vercel` |
| Modal (exp) | `@beachside/modal` |
| Your adapter | [`@beachside/adapter`](https://beachside.run/docs/guides/write-an-adapter/) |

"exp" marks experimental adapters that are less tested. See [Provider support](https://beachside.run/docs/providers/support/) for what each one can do.

## SDK

```sh
npm install beachside @beachside/daytona
```

```ts
import { Beachside, Image } from "beachside";
import { daytonaAdapter } from "@beachside/daytona";

const client = await Beachside.connect({
  adapter: daytonaAdapter,
  credentials: { apiKey: process.env.DAYTONA_API_KEY! },
  config: {
    target: "us",
    environment: Image.prepared("daytona-small"),
    network: "daytona-default",
  },
});

await client.sandboxes.with({}, async (box) => {
  const run = await box.exec(["printf", "ready"]);
  console.log(run.stdoutText());
});

await client.close();
```

Switching providers only changes the `adapter`, `credentials` and `config` you pass to `connect`. Your create, exec, files and destroy calls stay the same. See [Getting started](https://beachside.run/docs/direct-quickstart/) for every provider.

Using a coding agent? `npx skills add pandemicsyn/beachside --skill beachside -g` teaches it the SDK.

## CLI

Same sandboxes, straight from your shell. `beachside` creates, runs in and removes sandboxes on any provider with an adapter. It never prompts for input, every command has a `--json` form, and exit codes clearly indicate what to do next, so your coding agent can drive it as easily as you can.

```sh
npm install -g @beachside/cli
beachside adapter add e2b
```

```sh
export BEACHSIDE_PROVIDER=e2b E2B_API_KEY=...
beachside create --name web
beachside cp ./app.py web:/tmp/app.py
beachside exec web -- python3 /tmp/app.py
beachside ls
beachside rm web
```

Teach your agent to use it with `beachside skill setup`, which installs a skill that always matches the installed CLI. See [Agent skills](https://beachside.run/docs/agents/skills/) for every option. See the [Command line docs](https://beachside.run/docs/cli/).

## Features

- **One API, any provider.** Use common create, exec, files and destroy calls. Choose provider configuration and check its supported capabilities.
- **Plays nice with serverless.** Save references to recover across invocations. Scope sandbox cleanup while keeping snapshots and volumes.
- **Traced end to end.** OpenTelemetry traces connect SDK calls, provider operations, errors, and recovery context. Integrates with Sentry and Datadog. See [Observability](https://beachside.run/docs/observability/).
- **Small adapters.** Wrap any sandbox API with `defineAdapter`. Implement create and destroy to start, then add exec, files and recovery as your provider supports them. See [Writing an adapter](https://beachside.run/docs/guides/write-an-adapter/).

[API reference](https://beachside.run/docs/reference/typescript/) · [Agent skills](https://beachside.run/docs/agents/skills/) · [Roadmap](ROADMAP.md) · [License](LICENSE)
