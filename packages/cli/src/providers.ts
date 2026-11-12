import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  bindAdapter,
  type AdapterDefinition,
  type AdapterSetup,
  type AdapterSetupValue,
  type BoundAdapter,
  type Json,
  type RuntimeSession,
} from "@beachside/adapter";
import { Beachside, type BeachsideClient } from "beachside";
import { z } from "zod";
import {
  configHome,
  resolveEnvReferences,
  searchProjectAdapters,
  type Env,
  type LoadedConfig,
  type ProfileConfig,
} from "./config";
import { CliError, usage } from "./output";
import type { SecretReader } from "./secrets";

/**
 * An official adapter: its id, package and export. What it needs from the environment comes from
 * the adapter's own `setup` once it is installed.
 */
export type OfficialProvider = {
  id: string;
  module: string;
  export: string;
  experimental: boolean;
};

const official = (id: string, exported: string, experimental: boolean): OfficialProvider => ({
  id,
  module: `@beachside/${id}`,
  export: exported,
  experimental,
});

/** Official providers, in the order the docs list them. */
export const providers: readonly OfficialProvider[] = [
  official("boxd", "boxdAdapter", false),
  official("freestyle", "freestyleAdapter", false),
  official("daytona", "daytonaAdapter", false),
  official("e2b", "e2bAdapter", false),
  official("vercel", "vercelAdapter", false),
  official("boat", "boatAdapter", true),
  official("runloop", "runloopAdapter", true),
  official("archil", "archilAdapter", true),
  official("exe-dev", "exeDevAdapter", true),
  official("modal", "modalAdapter", true),
];

export function descriptor(id: string): OfficialProvider | undefined {
  return providers.find((provider) => provider.id === id);
}

/** A required setting that is not set: one key, or a group of alternative credentials. */
export type SetupNeed = {
  kind: "credential" | "config";
  key: string;
  /** The variable that supplies it, when the adapter names one. */
  env: string | null;
  /** How to supply it, such as `EXE_API_KEY` or `EXE_API_KEY or credentials.sshKey`. */
  label: string;
  description: string | null;
  url: string | null;
};

/** Whether a profile already has a setting, wherever it came from. */
export type HasSetting = (kind: "credential" | "config", key: string) => boolean;

function need(
  kind: SetupNeed["kind"],
  key: string,
  value: AdapterSetupValue | undefined,
  label?: string,
): SetupNeed {
  return {
    kind,
    key,
    env: value?.env ?? null,
    label: label ?? value?.env ?? `${kind === "credential" ? "credentials" : "config"}.${key}`,
    description: value?.description ?? null,
    url: value?.url ?? null,
  };
}

/** The required settings an adapter's setup says are not set yet. */
export function unmetSettings(setup: AdapterSetup, has: HasSetting): SetupNeed[] {
  const groups = setup.alternatives ?? [];
  const alternative = new Set(groups.flat());

  const single = [
    ...Object.entries(setup.credentials).flatMap(([key, value]) =>
      alternative.has(key) || has("credential", key) ? [] : [need("credential", key, value)],
    ),
    ...Object.entries(setup.config ?? {}).flatMap(([key, value]) =>
      value.required && !has("config", key) ? [need("config", key, value)] : [],
    ),
  ];

  // Alternatives are met when every key of one group is set.
  const met =
    !groups.length || groups.some((group) => group.every((key) => has("credential", key)));

  if (met) return single;

  const label = groups
    .map((group) =>
      group.map((key) => setup.credentials[key]?.env ?? `credentials.${key}`).join(" and "),
    )
    .join(" or ");

  const first = groups[0]!.find((key) => setup.credentials[key]) ?? groups[0]![0]!;

  return [...single, need("credential", first, setup.credentials[first], label)];
}

/** Required settings neither the environment nor `covered` (keys set elsewhere) supplies. */
export function missingSettings(
  setup: AdapterSetup,
  env: Env,
  covered: ReadonlySet<string> = new Set(),
): SetupNeed[] {
  return unmetSettings(setup, (kind, key) => {
    if (covered.has(key)) return true;
    const variable = kind === "credential" ? setup.credentials[key]?.env : setup.config?.[key]?.env;

    return Boolean(variable && env[variable]);
  });
}

/** What an adapter still needs from the environment, as labels; `covered` names keys set elsewhere. */
export function missingEnv(
  setup: AdapterSetup,
  env: Env,
  covered: ReadonlySet<string> = new Set(),
): string[] {
  return missingSettings(setup, env, covered).map((item) => item.label);
}

