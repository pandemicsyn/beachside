import { access, readFile, rm, rmdir, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
// The guide ships inside the CLI so `beachside skill` always describes this version's commands.
import bundled from "../../../skills/beachside-cli/SKILL.md" with { type: "text" };
import type { Flags } from "./commands";
import { CliError, usage } from "./output";
import type { Session } from "./session";

export const skillName = "beachside-cli";

export const skillActions = ["show", "setup", "install", "status", "remove"] as const;

export const skillAgents = ["claude", "codex", "opencode", "pi"] as const;

type Agent = (typeof skillAgents)[number];

/** Marks a copy this command wrote, so a later setup may replace or remove it and nothing else. */
const marker =
  "<!-- Installed by `beachside skill setup`; remove it with `beachside skill remove`. -->";

/** Older CLIs wrote the whole guide with this marker; they still count as ours. */
const legacyMarker =
  "<!-- Installed by `beachside skill install`; rerun it to update this file. -->";

/** Bump when the stub's wording changes, so `status` reports older stubs as outdated. */
const stubVersion = "1";

function bundledDescription(): string {
  const line = bundled.split("\n").find((entry) => entry.startsWith("description: "));

  if (!line) throw new Error("The bundled beachside-cli skill has no description");

  return line.slice("description: ".length);
}

/**
 * The installed skill is a short stub: the agent reads the guide from the installed CLI, so
 * upgrading the CLI updates what agents are told without rerunning setup.
 */
export function stubSkill(): string {
  return `---
name: ${skillName}
description: ${bundledDescription()}
metadata:
  beachside-stub: "${stubVersion}"
---
${marker}

Run \`beachside skill\` and follow the guide it prints. The guide comes from the installed
beachside CLI, so it describes the commands and flags of that version.

If \`beachside\` is not on PATH, stop and tell the user; do not install it yourself. If the
command fails for another reason, start with \`beachside doctor --json\`, then use
\`beachside schema\` and \`beachside <command> --help\`.
`;
}

/** Where a skill lands: Claude Code's own folder, or the shared `.agents/skills` most agents read. */
type Location = {
  name: "claude" | "shared";
  agents: Agent[];
  path: string;
  detected: boolean;
};

type State = "current" | "outdated" | "missing" | "foreign" | "unreadable";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

async function anyExists(paths: string[]): Promise<boolean> {
  const found = await Promise.all(paths.map((path) => exists(path)));

  return found.includes(true);
}

/**
 * Agents are detected by their config folders only, so the result never depends on what happens to
 * be on PATH. `--agent` sets up an agent that is not detected.
 */
async function locations(
  session: Session,
  project: boolean,
): Promise<{ claude: Location; shared: Location }> {
  const { env, cwd } = session.ctx;
  const home = env.HOME || homedir();
  const base = project ? cwd : home;
  const claudeDir = project ? join(cwd, ".claude") : env.CLAUDE_CONFIG_DIR || join(home, ".claude");

  const otherConfig = project
    ? [join(cwd, ".codex"), join(cwd, ".opencode"), join(cwd, ".pi")]
    : [
        env.CODEX_HOME || join(home, ".codex"),
        join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode"),
        join(home, ".pi"),
      ];

  return {
    claude: {
      name: "claude",
      agents: ["claude"],
      path: join(claudeDir, "skills", skillName, "SKILL.md"),
      detected: await exists(claudeDir),
    },
    shared: {
      name: "shared",
      agents: ["codex", "opencode", "pi"],
      path: join(base, ".agents", "skills", skillName, "SKILL.md"),
      detected: await anyExists(otherConfig),
    },
  };
}

function requestedAgents(flags: Flags): Agent[] {
  const names = flags.strings("agent");

  for (const name of names)
    if (!skillAgents.some((agent) => agent === name))
      throw usage(`Unknown agent "${name}"`, `use one of: ${skillAgents.join(", ")}`);

  return skillAgents.filter((agent) => names.includes(agent));
}

/**
 * Without `--agent`, setup writes the shared folder (read by most agents, even undetected ones) and
 * Claude Code's folder when Claude Code is set up. With `--agent`, only the named agents' folders.
 */
function chosen(all: { claude: Location; shared: Location }, agents: Agent[]): Location[] {
  if (agents.length === 0) return all.claude.detected ? [all.shared, all.claude] : [all.shared];

  return [all.shared, all.claude].filter((location) =>
    location.agents.some((agent) => agents.includes(agent)),
  );
}

async function readState(path: string): Promise<{ state: State; current: string | null }> {
  let current: string;

  try {
    current = await readFile(path, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { state: "missing", current: null };

    return { state: "unreadable", current: null };
  }

  if (current === stubSkill()) return { state: "current", current };

  if (current.includes(marker) || current.includes(legacyMarker))
    return { state: "outdated", current };

  return { state: "foreign", current };
}

type Entry = {
  location: Location["name"];
  agents: Agent[];
  path: string;
  result: string;
  reason?: string;
};

function entry(location: Location, result: string, reason?: string): Entry {
  const item: Entry = {
    location: location.name,
    agents: location.agents,
    path: location.path,
    result,
  };

  if (reason) item.reason = reason;

  return item;
}

const foreignReason =
  "a skill named beachside-cli that beachside did not install is there; pass --force to replace it";

async function setupAt(location: Location, force: boolean, dryRun: boolean): Promise<Entry> {
  const { state } = await readState(location.path);

  if (state === "current") return entry(location, "unchanged");

  if (state === "unreadable")
    return entry(location, "skipped", "the file could not be read; fix its permissions and rerun");

  if (state === "foreign" && !force) return entry(location, "skipped", foreignReason);

  if (!dryRun) {
    await mkdir(dirname(location.path), { recursive: true });
    await writeFile(location.path, stubSkill());
  }

  const result = { missing: "written", outdated: "updated", foreign: "replaced" }[state];

  return entry(location, result);
}

async function removeAt(location: Location, dryRun: boolean): Promise<Entry> {
  const { state } = await readState(location.path);

  if (state === "missing") return entry(location, "missing");

  if (state === "foreign")
    return entry(location, "skipped", "beachside did not install this copy; it was left alone");

  if (state === "unreadable") return entry(location, "skipped", "the file could not be read");

  if (!dryRun) {
    await rm(location.path);
    // The folder held only this file; leave it if someone added anything else.
    await rmdir(dirname(location.path)).catch(() => undefined);
  }

  return entry(location, "removed");
}

function report(
  session: Session,
  key: "installed" | "removed",
  entries: Entry[],
  dryRun: boolean,
): void {
  const { out } = session.ctx;
  const prefix = dryRun ? "would be " : "";

  for (const item of entries) if (item.reason) out.note(`skipped ${item.path}: ${item.reason}`);

  out.success(
    { name: skillName, [key]: entries, dryRun },
    entries
      .flatMap((item) =>
        item.result === "skipped"
          ? []
          : [`${(prefix + item.result).padEnd(dryRun ? 18 : 9)} ${item.path}`],
      )
      .join("\n"),
  );
}

export async function skillCommand(session: Session, flags: Flags): Promise<number> {
  const [action = "show", ...extra] = flags.positionals;
  const { out } = session.ctx;

  if (extra.length || !skillActions.some((name) => name === action))
    throw usage("Usage: beachside skill [show | setup | status | remove]");

  const project = flags.bool("project");
  const dryRun = flags.bool("dry-run");
  const force = flags.bool("force");
  const agents = requestedAgents(flags);

  if (action === "show") {
    if (project || dryRun || force || agents.length)
      throw usage("`beachside skill show` takes no options");

    if (out.json) out.success({ name: skillName, content: bundled }, "");
    else out.streams.stdout(bundled);

    return 0;
  }

  if (force && action !== "setup" && action !== "install")
    throw usage("--force only applies to `beachside skill setup`");

  const all = await locations(session, project);

  if (action === "status") {
    if (dryRun) throw usage("--dry-run does not apply to `beachside skill status`");

    const shown = agents.length ? chosen(all, agents) : [all.shared, all.claude];

    const skills = await Promise.all(
      shown.map(async (location) => ({
        location: location.name,
        agents: location.agents,
        detected: location.detected,
        path: location.path,
        state: (await readState(location.path)).state,
      })),
    );

    out.success(
      { name: skillName, skills },
      skills
        .map((item) => `${item.state.padEnd(10)} ${item.path}  (${item.agents.join(", ")})`)
        .join("\n"),
    );

    return 0;
  }

  if (action === "remove") {
    // Remove from every known folder, including agents that are no longer installed.
    const targets = agents.length ? chosen(all, agents) : [all.shared, all.claude];
    const removed = await Promise.all(targets.map((location) => removeAt(location, dryRun)));

    report(session, "removed", removed, dryRun);

    return 0;
  }

  const installed = await Promise.all(
    chosen(all, agents).map((location) => setupAt(location, force, dryRun)),
  );

  if (installed.every((item) => item.result === "skipped"))
    throw new CliError(
      "CONFLICT",
      `The ${skillName} skill is already installed another way: ${installed.map((item) => item.path).join(", ")}`,
      "pass --force to replace it, or update it with the tool that installed it",
    );

  report(session, "installed", installed, dryRun);

  return 0;
}
