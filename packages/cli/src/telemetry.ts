import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import manifest from "../package.json" with { type: "json" };
import projectSettings from "../telemetry-project.json" with { type: "json" };
import { configHome, type Env } from "./config";
import { usage } from "./output";
import type { Flags } from "./commands";
import type { Session } from "./session";

const provider = z.enum([
  "daytona",
  "e2b",
  "boxd",
  "vercel",
  "runloop",
  "freestyle",
  "archil",
  "exe-dev",
  "boat",
  "modal",
  "custom",
]);

const errorCode = z.enum([
  "USAGE",
  "LOCAL_IO",
  "INVALID_ARGUMENT",
  "NOT_FOUND",
  "UNSUPPORTED",
  "ADAPTER_NOT_INSTALLED",
  "ADAPTER_LOAD_FAILED",
  "ADAPTER_INSTALLER_MISSING",
  "LIMIT_REACHED",
  "SECRET_TOOL_MISSING",
  "SECRET_UNAVAILABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "SETUP_FAILED",
  "OUTCOME_UNKNOWN",
  "RATE_LIMIT",
  "CAPACITY",
  "UNAVAILABLE",
  "INTERNAL",
  "TIMEOUT",
  "CONFLICT",
  "CLEANUP_FAILED",
  "INTERRUPTED",
]);

const commandNames = [
  "create",
  "ls",
  "adopt",
  "inspect",
  "rm",
  "exec",
  "run",
  "sh",
  "image",
  "snapshot",
  "setup",
  "cp",
  "push",
  "cat",
  "doctor",
  "adapter",
  "providers",
  "skill",
  "gc",
] as const;

/** Rebuild every payload from allowed scalar fields; never spread command data into an event. */
export const CommandEvent = z.strictObject({
  command: z.enum(commandNames),
  action: z
    .enum([
      "build",
      "ls",
      "inspect",
      "rm",
      "forget",
      "create",
      "add",
      "show",
      "setup",
      "status",
      "remove",
      "cache ls",
      "cache rm",
      "cache prune",
    ])
    .optional(),
  provider: provider.optional(),
  result: z.enum(["success", "failure", "interrupted"]),
  failure_kind: z.enum(["cli", "remote_program"]).optional(),
  error_code: errorCode.optional(),
  duration_bucket: z.enum(["<1s", "1–5s", "5–30s", "30s+"]),
  cli_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
  platform: z.enum(["darwin", "linux", "win32", "other"]),
  architecture: z.enum(["arm64", "x64", "other"]),
  runtime_major: z.number().int().positive(),
  ci: z.boolean(),
  terminal: z.boolean(),
  $process_person_profile: z.literal(false),
});

export type CommandEvent = z.infer<typeof CommandEvent>;

export type Delivery = (id: string, event: CommandEvent) => Promise<void>;

// Public ingestion token for the CLI-only project, safe to ship in the published binary.
export const project = { ...projectSettings };

function isCI(env: Env): boolean {
  return [
    env.CI,
    env.CONTINUOUS_INTEGRATION,
    env.GITHUB_ACTIONS,
    env.GITLAB_CI,
    env.BUILDKITE,
    env.TF_BUILD,
  ].some((value) => Boolean(value && value !== "0" && value !== "false"));
}

async function preference(env: Env): Promise<boolean | undefined> {
  try {
    const data: unknown = JSON.parse(
      await readFile(join(configHome(env), "telemetry.json"), "utf8"),
    );

    return z.strictObject({ enabled: z.boolean() }).parse(data).enabled;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return undefined;

    // A corrupt or unreadable preference must never turn collection back on.
    return false;
  }
}

export async function telemetryStatus(env: Env) {
  const saved = await preference(env);
  const setting = env.BEACHSIDE_TELEMETRY?.toLowerCase();
  const explicit = setting === "1" || setting === "true" || saved === true;

  const reason =
    env.DO_NOT_TRACK === "1"
      ? "do_not_track"
      : setting === "0" || setting === "false"
        ? "environment"
        : saved === false && setting !== "1" && setting !== "true"
          ? "preference"
          : isCI(env) && !explicit
            ? "ci_default"
            : "enabled";

  return { enabled: reason === "enabled", reason, configured: Boolean(project.key) };
}

