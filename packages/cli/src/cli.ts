import { parseArgs } from "node:util";
import manifest from "../package.json" with { type: "json" };
import {
  catCommand,
  cpCommand,
  createCommand,
  doctorCommand,
  execCommand,
  Flags,
  adoptCommand,
  inspectCommand,
  lsCommand,
  providersCommand,
  pushCommand,
  rmCommand,
  runCommand,
  shCommand,
  setupCommand,
} from "./commands";
import {
  commandExitCode,
  describeError,
  managementExitCode,
  Output,
  usage,
  type Streams,
} from "./output";
import { Session, type Context } from "./session";
import { imageCommand } from "./images";
import { snapshotCommand } from "./snapshots";
import { skillCommand } from "./skill";
import { adapterCommand } from "./adapters";
import { secretCommand } from "./secret-command";
import { gcCommand } from "./gc";
import { complete, completionCommand, formatCompletion } from "./completion";
import type { Env } from "./config";
import { programStatus } from "./program-status";

type FlagSpec = {
  type: "string" | "boolean";
  multiple?: boolean;
  short?: string;
  value?: string;
  description: string;
};

type CommandSpec = {
  name: string;
  summary: string;
  usage: string;
  flags: Readonly<Record<string, FlagSpec>>;
  /** Accepts a command after `--`. */
  passthrough: boolean;
  /** exec-style commands pass the remote exit code through and use 125 for CLI failures. */
  remoteExit: boolean;
  examples: readonly string[];
  run: (session: Session, flags: Flags) => Promise<number>;
};

const globalFlags = {
  json: {
    type: "boolean",
    description: "Print one JSON document on stdout (also BEACHSIDE_JSON=1)",
  },
  profile: {
    type: "string",
    value: "name",
    description: "Profile from beachside.json (also BEACHSIDE_PROFILE)",
  },
  provider: {
    type: "string",
    value: "id",
    description: "Official provider from environment credentials (also BEACHSIDE_PROVIDER)",
  },
  config: {
    type: "string",
    value: "path",
    description: "Config file (default ~/.config/beachside/beachside.json, also BEACHSIDE_CONFIG)",
  },
  "state-dir": {
    type: "string",
    value: "dir",
    description: "State store folder (default ~/.config/beachside/state, also BEACHSIDE_STATE_DIR)",
  },
  help: { type: "boolean", short: "h", description: "Show help" },
  version: { type: "boolean", short: "V", description: "Print the CLI version" },
} satisfies Record<string, FlagSpec>;

/** Flags that pick what runs in a sandbox after it starts; shared by create, run and setup. */
const setupFlags = {
  setup: {
    type: "string",
    multiple: true,
    value: "name|path",
    description:
      "Run a named setup from beachside.json or a local script once the sandbox starts (repeatable, comma-separated)",
  },
  "setup-cmd": {
    type: "string",
    multiple: true,
    value: "shell",
    description: "Run a shell line as a setup step, after --setup (repeatable)",
  },
  startup: {
    type: "string",
    multiple: true,
    value: "path",
    description:
      "Run a local script every time the sandbox comes up without its processes, such as after a restore (repeatable)",
  },
  "startup-cmd": {
    type: "string",
    multiple: true,
    value: "shell",
    description: "Run a shell line as a startup step (repeatable)",
  },
  "no-default-setup": {
    type: "boolean",
    description: "Skip the setups the profile lists by default",
  },
  "quiet-setup": {
    type: "boolean",
    description: "Show setup step names and failures, not their output",
  },
  "setup-timeout": {
    type: "string",
    value: "duration",
    description: "Overall limit for setup and startup, e.g. 45m (default 30m; each step 10m)",
  },
} satisfies Record<string, FlagSpec>;

