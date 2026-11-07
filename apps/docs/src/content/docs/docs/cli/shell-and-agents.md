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

The CLI carries an agent skill that teaches coding agents how to use it: check the setup first, always use `--json`, prefer `run` for one-off work, read exit codes, never retry an unknown outcome, and clean up. The skill always matches the installed CLI version.

```sh
beachside skill install            # for you, in every project
beachside skill install --project  # for this repository only
```

`install` writes the skill to `.agents/skills/beachside-cli/`, read by most agents, and to `.claude/skills/beachside-cli/` when Claude Code is set up. Run it again after upgrading the CLI to update the skill. It never replaces a copy you installed another way.

`beachside skill` prints the skill, for agents without a skill system: paste it into their instructions.

The skill can also be installed with `npx skills add pandemicsyn/beachside --skill beachside-cli`. See [Agent skills](/docs/agents/skills/) for the SDK skill as well.
