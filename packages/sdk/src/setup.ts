import { z } from "zod";
import { BeachsideError, NonzeroExitError, type ExecOutput } from "./resource";

/**
 * Setup: steps Beachside runs in a sandbox after it starts, over ordinary `exec`, the same way on
 * every provider. `setup` runs once per sandbox lineage and is skipped when a restored snapshot
 * already holds it; `startup` runs whenever the sandbox comes up without its processes.
 */

/** One setup step: a shell line, an argv array, or the object form with options. */
export type SetupStep = string | readonly string[] | SetupStepOptions | SetupParallel;

/**
 * Steps that run at the same time, as one setup step: it finishes when all of them have, and
 * fails (after the others finish) when any of them fails. Only in `setup`, not `startup`.
 */
export type SetupParallel = {
  parallel: readonly (string | readonly string[] | SetupStepOptions)[];
  /** Shown in progress output and errors; defaults to the step names joined with `+`. */
  name?: string;
  /** `false` runs the group every time, like a step's `cache: false`. */
  cache?: boolean;
};

export type SetupStepOptions = {
  /** A shell line (run with `sh -c`) or an argv array (no shell). */
  run?: string | readonly string[];
  /** An inline script, uploaded and run with its shebang (`sh` without one). */
  script?: string;
  /** A local script file, read on this machine when the setup is resolved, then uploaded. */
  file?: string;
  /** Shown in progress output and errors; defaults to the command or file name. */
  name?: string;
  /**
   * Working directory, created when missing; `~` and relative paths start at the sandbox user's
   * home. Default: home.
   */
  cwd?: string;
  /** Environment for this step only. Put secrets in the create-time `env` instead. */
  env?: Record<string, string>;
  /**
   * Text sent to the step's stdin, such as a key the step reads with `--auth-key-file -`. Never
   * part of the digest, never saved. Not allowed on startup steps, which are saved for reruns.
   */
  stdin?: string;
  /** Per-step limit, 600 seconds by default and at most 3600. */
  timeoutSeconds?: number;
  /** `root` runs the step as root, through `sudo -n` when the sandbox user is not root. */
  user?: "root";
  /**
   * `false` marks a step that must run every time the sandbox comes up from a snapshot or setup
   * cache that already holds the rest of the setup, such as `git pull`.
   */
  cache?: boolean;
};

export type SetupDefinitionInput = {
  name: string;
  /** Other setups this one builds on; their steps run first. */
  extends?: readonly SetupDefinition[];
  setup?: readonly (SetupStep | SetupDefinition)[];
  startup?: readonly SetupStep[];
};

/** A named, reusable setup: the SDK's equivalent of a `setups` entry in `beachside.json`. */
export class SetupDefinition {
  readonly name: string;
  readonly extends: readonly SetupDefinition[];
  readonly setup: readonly (SetupStep | SetupDefinition)[];
  readonly startup: readonly SetupStep[];
  constructor(input: SetupDefinitionInput) {
    const parsed = DefinitionInput.safeParse(input);

    if (!parsed.success)
      throw new BeachsideError(
        "INVALID_ARGUMENT",
        `Invalid setup definition: ${issues(parsed.error)}`,
      );
    this.name = parsed.data.name;
    this.extends = Object.freeze([...(input.extends ?? [])]);
    this.setup = Object.freeze([...(input.setup ?? [])]);
    this.startup = Object.freeze([...(input.startup ?? [])]);
    Object.freeze(this);
  }
}

/** What `create({ setup })` accepts: a step list, one named setup, or a mix of both. */
export type SetupInput = SetupDefinition | readonly (SetupStep | SetupDefinition)[];

export const Setup = {
  /** A named, reusable setup that composes: `setup: [nodeDev, playwright]`. */
  define(input: SetupDefinitionInput): SetupDefinition {
    return new SetupDefinition(input);
  },
  /**
   * The digest Beachside records for a setup: the same value as `box.setupReport.digest`, or
   * null when there are no setup steps. Reads `Setup.file()` scripts.
   */
  async digest(input: SetupInput): Promise<string | null> {
    return (await resolveSetup({ setup: input })).digest;
  },
  /** A local script file, uploaded and run with its shebang. Its digest is the file content. */
  file(path: string, options: Omit<SetupStepOptions, "run" | "script" | "file"> = {}): SetupStep {
    return { ...options, file: path };
  },
  /** Run these steps at the same time, as one setup step. */
  parallel(
    steps: readonly (string | readonly string[] | SetupStepOptions)[],
    options: Omit<SetupParallel, "parallel"> = {},
  ): SetupParallel {
    return { ...options, parallel: steps };
  },
};

