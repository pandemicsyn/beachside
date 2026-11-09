import type { AdapterSandbox } from "./adapter-direct";
import { BeachsideError } from "./resource";
import { SandboxCleanupError } from "./scoped-sandbox";
import {
  SetupFailedError,
  planSetup,
  readSetupState,
  resolveSetup,
  runSetupPlan,
  type ResolvedSetup,
  type SetupCreateOptions,
  type SetupReport,
  type SetupRunContext,
  type SetupRunOptions,
  type SetupTarget,
} from "./setup";

const reports = new WeakMap<AdapterSandbox, SetupReport>();

/** The last setup report recorded for this handle, or null. */
export function setupReportOf(box: AdapterSandbox): SetupReport | null {
  return reports.get(box) ?? null;
}

export function recordSetupReport(box: AdapterSandbox, report: SetupReport): void {
  reports.set(box, report);
}

const EnvName = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Check `runSetup({ env })`: names a shell accepts, string values. */
export function validateSetupEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env))
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Callers may pass anything from JavaScript.
    if (!EnvName.test(key) || typeof value !== "string")
      throw new BeachsideError("INVALID_ARGUMENT", `Invalid setup env ${key}`, "none");
}

/** Extra controls for `box.runSetup()`. */
export type RunSetupOptions = {
  /** Run every step, even ones the sandbox already recorded. */
  force?: boolean;
  /** `run` also runs the startup the sandbox recorded when no startup is passed. */
  recordedStartup?: "run" | "skip";
  /**
   * `false` runs the steps with setup's output and errors but leaves the sandbox's setup record
   * alone, for helper steps that are not part of the sandbox's setup.
   */
  record?: boolean;
  /**
   * Environment for every step, under each step's own `env`. Like the sandbox's own env it is
   * not part of the digest, so a rotated token does not rerun setup.
   */
  env?: Record<string, string>;
};

export function wantsSetup(options: SetupCreateOptions): boolean {
  return options.setup !== undefined || options.startup !== undefined;
}

/** Resolve before any provider call, so a bad step or unreadable file costs nothing. */
export async function prepareSetup(options: SetupCreateOptions): Promise<ResolvedSetup | null> {
  return wantsSetup(options) ? resolveSetup(options) : null;
}

export type SetupHost = {
  target(box: AdapterSandbox): SetupTarget;
  streams: boolean;
};

/**
 * Run setup on a sandbox this call created or restored. `restored` reads the sandbox's state
 * first, so setup the snapshot already holds is skipped and its recorded startup runs. On
 * failure the new sandbox is destroyed unless `onSetupFailure: "keep"`.
 */
export async function applySetup(
  box: AdapterSandbox,
  host: SetupHost,
  resolved: ResolvedSetup | null,
  options: SetupCreateOptions,
  mode: "created" | "restored",
  signal?: AbortSignal,
): Promise<AdapterSandbox> {
  const target = host.target(box);
  const runsRecorded = mode === "restored" && options.recordedStartup !== "skip";
  // A restore reads the state for its recorded startup, and for setup the snapshot already holds.
  const readsState = runsRecorded || (mode === "restored" && resolved !== null);
  const recorded = readsState ? await readSetupState(target, signal) : null;

  if (!resolved && !recorded?.startup.length) return box;

  const plan = planSetup(
    resolved ?? { setup: [], startup: [], digest: null, names: [], cache: undefined },
    recorded,
    { startupFromRecord: runsRecorded },
  );

  if (!plan.setup.length && !plan.startup.length) return box;

  try {
    recordSetupReport(
      box,
      await runSetupPlan(target, plan, { ...runOptions(options), signal, streams: host.streams }),
    );
  } catch (error) {
    if (!(error instanceof SetupFailedError)) throw error;

    if (options.onSetupFailure === "keep") {
      error.sandbox = box;
      throw error;
    }

    try {
      await box.destroy(signal ? { signal } : {});
    } catch (cleanup) {
      throw new SandboxCleanupError(box, { status: "failed", error }, cleanup);
    }

    throw error;
  }

  return box;
}

/** Only the run controls, so create-only keys never reach the runner. */
export function runOptions(options: SetupRunOptions): SetupRunOptions {
  const picked: SetupRunOptions = {};

  if (options.onSetupOutput) picked.onSetupOutput = options.onSetupOutput;

  if (options.onSetupStep) picked.onSetupStep = options.onSetupStep;

  if (options.setupTimeoutSeconds) picked.setupTimeoutSeconds = options.setupTimeoutSeconds;

  return picked;
}

/** After a resume that started fresh processes, run the startup the sandbox recorded. */
export async function startupAfterResume(
  box: AdapterSandbox,
  host: SetupHost,
  options: SetupRunOptions,
  signal?: AbortSignal,
): Promise<void> {
  const target = host.target(box);
  const recorded = await readSetupState(target, signal);

  if (!recorded?.startup.length) return;

  const plan = planSetup(
    { setup: [], startup: [], digest: null, names: [], cache: undefined },
    recorded,
    { startupFromRecord: true },
  );

  try {
    recordSetupReport(
      box,
      await runSetupPlan(target, plan, { ...runOptions(options), signal, streams: host.streams }),
    );
  } catch (error) {
    if (error instanceof SetupFailedError) error.sandbox = box;
    throw error;
  }
}

/**
 * `box.runSetup()`: run setup on an existing sandbox. Steps the sandbox already recorded are
 * skipped unless `force`; a failure keeps the sandbox and puts it on the error.
 */
export async function runSetupOn(
  box: AdapterSandbox,
  host: SetupHost,
  options: SetupCreateOptions & RunSetupOptions,
  signal?: AbortSignal,
): Promise<SetupReport> {
  const resolved = await resolveSetup(options);
  const target = host.target(box);
  const record = options.record ?? true;
  const recorded = record ? await readSetupState(target, signal) : null;

  const plan = planSetup(resolved, recorded, {
    force: !record || (options.force ?? false),
    startupFromRecord: options.recordedStartup === "run",
  });

  try {
    const ctx: SetupRunContext = { ...runOptions(options), signal, streams: host.streams, record };

    if (options.env) ctx.env = options.env;

    const report = await runSetupPlan(target, plan, ctx);

    recordSetupReport(box, report);

    return report;
  } catch (error) {
    if (error instanceof SetupFailedError) error.sandbox = box;
    throw error;
  }
}