/** Setup cache controls; shared by create and run. */
const cacheFlags = {
  cache: {
    type: "boolean",
    description:
      "Cache this setup as a snapshot and restore it next time, even if no named setup asks for it",
  },
  "no-cache": {
    type: "boolean",
    description: "Neither use nor build a setup cache for this sandbox",
  },
  "refresh-cache": {
    type: "boolean",
    description: "Build the setup cache again now, replacing the current one",
  },
} satisfies Record<string, FlagSpec>;

const createFlags = {
  name: {
    type: "string",
    value: "name",
    description: "Store name (default: generated, like sb-1a2b3)",
  },
  image: {
    type: "string",
    value: "oci-ref",
    description: "OCI image, e.g. python:3.12; default is the profile's image",
  },
  prepared: {
    type: "string",
    value: "id",
    description: "Provider-prepared image id (template, snapshot name)",
  },
  network: {
    type: "string",
    value: "policy",
    description: "blocked or internet; default is the profile's policy",
  },
  label: { type: "string", multiple: true, value: "k=v", description: "Label to set (repeatable)" },
  env: {
    type: "string",
    multiple: true,
    value: "K=V",
    description:
      "Environment variable for every command in the sandbox (repeatable; K alone copies it from here)",
  },
  "env-file": {
    type: "string",
    multiple: true,
    value: "path",
    description: "Read K=V lines into the sandbox environment (repeatable; --env wins)",
  },
  secret: {
    type: "string",
    multiple: true,
    value: "K=secret",
    description:
      "Secret for the sandbox env: K=<named secret> or K=<source> (env:, gh:, op://, bws://, pass://); add @<preset|host>[,...] to keep the value out of the sandbox (repeatable)",
  },
  build: {
    type: "boolean",
    description: "Build --image now if this provider needs a build and none is recorded",
  },
  ttl: {
    type: "string",
    value: "duration",
    description:
      "Destroy the sandbox after this long even if nothing removes it, e.g. 30m or 2h; default is the profile's lifetime",
  },
  snapshot: {
    type: "string",
    value: "name",
    description: "Restore a snapshot recorded by `beachside snapshot create` instead of an image",
  },
  retry: {
    type: "string",
    value: "duration",
    description:
      "Keep retrying for up to this long when the provider refuses before creating anything (rate limit, capacity), e.g. 5m",
  },
  ...setupFlags,
  ...cacheFlags,
} satisfies Record<string, FlagSpec>;

const execFlags = {
  cwd: { type: "string", value: "dir", description: "Working directory in the sandbox" },
  env: {
    type: "string",
    multiple: true,
    value: "K=V",
    description: "Environment variable for this command (repeatable; K alone copies it from here)",
  },
  "env-file": {
    type: "string",
    multiple: true,
    value: "path",
    description: "Read K=V lines into this command's environment (repeatable; --env wins)",
  },
  stdin: { type: "boolean", description: "Send this process's stdin to the command" },
  "stdin-file": {
    type: "string",
    value: "path",
    description: "Send a local file as the command's stdin",
  },
  timeout: {
    type: "string",
    value: "duration",
    description: "Execution deadline, e.g. 90s or 10m (default 300s)",
  },
  "max-output": {
    type: "string",
    value: "size",
    description: "Captured output limit for buffered and --json output, e.g. 1m",
  },
  "no-stream": {
    type: "boolean",
    description: "Print the output when the command ends instead of as it arrives",
  },
} satisfies Record<string, FlagSpec>;

const excludeFlag = {
  type: "string",
  multiple: true,
  value: "glob",
  description: "Skip matching paths (repeatable; a pattern without / matches any name)",
} satisfies FlagSpec;

const pushFlags = {
  exclude: excludeFlag,
  "include-ignored": {
    type: "boolean",
    description: "Send every file, not only git-tracked and unignored ones",
  },
} satisfies Record<string, FlagSpec>;

