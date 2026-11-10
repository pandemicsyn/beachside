import { AdapterError, type Command } from "@beachside/adapter";

const EnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote one word for POSIX sh; the only special character inside quotes is `'`. */
export function quote(word: string): string {
  if (word.includes("\0"))
    throw new AdapterError("INVALID_ARGUMENT", "Arguments cannot contain NUL");

  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function checkedEnvKey(key: string): string {
  if (!EnvKey.test(key))
    throw new AdapterError("INVALID_ARGUMENT", "Environment variable names must be POSIX names");

  return key;
}

/** Throws before any effect when a variable name or value cannot be passed. */
export function checkEnv(env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) quote(`${checkedEnvKey(key)}=${value}`);
}

/**
 * The user's command as one sh line for Archil's process API, which takes a shell string:
 * an optional `cd`, quoted per-call exports (after the sandbox-wide environment Archil applies
 * to every process, so they override it), then `exec` of the program. argv stays arguments.
 */
export function commandLine(input: {
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
}): string {
  if (input.command.kind === "argv" && input.command.argv.length === 0)
    throw new AdapterError("INVALID_ARGUMENT", "argv must name a program");

  const env = Object.entries(input.env ?? {}).map(([key, value]) =>
    quote(`${checkedEnvKey(key)}=${value}`),
  );

  const program =
    input.command.kind === "argv"
      ? input.command.argv.map(quote).join(" ")
      : `/bin/sh -c ${quote(input.command.script)}`;

  // Exports are separate from `exec`, so the program word is never read as an assignment.
  const exports = env.length ? `export ${env.join(" ")}; ` : "";
  const run = `${exports}exec ${program}`;

  return input.cwd === undefined ? run : `cd -- ${quote(input.cwd)} && ${run}`;
}
