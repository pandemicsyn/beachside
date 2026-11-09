import { readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  Setup,
  type SetupEvent,
  type SetupOutput,
  type SetupRunOptions,
  type SetupStep,
  type SetupStepOptions,
} from "beachside";
import { z } from "zod";
import { expandHome, type Env, type LoadedConfig } from "./config";
import { CliError, usage, type Output } from "./output";
import { parseDuration } from "./units";

/**
 * Setups: steps the CLI runs in a sandbox after it starts. Named, provider-neutral setups live
 * under `setups` in beachside.json; `--setup` picks them or a script file, `--setup-cmd` adds
 * shell lines.
 */

export const SetupName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "use lowercase letters, digits, '.', '_' and '-'");

const StepObject = z
  .strictObject({
    run: z.union([z.string().min(1), z.array(z.string()).min(1)]).optional(),
    script: z.string().min(1).optional(),
    /** A script file, relative to the file that names it. */
    file: z.string().min(1).optional(),
    name: z.string().min(1).max(200).optional(),
    cwd: z.string().min(1).optional(),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
    /** A duration like 90s or 10m. */
    timeout: z.string().min(1).optional(),
    user: z.literal("root").optional(),
    cache: z.boolean().optional(),
  })
  .refine(
    (step) =>
      [step.run, step.script, step.file].filter((value) => value !== undefined).length === 1,
    "a step needs exactly one of run, script or file",
  );

/**
 * A step in beachside.json: a shell line, an argv array or the object form. A string that
 * starts with `./`, `../` or `~/` is a script file instead, relative to the file naming it.
 */
export const StepConfig = z.union([z.string().min(1), z.array(z.string()).min(1), StepObject]);

export type StepConfig = z.infer<typeof StepConfig>;

export const CacheConfig = z.union([
  z.boolean(),
  z.strictObject({
    /** How long a cache stays fresh, like 7d; the next create after that rebuilds it. */
    maxAge: z.string().min(1).optional(),
    /** Local files whose content is part of the cache key, such as a lockfile. */
    files: z.array(z.string().min(1)).optional(),
    /** Allow caching a setup whose env comes from a password manager. */
    secrets: z.literal("allow").optional(),
  }),
]);

export type CacheConfig = z.infer<typeof CacheConfig>;

