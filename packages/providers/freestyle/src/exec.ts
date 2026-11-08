import { AdapterError, type Command } from "@beachside/adapter";

/**
 * Freestyle's `exec-await` runs one command line through the guest shell and returns
 * stdout/stderr as UTF-8 text with invalid bytes replaced, and no documented size bound.
 * To keep argv as arguments and output as bytes, the adapter sends a small POSIX sh
 * wrapper: the user's command writes stdout/stderr to private files in the guest, and the
 * wrapper prints one header line. Small results follow inline as base64; larger ones stay
 * in the guest for a raw-byte download through the filesystem API. User output is never
 * read as a control record.
 */
export const EXEC_RECORD = "BEACHSIDE-EXEC-1";

/** Combined bound for results returned inline instead of downloaded. */
export const INLINE_BYTES = 32 * 1024;

const EnvKey = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Single-quote one word for POSIX sh; the only special character inside quotes is `'`. */
export function quote(word: string): string {
  if (word.includes("\0"))
    throw new AdapterError("INVALID_ARGUMENT", "Arguments cannot contain NUL");

  return `'${word.replaceAll("'", `'\\''`)}'`;
}

export type WrapperInput = {
  command: Command;
  cwd?: string;
  env?: Record<string, string>;
  /** True when finite stdin bytes travel in the native `stdin` field; otherwise stdin is empty. */
  stdin?: boolean;
  /** Per-stream byte bound applied in the guest. */
  maxBytes: number;
};

/**
 * Sandbox-wide environment written at create. Freestyle takes environment variables only per
 * command, so every command, process and terminal sources this file before its own `env`.
 */
export const ENV_FILE = "/etc/beachside.env";

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
export function commandLine(input: Pick<WrapperInput, "command" | "cwd" | "env">): string {
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
  const run = `{ if [ -r ${ENV_FILE} ]; then . ${ENV_FILE}; fi; ${exports}exec ${program}; }`;

  return input.cwd === undefined ? run : `cd -- ${quote(input.cwd)} && ${run}`;
}

export function wrapperScript(input: WrapperInput): string {
  const body = commandLine(input);
  // Native stdin reaches the wrapper's own stdin, which the command inherits.
  const stdin = input.stdin ? "" : " </dev/null";
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
    `: >"$beachside_d/done"; kill "$beachside_w" 2>/dev/null; wait "$beachside_w" 2>/dev/null; rm -f "$beachside_d/done"`,
    `beachside_ol=$(($(wc -c <"$beachside_d/stdout.raw"))); beachside_el=$(($(wc -c <"$beachside_d/stderr.raw")))`,
    `head -c ${bound} "$beachside_d/stdout.raw" >"$beachside_d/stdout"; head -c ${bound} "$beachside_d/stderr.raw" >"$beachside_d/stderr"`,
    `rm -f "$beachside_d/stdout.raw" "$beachside_d/stderr.raw"`,
    `if [ $(($(wc -c <"$beachside_d/stdout") + $(wc -c <"$beachside_d/stderr"))) -le ${INLINE_BYTES} ]; then`,
    `printf '${EXEC_RECORD} inline %s %s %s\\n' "$beachside_c" "$beachside_ol" "$beachside_el"`,
    `base64 <"$beachside_d/stdout" | tr -d '\\n'; printf '\\n'`,
    `base64 <"$beachside_d/stderr" | tr -d '\\n'; printf '\\n'`,
    `rm -rf "$beachside_d"`,
    "else",
    `printf '${EXEC_RECORD} files %s %s %s %s\\n' "$beachside_c" "$beachside_ol" "$beachside_el" "$beachside_d"`,
    "fi",
  ].join("\n");
}

export type WrapperResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
};

/** Output left in the guest: download `${directory}/stdout` and `${directory}/stderr`, then remove it. */
export type WrapperFiles = {
  exitCode: number;
  stdoutLength: number;
  stderrLength: number;
  directory: string;
};

const Inline = new RegExp(
  `^${EXEC_RECORD} inline (\\d{1,3}) (\\d{1,15}) (\\d{1,15})\\n([A-Za-z0-9+/]*={0,2})\\n([A-Za-z0-9+/]*={0,2})\\n$`,
);

const Files = new RegExp(
  `^${EXEC_RECORD} files (\\d{1,3}) (\\d{1,15}) (\\d{1,15}) (/tmp/beachside-exec\\.[A-Za-z0-9]{8})\\n$`,
);

/** Decode the wrapper record, or null when it is missing or malformed. */
export function parseWrapper(stdout: string): WrapperResult | WrapperFiles | null {
  const files = Files.exec(stdout);

  if (files) {
    const [, code, outLength, errLength, directory = ""] = files;

    return {
      exitCode: Number(code),
      stdoutLength: Number(outLength),
      stderrLength: Number(errLength),
      directory,
    };
  }

  const match = Inline.exec(stdout);

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

/**
 * Assemble a downloaded result. A stream shorter than the guest reported keeps the confirmed
 * exit and is marked truncated (`complete: false`); one longer than reported is not this
 * command's output, so the result is null.
 */
export function filesResult(
  files: WrapperFiles,
  stdout: Uint8Array,
  stderr: Uint8Array,
  maxBytes: number,
): { result: WrapperResult; complete: boolean } | null {
  const expected = (length: number) => Math.min(length, Math.max(0, Math.floor(maxBytes)));
  const outExpected = expected(files.stdoutLength);
  const errExpected = expected(files.stderrLength);

  if (stdout.byteLength > outExpected || stderr.byteLength > errExpected) return null;

  return {
    complete: stdout.byteLength === outExpected && stderr.byteLength === errExpected,
    result: {
      exitCode: files.exitCode,
      stdout,
      stderr,
      truncated: stdout.byteLength < files.stdoutLength || stderr.byteLength < files.stderrLength,
    },
  };
}
