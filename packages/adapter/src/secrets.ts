import { z } from "zod";
import { AdapterError } from "./errors";

/**
 * How an adapter keeps a brokered secret out of the sandbox:
 * - `placeholder`: the provider puts its own placeholder in the environment variable and swaps
 *   the real value into outbound HTTPS headers for the bound hosts (Daytona, boxd).
 * - `header`: the provider's egress proxy sets the whole header for the bound hosts; the
 *   environment variable holds a fixed Beachside placeholder (E2B, Vercel, Freestyle, Modal).
 */
export type SecretDelivery = "placeholder" | "header" | "gateway";

export type SecretSupport = {
  delivery: SecretDelivery;
  /** Can broker `basic` headers (git over HTTPS). */
  basicAuth: boolean;
  /** Accepts `*.example.com` host patterns. */
  wildcardHosts: boolean;
  /** Most brokered secrets one sandbox can carry. */
  maxSecrets: number;
  /** Only these hosts can be brokered (a gateway's known services); absent means any host. */
  hosts?: readonly string[];
  /**
   * Provider secrets are shared by name across the account's sandboxes: a second sandbox with
   * the same variable name and a different value changes it for both.
   */
  shared?: boolean;
};

/** Names of `env` entries that hold plain secrets. */
export const SecretEnvNames = z
  .array(
    z
      .string()
      .max(256)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  )
  .max(256);

export const SecretHeaderFormat = z.enum(["raw", "bearer", "basic"]);

export type SecretHeaderFormat = z.infer<typeof SecretHeaderFormat>;

const HOST = /^(\*\.)?([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

export const SecretHost = z.string().max(253).regex(HOST);

export const SecretHeader = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/),
  format: SecretHeaderFormat,
  /** Basic auth user name; the secret is the password. */
  username: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^:\r\n\0]+$/)
    .optional(),
});

export type SecretHeader = z.infer<typeof SecretHeader>;

export const SecretRule = z.strictObject({ host: SecretHost, header: SecretHeader });

export type SecretRule = z.infer<typeof SecretRule>;

export const MAX_SECRETS = 64;

/**
 * One brokered secret: the environment variable it is exposed as (holding a placeholder,
 * never the value) and the hosts whose requests carry it. Values are never persisted in
 * recovery tokens or included in messages.
 */
export const SecretBinding = z.strictObject({
  env: z
    .string()
    .max(256)
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  value: z
    .string()
    .min(1)
    .max(8192)
    .refine((value) => !/[\r\n\0]/.test(value)),
  rules: z.array(SecretRule).min(1).max(32),
});

export type SecretBinding = z.infer<typeof SecretBinding>;

export const SecretBindings = z
  .array(SecretBinding)
  .max(MAX_SECRETS)
  .refine((bindings) => new Set(bindings.map((binding) => binding.env)).size === bindings.length);

/** The environment value a header-delivery adapter puts in the sandbox for a brokered secret. */
export function secretPlaceholder(env: string): string {
  return `beachside:${env}`;
}

/** The full header value the proxy sends upstream. */
export function secretHeaderValue(value: string, header: SecretHeader): string {
  if (header.format === "bearer") return `Bearer ${value}`;

  if (header.format === "basic") return `Basic ${base64(`${header.username ?? ""}:${value}`)}`;

  return value;
}

function base64(text: string): string {
  let binary = "";

  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);

  return btoa(binary);
}

/** Every string a native error could echo for these secrets, for message redaction. */
export function secretValues(bindings: readonly SecretBinding[] | undefined): string[] {
  return (bindings ?? []).flatMap((binding) => [
    binding.value,
    ...binding.rules.flatMap((rule) =>
      rule.header.format === "raw" ? [] : [secretHeaderValue(binding.value, rule.header)],
    ),
  ]);
}

/** Hosts each binding reaches, deduplicated in first-seen order. */
export function secretHosts(binding: SecretBinding): string[] {
  return [...new Set(binding.rules.map((rule) => rule.host))];
}

/** Why this adapter cannot broker these secrets, or null. Names never include values. */
export function secretsProblem(
  support: SecretSupport | undefined,
  bindings: readonly SecretBinding[] | undefined,
): string | null {
  if (!bindings?.length) return null;

  if (!support)
    return "Targeted secrets are unsupported by this adapter: it cannot keep a value out of the sandbox. Use secret(value) without a target to put the value in the sandbox environment instead";

  if (bindings.length > support.maxSecrets)
    return `This adapter brokers at most ${support.maxSecrets} secrets per sandbox`;

  const headers = new Set<string>();

  for (const binding of bindings)
    for (const rule of binding.rules) {
      const key = `${rule.host} ${rule.header.name.toLowerCase()}`;

      if (support.delivery === "header" && headers.has(key))
        return `Two secrets set the ${rule.header.name.toLowerCase()} header for ${rule.host}`;
      headers.add(key);

      if (rule.header.format === "basic" && !support.basicAuth)
        return `Secret ${binding.env}: ${rule.host} needs Basic auth, which this adapter cannot broker. Use a plain secret(value), or a preset without that host (github-api instead of github)`;

      if (rule.host.startsWith("*.") && !support.wildcardHosts)
        return `Secret ${binding.env}: wildcard host ${rule.host} is unsupported by this adapter`;

      if (support.hosts && !support.hosts.includes(rule.host))
        return `Secret ${binding.env}: this adapter brokers only ${support.hosts.join(", ")}, not ${rule.host}. Use a plain secret() to put the value in the sandbox instead`;
    }

  return null;
}

