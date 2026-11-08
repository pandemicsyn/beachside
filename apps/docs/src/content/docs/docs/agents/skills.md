---
title: Agent skills
description: Install Beachside skills so coding agents know how to build with the SDK and drive sandboxes from the shell.
---

Beachside ships three agent skills from its repository: `beachside` and `beachside-cli` in [`skills/`](https://github.com/pandemicsyn/beachside/tree/main/skills), and `add-provider` in [`.agents/skills/`](https://github.com/pandemicsyn/beachside/tree/main/.agents/skills/add-provider). A skill is a `SKILL.md` file that an agent loads when a task needs it, so the guidance stays out of your prompt until it is useful.

| Skill           | Teaches an agent to                                                                                                                                                                                                                                 |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beachside`     | Write application code with `beachside` and a provider adapter: connect, create and clean up sandboxes, run commands, move files, and handle uncertain outcomes without repeating work.                                                             |
| `beachside-cli` | Create, use and remove sandboxes from the shell with the `beachside` command, read its JSON output and exit codes, and clean up after failures.                                                                                                     |
| `add-provider`  | Write a provider adapter with `@beachside/adapter`: verify the account, map the shared setup options, implement create and destroy, test with `adapterSuite`, then package and document it. See [Write an adapter](/docs/guides/write-an-adapter/). |

## Install

Install with the [`skills`](https://github.com/vercel-labs/skills) installer, which supports Claude Code, Codex, Cursor and other agents:

```sh
npx skills add pandemicsyn/beachside --skill beachside -g
npx skills add pandemicsyn/beachside --skill beachside-cli -g
npx skills add pandemicsyn/beachside --skill add-provider
```

`-g` installs the skill for your user. Leave it out to install into the current project instead, so everyone working in the repository gets it; that suits `add-provider`, which belongs in the adapter's repository.

The CLI also carries its own copy of `beachside-cli`, matching its version. `beachside skill install` writes it to `~/.agents/skills` (and `~/.claude/skills` when Claude Code is set up), and `beachside skill install --project` writes it into the current folder. `beachside skill` prints it.

For an agent without a skill system, copy the `SKILL.md` contents into its project or user instructions.

## What the skills do not do

The skills never hold credentials. The SDK skill reads keys from environment variables; the CLI skill uses your existing `beachside.json` profiles and tells the agent to leave configuration to you. Both tell the agent that live sandboxes cost money, to clean up what it creates, and never to retry an operation whose outcome is unknown.

For one-off tasks you can still paste the [SDK prompt](/docs/agents/build-with-sdk/) or the [provider integration prompt](/docs/agents/build-a-provider/) instead.

If you use Pi, the [Beachside Pi extension](/docs/agents/pi/) bundles the SDK and CLI skills and runs Pi’s coding tools in a sandbox.