export const commands: readonly CommandSpec[] = [
  {
    name: "create",
    summary: "Create a sandbox and print its name",
    usage:
      "beachside create [--name <name>] [--image <oci-ref> | --prepared <id> | --snapshot <name>] [--network <policy>] [--ttl <duration>] [--env K=V]... [--secret K=secret]... [--setup <name|path>]... [--setup-cmd <shell>]... [--with rex|herdr]...",
    flags: {
      ...createFlags,
      "if-not-exists": {
        type: "boolean",
        description: "Return the named sandbox if it is still alive instead of failing",
      },
      "rm-on-failure": {
        type: "boolean",
        description: "Remove the sandbox if its setup fails, instead of keeping it to look at",
      },
      with: {
        type: "string",
        multiple: true,
        value: "server",
        description:
          "Install and start a server reachable over your tailnet: rex or herdr (repeatable; needs TAILSCALE_AUTH_KEY, implies --network internet)",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside create --name web --network internet",
      "beachside create --name job-42 --if-not-exists --json",
      "beachside create --name ci --env-file .env --env API_TOKEN",
      "beachside create --name agent --network internet --secret ANTHROPIC_API_KEY=op://Dev/anthropic/key@anthropic",
      "beachside create --name agent --network internet --secret GH_TOKEN=github",
      "beachside create --name job-42 --ttl 1h",
      "beachside create --name job-42 --retry 5m --json",
      "beachside create --name web --with rex",
      "beachside create --name web --setup node --setup-cmd 'npm i -g pnpm'",
      "beachside create --name web --setup ./setup.sh --startup-cmd 'pnpm dev > /tmp/dev.log 2>&1 &'",
      "beachside create --name web --setup node --cache",
    ],
    run: createCommand,
  },
  {
    name: "ls",
    summary: "List sandboxes in the store with their current state",
    usage: "beachside ls [--offline | --remote]",
    flags: {
      offline: { type: "boolean", description: "Show stored records without asking providers" },
      remote: {
        type: "boolean",
        description: "List the profile's sandboxes from the provider instead of the store",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["beachside ls", "beachside ls --json", "beachside ls --remote --provider daytona"],
    run: lsCommand,
  },
  {
    name: "adopt",
    summary: "Add a sandbox from the provider's listing to the store so other commands reach it",
    usage: "beachside adopt <id> [--name <name>]",
    flags: {
      name: {
        type: "string",
        value: "name",
        description: "Store name (default: generated, like sb-1a2b3)",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["beachside ls --remote", "beachside adopt 4f1c2a --name worker"],
    run: adoptCommand,
  },
  {
    name: "inspect",
    summary: "Show a sandbox's state, expiry and reference",
    usage: "beachside inspect <sandbox>",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["beachside inspect web --json"],
    run: inspectCommand,
  },
  {
    name: "rm",
    summary: "Destroy sandboxes and remove their records",
    usage: "beachside rm <sandbox>... | --all [--force]",
    flags: {
      all: { type: "boolean", description: "Every sandbox in this store" },
      force: {
        type: "boolean",
        description: "Also destroy sandboxes this CLI did not create, or drop unreachable records",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: ["beachside rm web", "beachside rm --all"],
    run: rmCommand,
  },
  {
    name: "gc",
    summary:
      "Destroy the provider's sandboxes that carry the given labels, such as a killed job's, and prune stale setup caches",
    usage: "beachside gc --label k=v... [--older-than <duration>] [--dry-run]",
    flags: {
      label: {
        type: "string",
        multiple: true,
        value: "k=v",
        description: "Only sandboxes with this label set at create (repeatable; all must match)",
      },
      "older-than": {
        type: "string",
        value: "duration",
        description:
          "Only sandboxes the provider says were created at least this long ago, e.g. 2h",
      },
      "dry-run": {
        type: "boolean",
        description: "List what would be destroyed and change nothing",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside gc --label run=$GITHUB_RUN_ID",
      "beachside gc --label ci=true --older-than 2h --dry-run",
    ],
    run: gcCommand,
  },
  {
    name: "exec",
    summary: "Run a command in a sandbox; exits with the command's exit code",
    usage: "beachside exec <sandbox> [--cwd <dir>] [--env K=V]... [--stdin] -- <command> [args...]",
    flags: execFlags,
    passthrough: true,
    remoteExit: true,
    examples: [
      "beachside exec web -- ls -la /",
      "beachside exec web --cwd /work --env CI=1 -- npm test",
    ],
    run: execCommand,
  },
  {
    name: "sh",
    summary: "Run a shell script in a sandbox; exits with its exit code",
    usage: "beachside sh <sandbox> '<script>' | beachside sh <sandbox> -- '<script>'",
    flags: execFlags,
    passthrough: true,
    remoteExit: true,
    examples: ["beachside sh web 'cd /work && make test'", "beachside sh web -- '-n is fine here'"],
    run: shCommand,
  },
  {
    name: "run",
    summary: "Create a sandbox, run one command, and always destroy it",
    usage:
      "beachside run [create flags] [exec flags] [--keep] [--push <path>] -- <command> [args...]",
    flags: {
      ...createFlags,
      ...execFlags,
      keep: { type: "boolean", description: "Keep the sandbox and print its name on stderr" },
      push: {
        type: "string",
        value: "path",
        description: "Send a local folder to ~/work first and run the command there",
      },
      ...pushFlags,
    },
    passthrough: true,
    remoteExit: true,
    examples: [
      "beachside run -- python3 -c 'print(2 + 2)'",
      "beachside run --network internet -- curl -sI https://example.com",
      "beachside run --push . --timeout 15m --ttl 30m -- sh -c 'npm ci && npm test'",
      "beachside run --push . --setup-cmd 'npm ci' -- npm test",
    ],
    run: runCommand,
  },
  {
    name: "image",
    summary: "Build OCI images for providers that need it, and list, delete or forget the builds",
    usage:
      "beachside image build <oci-ref> [--name <name>] [--refresh] | ls [--remote] | inspect <name> | rm <name> [--force] | forget <name>",
    flags: {
      name: {
        type: "string",
        value: "name",
        description: "Record name for a build (default: from the reference, like python-3-12)",
      },
      refresh: { type: "boolean", description: "Build again even if this reference is recorded" },
      remote: {
        type: "boolean",
        description: "List the images on the provider for this profile, not the local records",
      },
      force: {
        type: "boolean",
        description: "Delete a recorded image this CLI did not verifiably create",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside image build python:3.12 --provider e2b",
      "beachside create --image python:3.12 --provider e2b",
      "beachside image ls",
      "beachside image ls --remote --provider e2b",
      "beachside image rm python-3-12",
      "beachside image forget python-3-12",
    ],
    run: imageCommand,
  },
  {
    name: "snapshot",
    summary: "Capture a sandbox as a snapshot, and list, inspect, delete or forget snapshots",
    usage:
      "beachside snapshot create <sandbox> [--name <name> [--replace]] | ls [--remote] | inspect <name> | rm <name> [--force] | forget <name>",
    flags: {
      name: {
        type: "string",
        value: "name",
        description: "Record name for a capture (default: <sandbox>-snap)",
      },
      replace: {
        type: "boolean",
        description: "Capture --name again; the old snapshot is deleted once the new one exists",
      },
      remote: {
        type: "boolean",
        description: "List the snapshots on the provider for this profile, not the local records",
      },
      force: {
        type: "boolean",
        description: "Delete a recorded snapshot this CLI did not verifiably capture",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside snapshot create web --name deps",
      "beachside create --snapshot deps --name web-2",
      "beachside run --snapshot deps -- npm test",
      "beachside snapshot create web --name deps --replace",
      "beachside snapshot ls",
      "beachside snapshot rm deps",
    ],
    run: snapshotCommand,
  },
  {
    name: "setup",
    summary: "Run setup in an existing sandbox, or list the named setups",
    usage:
      "beachside setup <sandbox> [--setup <name|path>]... [--setup-cmd <shell>]... [--force] | setup ls | setup cache ls|rm <setup>|prune [--dry-run]",
    flags: {
      ...setupFlags,
      force: {
        type: "boolean",
        description: "Run every step, even ones the sandbox already has",
      },
      "dry-run": {
        type: "boolean",
        description: "setup cache rm and prune: list what would be deleted and change nothing",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside setup ls",
      "beachside setup web",
      "beachside setup web --setup playwright",
      "beachside setup web --setup node --force",
      "beachside setup cache ls",
      "beachside setup cache rm node",
      "beachside setup cache prune --dry-run",
    ],
    run: setupCommand,
  },
  {
    name: "cp",
    summary: "Copy files or directories to or from a sandbox",
    usage: "beachside cp [-r] <src> <dst>   (one side is <sandbox>:/path)",
    flags: {
      "no-clobber": {
        type: "boolean",
        description: "Fail instead of overwriting an existing file",
      },
      recursive: {
        type: "boolean",
        short: "r",
        description: "Copy directories as one tar archive (needs tar in the sandbox)",
      },
      exclude: excludeFlag,
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside cp ./app.py web:/work/app.py",
      "beachside cp web:/work/out.json ./out.json",
      "beachside cp -r ./src web:/work --exclude node_modules",
      "beachside cp -r web:/work/coverage ./coverage",
    ],
    run: cpCommand,
  },
  {
    name: "push",
    summary: "Send a local folder's git-tracked and unignored files into a sandbox",
    usage: "beachside push <sandbox>[:/dir] [path]   (default: . to ~/work in the sandbox)",
    flags: pushFlags,
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside push ci",
      "beachside push ci:/srv/app ./app --exclude '*.log'",
      "beachside exec ci --cwd /srv/app -- npm test",
    ],
    run: pushCommand,
  },
  {
    name: "cat",
    summary: "Print a file from a sandbox",
    usage: "beachside cat <sandbox>:/path",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["beachside cat web:/etc/os-release"],
    run: catCommand,
  },
  {
    name: "doctor",
    summary: "Check config, credentials and the provider connection without creating anything",
    usage: "beachside doctor",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["beachside doctor --provider e2b"],
    run: doctorCommand,
  },
  {
    name: "adapter",
    summary: "Install, list or remove the adapters the CLI loads, in ~/.config/beachside/adapters",
    usage: "beachside adapter add <provider|package>[@version]... | ls | rm <provider|package>...",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside adapter add e2b",
      "beachside adapter add daytona vercel --json",
      "beachside adapter add @acme/beachside-adapter@1.2.0",
      "beachside adapter ls",
      "beachside adapter rm e2b",
    ],
    run: adapterCommand,
  },
  {
    name: "secret",
    summary: "List the named secrets in beachside.json and the sandboxes using them, never values",
    usage: "beachside secret ls",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["beachside secret ls", "beachside secret ls --json"],
    run: secretCommand,
  },
  {
    name: "providers",
    summary:
      "List official providers, whether their adapter is installed and their credentials set",
    usage: "beachside providers",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: ["beachside providers --json"],
    run: providersCommand,
  },
  {
    name: "skill",
    summary: "Print the agent skill for this CLI, or set it up for your coding agents",
    usage: "beachside skill [show | setup | status | remove] [--agent <name>]... [--project]",
    flags: {
      agent: {
        type: "string",
        multiple: true,
        value: "name",
        description:
          "Only this agent: claude, codex, opencode or pi (repeatable; default: detected agents)",
      },
      project: {
        type: "boolean",
        description: "Use this folder's .agents/skills (and .claude/skills) instead of your home",
      },
      "dry-run": {
        type: "boolean",
        description: "Report what setup or remove would change without changing anything",
      },
      force: {
        type: "boolean",
        description: "Let setup replace a beachside-cli skill that beachside did not install",
      },
    },
    passthrough: false,
    remoteExit: false,
    examples: [
      "beachside skill",
      "beachside skill setup",
      "beachside skill setup --project --dry-run",
      "beachside skill status --json",
      "beachside skill remove --agent claude",
    ],
    run: skillCommand,
  },
  {
    name: "completion",
    summary: "Print a shell completion script for zsh, bash or fish",
    usage: "beachside completion <zsh|bash|fish>",
    flags: {},
    passthrough: false,
    remoteExit: false,
    examples: [
      "source <(beachside completion zsh)   # in ~/.zshrc",
      "source <(beachside completion bash)  # in ~/.bashrc",
      "beachside completion fish > ~/.config/fish/completions/beachside.fish",
    ],
    run: completionCommand,
  },
];

export const exitCodes = [
  { code: 0, meaning: "success" },
  { code: 1, meaning: "other failure" },
  { code: 2, meaning: "usage error; fix the command" },
  { code: 3, meaning: "not found" },
  {
    code: 4,
    meaning:
      "unsupported by this provider or profile, adapter missing or broken, npm or a password-manager CLI not installed, or store limit reached",
  },
  {
    code: 5,
    meaning: "authentication or permission failure, or an unreadable password-manager secret",
  },
  { code: 6, meaning: "outcome unknown: an effect may have happened, inspect before retrying" },
  { code: 7, meaning: "retryable: rate limit, capacity or unavailable before any effect" },
  { code: 8, meaning: "partial: some steps were confirmed; read error.known" },
  {
    code: 9,
    meaning:
      "setup failed: a setup or startup step exited nonzero or timed out; error.known.sandbox names the sandbox if it was kept",
  },
  { code: 125, meaning: "exec/run: the CLI or provider failed; details in the error" },
  {
    code: 130,
    meaning:
      "interrupted by SIGINT (129 for SIGHUP, 143 for SIGTERM); an interrupted run still destroys its sandbox",
  },
];

function schema() {
  return {
    version: 1,
    cliVersion: manifest.version,
    globalFlags,
    commands: commands.map(({ run: _run, ...spec }) => spec),
    exitCodes,
    output: {
      json: "With --json, stdout holds exactly one document: {ok:true,data} or {ok:false,error:{code,message,retryable,outcome,hint?,known?,details?}}",
      exec: "exec, sh and run exit with the remote command's exit code; their JSON data is {exitCode,stdout,stderr,truncated}, and run adds sandbox {name,id,kept}. Without --json, output streams as it arrives where the provider supports it",
    },
  };
}

function flagLines(flags: Readonly<Record<string, FlagSpec>>): string[] {
  return Object.entries(flags).map(([name, spec]) => {
    const label = `${spec.short ? `-${spec.short}, ` : ""}--${name}${spec.value ? ` <${spec.value}>` : ""}`;

    return `  ${label.padEnd(26)} ${spec.description}`;
  });
}

function topHelp(): string {
  return [
    "beachside: create and manage sandboxes on any Beachside provider",
    "",
    "Usage: beachside <command> [flags]",
    "",
    "Commands:",
    ...commands.map((command) => `  ${command.name.padEnd(10)} ${command.summary}`),
    "  schema     Print a machine-readable description of every command",
    "",
    "Global flags:",
    ...flagLines(globalFlags),
    "",
    "Quick start:",
    "  beachside adapter add e2b",
    "  export BEACHSIDE_PROVIDER=e2b E2B_API_KEY=...",
    "  beachside create --name web",
    "  beachside exec web -- uname -a",
    "  beachside rm web",
    "  beachside run -- python3 -c 'print(2 + 2)'   # create, run, destroy",
    "",
    "Run `beachside <command> --help` for details, `beachside schema` for JSON.",
  ].join("\n");
}

function commandHelp(command: CommandSpec): string {
  return [
    command.summary,
    "",
    `Usage: ${command.usage}`,
    ...(Object.keys(command.flags).length ? ["", "Flags:", ...flagLines(command.flags)] : []),
    "",
    "Examples:",
    ...command.examples.map((example) => `  ${example}`),
  ].join("\n");
}

/** One node:util parseArgs option; optional keys stay absent rather than undefined. */
type ParseOption = { type: "string" | "boolean"; multiple?: boolean; short?: string };

function parseOption(spec: FlagSpec): ParseOption {
  const option: ParseOption = { type: spec.type };

  if (spec.multiple) option.multiple = true;

  if (spec.short) option.short = spec.short;

  return option;
}

/** The command is the first argument that is neither a flag nor a global flag's value. */
function commandIndex(head: readonly string[]): number {
  for (let index = 0; index < head.length; index++) {
    const arg = head[index]!;

    if (!arg.startsWith("-")) return index;

    const spec = Object.entries(globalFlags).find(([flag]) => flag === arg.slice(2))?.[1];

    if (spec?.type === "string" && !arg.includes("=")) index++;
  }

  return -1;
}

export type Io = {
  env: Env;
  cwd: string;
  streams: Streams;
  /** Whether stderr is a terminal; terminal tab status (OSC 7501) is only written to one. */
  stderrTerminal?: boolean;
  signal: AbortSignal;
  /** The CLI's own stdin, read as it arrives. */
  stdin: () => AsyncIterable<Uint8Array>;
};

/** The shell scripts from `beachside completion` call `beachside __complete -- <words>`. */
async function completeWords(words: readonly string[], io: Io): Promise<number> {
  const flagValue = (name: string) => {
    const index = words.indexOf(`--${name}`);

    return index === -1 ? undefined : words[index + 1];
  };

  const session = new Session({
    env: io.env,
    cwd: io.cwd,
    out: new Output(false, io.streams),
    signal: io.signal,
    stdin: io.stdin,
    flags: { json: false, config: flagValue("config"), stateDir: flagValue("state-dir") },
  });

  try {
    io.streams.stdout(formatCompletion(await complete(words, commands, globalFlags, session)));
  } catch {
    io.streams.stdout(":0\n");
  }

  return 0;
}

/** Commands that create, change or wait on sandboxes report tab status; quick reads stay quiet. */
const statusCommands = new Set(["create", "adopt", "rm", "gc", "exec", "sh", "run", "cp", "push"]);

const statusSubcommands = new Set(["image build", "image rm", "snapshot create", "snapshot rm"]);

/** A short label for the tab, such as "beachside exec web" or "beachside image build". */
function statusTitle(name: string, flags: Flags): string | undefined {
  const [first, second] = flags.positionals;

  if (statusSubcommands.has(`${name} ${first}`))
    return ["beachside", name, first, second].filter(Boolean).join(" ");

  if (!statusCommands.has(name)) return undefined;

  const target = name === "create" ? flags.string("name") : first;

  return ["beachside", name, target].filter(Boolean).join(" ");
}

/** Commands that notify when they finish after a long run. */
const notifyCommands = new Set(["run", "exec", "sh"]);

/** Seconds before a finished command notifies; `BEACHSIDE_NOTIFY_AFTER` overrides, `off` stops it. */
function notifyAfter(name: string, env: Io["env"]): number | undefined {
  if (!notifyCommands.has(name)) return undefined;
  const setting = env.BEACHSIDE_NOTIFY_AFTER?.trim().toLowerCase();

  if (setting === "off") return undefined;
  const seconds = setting ? Number(setting) : 30;

  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : 30_000;
}

function exitMessage(code: number): string {
  return code === 0 ? "done" : `exit code ${code}`;
}

/** Run one CLI invocation and return its exit code. */
export async function main(argv: readonly string[], io: Io): Promise<number> {
  if (argv[0] === "__complete") return completeWords(argv.slice(argv[1] === "--" ? 2 : 1), io);

  const separator = argv.indexOf("--");
  const head = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? null : argv.slice(separator + 1);
  const nameIndex = commandIndex(head);
  const name = nameIndex === -1 ? undefined : head[nameIndex];
  const jsonFromEnv = io.env.BEACHSIDE_JSON === "1" || io.env.BEACHSIDE_JSON === "true";
  const status = programStatus(io.env, io.stderrTerminal === true, io.streams.stderr);
  const out = new Output(jsonFromEnv || head.includes("--json"), io.streams, status);
  const command = commands.find((candidate) => candidate.name === name);

  try {
    if (!name && (head.includes("--version") || head.includes("-V"))) {
      out.success({ version: manifest.version }, manifest.version);

      return 0;
    }

    if (!name) {
      out.streams.stdout(`${topHelp()}\n`);

      return head.includes("--help") || head.includes("-h") ? 0 : 2;
    }

    if (name === "schema") {
      out.streams.stdout(`${JSON.stringify(schema(), null, 2)}\n`);

      return 0;
    }

    if (name === "help") {
      const topic = commands.find((candidate) => candidate.name === head[1]);
      out.streams.stdout(`${topic ? commandHelp(topic) : topHelp()}\n`);

      return 0;
    }

    if (!command) {
      const close = commands.find((candidate) => candidate.name.startsWith(name.slice(0, 2)));

      throw usage(
        `Unknown command ${name}`,
        close ? `did you mean \`beachside ${close.name}\`?` : "run `beachside --help`",
      );
    }

    if (rest && !command.passthrough)
      throw usage(`${command.name} does not take a command after --`);
    const options = { ...globalFlags, ...command.flags };
    let parsed: ReturnType<typeof parseArgs>;

    try {
      parsed = parseArgs({
        args: head.filter((_, index) => index !== nameIndex),
        options: Object.fromEntries(
          Object.entries(options).map(([flag, spec]) => [flag, parseOption(spec)]),
        ),
        allowPositionals: true,
        strict: true,
      });
    } catch (cause) {
      const known = Object.keys(options).map((flag) => `--${flag}`);

      throw usage(
        cause instanceof Error ? cause.message.split("\n")[0]! : String(cause),
        `${command.name} accepts: ${known.join(" ")}`,
      );
    }

    const flags = new Flags(parsed.values, parsed.positionals, rest);

    if (flags.bool("help")) {
      out.streams.stdout(`${commandHelp(command)}\n`);

      return 0;
    }

    const context: Context = {
      env: io.env,
      cwd: io.cwd,
      out,
      signal: io.signal,
      stdin: io.stdin,
      flags: {
        json: out.json,
        profile: flags.string("profile"),
        provider: flags.string("provider"),
        config: flags.string("config"),
        stateDir: flags.string("state-dir"),
      },
    };

    const session = new Session(context);
    const title = statusTitle(command.name, flags);

    const notifyMs = title ? notifyAfter(command.name, io.env) : undefined;
    const started = Date.now();

    /** Report the final state, and notify when a long command finishes. */
    const finish = (state: "done" | "error", message: string) => {
      if (!title) return;
      status.report(state, message);

      if (notifyMs !== undefined && Date.now() - started >= notifyMs)
        status.notify(state === "done" ? "beachside: done" : "beachside: failed", message);
    };

    try {
      if (title) status.report("working", title);
      const code = await command.run(session, flags);

      finish(code === 0 ? "done" : "error", `${title}: ${exitMessage(code)}`);

      return code;
    } catch (cause) {
      finish("error", `${title}: ${describeError(cause).message}`);
      throw cause;
    } finally {
      await session.close();
    }
  } catch (cause) {
    const report = describeError(cause);
    out.failure(report);

    return command?.remoteExit ? commandExitCode() : managementExitCode(report);
  }
}
