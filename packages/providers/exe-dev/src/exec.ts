import { AdapterError, type Command } from "@beachside/adapter";

/**
 * exe.dev runs one shell line per `ssh <vm> <command>` request and streams stdout and stderr
 * back as separate byte frames with the exit code. It has no stdin, no per-request deadline
 * and no output bound, so the adapter sends a small POSIX sh wrapper: the user's command
 * writes stdout/stderr to private files in the guest (bounded while it runs), and the wrapper
 * prints one record with the exit code, both stream lengths and the kept bytes as base64.
 * User output is never read as a control record.
 */
export const EXEC_RECORD = "BEACHSIDE-EXEC-1";

const EnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote one word for POSIX sh; the only special character inside quotes is `'`. */
export function quote(word: string): string {
  if (word.includes("\0"))
    throw new AdapterError("INVALID_ARGUMENT", "Arguments cannot contain NUL");

  return `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * Sandbox-wide environment written at create, in the login user's home directory. Every
 * command, process and terminal sources it before its own `env`, so it survives `pause`,
 * restarts and copies with the disk.
 */
export const ENV_FILE = "$HOME/.beachside.env";

function checkedEnvKey(key: string): string {
  if (!EnvKey.test(key))
    throw new AdapterError("INVALID_ARGUMENT", "Environment variable names must be POSIX names");

  return key;
}

/** The env file: a marker naming the create attempt, then one quoted export per variable. */
export function envFile(env: Record<string, string>, attempt: string): Uint8Array {
  const lines = Object.entries(env).map(
    ([key, value]) => `export ${checkedEnvKey(key)}=${quote(value)}`,
  );

  return new TextEncoder().encode([envMarker(attempt), ...lines, ""].join("\n"));
}

export function envMarker(attempt: string): string {
  return `# beachside ${attempt}`;
}

/** Throws before any effect when a variable name or value cannot be written. */
export function checkEnv(env: Record<string, string> | undefined): void {
  for (const [key, value] of Object.entries(env ?? {})) quote(`${checkedEnvKey(key)}=${value}`);
}

/** The user's command as one sh line: optional `cd`, quoted exports, then `exec` of the program. */
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

  // The sandbox-wide environment first, so a per-call entry overrides the same key. Exports
  // are separate from `exec`, so the program word is never read as an assignment.
  const exports = env.length ? `export ${env.join(" ")}; ` : "";
  const run = `{ if [ -r "${ENV_FILE}" ]; then . "${ENV_FILE}"; fi; ${exports}exec ${program}; }`;

  return input.cwd === undefined ? run : `cd -- ${quote(input.cwd)} && ${run}`;
}

export type WrapperInput = {
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
  /** A guest file holding finite stdin bytes; the wrapper removes it. Otherwise stdin is empty. */
  stdinPath?: string;
  /** Combined byte bound applied in the guest, stdout first. */
  maxBytes: number;
};

export function wrapperScript(input: WrapperInput): string {
  const body = commandLine(input);
  const stdin = input.stdinPath === undefined ? " </dev/null" : ` <${quote(input.stdinPath)}`;
  const bound = Math.max(0, Math.floor(input.maxBytes));

  return [
    "beachside_d=$(mktemp -d /tmp/beachside-exec.XXXXXXXX) || exit 97",
    // While the command runs, a watcher frees the disk blocks past the bound in both raw files
    // (punched holes keep the apparent size, which is the stream's total length), so a noisy
    // command cannot fill the guest disk. It is best effort where the filesystem lacks holes.
    `(while [ ! -e "$beachside_d/done" ]; do for beachside_s in stdout stderr; do beachside_z=$(($(wc -c <"$beachside_d/$beachside_s.raw" 2>/dev/null || echo 0))); if [ "$beachside_z" -gt ${bound} ]; then fallocate -p -o ${bound} -l $((beachside_z - ${bound})) "$beachside_d/$beachside_s.raw" 2>/dev/null; fi; done; sleep 0.2; done) </dev/null >/dev/null 2>&1 &`,
    "beachside_w=$!",
    `(${body})${stdin} >"$beachside_d/stdout.raw" 2>"$beachside_d/stderr.raw"`,
    "beachside_c=$?",
    ...(input.stdinPath === undefined ? [] : [`rm -f -- ${quote(input.stdinPath)}`]),
    `: >"$beachside_d/done"; kill "$beachside_w" 2>/dev/null; wait "$beachside_w" 2>/dev/null`,
    `beachside_ol=$(($(wc -c <"$beachside_d/stdout.raw"))); beachside_el=$(($(wc -c <"$beachside_d/stderr.raw")))`,
    `beachside_ok=$((beachside_ol < ${bound} ? beachside_ol : ${bound}))`,
    `printf '${EXEC_RECORD} %s %s %s\\n' "$beachside_c" "$beachside_ol" "$beachside_el"`,
    `head -c "$beachside_ok" "$beachside_d/stdout.raw" | base64 | tr -d '\\n'; printf '\\n'`,
    `head -c $((${bound} - beachside_ok)) "$beachside_d/stderr.raw" | base64 | tr -d '\\n'; printf '\\n'`,
    `rm -rf "$beachside_d"`,
  ].join("\n");
}

export type WrapperResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
};

const Record = new RegExp(
  `^${EXEC_RECORD} (\\d{1,3}) (\\d{1,15}) (\\d{1,15})\\n([A-Za-z0-9+/]*={0,2})\\n([A-Za-z0-9+/]*={0,2})\\n$`,
);

/** Decode the wrapper record, or null when it is missing or malformed. */
export function parseWrapper(stdout: string): WrapperResult | null {
  const match = Record.exec(stdout);

  if (!match) return null;
  const [, code, outLength, errLength, out = "", err = ""] = match;
  const stdoutBytes = Buffer.from(out, "base64");
  const stderrBytes = Buffer.from(err, "base64");
  const lengths = [Number(outLength), Number(errLength)] as const;

  if (
    stdoutBytes.length > lengths[0] ||
    stderrBytes.length > lengths[1] ||
    stdoutBytes.toString("base64") !== out ||
    stderrBytes.toString("base64") !== err
  )
    return null;

  return {
    exitCode: Number(code),
    stdout: new Uint8Array(stdoutBytes),
    stderr: new Uint8Array(stderrBytes),
    truncated: stdoutBytes.length < lengths[0] || stderrBytes.length < lengths[1],
  };
}
