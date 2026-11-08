---
title: Shell completion and agent skill
description: Turn on tab completion for beachside in zsh, bash or fish, and teach coding agents to use it.
---

## Shell completion

Add one line to your shell's startup file:

```sh
source <(beachside completion zsh)     # ~/.zshrc
source <(beachside completion bash)    # ~/.bashrc
```

For fish, save the script once:

```sh
beachside completion fish > ~/.config/fish/completions/beachside.fish
```

Tab then completes commands, flags, `--provider` ids, `--profile` names from `beachside.json`, and sandbox names:

```sh
beachside exec <tab>          # web  job-1
beachside cp ./app.py <tab>   # web:  job-1:
```

Sandbox names come from the CLI's own list, so pressing tab never calls a provider.

## Agent skill

The CLI carries an agent skill that teaches coding agents how to use it: check the setup first, always use `--json`, prefer `run` for one-off work, read exit codes, never retry an unknown outcome, report results, and clean up.

```sh
beachside skill setup            # for you, in every project
beachside skill setup --project  # for this repository only
```

`setup` writes a short skill to `.agents/skills/beachside-cli/`, read by most agents, and to `.claude/skills/beachside-cli/` when Claude Code is set up. The skill tells the agent to run `beachside skill` and follow the guide it prints, so the guide always matches the installed CLI and upgrading needs no rerun. `beachside skill status` shows each copy as `current`, `outdated`, `missing` or `foreign`, and `beachside skill remove` removes what setup installed. Pass `--agent` to choose agents and `--dry-run` to preview. Setup never replaces a copy you installed another way unless you pass `--force`.

`beachside skill` prints the guide, for agents without a skill system: paste it into their instructions.

The skill can also be installed with `npx skills add pandemicsyn/beachside --skill beachside-cli`. See [Agent skills](/docs/agents/skills/) for the SDK skill as well.
