import type { Env } from "@beachside-internal/profile/config";

/**
 * Program Status Protocol (OSC 7501) reports, so terminals such as Rex can show a command's
 * state on its tab: `ESC ] 7501 ; state=working:app=beachside:msg=<base64> ESC \`.
 *
 * Reports go to stderr and only to a terminal, so piped output and `--json` stay byte-clean.
 * `BEACHSIDE_PROGRAM_STATUS=on|off` overrides the default, which reports inside Rex only.
 */
export type ProgramState = "working" | "done" | "error";

export type ProgramStatus = {
  /** `progress` is a whole percentage for a `working` report; absent means indeterminate. */
  report(state: ProgramState, message: string, progress?: number): void;
  /** A desktop notification (OSC 777), for a long command that has finished. */
  notify(title: string, body: string): void;
};

/** The record id, so a program in the sandbox reporting its own root record never replaces ours. */
const id = "beachside";

/** The protocol allows 2048 decoded bytes; one short line is all a tab or picker shows. */
const maxMessageBytes = 512;

export const silentStatus: ProgramStatus = { report: () => {}, notify: () => {} };

export function programStatus(
  env: Env,
  terminal: boolean,
  write: (text: string) => void,
): ProgramStatus {
  const setting = env.BEACHSIDE_PROGRAM_STATUS?.toLowerCase();
  const wanted = setting === "on" || (setting !== "off" && Boolean(env.REX_SESSION));

  if (!wanted || !terminal) return silentStatus;

  return {
    report: (state, message, progress) => write(sequence(state, message, progress)),
    notify: (title, body) => write(notification(title, body)),
  };
}

export function sequence(state: ProgramState, message: string, progress?: number): string {
  const percent =
    state === "working" && progress !== undefined
      ? `:progress=${Math.max(0, Math.min(100, Math.floor(progress)))}`
      : "";

  return `\x1b]7501;state=${state}:id=${id}:app=beachside${percent}:msg=${encode(message)}\x1b\\`;
}

/** OSC 777 desktop notification. Fields are plain text, so `;` and control characters go. */
export function notification(title: string, body: string): string {
  return `\x1b]777;notify;${plain(title)};${plain(body)}\x1b\\`;
}

/**
 * Report a transfer's progress as bytes go by: one `working` report each time the whole
 * percentage changes. It stays below 100 until the caller reports the final state, since
 * `total` is an estimate (tar headers and padding add a little).
 */
export function meter(
  status: ProgramStatus,
  message: string,
  total: number,
): (bytes: number) => void {
  let sent = 0;
  let shown = -1;

  return (bytes) => {
    sent += bytes;
    const percent = total > 0 ? Math.min(99, Math.floor((sent / total) * 100)) : 0;

    if (percent === shown) return;
    shown = percent;
    status.report("working", message, percent);
  };
}

function plain(text: string): string {
  return Array.from(text, (char) => (isControl(char.codePointAt(0)!) || char === ";" ? " " : char))
    .join("")
    .trim()
    .slice(0, 256);
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
