import type { ErrorReport } from "@beachside-internal/profile/output";
import { silentStatus, type ProgramStatus } from "./program-status";

export * from "@beachside-internal/profile/output";

const managementExitCodes = new Map([
  ["USAGE", 2],
  ["LOCAL_IO", 2],
  ["INVALID_ARGUMENT", 2],
  ["NOT_FOUND", 3],
  ["UNSUPPORTED", 4],
  ["ADAPTER_NOT_INSTALLED", 4],
  ["ADAPTER_LOAD_FAILED", 4],
  ["ADAPTER_INSTALLER_MISSING", 4],
  ["LIMIT_REACHED", 4],
  ["SECRET_TOOL_MISSING", 4],
  ["SECRET_UNAVAILABLE", 5],
  ["UNAUTHENTICATED", 5],
  ["FORBIDDEN", 5],
]);

/** Exit codes for commands other than exec and run. */
export function managementExitCode(report: ErrorReport): number {
  if (report.outcome === "partial") return 8;

  if (report.outcome === "unknown") return report.code === "INTERNAL" ? 1 : 6;

  if (report.retryable) return 7;

  return managementExitCodes.get(report.code) ?? 1;
}

/**
 * exec, sh and run pass the remote exit code through, so every CLI-side failure is 125.
 * Native deadlines give no portable "the command was stopped" evidence, so there is no 124.
 */
export function commandExitCode(): 125 {
  return 125;
}

export type Streams = {
  stdout: (text: string | Uint8Array) => void;
  /** Resolves once the stream can take more; streaming writers await it so output stays bounded. */
  ready?: (stream: "stdout" | "stderr") => Promise<void>;
  stderr: (text: string | Uint8Array) => void;
};

export class Output {
  constructor(
    readonly json: boolean,
    readonly streams: Streams,
    /** Terminal tab status (OSC 7501); silent unless stderr is a terminal that wants it. */
    readonly status: ProgramStatus = silentStatus,
  ) {}

  /** Print the command's single result: a JSON envelope or the human text. */
  success<T>(data: T, human: string): void {
    if (this.json) this.streams.stdout(`${JSON.stringify({ ok: true, data })}\n`);
    else if (human) this.streams.stdout(human.endsWith("\n") ? human : `${human}\n`);
  }

  failure(report: ErrorReport): void {
    if (this.json) {
      this.streams.stdout(`${JSON.stringify({ ok: false, error: report })}\n`);

      return;
    }

    this.streams.stderr(`beachside: ${report.message}\n`);

    if (report.hint) this.streams.stderr(`hint: ${report.hint}\n`);

    if (report.outcome === "unknown" && report.code !== "INTERNAL")
      this.streams.stderr(
        "The operation may have taken effect; inspect before retrying (beachside ls, beachside inspect).\n",
      );

    if (report.known?.reference)
      this.streams.stderr(`known sandbox reference: ${JSON.stringify(report.known.reference)}\n`);
    else if (report.known?.recovery)
      this.streams.stderr(
        `operation recovery reference: ${JSON.stringify(report.known.recovery)}\n`,
      );

    for (const item of report.details?.removed ?? []) this.streams.stdout(`${item.name}\n`);

    for (const item of report.details?.skipped ?? [])
      this.streams.stderr(`skipped ${item.name}: ${item.reason ?? item.result}\n`);

    for (const item of report.details?.failed ?? [])
      this.streams.stderr(`failed ${item.name}: ${item.code} ${item.reason ?? ""}\n`);
  }

  /** Diagnostics never go to stdout, so stdout stays parseable. */
  note(text: string): void {
    this.streams.stderr(`${text}\n`);
  }
}
