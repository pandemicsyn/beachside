import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Flags } from "./commands";
import {
  CliConfig,
  searchProjectAdapters,
  type Env,
  type LoadedConfig,
  type ProfileConfig,
} from "./config";
import { CliError, usage } from "./output";
import { adapterSetup, descriptor, resolveProfileName, type ProfileSelection } from "./providers";
import { secretManager } from "./secrets";
import type { Session } from "./session";
import { listAll } from "./store";

export const profileActions = ["ls", "show", "use", "rm"] as const;

/** Where one profile value comes from, never the value of a credential. */
export type ValueSource =
  | { from: "profile"; value: z.infer<ReturnType<typeof z.json>> }
  | { from: "profile-hidden" }
  | { from: "env-reference"; env: string; set: boolean }
  | { from: "secret-manager"; manager: string; reference: string }
  | { from: "env"; env: string }
  | { from: "missing"; env: string | null; url: string | null };

const EnvReference = /^env:([A-Za-z_][A-Za-z0-9_]*)$/;

/** Describe a profile value without revealing a credential. */
function profileSource(
  value: z.infer<ReturnType<typeof z.json>>,
  secret: boolean,
  env: Env,
): ValueSource {
  const text = z.string().safeParse(value);

  if (text.success) {
    const reference = EnvReference.exec(text.data);

    if (reference)
      return { from: "env-reference", env: reference[1]!, set: Boolean(env[reference[1]!]) };

    const manager = secretManager(text.data);

    if (manager) return { from: "secret-manager", manager, reference: text.data };
  }

  return secret ? { from: "profile-hidden" } : { from: "profile", value };
}

function describeSource(source: ValueSource): string {
  switch (source.from) {
    case "profile":
      return JSON.stringify(source.value);
    case "profile-hidden":
      return "set in beachside.json (hidden)";
    case "env-reference":
      return `from $${source.env}${source.set ? "" : " (not set)"}`;
    case "secret-manager":
      return `${source.reference} (${source.manager})`;
    case "env":
      return `from $${source.env}`;
    case "missing":
      return `missing${source.env ? `: set ${source.env}` : ""}${source.url ? ` (${source.url})` : ""}`;
  }
}

type ProfileRow = {
  name: string;
  provider: string | null;
  module: string | null;
  /** Configured in beachside.json, or an official provider used from the environment alone. */
  source: "config" | "env";
  default: boolean;
  selected: boolean;
  setup: string[];
};

async function selection(session: Session): Promise<ProfileSelection | null> {
  try {
    return resolveProfileName(session.ctx.flags, await session.config(), session.ctx.env);
  } catch (cause) {
    if (cause instanceof CliError && cause.code === "USAGE") return null;
    throw cause;
  }
}

async function listProfiles(session: Session): Promise<number> {
  const loaded = await session.config();
  const selected = await selection(session);

  const rows: ProfileRow[] = Object.entries(loaded.value.profiles ?? {}).map(([name, profile]) => ({
    name,
    provider: profile.provider ?? null,
    module: profile.module ?? null,
    source: "config",
    default: loaded.value.default === name,
    selected: selected?.name === name,
    setup: profile.setup ?? [],
  }));

  // A provider picked with --provider or BEACHSIDE_PROVIDER is a profile too, from the environment.
  if (selected && !rows.some((row) => row.name === selected.name))
    rows.push({
      name: selected.name,
      provider: selected.name,
      module: descriptor(selected.name)?.module ?? null,
      source: "env",
      default: false,
      selected: true,
      setup: [],
    });

  const table = [
    ["", "NAME", "PROVIDER", "FROM", "SETUP"],
    ...rows.map((row) => [
      row.selected ? "*" : "",
      `${row.name}${row.default ? " (default)" : ""}`,
      row.provider ?? row.module ?? "-",
      row.source === "config" ? "beachside.json" : "environment",
      row.setup.join(",") || "-",
    ]),
  ];

  session.ctx.out.success(
    {
      config: { path: loaded.path, exists: loaded.exists },
      default: loaded.value.default ?? null,
      selected: selected?.name ?? null,
      profiles: rows,
    },
    rows.length
      ? renderRows(table)
      : `no profiles in ${loaded.path}\nset BEACHSIDE_PROVIDER and the provider's credentials, or add a profile (see \`beachside providers\`)`,
  );

  return 0;
}

