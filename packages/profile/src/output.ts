import { BeachsideError, OutcomeUnknownError } from "beachside";
import type { RecoveryReference, ResourceReference, SandboxReference } from "beachside";

/** A failure the CLI detected itself, before or around provider calls. */
export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly known?: Known,
    /** Whether an effect may already have happened; defaults to rejected (no effect). */
    readonly outcome: Outcome = code === "OUTCOME_UNKNOWN" ? "unknown" : "rejected",
    /** Per-item results for batch commands that stopped partway. */
    readonly details?: BatchDetails,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export type ExecSummary = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
};

export type BatchItem = { name: string; result: string; reason?: string };

export type BatchDetails = {
  removed: BatchItem[];
  skipped: BatchItem[];
  failed: (BatchItem & { code: string })[];
};

export function usage(message: string, hint?: string): CliError {
  return new CliError("USAGE", message, hint);
}

export type Known = {
  sandbox?: string;
  /** The image record an uncertain `beachside image build` keeps. */
  image?: string;
  /** The snapshot record an uncertain `beachside snapshot create` or `rm` keeps. */
  snapshot?: string;
  /** The snapshot a capture made when recording it failed. */
  snapshotReference?: ResourceReference;
  reference?: SandboxReference | null;
  /** The SDK's operation reference for an uncertain create; `beachside rm` uses it to recover. */
  recovery?: RecoveryReference;
  /** The command's captured result when a later step (cleanup, exit status) failed. */
  exec?: ExecSummary;
};

export type Outcome = "rejected" | "unknown" | "partial";

export type ErrorReport = {
  code: string;
  message: string;
  retryable: boolean;
  outcome: Outcome;
  hint?: string;
  known?: Known;
  details?: BatchDetails;
};

const retryableCodes = new Set(["RATE_LIMIT", "CAPACITY", "UNAVAILABLE"]);

/** Codes whose effect may already have happened, so blind retry is unsafe. */
const uncertainEffects = new Set(["possible", "unknown", "partial", "applied"]);

export function describeError(cause: unknown): ErrorReport {
  if (cause instanceof CliError)
    return {
      code: cause.code,
      message: cause.message,
      retryable: false,
      outcome: cause.outcome,
      hint: cause.hint,
      known: cause.known,
      details: cause.details,
    };

  if (cause instanceof BeachsideError) {
    const partial = cause.outcome?.status === "partial";

    let known: Known | undefined;

    if (cause.outcome && "sandbox" in cause.outcome && cause.outcome.sandbox)
      known = { reference: cause.outcome.sandbox };

    if (cause.reference) known = { ...known, recovery: cause.reference };

    const outcome: Outcome = partial
      ? "partial"
      : cause instanceof OutcomeUnknownError || uncertainEffects.has(cause.effect)
        ? "unknown"
        : "rejected";

    return {
      code: partial ? "PARTIAL" : cause.code,
      message: cause.message,
      retryable: outcome === "rejected" && retryableCodes.has(cause.code),
      outcome,
      known,
    };
  }

  // Local file errors (a missing --stdin-file, an unreadable cp source) happen before any effect.
  const local = cause instanceof Error && "syscall" in cause && "code" in cause;

  if (local)
    return {
      code: "LOCAL_IO",
      message: cause.message,
      retryable: false,
      outcome: "rejected",
    };

  return {
    code: "INTERNAL",
    message: cause instanceof Error ? cause.message : String(cause),
    retryable: false,
    outcome: "unknown",
  };
}
