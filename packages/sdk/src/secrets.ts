import {
  type SecretBinding,
  type SecretHeaderFormat,
  type SecretPreset,
  type SecretRule,
  SecretBinding as SecretBindingSchema,
  secretRules,
} from "@beachside/adapter";
import { BeachsideError } from "./resource";

const REDACTED = "[secret]";

type HeaderOptions = {
  /** Header for `hosts` (default `authorization`). */
  header?: string;
  /** Header format for `hosts` (default `bearer`). */
  format?: SecretHeaderFormat;
  /** Basic auth user name for `format: "basic"`. */
  username?: string;
};

/**
 * Where a secret is used, which keeps it out of the sandbox: a service preset, HTTPS hosts,
 * or both. At least one is required.
 */
export type SecretTarget =
  | (HeaderOptions & { for: SecretPreset; hosts?: readonly string[] })
  | (HeaderOptions & { for?: SecretPreset; hosts: readonly [string, ...string[]] });

/** @deprecated Use `SecretTarget`. */
export type SecretOptions = SecretTarget;

/**
 * A sensitive environment value. A plain secret puts the real value in the sandbox environment
 * and is redacted wherever Beachside prints or saves anything. With a target it is brokered:
 * the variable holds a placeholder and the provider adds the real value to HTTPS requests for
 * the target's hosts, so the sandbox never sees it.
 */
export class Secret {
  readonly #value: string;
  /** `plain` puts the value in the environment; `brokered` keeps it out of the sandbox. */
  readonly mode: "plain" | "brokered";
  /** Hosts and headers the provider adds the value to; empty for plain secrets. */
  readonly rules: readonly SecretRule[];
  constructor(value: string, mode: "plain" | "brokered", rules: readonly SecretRule[]) {
    this.#value = value;
    this.mode = mode;
    this.rules = Object.freeze(rules.map((rule) => Object.freeze(structuredClone(rule))));
    Object.freeze(this);
  }
  /** The real value, for code that hands it to a provider. Never log it. */
  reveal(): string {
    return this.#value;
  }
  toString(): string {
    return REDACTED;
  }
  toJSON(): string {
    return REDACTED;
  }
  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `Secret(${this.mode})`;
  }
}

function checkedValue(value: string): string {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can pass anything, and a missing env var is the common mistake.
  if (typeof value !== "string" || !value.length)
    throw new BeachsideError("INVALID_ARGUMENT", "A secret needs a non-empty string value");

  if (/[\r\n\0]/.test(value) || value.length > 8192)
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "A secret value must be at most 8192 characters without newlines or NUL",
    );

  return value;
}

/**
 * A secret for an environment variable.
 *
 * Without a target it is a plain secret: the sandbox gets the real value, which Beachside
 * never prints or saves. With a target (a service preset in `for`, or `hosts`) the sandbox
 * gets a placeholder instead and the provider adds the value to HTTPS requests for those
 * hosts; adapters that cannot do that refuse the create.
 *
 * ```ts
 * env: {
 *   DECRYPT_KEY: secret(process.env.DECRYPT_KEY!),
 *   ANTHROPIC_API_KEY: secret(process.env.ANTHROPIC_API_KEY!, { for: "anthropic" }),
 * }
 * ```
 */
export function secret(value: string, target?: SecretTarget): Secret {
  if (target === undefined) return new Secret(checkedValue(value), "plain", []);
  let rules: SecretRule[];

  try {
    rules = secretRules(target);
  } catch (error) {
    // SAFETY: secretRules throws only plain Errors with value-free messages.
    throw new BeachsideError("INVALID_ARGUMENT", (error as Error).message);
  }

  return new Secret(checkedValue(value), "brokered", rules);
}

export type EnvValue = string | Secret;

/** Split public env into the environment (plain secrets included) and brokered bindings. */
export type SplitEnv = {
  /** The environment, plain secrets included. */
  env?: Record<string, string>;
  /** Names in `env` that hold plain secrets, for adapters that keep them in a secret store. */
  secretEnv?: string[];
  /** Brokered bindings for the adapter. */
  secrets?: SecretBinding[];
};

export function splitEnv(env: Readonly<Record<string, EnvValue>> | undefined): SplitEnv {
  if (env === undefined || env === null) return {};
  const plain: Record<string, string> = {};
  const secretEnv: string[] = [];
  const secrets: SecretBinding[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (!(value instanceof Secret)) {
      plain[name] = value;
      continue;
    }

    if (value.mode === "plain") {
      plain[name] = value.reveal();
      secretEnv.push(name);
      continue;
    }

    const binding = SecretBindingSchema.safeParse({
      env: name,
      value: value.reveal(),
      rules: value.rules.map((rule) => structuredClone(rule)),
    });

    if (!binding.success)
      throw new BeachsideError(
        "INVALID_ARGUMENT",
        `Invalid secret for ${/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : "an env entry"}: names must match [A-Za-z_][A-Za-z0-9_]* with at most 32 host rules`,
      );
    secrets.push(binding.data);
  }

  const result: SplitEnv = {};

  if (Object.keys(plain).length) result.env = plain;

  if (secretEnv.length) result.secretEnv = secretEnv;

  if (secrets.length) result.secrets = secrets;

  return result;
}
