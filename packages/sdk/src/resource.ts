import type { OperationOutcome } from "@beachside/adapter";
import { SnapshotRequest, MountSpec } from "@beachside/adapter";
import type {
  AdapterDirectClient,
  AdapterSandbox,
  AdapterOperation,
  AdapterRecoveryReference,
} from "./adapter-direct";
import type { OperationKind, RetainedArtifact, Scope } from "@beachside/adapter";
import { z } from "zod";
import { type EnvValue, splitEnv } from "./secrets";
import { SecretBindings, type SecretBinding } from "@beachside/adapter";
import type { AdapterImage, AdapterSnapshot, AdapterVolume } from "./resources";
import {
  CreateEnv,
  CreateSandboxInput,
  ExecCommand,
  ExecRequest,
  MAX_EXEC_STDIN_BYTES,
  FilePath,
  type SafeError,
} from "@beachside/adapter/portable";

export type PreparedImage = {
  kind: "prepared";
  value: string;
  provider: string;
  scope: Scope;
};

export type ImageBuildResult = {
  prepared: PreparedImage;
  retainedResources: RetainedArtifact[];
  /**
   * The built image as a scoped reference for `images.get()` and `images.delete()`. Ownership is
   * `verified-created` only when the adapter proved this build created it; otherwise `unknown`.
   */
  reference: import("@beachside/adapter").ResourceReference<"image">;
};

export type { OciImage, ImageInput } from "@beachside/adapter";

import type { ImageInput, OciImage } from "@beachside/adapter";

export const Image = {
  prepared(value: string | PreparedImage): ImageInput {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- The public overload intentionally accepts either a raw template ID or a scoped result.
    return typeof value === "string"
      ? { kind: "prepared", value }
      : {
          kind: "prepared",
          value: value.value,
          binding: {
            provider: value.provider,
            scope: structuredClone(value.scope),
          },
        };
  },
  oci(value: string): OciImage {
    return { kind: "oci", value };
  },
};

/** Portable outbound network policy; adapters map it to native settings. */
export type NetworkPolicy = "blocked" | "internet" | (string & {});

export type CreateInput = {
  environment?: ImageInput;
  requirements?: { snapshot: SnapshotRequest };
  mounts?: MountSpec[];
  /** Outbound network policy; omitted uses the adapter setup default. */
  network?: NetworkPolicy;
  /** @deprecated Use `network`. */
  networkPolicy?: string;
  region?: string;
  labels?: Record<string, string>;
  /**
   * Environment variables for every command, process and terminal in the sandbox,
   * including after reopen. A per-call `env` entry overrides the same key. Values are
   * never saved in recovery references or included in errors and telemetry. Wrap a
   * credential in `secret(value, { for: "anthropic" })` to keep it out of the sandbox
   * entirely, or `secret.exposed(value)` to mark it as a credential that may be visible.
   */
  env?: Record<string, EnvValue>;
  /**
   * Lifetime for this sandbox only, replacing the adapter setup's `lifecycle.lifetimeSeconds`.
   * An adapter that cannot apply it exactly (or by rounding up) rejects before any effect.
   */
  lifecycle?: { lifetimeSeconds?: number };
};

export type ExecInput = {
  command: ExecCommand;
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Command input, ending with guest EOF. Strings encode as UTF-8. A stream (`AsyncIterable` or
   * `ReadableStream` of bytes) is sent as it arrives, with no size limit, while the command runs;
   * streams and input over 1 MiB need an adapter with incremental process stdin.
   */
  stdin?: string | Uint8Array | ExecStdinStream;
  /** Provider-specific execution/observation limit (default 300), not a total wait budget. Use the call signal to bound local waiting. */
  deadlineSeconds?: number;
  maxOutputBytes?: number;
};

/** Streamed command input: any async iterable or web stream of byte chunks. */
export type ExecStdinStream = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>;