export type ResolvedProfile = {
  name: string;
  provider: string;
  module: string;
  export: string;
  /** Directory a relative module path resolves against. */
  baseDir: string;
  /** Whether the project's node_modules may supply the adapter (config adapters.searchProject). */
  searchProject: boolean;
  config: Record<string, Json>;
  credentials: Record<string, string>;
};

/** Where an adapter module is looked up, for reading its setup before a profile is complete. */
export type AdapterLocation = Pick<
  ResolvedProfile,
  "name" | "module" | "export" | "baseDir" | "searchProject"
>;

/**
 * The adapter's `setup`, read by importing it. Null when the adapter is not installed, fails to
 * load or declares none; connecting reports those properly later.
 */
export async function adapterSetup(
  location: AdapterLocation,
  cwd: string,
  env: Env,
): Promise<AdapterSetup | null> {
  try {
    const target = await resolveAdapterModule(
      { ...location, provider: location.name, config: {}, credentials: {} },
      cwd,
      env,
    );

    const exported = z.record(z.string(), z.unknown()).parse(await import(target))[location.export];

    return isAdapter(exported) && !("bound" in exported) ? (exported.setup ?? null) : null;
  } catch {
    return null;
  }
}

/** The official adapter's location, for reading its setup with default lookup rules. */
export function officialLocation(
  provider: OfficialProvider,
  loaded: LoadedConfig,
  env: Env,
): AdapterLocation {
  return {
    name: provider.id,
    module: provider.module,
    export: provider.export,
    baseDir: loaded.dir,
    searchProject: searchProjectAdapters(loaded, env),
  };
}

/** A profile chosen by name: configured in beachside.json, or an official provider from the environment. */
export type ProfileSelection = {
  name: string;
  profile: ProfileConfig;
  /** `env` when --provider or BEACHSIDE_PROVIDER picked an official provider with no profile. */
  source: "config" | "env";
};

/**
 * Which profile is selected: --profile, BEACHSIDE_PROFILE, --provider, BEACHSIDE_PROVIDER, then
 * the config default. Null when nothing selects one.
 */
export function resolveProfileName(
  flags: { profile?: string; provider?: string },
  loaded: LoadedConfig,
  env: Env,
): ProfileSelection | null {
  const profiles = loaded.value.profiles ?? {};
  const profileName = flags.profile ?? (flags.provider ? undefined : env.BEACHSIDE_PROFILE);

  if (profileName) {
    const profile = profiles[profileName];

    if (!profile)
      throw usage(
        `Profile ${profileName} is not defined in ${loaded.path}`,
        Object.keys(profiles).length
          ? `known profiles: ${Object.keys(profiles).join(", ")}`
          : 'add it under "profiles" in beachside.json',
      );

    return { name: profileName, profile, source: "config" };
  }

  const providerId = flags.provider ?? env.BEACHSIDE_PROVIDER;

  if (providerId) return { name: providerId, profile: { provider: providerId }, source: "env" };

  const fallback = loaded.value.default;

  if (fallback) {
    const profile = profiles[fallback];

    if (!profile) throw usage(`Default profile ${fallback} is not defined in ${loaded.path}`);

    return { name: fallback, profile, source: "config" };
  }

  return null;
}

/** Pick the profile: --profile, BEACHSIDE_PROFILE, --provider, BEACHSIDE_PROVIDER, then the config default. */
export async function resolveProfile(
  flags: { profile?: string; provider?: string },
  loaded: LoadedConfig,
  env: Env,
  cwd: string,
): Promise<ResolvedProfile> {
  const selected = resolveProfileName(flags, loaded, env);

  if (selected) return fromProfile(selected.name, selected.profile, loaded, env, cwd);

  const ready: string[] = [];

  for (const provider of providers) {
    const setup = await adapterSetup(officialLocation(provider, loaded, env), cwd, env);

    if (setup && !missingEnv(setup, env).length) ready.push(provider.id);
  }

  throw usage(
    "No provider selected",
    ready.length
      ? `credentials found for: ${ready.join(", ")}; set BEACHSIDE_PROVIDER or pass --provider`
      : "set BEACHSIDE_PROVIDER and the provider's credentials (see `beachside providers`), or add a profile to beachside.json",
  );
}

