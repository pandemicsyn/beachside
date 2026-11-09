import { execFile } from "node:child_process";
import type { Json } from "@beachside/adapter";
import { BeachsideError, SECRET_PRESETS, secret, type Secret, type SecretTarget } from "beachside";
import { z } from "zod";
import type { Env } from "./config";
import { CliError, usage } from "./output";

/** A password manager whose CLI can read one secret by reference. */
type SecretBackend = {
  name: string;
  /** Matches the whole reference string. */
  pattern: RegExp;
  command: string;
  args: (reference: string) => string[];
  value: (stdout: string) => string;
  install: string;
  check: string;
};

const BwsSecret = z.object({ value: z.string() });

const backends: SecretBackend[] = [
  {
    // op://vault/item/field or op://vault/item/section/field
    name: "1Password",
    pattern: /^op:\/\/[^/\s]+\/[^/\s]+(\/[^/\s]+){1,2}(\?\S*)?$/,
    command: "op",
    args: (reference) => ["read", "--no-newline", reference],
    value: (stdout) => stdout,
    install: "install the 1Password CLI (https://developer.1password.com/docs/cli) and sign in",
    check: "check `op whoami` and that the vault, item and field exist",
  },
  {
    // bws://<secret-id>, read with BWS_ACCESS_TOKEN
    name: "Bitwarden Secrets Manager",
    pattern: /^bws:\/\/[0-9a-fA-F-]{36}$/,
    command: "bws",
    args: (reference) => ["secret", "get", reference.slice("bws://".length), "--output", "json"],
    value: (stdout) => BwsSecret.parse(JSON.parse(stdout)).value,
    install:
      "install the Bitwarden Secrets Manager CLI (https://bitwarden.com/help/secrets-manager-cli/) and set BWS_ACCESS_TOKEN",
    check: "check BWS_ACCESS_TOKEN and that the machine account can read the secret",
  },
  {
    // pass://path/in/store; the first line of the entry, as `pass -c` would copy
    name: "pass",
    pattern: /^pass:\/\/(?!.*(^|\/)\.\.(\/|$))[\w@+.-]+(\/[\w@+.-]+)*$/,
    command: "pass",
    args: (reference) => ["show", reference.slice("pass://".length)],
    value: (stdout) => stdout.split("\n")[0] ?? "",
    install: "install pass (https://www.passwordstore.org) and initialise your store",
    check: "check that `pass show <path>` works, including the GPG agent",
  },
];

function backendFor(value: string): SecretBackend | undefined {
  return backends.find((backend) => backend.pattern.test(value));
}

type RunResult = { code: number | string; stdout: string; stderr: string };

function run(command: string, args: string[], env: Env, signal: AbortSignal): Promise<RunResult> {
  return new Promise((done) => {
    execFile(
      command,
      args,
      { env: { ...env }, signal, timeout: 60_000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) =>
        done({
          code: error ? (error.code ?? "FAILED") : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        }),
    );
  });
}

/**
 * Reads password-manager references (`op://...`, `bws://...`, `pass://...`) through the manager's own CLI
 * when a profile connects, so secrets never need to be written into beachside.json. The CLI uses
 * its own sign-in. Each reference is read at most once per invocation and never stored.
 */
export class SecretReader {
  private readonly cache = new Map<string, Promise<string>>();

  constructor(
    private readonly env: Env,
    private readonly signal: AbortSignal,
  ) {}

  private read(backend: SecretBackend, reference: string, where: string): Promise<string> {
    let pending = this.cache.get(reference);

    if (!pending) {
      pending = this.fetch(backend, reference, where);
      this.cache.set(reference, pending);
    }

    return pending;
  }

  private async fetch(backend: SecretBackend, reference: string, where: string): Promise<string> {
    const result = await run(backend.command, backend.args(reference), this.env, this.signal);

    if (result.code === "ENOENT")
      throw new CliError(
        "SECRET_TOOL_MISSING",
        `${where} is a ${backend.name} reference, but \`${backend.command}\` is not installed`,
        backend.install,
      );

    // Only the manager's own diagnostics are shown; stdout may hold the secret.
    if (result.code !== 0)
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `Cannot read ${where} from ${backend.name} (${reference}): ${result.stderr.trim() || `${backend.command} exited with ${result.code}`}`,
        backend.check,
      );

