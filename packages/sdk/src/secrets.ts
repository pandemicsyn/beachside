import {
  type SecretBinding,
  type SecretRule,
  type SecretRuleOptions,
  SecretBinding as SecretBindingSchema,
  secretRules,
} from "@beachside/adapter";
import { BeachsideError } from "./resource";

const REDACTED = "[secret]";

export type SecretOptions = SecretRuleOptions;

/**
 * A credential for an environment variable. Brokered (the default) keeps the value out of the
 * sandbox: the variable holds a placeholder and the provider adds the real value to HTTPS
 * requests for the secret's hosts. Exposed puts the real value in the environment, still
 * redacted wherever Beachside prints or saves anything.
 */
export class Secret {
  readonly #value: string;
  /** `brokered` keeps the value out of the sandbox; `exposed` puts it in the environment. */
  readonly mode: "brokered" | "exposed";
  /** Hosts and headers the provider adds the value to; empty for exposed secrets. */
  readonly rules: readonly SecretRule[];
  constructor(value: string, mode: "brokered" | "exposed", rules: readonly SecretRule[]) {
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
 * A brokered secret: the sandbox never sees the value. Name a service preset with `for`
 * (`anthropic`, `openai`, `github`, `github-api`, `npm`) or list `hosts`.
 *
 * ```ts
 * env: { ANTHROPIC_API_KEY: secret(process.env.ANTHROPIC_API_KEY!, { for: "anthropic" }) }
 * ```
 */
export function secret(value: string, options: SecretOptions): Secret {
  let rules: SecretRule[];

  try {
    rules = secretRules(options ?? {});
  } catch (error) {
    throw new BeachsideError("INVALID_ARGUMENT", (error as Error).message);
  }

  return new Secret(checkedValue(value), "brokered", rules);
}

/** A secret whose real value is placed in the sandbox environment, redacted everywhere else. */
secret.exposed = function exposed(value: string): Secret {
  return new Secret(checkedValue(value), "exposed", []);
};

export type EnvValue = string | Secret;

/** Split public env into plain environment (exposed secrets included) and brokered bindings. */
export function splitEnv(env: Readonly<Record<string, EnvValue>> | undefined): {
  env?: Record<string, string>;
  secrets?: SecretBinding[];
} {
  if (env === undefined || env === null) return {};
  const plain: Record<string, string> = {};
  const secrets: SecretBinding[] = [];

  for (const [name, value] of Object.entries(env)) {
    if (!(value instanceof Secret)) {
      plain[name] = value;
      continue;
    }

    if (value.mode === "exposed") {
      plain[name] = value.reveal();
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

  const result: { env?: Record<string, string>; secrets?: SecretBinding[] } = {};

  if (Object.keys(plain).length) result.env = plain;

  if (secrets.length) result.secrets = secrets;

  return result;
}