export function isStdinStream(value: ExecInput["stdin"]): value is ExecStdinStream {
  return (
    value instanceof ReadableStream ||
    (value !== null &&
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Distinguish caller-supplied iterables from byte and text input.
      typeof value === "object" &&
      !(value instanceof Uint8Array) &&
      Symbol.asyncIterator in value)
  );
}

/** Whether stdin must travel incrementally: a stream, or bytes or text over the finite bound. */
export function stdinNeedsStream(stdin: ExecInput["stdin"]): boolean {
  if (stdin === undefined) return false;

  if (isStdinStream(stdin)) return true;

  if (stdin instanceof Uint8Array) return stdin.byteLength > MAX_EXEC_STDIN_BYTES;

  return stdin.length * 3 > MAX_EXEC_STDIN_BYTES && utf8Bytes(stdin) > MAX_EXEC_STDIN_BYTES;
}

function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/**
 * Input that must travel incrementally, read one chunk at a time. `cancel` stops the source when
 * the command no longer needs it, releasing a web stream's reader even while a read is pending.
 */
export type StdinSource = { next(): Promise<Uint8Array | null>; cancel(): void };

/** The streamed source for `stdin`, or undefined for finite input that fits the bound. */
export function streamedStdin(stdin: ExecInput["stdin"]): StdinSource | undefined {
  if (stdin === undefined || !stdinNeedsStream(stdin)) return undefined;

  if (stdin instanceof ReadableStream) return readableSource(stdin);

  if (isStdinStream(stdin)) return iterableSource(stdin);

  let bytes: Uint8Array | null =
    stdin instanceof Uint8Array ? Uint8Array.from(stdin) : new TextEncoder().encode(stdin);

  return {
    async next() {
      const chunk = bytes;
      bytes = null;

      return chunk;
    },
    cancel() {
      bytes = null;
    },
  };
}

/** Callers' stream chunks are checked at runtime, since JavaScript can pass anything. */
function stdinChunk(value: Uint8Array): Uint8Array {
  // SAFETY: Widened only for the runtime check; untyped callers may yield non-byte chunks.
  if (!((value as object) instanceof Uint8Array))
    throw new BeachsideError("INVALID_ARGUMENT", "Expected stdin stream byte chunks");

  return value;
}

function readableSource(stream: ReadableStream<Uint8Array>): StdinSource {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cancelled = false;

  return {
    async next() {
      if (cancelled) return null;
      reader ??= stream.getReader();
      const part = await reader.read();

      if (!part.done) return stdinChunk(part.value);
      // The stream ended: hand it back to the caller unlocked.
      cancelled = true;
      reader.releaseLock();

      return null;
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;

      if (!reader) {
        void stream.cancel().catch(() => undefined);

        return;
      }

      // Cancelling settles a pending read, after which the lock can be released.
      const owned = reader;
      void owned
        .cancel()
        .catch(() => undefined)
        .finally(() => owned.releaseLock());
    },
  };
}

function iterableSource(iterable: AsyncIterable<Uint8Array>): StdinSource {
  const iterator = iterable[Symbol.asyncIterator]();
  let cancelled = false;

  return {
    async next() {
      if (cancelled) return null;
      const part = await iterator.next();

      return part.done ? null : stdinChunk(part.value);
    },
    cancel() {
      if (cancelled) return;
      cancelled = true;
      // An iterator's return() runs its cleanup (closing a file or socket) once it can.
      void Promise.resolve()
        .then(() => iterator.return?.())
        .catch(() => undefined);
    },
  };
}

export type ValidatedExecInput = Required<
  Pick<ExecInput, "command" | "deadlineSeconds" | "maxOutputBytes">
> &
  Omit<ExecInput, "stdin"> & { stdin?: Uint8Array };

const ExecStdinInput = z.union([
  z
    .string()
    .max(MAX_EXEC_STDIN_BYTES)
    .transform((value) => ({ kind: "text" as const, value })),
  z
    .instanceof(Uint8Array)
    .refine((value) => value.byteLength <= MAX_EXEC_STDIN_BYTES)
    .transform((value) => ({ kind: "bytes" as const, value })),
]);

