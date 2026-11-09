---
title: Run CI jobs
description: Run each CI job in a fresh sandbox with the Beachside CLI, on GitHub Actions or any other CI system.
---

Running CI jobs in sandboxes keeps the runner thin and gives every job a clean, isolated machine that you size on the provider you already use. The CLI is built for this: `run` exits with your command's exit code, streams output live, and destroys the sandbox when the command ends, fails or is cancelled.

## A first workflow

This GitHub Actions job sends the checkout to a new E2B sandbox, runs the tests there and fails the job if they fail:

```yaml
name: test
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    env:
      E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
    steps:
      - uses: actions/checkout@v4
      - uses: pandemicsyn/beachside/actions/setup-beachside@main
        with:
          adapters: e2b
          provider: e2b
      - run: >
          beachside run --push . --network internet
          --timeout 15m --ttl 30m --retry 5m
          --label ci=${{ github.repository_owner }}
          -- sh -c 'npm ci && npm test'
```

`--push .` sends the files git tracks (plus untracked files that are not ignored) and runs the command in that folder, so `node_modules`, `.git` and build output stay on the runner, and the sandbox needs no access to your repository. Any official provider works the same way: change `adapters`, `provider` and the credential variables ([environment-only setup](/docs/cli/configuration/#environment-only-setup) lists them).

Put provider credentials in the job's `env`, as above, rather than on one step. The action's cleanup step runs at the end of the job and needs them too.

## The setup action

`setup-beachside` installs the CLI and your adapters, then removes the sandboxes the job created when the job ends.

| Input       | Default      | What it does                                                                                      |
| ----------- | ------------ | ------------------------------------------------------------------------------------------------- |
| `version`   | `latest`     | CLI version to install. Pin it, for example `0.8.0`, so every run uses the same CLI and adapters. |
| `adapters`  | none         | Provider ids to install, such as `e2b` or `daytona e2b`, at the CLI's version.                    |
| `provider`  | none         | Sets `BEACHSIDE_PROVIDER` for later steps, for jobs without a `beachside.json` profile.           |
| `state-dir` | job temp dir | Where the CLI records sandboxes, images and snapshots. Exported as `BEACHSIDE_STATE_DIR`.         |
| `cleanup`   | `true`       | At the end of the job, even after a failure or cancellation, run `beachside rm --all`.            |

Each job gets its own state folder, so the cleanup step only ever reaches sandboxes that job created, even on a shared self-hosted runner. Cleanup never fails the job; if a removal fails, it shows a warning and the sandbox's lifetime still applies. The action has two outputs, `version` and `state-dir`.

Pin the action itself to a release tag or a commit SHA for reproducible builds, as you would any other action.

## More control: separate steps

When you want results back, such as JUnit reports or coverage, split the job into steps. Steps share the runner's state folder, so later steps reach the sandbox by name:

```yaml
- run: beachside create --name job --network internet --ttl 45m --retry 5m --label ci=${{ github.repository_owner }}
- run: echo "WORK=$(beachside push job)" >> "$GITHUB_ENV"
- run: beachside exec job --cwd "$WORK" --timeout 30m -- sh -c 'npm ci && npm test -- --reporter=junit --outputFile=junit.xml'
- if: always()
  run: beachside cp job:"$WORK"/junit.xml junit.xml
- if: always()
  run: beachside cp -r job:"$WORK"/coverage ./coverage
```

`push` prints the folder it wrote to, by default `work` under the sandbox user's home. `exec` exits with the command's exit code. The setup action removes `job` at the end, so there is no `rm` step; without the action, add `beachside rm job` with `if: always()`.

## Warm bases

Installing dependencies on every job is slow. A cached setup installs them once, saves the result as a snapshot, and later jobs start from it. Put the setup in the repository, keyed on the lockfile:

```json
{
  "setups": {
    "deps": {
      "setup": ["npm ci"],
      "cache": { "files": ["./package-lock.json"] }
    }
  },
  "default": ["deps"]
}
```

Save it as `.beachside/setup.json`, and let the workflow read it:

```yaml
env:
  BEACHSIDE_PROJECT_SETUPS: "1"
steps:
  - uses: actions/checkout@v4
  - uses: pandemicsyn/beachside/actions/setup-beachside@main
    id: beachside
    with:
      adapters: e2b
      provider: e2b
  - uses: actions/cache@v4
    with:
      path: ${{ steps.beachside.outputs.state-dir }}/snapshots
      key: beachside-caches-${{ github.run_id }}
      restore-keys: beachside-caches-
  - run: >
      beachside run --push . --network internet --timeout 15m --ttl 30m --retry 5m
      -- npm test
```

The first job builds the cache: it pushes the checkout, runs `npm ci` in it, snapshots the sandbox, then runs the tests. Later jobs restore that snapshot, push the checkout on top, and go straight to the tests. A lockfile change is a new cache key, so the next job rebuilds it. A cache older than its `maxAge` (7 days by default) is rebuilt too, and the old snapshot is deleted once the new one exists.

The cache records live in the state folder, which starts empty on a hosted runner, so `actions/cache` carries them between jobs. Its key changes every run so the newest records are always saved. On providers that label snapshots (Runloop), a runner with an empty state folder finds the cache by its label, and the `actions/cache` step can go.

Snapshots stay on the provider until deleted, and some providers charge for storage. To prune stale caches, add `beachside setup cache prune` after the `actions/cache` step, so it sees the same records. `beachside setup cache ls` and `setup cache rm <setup>` manage caches by hand. See [Cache a setup](/docs/cli/setup/#cache-a-setup) for the details.

You can still build a base by hand with `beachside snapshot create` and start jobs with `beachside run --snapshot <name>`; keep its record in `actions/cache` the same way.

On E2B and Daytona you can instead build an image into a provider template once, from your machine, and give jobs its id:

```sh
beachside image build node:22 --json | jq -r .data.prepared
```

Save the printed id as a repository variable and start jobs with `beachside run --prepared ${{ vars.BEACHSIDE_BASE }} ...`. This needs no cache, but the image only holds what the OCI image holds, not your installed dependencies.

## Time limits

- `--timeout` is how long the command may run, 5 minutes by default. Raise it for long test suites.
- `--ttl` is how long the provider keeps the sandbox, even if nothing removes it. Keep it longer than `--timeout`, and longer than all steps that use the sandbox. It is the backstop when a runner dies before cleanup can run.
- Set the job's `timeout-minutes` above both, so GitHub doesn't cancel a job that would have finished.

When GitHub cancels a job, `run` destroys its sandbox before exiting, and the setup action's cleanup step removes any others.

## Runners that die

If a runner dies mid-job, neither `run` nor the cleanup step gets to run, and the job's store goes with the runner. The examples above label every sandbox, so a scheduled workflow can collect what's left from the provider's own listing:

```yaml
on:
  schedule: [{ cron: "0 * * * *" }]
jobs:
  sweep:
    runs-on: ubuntu-latest
    env:
      E2B_API_KEY: ${{ secrets.E2B_API_KEY }}
    steps:
      - uses: pandemicsyn/beachside/actions/setup-beachside@main
        with:
          adapters: e2b
          provider: e2b
      - run: beachside gc --label ci=${{ github.repository_owner }} --older-than 2h
```

Set `--older-than` above your longest job so the sweep never removes a sandbox a running job still uses. See [Cleaning up after killed jobs](/docs/cli/#cleaning-up-after-killed-jobs) for what `gc` matches and skips per provider. On every provider, `--ttl` remains the backstop.

## Many jobs at once

Providers limit how many sandboxes you can start, and how fast. `--retry <duration>` on `create` and `run` waits and tries again, with growing waits, while the provider refuses before creating anything (rate limit, no capacity, unavailable). It never retries when the outcome is unknown, so a create is never sent twice. Without `--retry`, those refusals exit 7.

For large matrices, also cap parallel jobs with `strategy.max-parallel` below your provider plan's concurrent sandbox limit.

## Exit codes in CI

`run` and `exec` exit with the remote command's own code, so a failing test fails the step. When the CLI itself fails they exit 125, and a create refused for capacity exits 7. Other commands use the codes in the [command reference](/docs/cli/reference/). Add `--json` to any command for one machine-readable result on stdout.

## Other CI systems

The action is a convenience; the CLI needs only Node.js, npm and credentials in the environment. On GitLab CI, for example:

```yaml
test:
  image: node:22
  variables:
    BEACHSIDE_PROVIDER: e2b
    BEACHSIDE_STATE_DIR: $CI_PROJECT_DIR/.beachside
  script:
    - npm install -g @beachside/cli@0.8.0
    - beachside adapter add e2b
    - beachside run --push . --network internet --timeout 15m --ttl 30m --retry 5m -- sh -c 'npm ci && npm test'
  after_script:
    - beachside rm --all || true
```

Set `E2B_API_KEY` as a masked CI/CD variable. Keep `BEACHSIDE_STATE_DIR` per job, as here, so `rm --all` only reaches that job's sandboxes.