    try {
      return backend.value(result.stdout);
    } catch {
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `${backend.name} returned an unreadable answer for ${where} (${reference})`,
        backend.check,
      );
    }
  }

  /**
   * One secret value from a source: `env:NAME`, `gh:` (the local `gh auth token`), or a
   * password-manager reference. Literals are allowed only from beachside.json, never from a flag
   * that would put the value in shell history.
   */
  async value(source: string, where: string, literal: boolean): Promise<string> {
    if (source.startsWith("env:")) {
      const name = source.slice(4);
      const value = this.env[name];

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value === undefined || value === "")
        throw new CliError(
          "SECRET_UNAVAILABLE",
          `${where} reads ${source}, which is not set in this environment`,
        );

      return value;
    }

    if (source === "gh:") {
      let pending = this.cache.get(source);

      if (!pending) {
        pending = this.githubToken(where);
        this.cache.set(source, pending);
      }

      return pending;
    }

    const backend = backendFor(source);

    if (backend) return this.read(backend, source, where);

    if (!literal)
      throw usage(
        `${where} needs a value source: env:NAME, gh:, op://, bws:// or pass://`,
        "literal values would land in shell history; name one in the secrets block of beachside.json instead",
      );

    return source;
  }

  private async githubToken(where: string): Promise<string> {
    const result = await run("gh", ["auth", "token"], this.env, this.signal);

    if (result.code === "ENOENT")
      throw new CliError(
        "SECRET_TOOL_MISSING",
        `${where} reads gh:, but \`gh\` is not installed`,
        "install the GitHub CLI (https://cli.github.com) and run `gh auth login`, or use a fine-grained PAT",
      );

    const token = result.stdout.trim();

    if (result.code !== 0 || !token)
      throw new CliError(
        "SECRET_UNAVAILABLE",
        `Cannot read ${where} from gh: ${result.stderr.trim() || "no token"}`,
        "run `gh auth login`, or use a fine-grained PAT from env:, op://, bws:// or pass://",
      );

    return token;
  }

  /** Replace every password-manager reference inside a config or credentials value. */
  async resolve(value: Json, where: string): Promise<Json> {
    const text = z.string().safeParse(value);

    if (text.success) {
      const backend = backendFor(text.data);

      return backend ? this.read(backend, text.data, where) : value;
    }

    if (Array.isArray(value))
      return Promise.all(value.map((item, index) => this.resolve(item, `${where}[${index}]`)));

    const record = z.record(z.string(), z.json()).safeParse(value);

    if (record.success)
      return Object.fromEntries(
        await Promise.all(
          Object.entries(record.data).map(
            async ([key, item]) => [key, await this.resolve(item, `${where}.${key}`)] as const,
          ),
        ),
      );

    return value;
  }
}

// SAFETY: SECRET_PRESETS is a non-empty record keyed by exactly the preset names.
const Preset = z.enum(Object.keys(SECRET_PRESETS) as [keyof typeof SECRET_PRESETS]);

/** One named secret in beachside.json's `secrets` block. */
export const SecretConfig = z.strictObject({
  /** A literal, env:NAME, gh:, op://, bws:// or pass:// */
  value: z.string().min(1),
  /** With `for` or `hosts` the value is kept out of the sandbox; without, it is a plain secret. */
  for: Preset.optional(),
  hosts: z.array(z.string().min(1)).min(1).max(32).optional(),
  header: z.string().min(1).optional(),
  format: z.enum(["raw", "bearer", "basic"]).optional(),
  username: z.string().min(1).optional(),
});

export type SecretConfig = z.infer<typeof SecretConfig>;

/** What the store keeps about a sandbox's secret: never the value or where it came from. */
export const SecretRecord = z.strictObject({
  env: z.string().min(1),
  mode: z.enum(["plain", "brokered"]),
  hosts: z.array(z.string()),
  /** The beachside.json secret it came from, when named. */
  named: z.string().optional(),
});

export type SecretRecord = z.infer<typeof SecretRecord>;

/** A parsed `--secret`, before its value is read. */
export type SecretSpec = {
  env: string;
  source: string;
  /** Where the value is used; absent for a plain secret. */
  target?: SecretTarget;
  named?: string;
  /** Whether the value may be a literal (only from beachside.json). */
  literal: boolean;
};

const EnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;

const SecretName = /^[a-z0-9][a-z0-9_-]{0,62}$/;

type TargetFields = Omit<SecretConfig, "value">;