export type OutputPreview = { text: string; shortened: boolean };

export type ExecOutput = {
  exitCode: number | null;
  stdout: Uint8Array;
  stderr: Uint8Array;
  truncated: boolean;
  stdoutText(maxBytes?: number): string;
  stdoutText(options: { full: true }): string;
  stderrText(maxBytes?: number): string;
  stderrText(options: { full: true }): string;
  stdoutPreview(options?: { maxBytes?: number }): OutputPreview;
  stderrPreview(options?: { maxBytes?: number }): OutputPreview;
};

export type RecoveryReference = AdapterRecoveryReference;

/** A submitted operation; a concrete kind retains advanced continuation and narrowing. */
export type OperationHandle<T, K extends OperationKind | undefined = undefined> = [K] extends [
  OperationKind,
]
  ? AdapterOperation<T, Extract<K, OperationKind>>
  : {
      readonly durability: "process";
      readonly reference: RecoveryReference;
      observe(): Promise<T | null>;
      wait(options?: { signal?: AbortSignal; pollMs?: number }): Promise<T>;
    };

/** @deprecated Use BeachsideClient for the complete SDK connection surface. */
export type DirectBeachsideClient = Pick<
  AdapterDirectClient,
  | "provider"
  | "capabilities"
  | "images"
  | "sandboxes"
  | "snapshots"
  | "volumes"
  | "operations"
  | "recover"
  | "close"
>;

/** @deprecated Use SandboxHandle. This structural compatibility view remains available. */
export type DirectSandboxHandle = Pick<AdapterSandbox, keyof AdapterSandbox>;

/** Public sandbox handle. */
export type SandboxHandle<Advanced extends boolean = false> = Advanced extends true
  ? AdapterSandbox
  : DirectSandboxHandle;

/** Public SDK connection. */
export type BeachsideClient<Advanced extends boolean = false> = Advanced extends true
  ? AdapterDirectClient
  : DirectBeachsideClient;

/** A retained snapshot, with independent restore and deletion operations. */
export type SnapshotHandle = AdapterSnapshot;

/** A prepared image on the provider, with inspection and explicit deletion. */
export type ImageHandle = AdapterImage;

/** Retained storage, with explicit mount descriptors and deletion. */
export type VolumeHandle = AdapterVolume;

export class BeachsideError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly effect: SafeError["effect"] = "none",
    readonly outcome?: OperationOutcome,
    readonly reference?: RecoveryReference,
  ) {
    super(message);
    this.name = "BeachsideError";
  }
}

export class UnsupportedFeatureError extends BeachsideError {
  constructor(
    readonly feature: string,
    readonly unmetRequirements: readonly string[],
  ) {
    super("UNSUPPORTED", `${feature} is unsupported: ${unmetRequirements.join("; ")}`, "none");
    this.name = "UnsupportedFeatureError";
  }
}

export class OutcomeUnknownError<
  R extends RecoveryReference = RecoveryReference,
> extends BeachsideError {
  constructor(
    readonly reference: R,
    message = "Outcome unknown; investigate without blindly resubmitting",
    outcome?: OperationOutcome,
  ) {
    super("OUTCOME_UNKNOWN", message, "possible", outcome);
    this.name = "OutcomeUnknownError";
  }
}

export class WaitAbortedError<
  R extends RecoveryReference = RecoveryReference,
> extends BeachsideError {
  readonly cause: unknown;
  constructor(
    readonly reference: R,
    reason: AbortSignal["reason"],
    outcome?: OperationOutcome,
  ) {
    super(
      "WAIT_ABORTED",
      "Waiting stopped after submission; recover with this reference",
      "possible",
      outcome,
    );
    this.name = "AbortError";
    this.cause = reason;
  }
}

export class NonzeroExitError extends BeachsideError {
  constructor(readonly result: ExecOutput) {
    super("NONZERO_EXIT", `Command exited with code ${result.exitCode}`, "applied");
    this.name = "NonzeroExitError";
  }
}

