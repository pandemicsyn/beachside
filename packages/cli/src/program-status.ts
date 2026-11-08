import type { Env } from "./config";

/**
 * Program Status Protocol (OSC 7501) reports, so terminals such as Rex can show a command's
 * state on its tab: `ESC ] 7501 ; state=working:app=beachside:msg=<base64> ESC \`.
 *
 * Reports go to stderr and only to a terminal, so piped output and `--json` stay byte-clean.
 * `BEACHSIDE_PROGRAM_STATUS=on|off` overrides the default, which reports inside Rex only.
 */
export type ProgramState = "working" | "done" | "error";

export type ProgramStatus = {
  report(state: ProgramState, message: string): void;
};

/** The record id, so a program in the sandbox reporting its own root record never replaces ours. */
const id = "beachside";

/** The protocol allows 2048 decoded bytes; one short line is all a tab or picker shows. */
const maxMessageBytes = 512;

export const silentStatus: ProgramStatus = { report: () => {} };

export function programStatus(
  env: Env,
  terminal: boolean,
  write: (text: string) => void,
): ProgramStatus {
  const setting = env.BEACHSIDE_PROGRAM_STATUS?.toLowerCase();
  const wanted = setting === "on" || (setting !== "off" && Boolean(env.REX_SESSION));

  if (!wanted || !terminal) return silentStatus;

  return { report: (state, message) => write(sequence(state, message)) };
}

export function sequence(state: ProgramState, message: string): string {
  return `\x1b]7501;state=${state}:id=${id}:app=beachside:msg=${encode(message)}\x1b\\`;
}

/** Base64 of one line: control characters would make the terminal discard the whole report. */
function encode(message: string): string {
  const line = Array.from(message, (char) => (isControl(char.codePointAt(0)!) ? " " : char))
    .join("")
    .trim();

  let bytes = Buffer.from(line, "utf8");

  if (bytes.length > maxMessageBytes) {
    // Cut on a code point boundary so the decoded text is still valid UTF-8.
    let end = maxMessageBytes;

    while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
    bytes = bytes.subarray(0, end);
  }

  return bytes.toString("base64");
}

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}
