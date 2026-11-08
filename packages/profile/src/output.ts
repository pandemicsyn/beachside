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