export class NoExitCodeError extends BeachsideError {
  constructor(readonly result: ExecOutput) {
    super("EXIT_STATUS_UNKNOWN", "Execution completed without an exit code", "applied");
    this.name = "NoExitCodeError";
  }
}

export function newInvocationKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const millis = Date.now();

  for (let i = 0; i < 6; i++) bytes[5 - i] = Math.floor(millis / 2 ** (i * 8)) & 255;
  bytes[6] = (bytes[6]! & 15) | 0x70;
  bytes[8] = (bytes[8]! & 63) | 0x80;
  const h = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

function displayLimit(maxBytes = 16_384): number {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 1_048_576)
    throw new RangeError("maxBytes must be between 0 and 1048576");

  return maxBytes;
}

type OutputOptions = { full: true } | { maxBytes?: number };

function optionObject(value: OutputOptions, key: string): boolean {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can supply malformed options to this public API.
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;

  return (
    Object.prototype.toString.call(value) === "[object Object]" &&
    Reflect.ownKeys(value).every((field) => field === key) &&
    (!(key in value) || Object.hasOwn(value, key))
  );
}

function decodeOutput(bytes: Uint8Array, options?: number | { full: true }): string {
  if (options === undefined) return new TextDecoder().decode(bytes);

  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve the numeric overload while validating JavaScript option objects.
  if (typeof options === "number") {
    const maxBytes = displayLimit(options);

    return (
      new TextDecoder().decode(bytes.subarray(0, maxBytes)) + (bytes.length > maxBytes ? "…" : "")
    );
  }

  if (!optionObject(options, "full") || !Object.hasOwn(options, "full") || options.full !== true)
    throw new RangeError("Text options must contain only full: true");

  return new TextDecoder().decode(bytes);
}

export function outputText(bytes: Uint8Array, maxBytes?: number): string;
export function outputText(bytes: Uint8Array, options: { full: true }): string;
export function outputText(bytes: Uint8Array, options?: number | { full: true }): string {
  return decodeOutput(bytes, options);
}

function previewOutput(bytes: Uint8Array, options?: { maxBytes?: number }): OutputPreview {
  if (options !== undefined && !optionObject(options, "maxBytes"))
    throw new RangeError("Preview options allow only maxBytes");
  const maxBytes = displayLimit(options?.maxBytes);

  return { text: decodeOutput(bytes, maxBytes), shortened: bytes.length > maxBytes };
}

export function validateFilePath(path: string): string {
  if (!FilePath.safeParse(path).success)
    throw new BeachsideError("INVALID_ARGUMENT", "Invalid absolute file path");

  return path;
}

export function execOutput(
  exitCode: number | null,
  stdout: Uint8Array,
  stderr: Uint8Array,
  truncated: boolean,
): ExecOutput {
  return {
    exitCode,
    stdout,
    stderr,
    truncated,
    stdoutText: (options) => decodeOutput(stdout, options),
    stderrText: (options) => decodeOutput(stderr, options),
    stdoutPreview: (options) => previewOutput(stdout, options),
    stderrPreview: (options) => previewOutput(stderr, options),
  };
}

export function checkExec(result: ExecOutput): ExecOutput {
  if (result.exitCode === null) throw new NoExitCodeError(result);

  if (result.exitCode !== 0) throw new NonzeroExitError(result);

  return result;
}

/** Resolves `network` (or deprecated `networkPolicy`) to the policy name an adapter declares. */
export function resolveNetworkPolicy(
  network: string | undefined,
  networkPolicy: string | undefined,
  fallback: string,
  aliases: Readonly<Record<string, string>> = {},
): string {
  if (network !== undefined && networkPolicy !== undefined && network !== networkPolicy)
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "Pass either network or the deprecated networkPolicy, not both",
    );

  const requested = network ?? networkPolicy ?? fallback;

  return Object.hasOwn(aliases, requested) ? aliases[requested]! : requested;
}