async function fromProfile(
  name: string,
  profile: ProfileConfig,
  loaded: LoadedConfig,
  env: Env,
  cwd: string,
): Promise<ResolvedProfile> {
  const known = profile.provider ? descriptor(profile.provider) : undefined;

  if (profile.provider && !known && !profile.module)
    throw usage(
      `Unknown provider ${profile.provider}`,
      `official providers: ${providers.map((provider) => provider.id).join(", ")}; use "module" for other adapters`,
    );

  const where = `profile ${name}`;

  const location: AdapterLocation = {
    name,
    module: profile.module ?? known?.module ?? "",
    export: profile.export ?? known?.export ?? "default",
    baseDir: loaded.dir,
    searchProject: searchProjectAdapters(loaded, env),
  };

  // The adapter says which environment variables fill its settings; profile values override them.
  const setup = location.module ? await adapterSetup(location, cwd, env) : null;

  const credentials = Object.fromEntries([
    ...Object.entries(setup?.credentials ?? {}).flatMap(([key, entry]) => {
      const value = env[entry.env];

      return value ? [[key, value] as const] : [];
    }),
    ...Object.entries(profile.credentials ?? {}).map(
      ([key, value]) =>
        [
          key,
          z.string().parse(resolveEnvReferences(value, env, `${where}.credentials.${key}`)),
        ] as const,
    ),
  ]);

  const config = Object.fromEntries([
    ...Object.entries(setup?.config ?? {}).flatMap(([key, entry]) => {
      const value = env[entry.env];

      return value ? [[key, value] as const] : [];
    }),
    ...Object.entries(profile.config ?? {}).map(
      ([key, value]) => [key, resolveEnvReferences(value, env, `${where}.config.${key}`)] as const,
    ),
  ]);

  if (setup) {
    const missing = unmetSettings(setup, (kind, key) =>
      kind === "credential" ? Boolean(credentials[key]) : config[key] !== undefined,
    );

    if (missing.length)
      throw usage(
        `${where}${known ? ` (${known.id})` : ""} is missing ${missing.map((item) => item.label).join(", ")}`,
        [
          "set the environment variables, or put the values in the profile in beachside.json",
          ...missing.flatMap((item) => (item.url ? [`${item.label}: ${item.url}`] : [])),
        ].join("; "),
      );
  }

  return {
    name,
    provider: known?.id ?? profile.provider ?? name,
    module: location.module,
    export: location.export,
    baseDir: location.baseDir,
    searchProject: location.searchProject,
    config,
    credentials,
  };
}

const PackageManifest = z.object({
  main: z.string().optional(),
  exports: z.json().optional(),
});

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);

    return true;
  } catch {
    return false;
  }
}

/** Conditions Node applies to an ESM import, matched in the manifest's own key order. */
const importConditions = new Set(["import", "node", "default"]);

/** Node's export-target resolution: a string, the first resolvable array item, or a condition map. */
function exportTarget(value: z.infer<ReturnType<typeof z.json>>): string | null {
  const plain = z.string().safeParse(value);

  if (plain.success) return plain.data;

  const list = z.array(z.json()).safeParse(value);

  if (list.success) {
    for (const item of list.data) {
      const target = exportTarget(item);

      if (target) return target;
    }

    return null;
  }

  const conditions = z.record(z.string(), z.json()).safeParse(value);

  if (!conditions.success) return null;

  for (const [condition, nested] of Object.entries(conditions.data)) {
    if (!importConditions.has(condition)) continue;

    const target = exportTarget(nested);

    if (target) return target;
  }

  return null;
}

function rootEntry(manifest: z.infer<typeof PackageManifest>): string {
  const exports = manifest.exports;

  if (exports === undefined || exports === null) return manifest.main || "index.js";

  // An exports map keyed by subpath names the package root as ".".
  const subpaths = z.record(z.string(), z.json()).safeParse(exports);

  const root =
    subpaths.success && Object.keys(subpaths.data).some((key) => key.startsWith("."))
      ? subpaths.data["."]
      : exports;

  return (root === undefined ? null : exportTarget(root)) ?? manifest.main ?? "index.js";
}

/** The folder `beachside adapter add` installs into: its own package.json and node_modules. */
export function adaptersDir(env: Env): string {
  return join(configHome(env), "adapters");
}

export async function entryFor(packageDir: string): Promise<string | null> {
  const manifestPath = join(packageDir, "package.json");

  if (!(await exists(manifestPath))) return null;
  const manifest = PackageManifest.safeParse(JSON.parse(await readFile(manifestPath, "utf8")));

  if (!manifest.success) return null;
  const entry = resolve(packageDir, rootEntry(manifest.data));
  const inside = relative(packageDir, entry);

  if (!inside || inside.startsWith("..") || isAbsolute(inside))
    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `${manifestPath} points its entry outside the package (${rootEntry(manifest.data)})`,
    );

  return entry;
}