/** Live output from a setup or startup step. */
export type SetupOutput = {
  phase: SetupPhase;
  step: SetupStepRef;
  stream: "stdout" | "stderr";
  text: string;
};

export type SetupPhase = "setup" | "startup";

export type SetupStepRef = {
  index: number;
  total: number;
  name: string;
  /** Set on a step inside a parallel group: the group's name. Output may interleave. */
  group?: string;
};

/** Progress: a step starting, finishing or being skipped, plus notes such as a setup mismatch. */
export type SetupEvent =
  | { type: "start"; phase: SetupPhase; step: SetupStepRef }
  | { type: "done"; phase: SetupPhase; step: SetupStepRef; exitCode: number; seconds: number }
  | { type: "skipped"; phase: SetupPhase; step: SetupStepRef; reason: string }
  | { type: "note"; phase: SetupPhase; message: string };

export type SetupStepReport = {
  index: number;
  name: string;
  digest: string;
  status: "ran" | "skipped";
  exitCode: number | null;
  seconds: number;
};

/** What setup did on a sandbox, available as `box.setupReport` after create, restore or resume. */
export type SetupReport = {
  /** Digest of the requested setup steps, or null when none were requested. */
  digest: string | null;
  setup: SetupStepReport[];
  startup: SetupStepReport[];
};

/** Setup controls shared by create, restore, resume and `runSetup`. */
export type SetupRunOptions = {
  onSetupOutput?: (chunk: SetupOutput) => void | Promise<void>;
  onSetupStep?: (event: SetupEvent) => void | Promise<void>;
  /** Overall limit for setup plus startup, 1800 seconds by default. */
  setupTimeoutSeconds?: number;
};

/** Setup keys on `create()`, `with()` and `restore()`. */
export type SetupCreateOptions = SetupRunOptions & {
  setup?: SetupInput;
  startup?: readonly SetupStep[];
  /**
   * On restore: `run` (default) runs the startup the snapshot recorded when no `startup` is
   * passed; `skip` leaves it, for callers that run setup themselves with `box.runSetup()`.
   */
  recordedStartup?: "run" | "skip";
  /**
   * What happens to a new sandbox whose setup or startup fails: `destroy` (default) removes it
   * before the error is thrown; `keep` leaves it running and puts it on the error as `sandbox`.
   */
  onSetupFailure?: "destroy" | "keep";
};

export const setupCreateKeys = [
  "setup",
  "startup",
  "recordedStartup",
  "onSetupOutput",
  "onSetupStep",
  "setupTimeoutSeconds",
  "onSetupFailure",
] as const;

/** A setup or startup step failed, timed out or lost contact. */
export class SetupFailedError extends BeachsideError {
  readonly step: SetupStepRef;
  readonly exitCode: number | null;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  /** The sandbox, when it was kept (`onSetupFailure: "keep"`, a resumed box, or `runSetup`). */
  sandbox: import("./resource").SandboxHandle<true> | undefined;
  constructor(
    readonly phase: SetupPhase,
    step: SetupStepRef,
    detail: { exitCode: number | null; stdoutTail: string; stderrTail: string; reason: string },
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A lost exec can reject with any JavaScript value; keep it for diagnosis.
    readonly cause?: unknown,
  ) {
    const tail = detail.stderrTail.trim() || detail.stdoutTail.trim();
    super(
      "SETUP_FAILED",
      `${phase} step ${step.index + 1}/${step.total} "${step.name}" ${detail.reason}${tail ? `:\n${tail}` : ""}`,
      "applied",
    );
    this.name = "SetupFailedError";
    this.step = step;
    this.exitCode = detail.exitCode;
    this.stdoutTail = detail.stdoutTail;
    this.stderrTail = detail.stderrTail;
    this.sandbox = undefined;
  }
}

/** A step ready to run: files read, defaults applied, digest computed. */
export type ResolvedStep = {
  name: string;
  kind: "shell" | "argv" | "script" | "parallel";
  /** The steps of a parallel group. */
  children?: ResolvedStep[];
  /** The shell line, the inline script or file content. Empty for argv. */
  text: string;
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
  timeoutSeconds: number;
  user?: "root";
  cache: boolean;
  digest: string;
};