export type ValidatedCreate = Omit<CreateInput, "network" | "env"> & {
  environment: ImageInput;
  networkPolicy: string;
  env?: Record<string, string>;
  secrets?: SecretBinding[];
};

export function validateCreate(
  input: (CreateInput & { secrets?: SecretBinding[] }) | undefined,
  defaultEnvironment?: ImageInput,
  defaultNetworkPolicy = "blocked",
  networkPolicyAliases?: Readonly<Record<string, string>>,
): ValidatedCreate {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can pass any create input.
  const raw = typeof input === "object" && input !== null ? input : undefined;

  if (input !== undefined && !raw)
    throw new BeachsideError("INVALID_ARGUMENT", "Invalid create request");
  // Already-validated requests are re-checked with their brokered bindings intact.
  const { secrets: bound, ...rest } = raw ?? {};
  const { env, secrets: split } = splitEnv(rest.env);
  const given = bound === undefined ? undefined : SecretBindings.safeParse(bound);

  if (given && !given.success) throw new BeachsideError("INVALID_ARGUMENT", "Invalid secrets");
  const secrets = given || split ? [...(given?.data ?? []), ...(split ?? [])] : undefined;
  const request = validateCreateRequest(
    raw ? { ...rest, env } : undefined,
    defaultEnvironment,
    defaultNetworkPolicy,
    networkPolicyAliases,
  );

  if (secrets) {
    if (secrets.some((binding) => request.env && Object.hasOwn(request.env, binding.env)))
      throw new BeachsideError("INVALID_ARGUMENT", "A secret and an env entry share a name");
    request.secrets = secrets;
  }

  return request;
}

function validateCreateRequest(
  input: Omit<CreateInput, "env"> & { env?: Record<string, string> } | undefined,
  defaultEnvironment?: ImageInput,
  defaultNetworkPolicy = "blocked",
  networkPolicyAliases?: Readonly<Record<string, string>>,
): ValidatedCreate {
  const parsed = z
    .strictObject({
      environment: z
        .discriminatedUnion("kind", [
          z.strictObject({
            kind: z.literal("prepared"),
            value: z.string().min(1),
            binding: z
              .strictObject({
                provider: z.string().min(1).max(128),
                scope: z.strictObject({
                  authority: z.strictObject({
                    kind: z.string().min(1).max(64),
                    id: z.string().min(1).max(512),
                  }),
                  partition: z.record(z.string().min(1).max(64), z.string().max(2048)),
                }),
              })
              .optional(),
          }),
          z.strictObject({ kind: z.literal("oci"), value: z.string().min(1) }),
        ])
        .optional(),
      requirements: z.strictObject({ snapshot: SnapshotRequest }).optional(),
      mounts: z.array(MountSpec).max(32).optional(),
      network: z.string().min(1).max(128).optional(),
      networkPolicy: z.string().min(1).max(128).optional(),
      region: z.string().min(1).max(128).optional(),
      labels: z.record(z.string(), z.string()).optional(),
      env: CreateEnv.optional(),
      lifecycle: z
        .strictObject({ lifetimeSeconds: z.number().int().positive().safe().optional() })
        .optional(),
    })
    .safeParse(input === undefined ? {} : input);

  if (!parsed.success) {
    // Report only the bounds; environment keys and values never enter a message.
    if (
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JavaScript callers can pass any create input.
      typeof input === "object" &&
      input !== null &&
      input.env !== undefined &&
      !CreateEnv.safeParse(input.env).success
    )
      throw new BeachsideError(
        "INVALID_ARGUMENT",
        "Invalid create env: use at most 128 names matching [A-Za-z_][A-Za-z0-9_]* with string values without NUL, 64 KiB in total",
      );

    throw new BeachsideError("INVALID_ARGUMENT", "Invalid create request");
  }

  const env = parsed.data.env && Object.keys(parsed.data.env).length ? parsed.data.env : undefined;

  if (parsed.data.environment === undefined) {
    if (defaultEnvironment === undefined)
      throw new BeachsideError(
        "INVALID_ARGUMENT",
        "Configure an adapter environment (daytona({ environment: ... })) or pass create({ environment: ... })",
      );

    return validateCreateRequest(
      { ...parsed.data, environment: defaultEnvironment },
      undefined,
      defaultNetworkPolicy,
      networkPolicyAliases,
    );
  }

  const { network, env: _env, ...request } = parsed.data;

  const networkPolicy = resolveNetworkPolicy(
    network,
    request.networkPolicy,
    defaultNetworkPolicy,
    networkPolicyAliases,
  );

  if (!parsed.data.environment.value.trim())
    throw new BeachsideError("INVALID_ARGUMENT", "A prepared or OCI image is required");

  const contract = CreateSandboxInput.safeParse({
    environment:
      parsed.data.environment.kind === "prepared"
        ? { kind: "prepared", imageId: parsed.data.environment.value }
        : { kind: "oci", reference: parsed.data.environment.value },
    network: { policy: networkPolicy },
    requirements: parsed.data.requirements,
    region: parsed.data.region,
    labels: parsed.data.labels,
  });

  if (!contract.success) throw new BeachsideError("INVALID_ARGUMENT", "Invalid create request");

  const resolved: ValidatedCreate = {
    ...request,
    environment: parsed.data.environment,
    networkPolicy,
  };

  if (env) resolved.env = env;

  return resolved;
}

