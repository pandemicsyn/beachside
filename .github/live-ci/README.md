# Live CI

`.github/workflows/live-ci.yml` runs a real CI job on real providers. It is started by hand from
the Actions tab (**Live CI**, then **Run workflow**) and never runs on push or pull requests,
because it creates paid sandboxes.

Each provider job:

1. Builds the CLI and the provider's adapter from the chosen commit and installs them as packed
   tarballs (or, with `cli-version` set, installs that release through `actions/setup-beachside`).
2. Restores the base snapshot record from the Actions cache, keyed on `bun.lock` and
   `prepare.sh`. On a miss it creates a sandbox, pushes the checkout, runs `prepare.sh` (Bun and
   `bun install`) and captures the `live-base` snapshot with `--replace`.
3. Creates the job sandbox from that snapshot, pushes the checkout on top, checks that exit codes
   pass through, then runs `test.sh`: lint, build and the CLI tests.
4. Copies `junit.xml` back and uploads it, removes the job's sandboxes, and runs `gc` on this
   run's label to check nothing was left behind.

It needs these repository secrets: `DAYTONA_API_KEY` and `E2B_API_KEY`, and the repository
variable `DAYTONA_PREPARED`. `DAYTONA_TARGET` defaults to `us`; set a repository variable to change
it.

Daytona has no default image, and building this monorepo needs more than its smallest size, so
build a base image once at 2 vCPU / 4 GiB and save its id as `DAYTONA_PREPARED`:

```sh
cat > /tmp/live.json <<'JSON'
{ "default": "live", "profiles": { "live": { "provider": "daytona",
  "config": { "resources": { "vcpus": 2, "memoryMiB": 4096 } } } } }
JSON
BEACHSIDE_CONFIG=/tmp/live.json beachside image build node:22-bookworm --json | jq -r .data.prepared
```

Daytona jobs use the `daytona-default` network policy, because orgs with limited egress refuse
`internet`; it still reaches GitHub and npm. The Daytona profile sets
`snapshots.restartAfterCapture: false`, since the base sandbox is removed right after capture.

Sandboxes are labelled `ci=beachside-live`, so `beachside gc --label ci=beachside-live --older-than 2h`
sweeps anything a killed runner left. Each provider keeps one `live-base` snapshot between runs;
a dependency change replaces it.