export type ResolvedSetup = {
  setup: ResolvedStep[];
  startup: ResolvedStep[];
  /** Digest over the setup steps; null when there are none. */
  digest: string | null;
  /** Names of the named setups involved, outermost first. */
  names: string[];
};

const PlainObject = z.record(z.string(), z.unknown());

const Env = z.record(z.string().min(1).max(256), z.string());

const StepObject = z
  .strictObject({
    run: z.union([z.string().min(1), z.array(z.string()).min(1)]).optional(),
    script: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    name: z.string().min(1).max(200).optional(),
    cwd: z.string().min(1).max(4096).optional(),
    env: Env.optional(),
    stdin: z.string().optional(),
    timeoutSeconds: z.number().int().positive().max(3600).optional(),
    user: z.literal("root").optional(),
    cache: z.boolean().optional(),
  })
  .refine(
    (step) =>
      [step.run, step.script, step.file].filter((value) => value !== undefined).length === 1,
    "a step needs exactly one of run, script or file",
  );

const LeafStep = z.union([z.string().min(1), z.array(z.string()).min(1), StepObject]);

const ParallelStep = z.strictObject({
  parallel: z.array(LeafStep).min(2).max(32),
  name: z.string().min(1).max(200).optional(),
  cache: z.boolean().optional(),
});

const Step = z.union([LeafStep, ParallelStep]);

const DefinitionInput = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/, "use lowercase letters, digits, '.', '_' and '-'"),
  extends: z.array(z.instanceof(SetupDefinition)).optional(),
  setup: z.array(z.union([Step, z.instanceof(SetupDefinition)])).optional(),
  startup: z.array(Step).optional(),
});

const RunOptions = z.strictObject({
  setup: z
    .union([z.instanceof(SetupDefinition), z.array(z.union([Step, z.instanceof(SetupDefinition)]))])
    .optional(),
  startup: z.array(Step).optional(),
  onSetupOutput: z.function().optional(),
  onSetupStep: z.function().optional(),
  setupTimeoutSeconds: z.number().int().positive().max(86_400).optional(),
  onSetupFailure: z.enum(["destroy", "keep"]).optional(),
  recordedStartup: z.enum(["run", "skip"]).optional(),
});

function issues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

/** Check setup keys at the API boundary; throws INVALID_ARGUMENT before any effect. */
export function validateSetupOptions(options: SetupCreateOptions): void {
  const parsed = RunOptions.safeParse(options);

  if (!parsed.success)
    throw new BeachsideError("INVALID_ARGUMENT", `Invalid setup: ${issues(parsed.error)}`);
}

/** Split setup keys from the rest of a create or restore input. */
export type SplitSetup<T> = {
  setupOptions: SetupCreateOptions;
  rest: Omit<T, (typeof setupCreateKeys)[number]> | undefined;
};

export function splitSetup<T extends SetupCreateOptions>(input: T | undefined): SplitSetup<T> {
  // Non-object input passes through unchanged, so the caller's own validation rejects it.
  if (input === undefined || !PlainObject.safeParse(input).success)
    return { setupOptions: {}, rest: input };

  const {
    setup,
    startup,
    recordedStartup,
    onSetupOutput,
    onSetupStep,
    setupTimeoutSeconds,
    onSetupFailure,
    ...rest
  } = input;

  const setupOptions: SetupCreateOptions = {};

  if (setup !== undefined) setupOptions.setup = setup;

  if (startup !== undefined) setupOptions.startup = startup;

  if (onSetupOutput !== undefined) setupOptions.onSetupOutput = onSetupOutput;

  if (onSetupStep !== undefined) setupOptions.onSetupStep = onSetupStep;

  if (setupTimeoutSeconds !== undefined) setupOptions.setupTimeoutSeconds = setupTimeoutSeconds;

  if (onSetupFailure !== undefined) setupOptions.onSetupFailure = onSetupFailure;

  if (recordedStartup !== undefined) setupOptions.recordedStartup = recordedStartup;
  validateSetupOptions(setupOptions);

  const split: SplitSetup<T> = { setupOptions, rest };

  return split;
}

/** Whether a create or restore input carries any setup key. */
export function hasSetupKeys(input: SetupCreateOptions | undefined): boolean {
  return (
    input !== undefined &&
    PlainObject.safeParse(input).success &&
    setupCreateKeys.some((key) => key in input)
  );
}