function isArgumentArray(input: ExecInput | readonly string[]): input is readonly string[] {
  return Array.isArray(input);
}

export function validateExec(
  input: ExecInput | readonly string[],
  options: { allowStdin?: boolean } = {},
): ValidatedExecInput {
  const request = isArgumentArray(input)
    ? { command: { kind: "argv" as const, argv: [...input] } }
    : input;

  if (options.allowStdin === false && !isArgumentArray(input) && request?.stdin !== undefined)
    throw new BeachsideError("INVALID_ARGUMENT", "stdin is available only for finite exec input");

  let stdin: Uint8Array | undefined;

  if (request?.stdin !== undefined && isStdinStream(request.stdin))
    throw new BeachsideError(
      "INVALID_ARGUMENT",
      "Streamed stdin is available through exec(), not as finite input",
    );

  if (request?.stdin !== undefined) {
    const parsedInput = ExecStdinInput.safeParse(request.stdin);

    if (!parsedInput.success)
      throw new BeachsideError("INVALID_ARGUMENT", "Invalid or oversized execution stdin");

    stdin =
      parsedInput.data.kind === "text"
        ? new TextEncoder().encode(parsedInput.data.value)
        : new Uint8Array(parsedInput.data.value);

    if (stdin.byteLength > MAX_EXEC_STDIN_BYTES)
      throw new BeachsideError("INVALID_ARGUMENT", "Execution stdin exceeds the byte bound");
  }

  const parsed = ExecRequest.safeParse({
    command: request?.command,
    cwd: request?.cwd,
    env: request?.env,
    deadlineSeconds: request?.deadlineSeconds,
    stdin,
    output: { capture: "bounded", maxBytes: request?.maxOutputBytes ?? 1_048_576 },
  });

  if (!parsed.success) throw new BeachsideError("INVALID_ARGUMENT", "Invalid execution request");

  return {
    command: parsed.data.command,
    cwd: parsed.data.cwd,
    env: parsed.data.env,
    stdin,
    deadlineSeconds: parsed.data.deadlineSeconds ?? 300,
    maxOutputBytes: parsed.data.output?.maxBytes ?? 1_048_576,
  };
}

export function waitDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted)
    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);

    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", abort, { once: true });
  });
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

export function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);

    return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };

    signal.addEventListener("abort", abort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Validate caller input only; native response validation must remain separate. */
export function validateResourceInput<S extends z.ZodType>(
  schema: S,
  value: z.input<S>,
  message: string,
): z.output<S> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) throw new BeachsideError("INVALID_ARGUMENT", message);

  return parsed.data;
}

/** Options for local read-only sandbox observation. */
export type ReadOptions = { signal?: AbortSignal };
