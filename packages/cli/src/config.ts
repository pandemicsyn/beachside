import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { CliError, usage } from "./output";
import { SetupConfig, SetupName } from "./setups";

export type Env = Readonly<Record<string, string | undefined>>;

export const ProfileConfig = z
  .strictObject({
    /** An official provider id; its adapter package is `@beachside/<provider>`. */
    provider: z
      .string()
      .regex(/^[a-z0-9-]{1,64}$/)
      .optional()
      .describe(
        "An official provider: boxd, freestyle, daytona, e2b, vercel, boat, runloop, archil, exe-dev, modal",
      ),
    /** Any adapter module: a package name or a path relative to the config file. */
    module: z
      .string()
      .min(1)
      .max(1024)
      .optional()
      .describe("Any other adapter: a package name or a path"),
    /** The module export holding the adapter definition or bound adapter. */
    export: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("The module export that holds the adapter"),
    config: z.record(z.string(), z.json()).optional().describe("The adapter's own settings"),
    credentials: z
      .record(z.string(), z.string())
      .optional()
      .describe("Credentials: a value, env:NAME, or op://, bws:// or pass:// references"),
    /** Named setups every create with this profile runs first (skip with --no-default-setup). */
    setup: z
      .array(SetupName)
      .optional()
      .describe("Named setups every create with this profile runs first"),
  })
  .refine((profile) => profile.provider || profile.module, {
    message: "A profile needs a provider or a module",
  });

export type ProfileConfig = z.infer<typeof ProfileConfig>;

/** Where the published JSON Schema for beachside.json lives; editors read it from `$schema`. */
export const CONFIG_SCHEMA_URL = "https://beachside.run/schema/beachside.json";

export const CliConfig = z.strictObject({
  /** The JSON Schema an editor checks the file against; the CLI ignores it. */
  $schema: z.string().max(2048).optional().describe("JSON Schema for editors; the CLI ignores it"),
  default: z.string().min(1).optional().describe("The profile used when nothing else picks one"),
  profiles: z
    .record(z.string(), ProfileConfig)
    .optional()
    .describe("Named adapter setups: a provider or module, its config and credentials"),
  state: z
    .strictObject({ kind: z.literal("fs"), dir: z.string().min(1).optional() })
    .optional()
    .describe("Where sandbox, snapshot and image records are kept"),
  limits: z
    .strictObject({ maxSandboxes: z.number().int().positive().nullable().optional() })
    .optional()
    .describe("maxSandboxes: how many sandboxes the CLI keeps at once"),
  images: z
    .strictObject({ autoBuild: z.boolean().optional() })
    .optional()
    .describe("autoBuild: build a missing --image on demand on E2B and Daytona"),
  /** Also load adapters from the working directory's node_modules (off: a checkout could plant one). */
  adapters: z
    .strictObject({ searchProject: z.boolean().optional() })
    .optional()
    .describe("searchProject: also load adapters from the project's node_modules"),
  /** Named, provider-neutral setups for `--setup <name>`. */
  setups: z
    .record(SetupName, SetupConfig)
    .optional()
    .describe("Named setup steps for --setup <name>"),
  /** Also read setups from a checkout's `.beachside/setup.json` (off: a checkout could plant one). */
  projectSetups: z
    .boolean()
    .optional()
    .describe("Also read setups from a checkout's .beachside/setup.json"),
});

export type CliConfig = z.infer<typeof CliConfig>;

/** The JSON Schema for beachside.json, published at CONFIG_SCHEMA_URL. */
export function configJsonSchema(): z.core.JSONSchema.JSONSchema {
  return {
    ...z.toJSONSchema(CliConfig, { io: "input", unrepresentable: "any" }),
    $id: CONFIG_SCHEMA_URL,
    title: "beachside.json",
    description:
      "Configuration for the beachside CLI: https://beachside.run/docs/cli/configuration/",
  };
}

export type LoadedConfig = {
  path: string;
  /** Directory relative module paths and the default state folder resolve against. */
  dir: string;
  exists: boolean;
  value: CliConfig;
};

export function configHome(env: Env): string {
  return join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "beachside");
}

export function expandHome(path: string, env: Env): string {
  return path === "~" || path.startsWith("~/") ? join(env.HOME || homedir(), path.slice(1)) : path;
}