/** Default per-step limit. */
export const STEP_TIMEOUT_SECONDS = 600;

/** Default overall limit for one setup run. */
export const SETUP_TIMEOUT_SECONDS = 1800;

/** Inline scripts above this size go through the file API rather than inside the command. */
const INLINE_SCRIPT_BYTES = 96 * 1024;

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Reads a local script file; injectable so tests and the CLI can resolve paths their own way. */
export type ReadSetupFile = (path: string) => Promise<string>;

async function readLocalFile(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");

  try {
    return await readFile(path, "utf8");
  } catch (cause) {
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      `Cannot read setup file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function firstLine(text: string, max = 60): string {
  const line = text.trim().split("\n")[0]!.trim();

  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1) || path;
}

type StepSource = SetupStepOptions;

function stepObject(step: SetupStep): StepSource {
  if (Array.isArray(step)) return { run: [...step] };

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Steps are a string, an argv array or an options object; zod has already validated the shape.
  if (typeof step === "string") return { run: step };

  // SAFETY: Neither a string nor an array, so this is the validated options object.
  return step as StepSource;
}

async function resolveStep(step: SetupStep, readFile: ReadSetupFile): Promise<ResolvedStep> {
  const parsed = Step.safeParse(step);

  if (!parsed.success)
    throw new BeachsideError("INVALID_ARGUMENT", `Invalid setup step: ${issues(parsed.error)}`);

  const group = ParallelStep.safeParse(step);

  if (group.success) {
    // SAFETY: The parallel schema matched, so this is the parallel form with its leaf steps.
    const children = await Promise.all(
      (step as SetupParallel).parallel.map((child) => resolveStep(child, readFile)),
    );

    if (children.some((child) => child.stdin !== undefined))
      throw new BeachsideError("INVALID_ARGUMENT", "Steps in a parallel group cannot take stdin");

    return {
      name: group.data.name ?? children.map((child) => child.name).join(" + "),
      kind: "parallel",
      children,
      text: "",
      argv: [],
      timeoutSeconds: Math.max(...children.map((child) => child.timeoutSeconds)),
      cache: group.data.cache ?? true,
      digest: await sha256(JSON.stringify(["parallel", children.map((child) => child.digest)])),
    };
  }

  const source = stepObject(step);
  let kind: ResolvedStep["kind"];
  let text = "";
  let argv: string[] = [];
  let name: string;

  if (source.file !== undefined) {
    kind = "script";
    text = await readFile(source.file);
    name = source.name ?? baseName(source.file);
  } else if (source.script !== undefined) {
    kind = "script";
    text = source.script;
    name = source.name ?? "script";
  } else if (Array.isArray(source.run)) {
    kind = "argv";
    argv = [...source.run];
    name = source.name ?? firstLine(argv.join(" "));
  } else {
    kind = "shell";
    // SAFETY: zod required exactly one of run, script and file, and run is not an array here.
    text = source.run as string;
    name = source.name ?? firstLine(text);
  }

  const env = source.env ? Object.fromEntries(Object.entries(source.env).sort()) : undefined;
  const cache = source.cache ?? true;

  const digest = await sha256(
    JSON.stringify([
      kind,
      text,
      argv,
      source.cwd ?? null,
      source.user ?? null,
      Object.keys(env ?? {}),
    ]),
  );

  const resolved: ResolvedStep = {
    name,
    kind,
    text,
    argv,
    timeoutSeconds: source.timeoutSeconds ?? STEP_TIMEOUT_SECONDS,
    cache,
    digest,
  };

  if (source.cwd !== undefined) resolved.cwd = source.cwd;

  if (env !== undefined) resolved.env = env;

  if (source.user !== undefined) resolved.user = source.user;

  if (source.stdin !== undefined) resolved.stdin = source.stdin;

  return resolved;
}

/** Flatten named setups and steps into ordered lists, reading files and computing digests. */
export async function resolveSetup(
  options: Pick<SetupCreateOptions, "setup" | "startup">,
  readFile: ReadSetupFile = readLocalFile,
): Promise<ResolvedSetup> {
  const setupSteps: SetupStep[] = [];
  const startupSteps: SetupStep[] = [];
  const names: string[] = [];
  const seen = new Set<SetupDefinition>();

  const visit = (definition: SetupDefinition, path: SetupDefinition[]) => {
    if (path.includes(definition))
      throw new BeachsideError(
        "INVALID_ARGUMENT",
        `Setup ${definition.name} extends itself: ${[...path, definition].map((entry) => entry.name).join(" -> ")}`,
      );

    // A setup reached twice through `extends` runs once, at its first position.
    if (seen.has(definition)) return;
    seen.add(definition);
    names.push(definition.name);

    for (const base of definition.extends) visit(base, [...path, definition]);

    for (const item of definition.setup)
      if (item instanceof SetupDefinition) visit(item, [...path, definition]);
      else setupSteps.push(item);
    startupSteps.push(...definition.startup);
  };

  const input = options.setup;

  if (input instanceof SetupDefinition) visit(input, []);
  else
    for (const item of input ?? [])
      if (item instanceof SetupDefinition) visit(item, []);
      else setupSteps.push(item);
  startupSteps.push(...(options.startup ?? []));

  const setup = await Promise.all(setupSteps.map((step) => resolveStep(step, readFile)));
  const startup = await Promise.all(startupSteps.map((step) => resolveStep(step, readFile)));

  rejectStartupStdin(startup);

  return {
    setup,
    startup,
    digest: setup.length ? await sha256(JSON.stringify(setup.map((step) => step.digest))) : null,
    names,
  };
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}

/** Where Beachside keeps setup state inside a sandbox, relative to the user's home. */
export const STATE_DIR = ".beachside/setup";

const asRoot = `S=; [ "$(id -u)" = 0 ] || S="sudo -n -E"`;

const StoredStep = z.strictObject({
  name: z.string(),
  kind: z.enum(["shell", "argv", "script"]),
  text: z.string(),
  argv: z.array(z.string()),
  cwd: z.string().optional(),
  env: Env.optional(),
  timeoutSeconds: z.number().int().positive(),
  user: z.literal("root").optional(),
  cache: z.boolean(),
  digest: z.string(),
});

/** The state file Beachside keeps in each sandbox; it travels with snapshots. */
export const SetupState = z.strictObject({
  version: z.literal(1),
  setup: z.strictObject({
    digest: z.string().nullable(),
    complete: z.boolean(),
    steps: z.array(z.strictObject({ name: z.string(), digest: z.string() })),
    updatedAt: z.string(),
  }),
  /** Startup steps recorded so a restore or resume can run them again. */
  startup: z.array(StoredStep),
});

export type SetupState = z.infer<typeof SetupState>;

/** What the runner needs from a sandbox handle. */
export type SetupTarget = {
  exec(
    input: import("./resource").ExecInput | readonly string[],
    options?: import("./processes").ExecOptions,
  ): Promise<ExecOutput>;
  writeFile?(path: string, bytes: Uint8Array, options?: { overwrite?: boolean }): Promise<void>;
};

export type SetupRunContext = SetupRunOptions & {
  signal?: AbortSignal;
  /** `false` runs the steps without touching the sandbox's setup state file. */
  record?: boolean;
  /** Whether the adapter can stream exec output live; otherwise output arrives per step. */
  streams: boolean;
  /** Environment for every step, under each step's own; like sandbox env, not in the digest. */
  env?: Record<string, string>;
  /** `false` records the startup steps in the state file without running them. */
  runStartup?: boolean;
};

const TAIL_LINES = 20;

function tail(text: string): string {
  return text.trimEnd().split("\n").slice(-TAIL_LINES).join("\n");
}

function heredoc(path: string, content: string, tag: string): string {
  const body = content.endsWith("\n") ? content : `${content}\n`;

  return `cat > ${path} <<'BEACHSIDE_${tag}'\n${body}BEACHSIDE_${tag}\n`;
}

/** The sandbox user's home directory, which anchors relative working directories. */
async function home(target: SetupTarget, signal: AbortSignal): Promise<string> {
  const output = await target.exec(
    { command: { kind: "shell", script: 'printf %s "$HOME"' } },
    { signal },
  );

  const value = output.stdoutText().trim();

  return value || "/root";
}

function cwdFor(step: ResolvedStep, homeDir: string): string {
  const cwd = step.cwd;

  if (cwd === undefined || cwd === "~") return homeDir;

  if (cwd.startsWith("~/")) return `${homeDir}/${cwd.slice(2)}`;

  return cwd.startsWith("/") ? cwd : `${homeDir}/${cwd}`;
}

async function commandFor(
  step: ResolvedStep,
  target: SetupTarget,
  homeDir: string,
  signal: AbortSignal,
): Promise<import("./resource").ExecInput["command"]> {
  const root = step.user === "root";

  if (step.kind === "argv") {
    if (!root) return { kind: "argv", argv: step.argv };

    return { kind: "shell", script: `${asRoot}\nexec $S ${step.argv.map(shellQuote).join(" ")}` };
  }

  if (step.kind === "shell")
    return root
      ? { kind: "shell", script: `${asRoot}\nexec $S sh -c ${shellQuote(step.text)}` }
      : { kind: "shell", script: step.text };

  const dir = `${homeDir}/${STATE_DIR}/steps`;
  const file = `${dir}/${step.digest.slice(0, 16)}`;

  const run = step.text.startsWith("#!")
    ? `exec $S ${shellQuote(file)}`
    : `exec $S sh ${shellQuote(file)}`;

  const prefix = `${root ? asRoot : "S="}\nmkdir -p ${shellQuote(dir)}\n`;

  if (new TextEncoder().encode(step.text).byteLength <= INLINE_SCRIPT_BYTES)
    return {
      kind: "shell",
      script: `${prefix}${heredoc(shellQuote(file), step.text, step.digest.slice(0, 16))}chmod +x ${shellQuote(file)}\n${run}`,
    };

  if (!target.writeFile)
    throw new BeachsideError(
      "UNSUPPORTED",
      `Setup script "${step.name}" is over ${INLINE_SCRIPT_BYTES} bytes and this adapter cannot write files`,
    );
  await target.exec(
    { command: { kind: "shell", script: `mkdir -p ${shellQuote(dir)}` } },
    { signal },
  );
  await target.writeFile(file, new TextEncoder().encode(step.text), { overwrite: true });

  return { kind: "shell", script: `${prefix}chmod +x ${shellQuote(file)}\n${run}` };
}

/** Read the setup state file; a missing or unreadable file means no recorded setup. */
export async function readSetupState(
  target: SetupTarget,
  signal?: AbortSignal,
): Promise<SetupState | null> {
  try {
    const output = await target.exec(
      {
        command: {
          kind: "shell",
          script: `cat "$HOME/${STATE_DIR}/state.json" 2>/dev/null || true`,
        },
      },
      signal ? { signal } : {},
    );

    const text = output.stdoutText({ full: true }).trim();

    if (!text) return null;

    const parsed = SetupState.safeParse(JSON.parse(text));

    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function writeSetupState(
  target: SetupTarget,
  state: SetupState,
  signal: AbortSignal,
): Promise<void> {
  const json = JSON.stringify(state);

  await target.exec(
    {
      command: {
        kind: "shell",
        script: `mkdir -p "$HOME/${STATE_DIR}"\n${heredoc(`"$HOME/${STATE_DIR}/state.json.tmp"`, json, "STATE")}mv "$HOME/${STATE_DIR}/state.json.tmp" "$HOME/${STATE_DIR}/state.json"`,
      },
    },
    { signal },
  );
}

function storedStartup(steps: readonly ResolvedStep[]): SetupState["startup"] {
  return steps.map((step) => StoredStep.parse(step));
}

function rejectStartupStdin(steps: readonly ResolvedStep[]): void {
  if (steps.some((step) => step.kind === "parallel"))
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "Startup steps cannot be parallel groups; start background servers with `&` instead",
    );

  if (steps.some((step) => step.stdin !== undefined))
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "Startup steps cannot take stdin: they are saved in the sandbox to run again",
    );
}

/** Startup steps recorded in a state file, ready to run again. */
export function recordedStartupSteps(state: SetupState | null): ResolvedStep[] {
  return state ? state.startup.map((step) => ({ ...step })) : [];
}

class PhaseRunner {
  private homeDir: string | undefined;
  constructor(
    private readonly target: SetupTarget,
    private readonly ctx: SetupRunContext,
    private readonly signal: AbortSignal,
  ) {}
  async home(): Promise<string> {
    this.homeDir ??= await home(this.target, this.signal);

    return this.homeDir;
  }
  async emit(event: SetupEvent): Promise<void> {
    await this.ctx.onSetupStep?.(event);
  }
  async step(phase: SetupPhase, step: ResolvedStep, ref: SetupStepRef): Promise<SetupStepReport> {
    if (step.kind === "parallel") return this.group(phase, step, ref);

    await this.emit({ type: "start", phase, step: ref });
    const started = Date.now();
    const timeout = AbortSignal.timeout(step.timeoutSeconds * 1000);
    const signal = AbortSignal.any([this.signal, timeout]);
    const homeDir = await this.home();
    let output: ExecOutput;

    try {
      const command = await commandFor(step, this.target, homeDir, signal);

      // A working directory that does not exist yet is created, like `mkdir -p`.
      if (step.cwd !== undefined)
        await this.target.exec(
          { command: { kind: "argv", argv: ["mkdir", "-p", cwdFor(step, homeDir)] } },
          { signal },
        );
      const input: import("./resource").ExecInput = { command, cwd: cwdFor(step, homeDir) };

      if (step.env || this.ctx.env) input.env = { ...this.ctx.env, ...step.env };

      if (step.stdin !== undefined) input.stdin = step.stdin;

      const onOutput = this.ctx.onSetupOutput;

      // Steps with stdin take the buffered path, which every exec adapter supports.
      if (this.ctx.streams && onOutput && step.stdin === undefined)
        output = await this.target.exec(input, {
          signal,
          onOutput: (chunk) =>
            onOutput({ phase, step: ref, stream: chunk.stream, text: chunk.text }),
        });
      else {
        output = await this.target.exec(
          { ...input, deadlineSeconds: step.timeoutSeconds },
          { signal },
        );
        await this.replay(phase, ref, output);
      }
    } catch (cause) {
      if (cause instanceof NonzeroExitError) {
        output = cause.result;

        if (!this.ctx.streams || !this.ctx.onSetupOutput || step.stdin !== undefined)
          await this.replay(phase, ref, output);
      } else {
        const timedOut = timeout.aborted && !this.signal.aborted;

        throw new SetupFailedError(
          phase,
          ref,
          {
            exitCode: null,
            stdoutTail: "",
            stderrTail: "",
            reason: timedOut
              ? `timed out after ${step.timeoutSeconds}s; the command may still be running in the sandbox`
              : this.signal.aborted
                ? "was stopped before it finished; the command may still be running in the sandbox"
                : `did not finish: ${cause instanceof Error ? cause.message : String(cause)}`,
          },
          cause,
        );
      }
    }

    const seconds = Math.round((Date.now() - started) / 100) / 10;

    if (output.exitCode !== 0)
      throw new SetupFailedError(phase, ref, {
        exitCode: output.exitCode,
        stdoutTail: tail(output.stdoutText({ full: true })),
        stderrTail: tail(output.stderrText({ full: true })),
        reason:
          output.exitCode === null
            ? "ended without an exit code"
            : `failed (exit ${output.exitCode})`,
      });
    await this.emit({ type: "done", phase, step: ref, exitCode: 0, seconds });

    return {
      index: ref.index,
      name: step.name,
      digest: step.digest,
      status: "ran",
      exitCode: 0,
      seconds,
    };
  }
  /** A parallel group: every child runs; the first failure is thrown once all have finished. */
  private async group(
    phase: SetupPhase,
    step: ResolvedStep,
    ref: SetupStepRef,
  ): Promise<SetupStepReport> {
    const children = step.children ?? [];

    await this.emit({ type: "start", phase, step: ref });
    const started = Date.now();

    const results = await Promise.allSettled(
      children.map((child, index) =>
        this.step(phase, child, {
          index,
          total: children.length,
          name: child.name,
          group: step.name,
        }),
      ),
    );

    const failed = results.find((result) => result.status === "rejected");

    if (failed) throw failed.reason;
    const seconds = Math.round((Date.now() - started) / 100) / 10;

    await this.emit({ type: "done", phase, step: ref, exitCode: 0, seconds });

    return {
      index: ref.index,
      name: step.name,
      digest: step.digest,
      status: "ran",
      exitCode: 0,
      seconds,
    };
  }
  private async replay(phase: SetupPhase, ref: SetupStepRef, output: ExecOutput): Promise<void> {
    const onOutput = this.ctx.onSetupOutput;

    if (!onOutput) return;
    const stdout = output.stdoutText({ full: true });
    const stderr = output.stderrText({ full: true });

    if (stdout) await onOutput({ phase, step: ref, stream: "stdout", text: stdout });

    if (stderr) await onOutput({ phase, step: ref, stream: "stderr", text: stderr });
  }
}

export type SetupPlan = {
  /** Setup steps, each marked to run or to skip because the sandbox already holds it. */
  setup: { step: ResolvedStep; run: boolean; reason?: string }[];
  startup: ResolvedStep[];
  digest: string | null;
  notes: string[];
};

/**
 * Decide what runs. `recorded` is the sandbox's state file (a restored snapshot or a reopened
 * box). Steps already recorded, in the same order, are skipped unless marked `cache: false`;
 * a different recorded setup reruns everything with a note.
 */
export function planSetup(
  resolved: ResolvedSetup,
  recorded: SetupState | null,
  options: { force?: boolean; startupFromRecord?: boolean } = {},
): SetupPlan {
  const notes: string[] = [];
  const done = recorded?.setup.steps ?? [];
  let prefix = 0;

  if (!options.force) {
    while (
      prefix < done.length &&
      prefix < resolved.setup.length &&
      done[prefix]!.digest === resolved.setup[prefix]!.digest
    )
      prefix++;

    // Diverged: the sandbox holds other steps where the requested ones differ. A request that
    // is a prefix of what the sandbox holds is already satisfied.
    if (prefix < done.length && prefix < resolved.setup.length) {
      notes.push(
        "the sandbox holds a different setup than requested; running every requested step",
      );
      prefix = 0;
    }
  }

  const startup =
    resolved.startup.length || !options.startupFromRecord
      ? resolved.startup
      : recordedStartupSteps(recorded);

  return {
    setup: resolved.setup.map((step, index) =>
      index < prefix
        ? step.cache
          ? { step, run: false, reason: "already in this sandbox" }
          : { step, run: true }
        : { step, run: true },
    ),
    startup,
    digest: resolved.digest,
    notes,
  };
}

/**
 * Run a plan: setup steps in order (saving progress in the state file after each), then
 * startup. Stops at the first failure with `SetupFailedError`.
 */
export async function runSetupPlan(
  target: SetupTarget,
  plan: SetupPlan,
  ctx: SetupRunContext,
): Promise<SetupReport> {
  const budget = AbortSignal.timeout((ctx.setupTimeoutSeconds ?? SETUP_TIMEOUT_SECONDS) * 1000);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, budget]) : budget;
  const runner = new PhaseRunner(target, ctx, signal);
  const report: SetupReport = { digest: plan.digest, setup: [], startup: [] };

  for (const message of plan.notes) await runner.emit({ type: "note", phase: "setup", message });

  if (ctx.record === false) {
    for (const [index, entry] of plan.setup.entries())
      report.setup.push(
        await runner.step("setup", entry.step, {
          index,
          total: plan.setup.length,
          name: entry.step.name,
        }),
      );
  } else if (plan.setup.length) {
    const total = plan.setup.length;
    const completed: SetupState["setup"]["steps"] = [];

    const save = (complete: boolean) =>
      writeSetupState(
        target,
        {
          version: 1,
          setup: {
            digest: plan.digest,
            complete,
            steps: completed,
            updatedAt: new Date().toISOString(),
          },
          startup: storedStartup(plan.startup),
        },
        signal,
      );

    for (const [index, entry] of plan.setup.entries()) {
      const ref = { index, total, name: entry.step.name };

      if (!entry.run) {
        await runner.emit({
          type: "skipped",
          phase: "setup",
          step: ref,
          reason: entry.reason ?? "",
        });
        report.setup.push({
          index,
          name: entry.step.name,
          digest: entry.step.digest,
          status: "skipped",
          exitCode: null,
          seconds: 0,
        });
        completed.push({ name: entry.step.name, digest: entry.step.digest });
        continue;
      }

      report.setup.push(await runner.step("setup", entry.step, ref));
      completed.push({ name: entry.step.name, digest: entry.step.digest });
      await save(index === total - 1);
    }

    // Every step skipped: the record already matches, but keep startup current.
    if (plan.setup.every((entry) => !entry.run)) await save(true);
  } else if (plan.startup.length) {
    const current = await readSetupState(target, signal);

    await writeSetupState(
      target,
      {
        version: 1,
        setup: current?.setup ?? {
          digest: null,
          complete: true,
          steps: [],
          updatedAt: new Date().toISOString(),
        },
        startup: storedStartup(plan.startup),
      },
      signal,
    );
  }

  if (ctx.runStartup === false) return report;

  for (const [index, step] of plan.startup.entries())
    report.startup.push(
      await runner.step("startup", step, { index, total: plan.startup.length, name: step.name }),
    );

  return report;
}