export async function telemetryCommand(session: Session, flags: Flags): Promise<number> {
  const [action = "status", ...args] = flags.positionals;

  if (args.length || !["enable", "disable", "status"].includes(action))
    throw usage("Expected telemetry enable, disable or status");

  if (action !== "status") {
    await mkdir(configHome(session.ctx.env), { recursive: true, mode: 0o700 });
    await writeFile(
      join(configHome(session.ctx.env), "telemetry.json"),
      `${JSON.stringify({ enabled: action === "enable" })}\n`,
      { mode: 0o600 },
    );
  }

  const status = await telemetryStatus(session.ctx.env);
  session.ctx.out.success(
    status,
    `CLI telemetry ${status.enabled ? "enabled" : "disabled"} (${status.reason}). Delivery ${status.configured ? "configured" : "not configured in this build"}.`,
  );

  return 0;
}

async function installationId(env: Env): Promise<string> {
  const path = join(configHome(env), "telemetry-id");
  await mkdir(configHome(env), { recursive: true, mode: 0o700 });

  try {
    await writeFile(path, randomUUID(), { flag: "wx", mode: 0o600 });
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "EEXIST")) throw cause;
  }

  return z.uuid().parse(await readFile(path, "utf8"));
}

export function eventProperties(input: {
  command: string;
  action?: string;
  providers: readonly string[];
  code: number;
  error?: string;
  remote: boolean;
  interrupted: boolean;
  duration: number;
  env: Env;
  terminal: boolean;
}): CommandEvent | undefined {
  const parsedCommand = z.enum(commandNames).safeParse(input.command);

  if (!parsedCommand.success) return;

  const parsedProvider = provider.safeParse(
    input.providers.length === 1 ? input.providers[0] : undefined,
  );

  const parsedError = errorCode.safeParse(input.error);
  const failed = input.code !== 0 || input.error !== undefined;

  return CommandEvent.parse({
    command: parsedCommand.data,
    action: input.action,
    provider: parsedProvider.success ? parsedProvider.data : undefined,
    result: input.interrupted ? "interrupted" : failed ? "failure" : "success",
    failure_kind:
      failed && !input.interrupted
        ? input.remote && !input.error
          ? "remote_program"
          : "cli"
        : undefined,
    error_code: input.error ? (parsedError.success ? parsedError.data : "INTERNAL") : undefined,
    duration_bucket:
      input.duration < 1000
        ? "<1s"
        : input.duration < 5000
          ? "1–5s"
          : input.duration < 30000
            ? "5–30s"
            : "30s+",
    cli_version: manifest.version,
    platform: ["darwin", "linux", "win32"].includes(process.platform) ? process.platform : "other",
    architecture: ["arm64", "x64"].includes(process.arch) ? process.arch : "other",
    runtime_major: Number(process.versions.node.split(".")[0]),
    ci: isCI(input.env),
    terminal: input.terminal,
    $process_person_profile: false,
  });
}

/** Only called by the CLI dispatcher. No SDK hooks, logs, traces, or automatic error capture. */
export async function deliver(id: string, event: CommandEvent): Promise<void> {
  try {
    const response = await fetch(new URL("/i/v0/e/", project.host), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(250),
      body: JSON.stringify({
        api_key: project.key,
        distinct_id: z.uuid().parse(id),
        event: "cli_command_completed",
        timestamp: new Date().toISOString(),
        properties: { ...CommandEvent.parse(event), $geoip_disable: true },
      }),
    });

    await response.body?.cancel();
  } catch {
    // No retries, console output, or local event spool when offline or rejected.
  }
}

export async function record(
  env: Env,
  terminal: boolean,
  write: (text: string) => void,
  event: CommandEvent,
  send: Delivery = deliver,
): Promise<void> {
  try {
    if (!(await telemetryStatus(env)).enabled || (send === deliver && !project.key)) return;
    const id = await installationId(env);

    if (terminal) {
      try {
        await writeFile(join(configHome(env), "telemetry-notice"), "1", {
          flag: "wx",
          mode: 0o600,
        });
        write(
          "Beachside CLI collects basic usage telemetry. Disable: beachside telemetry disable or BEACHSIDE_TELEMETRY=0. The SDK sends no product telemetry.\n",
        );
      } catch {
        /* An existing notice or unwritable home must not affect a command. */
      }
    }

    await send(id, CommandEvent.parse(event));
  } catch {
    /* Telemetry must not change output or exit status. */
  }
}