/** Read `beachside.json`; a missing default file is an empty configuration. */
export async function loadConfig(
  explicitPath: string | undefined,
  env: Env,
): Promise<LoadedConfig> {
  const chosen = explicitPath ?? env.BEACHSIDE_CONFIG;
  const path = resolve(expandHome(chosen ?? join(configHome(env), "beachside.json"), env));
  let text: string;

  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    if (!chosen && cause instanceof Error && "code" in cause && cause.code === "ENOENT")
      return { path, dir: dirname(path), exists: false, value: {} };

    throw usage(`Cannot read config ${path}: ${cause instanceof Error ? cause.message : cause}`);
  }

  let json: z.infer<ReturnType<typeof z.json>>;

  try {
    json = z.json().parse(JSON.parse(text));
  } catch {
    throw usage(`Config ${path} is not valid JSON`);
  }

  const parsed = CliConfig.safeParse(json);

  if (!parsed.success)
    throw usage(
      `Config ${path} is invalid: ${z.prettifyError(parsed.error).replaceAll("\n", "; ")}`,
    );

  return { path, dir: dirname(path), exists: true, value: parsed.data };
}

/** A flag or env path is relative to the working directory; `state.dir` to the config file. */
export function stateDir(
  flag: string | undefined,
  config: LoadedConfig,
  env: Env,
  cwd: string,
): string {
  const given = flag ?? env.BEACHSIDE_STATE_DIR;

  if (given) return resolve(cwd, expandHome(given, env));
  const configured = config.value.state?.dir;

  if (configured) return resolve(config.dir, expandHome(configured, env));

  return join(configHome(env), "state");
}

/** Whether adapters may come from the project's node_modules; opt-in, since they receive credentials. */
export function searchProjectAdapters(config: LoadedConfig, env: Env): boolean {
  const fromEnv = env.BEACHSIDE_PROJECT_ADAPTERS;

  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv === "true";

  return config.value.adapters?.searchProject ?? false;
}

/** Whether `.beachside/setup.json` in the working tree is read; BEACHSIDE_PROJECT_SETUPS wins. */
export function readProjectSetups(config: LoadedConfig, env: Env): boolean {
  const fromEnv = env.BEACHSIDE_PROJECT_SETUPS;

  if (fromEnv !== undefined && fromEnv !== "") return fromEnv === "1" || fromEnv === "true";

  return config.value.projectSetups ?? false;
}

export function maxSandboxes(config: LoadedConfig, env: Env): number | null {
  const fromEnv = env.BEACHSIDE_MAX_SANDBOXES;

  if (fromEnv !== undefined && fromEnv !== "") {
    const parsed = z.coerce.number().int().positive().safeParse(fromEnv);

    if (!parsed.success) throw usage("BEACHSIDE_MAX_SANDBOXES must be a positive integer");

    return parsed.data;
  }

  return config.value.limits?.maxSandboxes ?? null;
}

const EnvReference = z.string().regex(/^env:[A-Za-z_][A-Za-z0-9_]*$/);

/** Whether a profile value is usable here: an `env:NAME` reference needs NAME to be set. */
export function valueAvailable(value: JsonValue, env: Env): boolean {
  const reference = EnvReference.safeParse(value);

  return !reference.success || Boolean(env[reference.data.slice(4)]);
}

type JsonValue = z.infer<ReturnType<typeof z.json>>;

/** Replace `env:NAME` strings with the variable's value; credentials never live in files. */
export function resolveEnvReferences(value: JsonValue, env: Env, where: string): JsonValue {
  const reference = EnvReference.safeParse(value);

  if (reference.success) {
    const name = reference.data.slice(4);
    const found = env[name];

    if (found === undefined || found === "")
      throw new CliError("USAGE", `${where} needs environment variable ${name}`);

    return found;
  }

  if (Array.isArray(value)) return value.map((item) => resolveEnvReferences(item, env, where));

  const record = z.record(z.string(), z.json()).safeParse(value);

  if (record.success)
    return Object.fromEntries(
      Object.entries(record.data).map(([key, item]) => [
        key,
        resolveEnvReferences(item, env, `${where}.${key}`),
      ]),
    );

  return value;
}