export type SecretPreset = "anthropic" | "openai" | "github" | "github-api" | "npm";

export const SECRET_PRESETS: Readonly<Record<SecretPreset, readonly SecretRule[]>> = {
  anthropic: [{ host: "api.anthropic.com", header: { name: "x-api-key", format: "raw" } }],
  openai: [{ host: "api.openai.com", header: { name: "authorization", format: "bearer" } }],
  "github-api": [{ host: "api.github.com", header: { name: "authorization", format: "bearer" } }],
  github: [
    { host: "api.github.com", header: { name: "authorization", format: "bearer" } },
    {
      host: "github.com",
      header: { name: "authorization", format: "basic", username: "x-access-token" },
    },
  ],
  npm: [{ host: "registry.npmjs.org", header: { name: "authorization", format: "bearer" } }],
};

export function isSecretPreset(value: string): value is SecretPreset {
  return Object.hasOwn(SECRET_PRESETS, value);
}

export type SecretRuleOptions = {
  /** A service preset: its hosts and header format. */
  for?: SecretPreset;
  /** Hosts whose HTTPS requests carry the secret, added to the preset's. */
  hosts?: readonly string[];
  /** Header for `hosts` (default `authorization`). */
  header?: string;
  /** Header format for `hosts` (default `bearer`). */
  format?: SecretHeaderFormat;
  /** Basic auth user name for `format: "basic"`. */
  username?: string;
};

/** Expand a preset and raw hosts into validated rules; throws a value-free message. */
export function secretRules(options: SecretRuleOptions): SecretRule[] {
  const rules: SecretRule[] = [];

  if (options.for !== undefined) {
    if (!isSecretPreset(options.for))
      throw new Error(
        `Unknown secret preset '${options.for}'; use one of ${Object.keys(SECRET_PRESETS).join(", ")}, or hosts`,
      );
    rules.push(...SECRET_PRESETS[options.for].map((rule) => structuredClone(rule)));
  }

  const format = options.format ?? "bearer";

  for (const host of options.hosts ?? []) {
    const header: SecretHeader = { name: options.header ?? "authorization", format };

    if (options.username !== undefined) header.username = options.username;
    const rule = SecretRule.safeParse({ host: host.toLowerCase(), header });

    if (!rule.success)
      throw new Error(
        `Invalid secret host or header: '${host}' must be a DNS name (optionally *.name), and the header a valid HTTP header name`,
      );
    rules.push(rule.data);
  }

  if (!rules.length) throw new Error("A brokered secret needs `for` (a service preset) or `hosts`");

  return rules;
}

/**
 * Headers to set per host for header-delivery adapters. Two secrets that set the same header
 * on the same host are a conflict, rejected before any effect.
 */
export function secretHeadersByHost(
  bindings: readonly SecretBinding[] | undefined,
): Map<string, Record<string, string>> {
  const hosts = new Map<string, Record<string, string>>();

  for (const binding of bindings ?? [])
    for (const rule of binding.rules) {
      const headers = hosts.get(rule.host) ?? {};
      const name = rule.header.name.toLowerCase();

      if (Object.hasOwn(headers, name))
        throw new AdapterError(
          "INVALID_ARGUMENT",
          `Two secrets set the ${name} header for ${rule.host}`,
        );
      headers[name] = secretHeaderValue(binding.value, rule.header);
      hosts.set(rule.host, headers);
    }

  return hosts;
}

/** Plain env plus each brokered secret's placeholder, for adapters that pick the placeholder. */
export function envWithSecretPlaceholders(
  env: Readonly<Record<string, string>> | undefined,
  bindings: readonly SecretBinding[] | undefined,
): Record<string, string> | undefined {
  if (!bindings?.length) return env ? { ...env } : undefined;
  const result = { ...env };

  for (const binding of bindings) result[binding.env] = secretPlaceholder(binding.env);

  return result;
}

/** Replace every secret value (and computed header value) in a native message. */
export function redactSecrets(
  text: string,
  bindings: readonly SecretBinding[] | undefined,
): string {
  let result = text;

  for (const value of secretValues(bindings).sort((a, b) => b.length - a.length))
    result = result.split(value).join("[secret]");

  return result;
}