export const SetupConfig = z.strictObject({
  /** Other named setups this one builds on; their steps run first. */
  extends: z.array(SetupName).optional(),
  setup: z.array(StepConfig).optional(),
  startup: z.array(StepConfig).optional(),
  /** The network the setup needs, such as internet; it becomes the create default. */
  network: z.string().min(1).optional(),
  /** Sandbox environment the setup needs; values may be env: or password-manager references. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()).optional(),
  cache: CacheConfig.optional(),
});

export type SetupConfig = z.infer<typeof SetupConfig>;

/** What a create asked for, resolved: steps ready for the SDK plus what they need. */
export type CliSetup = {
  /** What was asked for, in order: named setups, file paths and `cmd` for --setup-cmd. */
  sources: string[];
  setup: SetupStep[];
  startup: SetupStep[];
  /** The network a named setup needs, and which setup asked for it. */
  network?: { value: string; from: string };
  /** Sandbox environment from named setups, still unresolved (env: and vault references). */
  env: Record<string, string>;
  /** The first cache setting among the named setups. */
  cache?: { config: CacheConfig; from: string; dir: string };
  digest: string | null;
  /** The request with file paths made absolute, so `beachside setup <sandbox>` can replay it. */
  request: SetupRequest;
};

export type SetupRequest = {
  /** `--setup`: named setups or script files, in order. */
  setups: string[];
  /** `--setup-cmd`: shell lines. */
  commands: string[];
  /** `--startup`: script files. */
  startups: string[];
  /** `--startup-cmd`: shell lines. */
  startupCommands: string[];
  /** Named setups the profile lists by default, unless `--no-default-setup`. */
  defaults: string[];
};

export function setupRequest(
  values: Omit<SetupRequest, "setups"> & { setups: string[] },
): SetupRequest {
  return {
    ...values,
    setups: values.setups.flatMap((value) => value.split(",")).map((v) => v.trim()),
  };
}

export function hasSetupRequest(request: SetupRequest): boolean {
  return (
    request.setups.length +
      request.commands.length +
      request.startups.length +
      request.startupCommands.length +
      request.defaults.length >
    0
  );
}

/** Named setups from the config, plus any found in a project file (phase 4). */
export type SetupCatalog = {
  entries: Map<string, { config: SetupConfig; dir: string; origin: string }>;
};

export function catalog(loaded: LoadedConfig): SetupCatalog {
  const entries: SetupCatalog["entries"] = new Map();

  for (const [name, config] of Object.entries(loaded.value.setups ?? {}))
    entries.set(name, { config, dir: loaded.dir, origin: loaded.path });

  return { entries };
}

const filePrefix = /^(\.\.?\/|~\/)/;

async function readScript(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw usage(
      `Cannot read setup script ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** A step from config or flags as an SDK step, with any script file read now. */
async function toStep(step: StepConfig, dir: string, env: Env, where: string): Promise<SetupStep> {
  const parsed = StepConfig.safeParse(step);

  if (!parsed.success)
    throw usage(
      `Invalid setup step in ${where}: ${z.prettifyError(parsed.error).replaceAll("\n", "; ")}`,
    );

  const value = parsed.data;

  if (Array.isArray(value)) return value;

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- A validated step is a string, an array or an object.
  if (typeof value === "string") {
    if (!filePrefix.test(value)) return value;

    const path = resolve(dir, expandHome(value, env));

    return { script: await readScript(path), name: basename(path) };
  }

  const out: SetupStepOptions = {};

  if (value.run !== undefined) out.run = value.run;

  if (value.script !== undefined) out.script = value.script;

  if (value.file !== undefined) {
    const path = resolve(dir, expandHome(value.file, env));

    out.script = await readScript(path);
    out.name = basename(path);
  }

  if (value.name !== undefined) out.name = value.name;

  if (value.cwd !== undefined) out.cwd = value.cwd;

  if (value.env !== undefined) out.env = value.env;

  if (value.timeout !== undefined) out.timeoutSeconds = parseDuration(value.timeout, "timeout");

  if (value.user !== undefined) out.user = value.user;

  if (value.cache !== undefined) out.cache = value.cache;

  return out;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve a setup request: profile defaults, then `--setup` items, then `--setup-cmd`. Named
 * setups expand their `extends` first and run once even when reached twice. Everything is read
 * and checked here, before any sandbox exists.
 */
export async function resolveSetupRequest(
  request: SetupRequest,
  known: SetupCatalog,
  cwd: string,
  env: Env,
): Promise<CliSetup> {
  const replay: SetupRequest = {
    setups: [],
    commands: [...request.commands],
    startups: [],
    startupCommands: [...request.startupCommands],
    defaults: [...request.defaults],
  };

  const result: CliSetup = {
    sources: [],
    setup: [],
    startup: [],
    env: {},
    digest: null,
    request: replay,
  };

  const seen = new Set<string>();

  const visit = async (name: string, path: string[]): Promise<void> => {
    if (path.includes(name))
      throw usage(`Setup ${name} extends itself: ${[...path, name].join(" -> ")}`);

    if (seen.has(name)) return;
    seen.add(name);

    const entry = known.entries.get(name);

    if (!entry)
      throw usage(
        `Unknown setup ${name}`,
        known.entries.size
          ? `choose from ${[...known.entries.keys()].join(", ")}, or pass a script path like ./setup.sh`
          : "define it under setups in beachside.json, or pass a script path like ./setup.sh",
      );

    for (const base of entry.config.extends ?? []) await visit(base, [...path, name]);

    const where = `setup ${name} (${entry.origin})`;

    for (const step of entry.config.setup ?? [])
      result.setup.push(await toStep(step, entry.dir, env, where));

    for (const step of entry.config.startup ?? [])
      result.startup.push(await toStep(step, entry.dir, env, where));

    if (entry.config.network) {
      if (result.network && result.network.value !== entry.config.network)
        throw usage(
          `Setups ${result.network.from} and ${name} need different networks (${result.network.value}, ${entry.config.network})`,
        );

      result.network ??= { value: entry.config.network, from: name };
    }

    for (const [key, value] of Object.entries(entry.config.env ?? {}))
      if (!(key in result.env)) result.env[key] = value;

    if (entry.config.cache !== undefined && entry.config.cache !== false && !result.cache)
      result.cache = { config: entry.config.cache, from: name, dir: entry.dir };
  };

  for (const name of request.defaults) {
    result.sources.push(name);
    await visit(name, []);
  }

  for (const value of request.setups) {
    if (known.entries.has(value)) {
      result.sources.push(value);
      replay.setups.push(value);
      await visit(value, []);
      continue;
    }

    const path = resolve(cwd, expandHome(value, env));

    if (filePrefix.test(value) || value.startsWith("/") || (await isFile(path))) {
      if (!(await isFile(path)))
        throw usage(`--setup ${value}: no such file`, "pass a named setup or a script file");

      result.sources.push(value);
      replay.setups.push(path);
      result.setup.push({ script: await readScript(path), name: basename(path) });
      continue;
    }

    replay.setups.push(value);
    await visit(value, []);
  }

  if (request.commands.length) result.sources.push("cmd");

  result.setup.push(...request.commands);

  for (const value of request.startups) {
    const path = resolve(cwd, expandHome(value, env));

    if (!(await isFile(path)))
      throw usage(`--startup ${value}: no such file`, "pass a script file, or use --startup-cmd");

    replay.startups.push(path);
    result.startup.push({ script: await readScript(path), name: basename(path) });
  }

  result.startup.push(...request.startupCommands);

  try {
    result.digest = await Setup.digest(result.setup);
  } catch (cause) {
    throw usage(cause instanceof Error ? cause.message : String(cause));
  }

  return result;
}

/** Human progress on stderr: a header per step, then its output unless quiet. */
export function setupProgress(out: Output, quiet: boolean): SetupRunOptions {
  const label = (event: { phase: string; step: { index: number; total: number; name: string } }) =>
    `${event.phase} [${event.step.index + 1}/${event.step.total}] ${event.step.name}`;

  return {
    onSetupStep: (event: SetupEvent) => {
      if (event.type === "start") out.note(label(event));
      else if (event.type === "skipped") {
        if (!quiet) out.note(`${label(event)}: skipped, ${event.reason}`);
      } else if (event.type === "note") out.note(`${event.phase}: ${event.message}`);
      else if (!quiet) out.note(`${label(event)}: done in ${event.seconds}s`);
    },
    onSetupOutput: (chunk: SetupOutput) => {
      if (!quiet) out.streams.stderr(chunk.text);
    },
  };
}

/** Where a config entry's relative script paths resolve: next to the file that holds it. */
export function configDir(path: string): string {
  return dirname(path);
}

export function setupFailedHint(sandbox: string, kept: boolean): string {
  return kept
    ? `look around with \`beachside sh ${sandbox} '...'\`, rerun the missing steps with \`beachside setup ${sandbox}\`, or remove it with \`beachside rm ${sandbox}\``
    : `the sandbox was removed; fix the step and create it again`;
}

export function setupFailed(message: string, sandbox: string, kept: boolean): CliError {
  return new CliError("SETUP_FAILED", message, setupFailedHint(sandbox, kept), { sandbox });
}

/** What the store keeps about a sandbox's setup: names and digests, never script bodies. */
export const SetupRecord = z.strictObject({
  digest: z.string().nullable(),
  /** Named setups and script paths, so `beachside setup <sandbox>` can run them again. */
  sources: z.array(z.string()),
  /** What was asked for, file paths absolute; older records lack it. */
  request: z
    .strictObject({
      setups: z.array(z.string()),
      commands: z.array(z.string()),
      startups: z.array(z.string()),
      startupCommands: z.array(z.string()),
      defaults: z.array(z.string()),
    })
    .optional(),
  /** `running` is saved before the first step, so an interrupted setup is still visible. */
  state: z.enum(["running", "ready", "failed"]),
  steps: z.array(
    z.strictObject({
      phase: z.enum(["setup", "startup"]),
      name: z.string(),
      status: z.enum(["running", "ran", "skipped", "failed"]),
      exitCode: z.number().int().nullable().optional(),
      seconds: z.number().optional(),
    }),
  ),
  /** Phase 3: whether this sandbox came from a setup cache. */
  cache: z
    .strictObject({
      status: z.enum(["hit", "built", "skipped"]),
      key: z.string(),
      snapshot: z.string().optional(),
    })
    .optional(),
});

export type SetupRecord = z.infer<typeof SetupRecord>;

/** One line per setup for human output. */
export function setupLines(setup: SetupRecord | undefined): string[] {
  if (!setup) return [];

  const ran = setup.steps.filter((step) => step.status === "ran").length;
  const skipped = setup.steps.filter((step) => step.status === "skipped").length;
  const sources = setup.sources.length ? setup.sources.join(", ") : "recorded startup";
  const cache = setup.cache ? `, cache ${setup.cache.status}` : "";

  return [`setup     ${setup.state} (${sources}; ${ran} ran, ${skipped} skipped${cache})`];
}