export const PackageName = /^(@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Adapters are installed separately and receive credentials, so they come from
 * `~/.config/beachside/adapters` or the CLI's own module resolution. The working directory's
 * node_modules (walking up) is searched only when adapters.searchProject opts in.
 */
export async function resolveAdapterModule(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
): Promise<string> {
  const spec = profile.module;

  if (spec.startsWith(".") || isAbsolute(spec))
    return pathToFileURL(resolve(profile.baseDir, spec)).href;

  if (!PackageName.test(spec))
    throw usage(`Adapter module ${spec} is not a package name or a path`);

  const roots = [join(adaptersDir(env), "node_modules")];

  if (profile.searchProject)
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      roots.push(join(dir, "node_modules"));

      if (dirname(dir) === dir) break;
    }

  for (const root of roots) {
    const entry = await entryFor(join(root, spec));

    if (entry) return pathToFileURL(entry).href;
  }

  return spec;
}

export function isAdapter(
  value: unknown,
): value is AdapterDefinition<z.ZodType, z.ZodType, RuntimeSession> | BoundAdapter {
  return value instanceof Object && "name" in value && "connect" in value && "config" in value;
}

const AdapterExport = z.custom<
  AdapterDefinition<z.ZodType, z.ZodType, RuntimeSession> | BoundAdapter
>(isAdapter);

/** Whether a failed import means the adapter itself is absent, rather than broken. */
async function adapterMissing(target: string, spec: string, message: string): Promise<boolean> {
  if (target.startsWith("file:")) return !(await exists(fileURLToPath(target)));

  return message.includes(`'${spec}'`) || message.includes(`"${spec}"`);
}

export async function loadAdapter(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
  secrets: SecretReader,
): Promise<BoundAdapter> {
  const target = await resolveAdapterModule(profile, cwd, env);
  const schema = z.object({ [profile.export]: AdapterExport });
  let parsed: ReturnType<typeof schema.safeParse>;

  try {
    parsed = schema.safeParse(await import(target));
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    const official = descriptor(profile.provider);

    if (await adapterMissing(target, profile.module, message))
      throw new CliError(
        "ADAPTER_NOT_INSTALLED",
        `Cannot load adapter ${profile.module} for profile ${profile.name}: ${message}`,
        official
          ? `install it with \`beachside adapter add ${official.id}\` (into ${adaptersDir(env)}); project installs need adapters.searchProject or BEACHSIDE_PROJECT_ADAPTERS=1`
          : "check the profile's module path",
      );

    // The adapter was found, so the failure came from inside it or one of its dependencies.
    throw new CliError(
      "ADAPTER_LOAD_FAILED",
      `Adapter ${profile.module} for profile ${profile.name} is installed but failed to load: ${message}`,
      "reinstall the adapter and its dependencies; the message above comes from the adapter package",
    );
  }

  if (!parsed.success)
    throw new CliError(
      "ADAPTER_NOT_INSTALLED",
      `${profile.module} has no adapter export named ${profile.export}`,
    );
  const exported = parsed.data[profile.export];

  if (!exported) throw new CliError("ADAPTER_NOT_INSTALLED", `${profile.module} export is empty`);

  if ("bound" in exported) return exported;

  // Password-manager references are read only now, when the profile is actually used.
  const where = `profile ${profile.name}`;
  const config = await secrets.resolve(profile.config, `${where}.config`);

  const credentials = z
    .record(z.string(), z.string())
    .parse(await secrets.resolve(profile.credentials, `${where}.credentials`));

  return bindAdapter(exported, config, credentials);
}

/** The provider refused the profile's credentials: say which profile and where to fix it. */
export function credentialsRejected(
  profile: ResolvedProfile,
  setup: AdapterSetup | null,
  code: "UNAUTHENTICATED" | "FORBIDDEN",
  reason: string,
): CliError {
  return new CliError(
    code,
    `${profile.provider} rejected the credentials for profile ${profile.name}: ${reason}`,
    [
      "check the key and the account it belongs to; `beachside profile show` says where each value comes from",
      ...Object.values(setup?.credentials ?? {}).flatMap((value) =>
        value.url ? [`${value.env}: ${value.url}`] : [],
      ),
    ].join("; "),
  );
}

const AuthFailure = z.object({
  code: z.enum(["UNAUTHENTICATED", "FORBIDDEN"]),
  message: z.string(),
});

export async function connect(
  profile: ResolvedProfile,
  cwd: string,
  env: Env,
  secrets: SecretReader,
): Promise<BeachsideClient<true>> {
  const adapter = await loadAdapter(profile, cwd, env, secrets);

  try {
    return await Beachside.connect(adapter);
  } catch (cause) {
    // Connecting changes nothing, so a refused key is a plain rejection with a fix, not "unknown".
    const auth = cause instanceof CliError ? null : AuthFailure.safeParse(cause);

    if (auth?.success)
      throw credentialsRejected(
        profile,
        await adapterSetup(profile, cwd, env),
        auth.data.code,
        auth.data.message,
      );
    throw cause;
  }
}