function renderRows(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));

  return rows
    .map((row) =>
      row
        .map((cell, column) => cell.padEnd(widths[column]!))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** A profile and where it is defined. */
type NamedProfile = { profile: ProfileConfig; source: ProfileRow["source"] };

/** A configured profile by name, else an official provider used from the environment. */
function namedProfile(loaded: LoadedConfig, name: string): NamedProfile {
  const configured = loaded.value.profiles?.[name];

  if (configured) return { profile: configured, source: "config" };

  if (descriptor(name)) return { profile: { provider: name }, source: "env" };

  throw new CliError(
    "NOT_FOUND",
    `Profile ${name} is not defined in ${loaded.path}`,
    Object.keys(loaded.value.profiles ?? {}).length
      ? `known profiles: ${Object.keys(loaded.value.profiles ?? {}).join(", ")}`
      : "`beachside profile ls` lists profiles; an official provider id also works",
  );
}

async function showProfile(session: Session, names: string[]): Promise<number> {
  if (names.length > 1) throw usage("profile show takes at most one profile name");
  const { env, cwd } = session.ctx;
  const loaded = await session.config();

  const name =
    names[0] ??
    (await selection(session))?.name ??
    (() => {
      throw usage(
        "No profile selected",
        "pass a profile name, --profile, or set BEACHSIDE_PROVIDER; `beachside profile ls` lists them",
      );
    })();

  const { profile, source } = namedProfile(loaded, name);
  const known = profile.provider ? descriptor(profile.provider) : undefined;
  const module = profile.module ?? known?.module;

  const setup = module
    ? await adapterSetup(
        {
          name,
          module,
          export: profile.export ?? known?.export ?? "default",
          baseDir: loaded.dir,
          searchProject: searchProjectAdapters(loaded, env),
        },
        cwd,
        env,
      )
    : null;

  const describe = (
    kind: "credentials" | "config",
    values: Record<string, z.infer<ReturnType<typeof z.json>>>,
  ): Record<string, ValueSource> => {
    const declared = kind === "credentials" ? setup?.credentials : setup?.config;
    const keys = [...new Set([...Object.keys(declared ?? {}), ...Object.keys(values)])];

    return Object.fromEntries(
      keys.flatMap((key) => {
        const value = values[key];

        if (value !== undefined) return [[key, profileSource(value, kind === "credentials", env)]];
        const entry = declared?.[key];

        if (!entry) return [];

        if (env[entry.env]) return [[key, { from: "env", env: entry.env } satisfies ValueSource]];
        const required = kind === "credentials" || ("required" in entry && entry.required === true);

        return required
          ? [
              [
                key,
                { from: "missing", env: entry.env, url: entry.url ?? null } satisfies ValueSource,
              ],
            ]
          : [];
      }),
    );
  };

  const credentials = describe("credentials", profile.credentials ?? {});
  const config = describe("config", profile.config ?? {});

  const missing = Object.values({ ...credentials, ...config }).some(
    (item) => item.from === "missing",
  );

  const lines = [
    `profile   ${name}${loaded.value.default === name ? " (default)" : ""}`,
    `from      ${source === "config" ? loaded.path : "environment variables"}`,
    `adapter   ${profile.provider ?? profile.module ?? "-"}${setup || !module ? "" : " (not installed, or declares no setup)"}`,
    ...Object.entries(credentials).map(
      ([key, item]) => `  ${`credentials.${key}`.padEnd(24)} ${describeSource(item)}`,
    ),
    ...Object.entries(config).map(
      ([key, item]) => `  ${`config.${key}`.padEnd(24)} ${describeSource(item)}`,
    ),
    ...(profile.setup?.length ? [`setup     ${profile.setup.join(", ")}`] : []),
    ...(setup?.docs ? [`docs      ${setup.docs}`] : []),
  ];

  session.ctx.out.success(
    {
      name,
      source,
      default: loaded.value.default === name,
      provider: profile.provider ?? null,
      module: profile.module ?? null,
      export: profile.export ?? known?.export ?? null,
      credentials,
      config,
      setup: profile.setup ?? [],
      ready: !missing,
      docs: setup?.docs ?? null,
    },
    lines.join("\n"),
  );

  return 0;
}

/** The config file's own JSON, read again so a write keeps everything a parse would drop. */
async function rawConfig(
  loaded: LoadedConfig,
): Promise<Record<string, z.infer<ReturnType<typeof z.json>>>> {
  if (!loaded.exists) return {};

  return z.record(z.string(), z.json()).parse(JSON.parse(await readFile(loaded.path, "utf8")));
}

/**
 * Write beachside.json in place: validate it first, write a temporary file beside it and rename
 * it over, keeping the file's mode (a new file is 0600, since it may hold credentials).
 */
export async function writeConfig(
  loaded: LoadedConfig,
  value: Record<string, z.infer<ReturnType<typeof z.json>>>,
): Promise<void> {
  const parsed = CliConfig.safeParse(value);

  if (!parsed.success)
    throw usage(
      `The change would make ${loaded.path} invalid: ${z.prettifyError(parsed.error).replaceAll("\n", "; ")}`,
    );

  let mode = 0o600;

  try {
    mode = (await stat(loaded.path)).mode & 0o777;
  } catch {
    await mkdir(dirname(loaded.path), { recursive: true });
  }

  const temporary = join(dirname(loaded.path), `.beachside.json.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode, flag: "wx" });
  await chmod(temporary, mode);
  await rename(temporary, loaded.path);
}

async function useProfile(session: Session, names: string[]): Promise<number> {
  if (names.length !== 1) throw usage("profile use takes one profile name");
  const name = names[0]!;
  const loaded = await session.config();

  if (!loaded.value.profiles?.[name])
    throw new CliError(
      "NOT_FOUND",
      `Profile ${name} is not defined in ${loaded.path}`,
      descriptor(name)
        ? `add a profile for ${name} first, for example {"profiles": {"${name}": {"provider": "${name}"}}}; env-only providers are picked with BEACHSIDE_PROVIDER`
        : "`beachside profile ls` lists profiles",
    );

  const previous = loaded.value.default ?? null;

  if (previous !== name) await writeConfig(loaded, { ...(await rawConfig(loaded)), default: name });

  const overridden =
    session.ctx.flags.profile ??
    session.ctx.env.BEACHSIDE_PROFILE ??
    session.ctx.flags.provider ??
    session.ctx.env.BEACHSIDE_PROVIDER;

  session.ctx.out.success(
    { default: name, previous, changed: previous !== name, config: loaded.path },
    [
      previous === name
        ? `${name} is already the default`
        : `default profile is now ${name}${previous ? ` (was ${previous})` : ""}`,
      ...(overridden
        ? [
            `note: --profile, --provider, BEACHSIDE_PROFILE and BEACHSIDE_PROVIDER still win over the default`,
          ]
        : []),
    ].join("\n"),
  );

  return 0;
}

async function removeProfile(session: Session, flags: Flags, names: string[]): Promise<number> {
  if (names.length !== 1) throw usage("profile rm takes one profile name");
  const name = names[0]!;
  const loaded = await session.config();

  if (!loaded.value.profiles?.[name])
    throw new CliError("NOT_FOUND", `Profile ${name} is not defined in ${loaded.path}`);

  // Records keep the profile that made them; without it the CLI can't reach those resources.
  const store = await session.store();

  const inUse = (
    await Promise.all(
      (["sandbox", "snapshot", "image"] as const).map(async (kind) =>
        (await listAll(store, kind))
          .filter(({ record }) => record.profile === name)
          .map(({ record }) => `${kind} ${record.name}`),
      ),
    )
  ).flat();

  if (inUse.length && !flags.bool("force"))
    throw new CliError(
      "USAGE",
      `Profile ${name} is still used by ${inUse.length} record(s): ${inUse.slice(0, 5).join(", ")}${inUse.length > 5 ? ", ..." : ""}`,
      "remove them first (`beachside rm`, `snapshot rm`, `image rm`), or pass --force to remove the profile anyway; the CLI then can't reach them",
    );

  const raw = await rawConfig(loaded);
  const profiles = z.record(z.string(), z.json()).parse(raw.profiles ?? {});
  const { [name]: _removed, ...rest } = profiles;
  const wasDefault = loaded.value.default === name;
  const { default: _default, ...others } = raw;

  await writeConfig(loaded, { ...(wasDefault ? others : raw), profiles: rest });

  session.ctx.out.success(
    { removed: name, wasDefault, orphaned: inUse },
    [
      `removed profile ${name}${wasDefault ? "; there is no default profile now" : ""}`,
      ...(wasDefault && Object.keys(rest).length
        ? [`pick one with \`beachside profile use <name>\` (${Object.keys(rest).join(", ")})`]
        : []),
    ].join("\n"),
  );

  return 0;
}

export async function profileCommand(session: Session, flags: Flags): Promise<number> {
  const [action, ...args] = flags.positionals;

  if (action !== "rm" && flags.bool("force")) throw usage("--force applies only to profile rm");

  switch (action) {
    case "ls":
      if (args.length) throw usage("profile ls takes no arguments");

      return listProfiles(session);
    case "show":
      return showProfile(session, args);
    case "use":
      return useProfile(session, args);
    case "rm":
      return removeProfile(session, flags, args);
    default:
      throw usage(
        action ? `Unknown profile command ${action}` : "Expected a profile command",
        `use one of: ${profileActions.join(", ")}`,
      );
  }
}
