---
title: Setup and startup
description: Run setup steps when a sandbox is created, startup steps whenever it comes up, and reuse named setups across providers.
---

Pass `setup` to `create()` and Beachside runs those steps in the new sandbox before `create()` returns. Steps go through the adapter's exec, so the same setup works on every provider that runs commands.

```ts
import { Setup } from "beachside";

const box = await beachside.sandboxes.create({
  network: "internet",
  setup: [
    "curl -fsSL https://get.pnpm.io/install.sh | sh -",
    ["git", "clone", "--depth=1", "https://github.com/acme/app", "app"],
    Setup.file("./scripts/install.sh"),
    { run: "pnpm install", cwd: "app", name: "install deps" },
  ],
});
```

A step is one of:

- a shell line: `"pnpm install"`
- an argv array, run without a shell: `["make", "deps"]`
- `Setup.file(path)`: a local script, uploaded and run with its shebang (`sh` when it has none)
- an object with exactly one of `run`, `script` (inline text) or `file`, plus any of:
  - `name`: shown in progress and errors
  - `cwd`: created if missing; relative paths start at the sandbox user's home
  - `env`: for this step only
  - `stdin`: text sent to the step's stdin, such as a secret the step should not see in its env
  - `timeoutSeconds`: default 600, at most 3600
  - `user: "root"`: runs with `sudo -n -E` where the default user is not root
  - `cache: false`: always runs, even when the sandbox already has it

`Setup.parallel([stepA, stepB], { name })` runs steps at the same time as one setup step. The group finishes when all of them have. If any fails, it throws once the others have finished. It counts as one step for skipping and digests, and is for `setup` only. Progress events and output for its steps carry `step.group`.

`sandboxes.with()` takes the same keys.

## Progress and failures

```ts
const box = await beachside.sandboxes.create({
  setup: ["npm ci"],
  onSetupStep: (event) => console.error(event.type, event.phase, event.step?.name),
  onSetupOutput: (chunk) => process.stderr.write(chunk.text),
  setupTimeoutSeconds: 1200,
});

console.log(box.setupReport); // { digest, setup: [{ name, status, exitCode, seconds }], startup }
```

Output streams live where the adapter streams exec output, and arrives per step elsewhere. A step that exits nonzero, times out or loses contact throws `SetupFailedError` (`code: "SETUP_FAILED"`), with `phase`, `step`, `exitCode`, `stdoutTail` and `stderrTail`. By default the new sandbox is destroyed first. With `onSetupFailure: "keep"` it stays running and the error carries it as `error.sandbox`.

The whole setup plus startup has 1800 seconds unless `setupTimeoutSeconds` says otherwise.

## Startup

`startup` steps run after setup, and again whenever the sandbox comes up without its processes: after `restore()` and after a `resume()` that started fresh. Use them for servers and daemons.

```ts
const box = await beachside.sandboxes.create({
  setup: ["npm ci"],
  startup: ["npm run dev > /tmp/dev.log 2>&1 &"],
});

const snapshot = await box.snapshot();
const copy = await snapshot.restore(); // runs `npm run dev` again
```

The sandbox records its startup steps in `~/.beachside/setup/`, so the record travels with snapshots. A `restore()` that passes `startup` runs those instead. `recordedStartup: "skip"` runs none of the recorded ones. Startup steps cannot use `stdin`.

## Named setups

`Setup.define()` names a setup so it can be shared and composed:

```ts
const node = Setup.define({
  name: "node",
  setup: ["curl -fsSL https://fnm.vercel.app/install | bash", "fnm install 22"],
});

const web = Setup.define({
  name: "web",
  extends: [node],
  setup: [{ run: "pnpm install", cwd: "app" }],
  startup: ["pnpm --dir app dev > /tmp/dev.log 2>&1 &"],
});

await beachside.sandboxes.create({ setup: [web, "pnpm build"] });
```

A setup reached twice runs once.

## Run setup on an existing sandbox

```ts
const report = await box.runSetup({ setup: [web, "npx playwright install"] });
```

`runSetup()` compares the steps with what the sandbox recorded. Steps it already ran, in the same order, are skipped, so running a longer list only runs what is new. `force: true` runs everything. A failure keeps the sandbox. Pass `env` to give every step the same environment without making it part of the digest.

Each sandbox records a digest of its steps: their kind, text, arguments, working folder, user and env names. Env values and stdin are never part of it, so a rotated token keeps the same digest. `Setup.digest(steps)` computes the same value locally, and `box.setupReport.digest` holds the sandbox's.

## Where setup is refused

Setup needs exec. On an adapter without it, `create({ setup })` fails with `UNSUPPORTED` before anything is created. `submitCreate()` and `submitRestore()` do not run setup; once the sandbox is ready, call `box.runSetup()`.

From the command line, `--setup`, `--setup-cmd`, `--startup-cmd` and `setups` in `beachside.json` do the same; see [Set up a sandbox](/docs/cli/setup/).