/** A target from preset and hosts, checked now so a bad host fails before any value is read. */
export function targetFrom(fields: TargetFields, where: string): SecretTarget | undefined {
  const { for: preset, hosts, ...header } = fields;
  const [first, ...more] = hosts ?? [];
  let target: SecretTarget | undefined;

  if (first !== undefined) target = { ...header, hosts: [first, ...more] };

  if (preset !== undefined) target = { ...target, ...header, for: preset };

  if (!target) {
    if (Object.keys(header).length) throw usage(`${where}: header, format and username need hosts`);

    return undefined;
  }

  try {
    secret("probe", target);
  } catch (error) {
    throw usage(`${where}: ${error instanceof BeachsideError ? error.message : String(error)}`);
  }

  return target;
}

/**
 * `--secret NAME=<named>` uses a secret from beachside.json; `--secret NAME=<source>` puts the
 * value in the sandbox as a plain secret; `--secret NAME=<source>@<preset|host>[,...]` keeps it
 * out of the sandbox, added by the provider to HTTPS requests for those hosts.
 */
export function parseSecretFlags(
  entries: readonly string[],
  named: Readonly<Record<string, SecretConfig>> | undefined,
): SecretSpec[] {
  const specs: SecretSpec[] = [];

  for (const entry of entries) {
    const split = entry.indexOf("=");
    const env = split > 0 ? entry.slice(0, split) : "";

    if (!EnvName.test(env))
      throw usage(
        "--secret expects NAME=<named secret>, NAME=<source> or NAME=<source>@<preset|host>",
        "e.g. --secret ANTHROPIC_API_KEY=op://Dev/anthropic/key@anthropic",
      );

    if (specs.some((spec) => spec.env === env)) throw usage(`--secret ${env} is given twice`);
    const rest = entry.slice(split + 1);
    const at = rest.lastIndexOf("@");

    // A bare name refers to beachside.json; anything else is a value source.
    if (at < 0 && SecretName.test(rest)) {
      const config = named?.[rest];

      if (!config)
        throw usage(
          `--secret ${env}=${rest} names no secret in beachside.json`,
          named && Object.keys(named).length
            ? `named secrets: ${Object.keys(named).join(", ")}; or give a source such as env:NAME or op://...`
            : "add it to the secrets block of beachside.json, or give a source such as env:NAME or op://...",
        );
      const { value, ...fields } = config;
      const spec: SecretSpec = { env, source: value, named: rest, literal: true };
      const target = targetFrom(fields, `secrets.${rest}`);

      if (target) spec.target = target;
      specs.push(spec);
      continue;
    }

    const source = at < 0 ? rest : rest.slice(0, at);

    if (!source) throw usage(`--secret ${env} needs a value source before @`);
    const spec: SecretSpec = { env, source, literal: false };

    if (at >= 0) {
      const targets = rest
        .slice(at + 1)
        .split(",")
        .filter(Boolean);

      if (!targets.length) throw usage(`--secret ${env} needs a preset or host after @`);
      const presets = targets.filter((target) => Object.hasOwn(SECRET_PRESETS, target));

      if (presets.length > 1) throw usage(`--secret ${env} names more than one preset`);
      const hosts = targets.filter((target) => !presets.includes(target));
      const fields: TargetFields = {};

      if (presets[0]) fields.for = Preset.parse(presets[0]);

      if (hosts.length) fields.hosts = hosts;
      spec.target = targetFrom(fields, `--secret ${env}`);
    }

    specs.push(spec);
  }

  return specs;
}

/** Read each value once and wrap it; records carry names, modes and hosts only. */
export async function resolveSecrets(
  specs: readonly SecretSpec[],
  reader: SecretReader,
): Promise<{ env: Record<string, Secret>; records: SecretRecord[] }> {
  const env: Record<string, Secret> = {};
  const records: SecretRecord[] = [];

  // One at a time, so a password manager prompts at most once before caching its session.
  for (const spec of specs) {
    const where = spec.named ? `secret ${spec.named}` : `--secret ${spec.env}`;
    const value = await reader.value(spec.source, where, spec.literal);
    let wrapped: Secret;

    try {
      wrapped = secret(value, spec.target);
    } catch (error) {
      throw usage(`${where}: ${error instanceof BeachsideError ? error.message : String(error)}`);
    }

    env[spec.env] = wrapped;

    const record: SecretRecord = {
      env: spec.env,
      mode: wrapped.mode,
      hosts: [...new Set(wrapped.rules.map((rule) => rule.host))],
    };

    if (spec.named) record.named = spec.named;
    records.push(record);
  }

  return { env, records };
}

/** Where a named secret's value comes from, for listings; never the value itself. */
export function secretSourceKind(value: string): string {
  if (value.startsWith("env:")) return value;

  if (value === "gh:") return "gh:";

  const backend = backendFor(value);

  return backend ? backend.name : "literal";
}
