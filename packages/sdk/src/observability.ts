import { certifiedRecoveryAvailable, certifiedOperationReference } from "./recovery-diagnostics";
import packageMetadata from "../package.json";
/* oxlint-disable anti-slop/no-runtime-typeof -- This bounded allowlist helper checks primitives in memory without serializing arbitrary values or allocating a schema per span. */
/* oxlint-disable anti-slop/no-unknown-returns -- The heterogeneous instance wrapper is internal and preserves the target method's existing generic return type. */
/* oxlint-disable anti-slop/no-unknown-parameters -- Telemetry boundaries accept arbitrary thrown values and heterogeneous SDK results without serializing them. */
import {
  context,
  trace,
  ROOT_CONTEXT,
  SpanStatusCode,
  SpanKind,
  type Context,
  type Span,
  type SpanContext,
  type TracerProvider,
  type Attributes,
} from "@opentelemetry/api";
import { BeachsideError, NonzeroExitError, NoExitCodeError } from "./resource";

export interface ObservabilityOptions {
  /** Omission uses the application provider. Beachside never owns provider shutdown. */
  tracing?: false | { tracerProvider?: TracerProvider };
}

export interface DiagnosticContext {
  errorCode?: string;
  effect?: "none" | "possible" | "applied" | "partial" | "unknown";
  operationId?: string;
  submissionId?: string;
  operationState?: "pending" | "completed" | "rejected" | "failed" | "unknown";
  recoveryAvailable: boolean;
}

const retainedCounts = new WeakMap<object, number>();

export function noteRetainedResources<T extends object>(value: T, count: number): void {
  retainedCounts.set(value, Math.min(count, 100));
}

const operationFacts = new WeakMap<
  object,
  { state: NonNullable<DiagnosticContext["operationState"]>; effect: DiagnosticContext["effect"] }
>();

export function noteOperation<T extends object>(
  value: T,
  state: NonNullable<DiagnosticContext["operationState"]>,
  effect: DiagnosticContext["effect"],
): void {
  const facts = operationFacts.get(value);

  if (facts) {
    facts.state = state;
    facts.effect = effect;
  } else operationFacts.set(value, { state, effect });
}

const codes = new Set([
  "INVALID_ARGUMENT",
  "INVALID_RESPONSE",
  "UNSUPPORTED",
  "UNAVAILABLE",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "CONFLICT",
  "NOT_FOUND",
  "CAPACITY",
  "RATE_LIMIT",
  "OUTPUT_CAPACITY",
  "OUTPUT_UNAVAILABLE",
  "INVOCATION_EXPIRED",
  "CLIENT_CLOSED",
  "WAIT_ABORTED",
  "OUTCOME_UNKNOWN",
  "REFERENCE_SAVE_FAILED",
  "SOURCE_RESTART_FAILED",
  "NONZERO_EXIT",
  "EXIT_STATUS_UNKNOWN",
  "TIMEOUT",
  "HTTP_ERROR",
  "OPERATION_FAILED",
  "INTERNAL",
]);

// Only Beachside-generated identities, never native locators, are eligible for telemetry.
export function safeIdentity(value: unknown): string | undefined {
  return typeof value === "string" && /^(sdk|op|sub)_[0-9a-f]{32}$/.test(value) ? value : undefined;
}

/** Pure correlation data; the original handle/error retains recovery authority. */
export function diagnosticContext(value: unknown): Readonly<DiagnosticContext> {
  const record: DiagnosticContext = { recoveryAvailable: false };

  try {
    if (value instanceof BeachsideError) {
      const code = Object.getOwnPropertyDescriptor(value, "code")?.value;
      const effect = Object.getOwnPropertyDescriptor(value, "effect")?.value;

      record.errorCode = typeof code === "string" && codes.has(code) ? code : "INTERNAL";

      if (
        effect === "none" ||
        effect === "possible" ||
        effect === "applied" ||
        effect === "partial" ||
        effect === "unknown"
      )
        record.effect = effect;

      if (code === "OUTCOME_UNKNOWN") record.operationState = "unknown";

      if (value instanceof NonzeroExitError || value instanceof NoExitCodeError)
        record.operationState = "completed";
    }

    if (value && typeof value === "object") {
      const state = operationFacts.get(value);

      if (state) {
        record.operationState = state.state;
        record.effect = state.effect;
      }

      // Data properties only: diagnostic collection never invokes application accessors.
      const ref =
        certifiedOperationReference(value) ??
        Object.getOwnPropertyDescriptor(value, "reference")?.value;

      if (ref && typeof ref === "object") {
        record.operationId = safeIdentity(
          Object.getOwnPropertyDescriptor(ref, "operationId")?.value,
        );
        record.submissionId = safeIdentity(
          Object.getOwnPropertyDescriptor(ref, "submissionId")?.value,
        );
        record.recoveryAvailable = certifiedRecoveryAvailable(ref);
      }
    }
  } catch {
    // Malformed objects/getters are not a diagnostic failure path.
  }

  return Object.freeze(record);
}

function diagnosticAttributes(value: unknown): Attributes {
  const d = diagnosticContext(value);
  const attrs: Attributes = {};

  if (d.errorCode) attrs["beachside.error.code"] = d.errorCode;

  if (d.effect) attrs["beachside.effect"] = d.effect;

  if (d.operationId) attrs["beachside.operation.id"] = d.operationId;

  if (d.submissionId) attrs["beachside.submission.id"] = d.submissionId;

  if (d.operationState) attrs["beachside.operation.state"] = d.operationState;
  attrs["beachside.recovery.available"] = d.recoveryAvailable;

  if (value && typeof value === "object") {
    const retained = retainedCounts.get(value);

    if (retained !== undefined) attrs["beachside.retained_resource.count"] = retained;
  }

  return attrs;
}

/** W3C version 00 only; fixed size, no tracestate or baggage. */
export function parseTraceParent(value: unknown): SpanContext | undefined {
  if (typeof value !== "string" || value.length !== 55) return;
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-(00|01)$/.exec(value);

  if (!match || /^0+$/.test(match[1]!) || /^0+$/.test(match[2]!)) return;

  return { traceId: match[1]!, spanId: match[2]!, traceFlags: Number(match[3]), isRemote: true };
}

function attempt<T>(work: () => T): T | undefined {
  try {
    return work();
  } catch {
    return undefined;
  }
}

export function activeTraceParent(): string | undefined {
  return attempt(() => {
    const sc = trace.getSpanContext(context.active());

    if (!sc || !trace.isSpanContextValid(sc)) return;

    return `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags & 1 ? "01" : "00"}`;
  });
}

const operationKinds = new Set([
  "create",
  "exec",
  "destroy",
  "file_write",
  "file_mkdir",
  "file_remove",
  "image_build",
  "image_delete",
  "snapshot_capture",
  "snapshot_restore",
  "snapshot_delete",
  "volume_create",
  "volume_delete",
]);

function operationKind(value: unknown): string | undefined {
  return typeof value === "string" && operationKinds.has(value) ? value : undefined;
}

function identityKind(value: unknown): string | undefined {
  return attempt(() => {
    if (!value || typeof value !== "object") return;

    const reference =
      certifiedOperationReference(value) ??
      Object.getOwnPropertyDescriptor(value, "reference")?.value;

    if (!reference || typeof reference !== "object") return;

    return operationKind(Object.getOwnPropertyDescriptor(reference, "kind")?.value);
  });
}

function callType(name: string): string | undefined {
  if (
    [
      "beachside.sandbox.create",
      "beachside.sandbox.submit_create",
      "beachside.sandbox.check_create",
    ].includes(name)
  )
    return "create";

  if (["beachside.exec", "beachside.exec.submit"].includes(name)) return "exec";

  if (["beachside.image.build", "beachside.image.submit_build"].includes(name))
    return "image_build";

  if (name === "beachside.file.write") return "file_write";

  if (name === "beachside.file.mkdir") return "file_mkdir";

  if (name === "beachside.file.remove") return "file_remove";

  if (name === "beachside.sandbox.destroy") return "destroy";

  return undefined;
}

interface CallState {
  name: string;
  operationType?: string;
  polls: number;
  transitions: number;
  last?: string;
  effect: "none" | "possible" | "applied";
  dropped: number;
  span: Span;
}

/** Internal direct SDK instrumentation; never configures OTel globals. */
export class Telemetry {
  private readonly owner = Symbol("beachside.call");
  constructor(
    options: ObservabilityOptions = {},
    private readonly mode: "direct" = "direct",
    private readonly provider = "custom",
  ) {
    this.options = { tracing: options.tracing };
  }
  private readonly options: ObservabilityOptions;
  get enabled(): boolean {
    return this.options.tracing !== false;
  }
  correlate(value: unknown): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (call && call.span.isRecording()) call.span.setAttributes(diagnosticAttributes(value));
    });
  }
  submitted(): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (call) call.effect = "possible";
    });
  }
  poll(state: "pending" | "completed" | "rejected" | "unknown"): void {
    if (!this.enabled) return;
    attempt(() => {
      // SAFETY: This private context key is set only by this Telemetry instance with a CallState.
      const call = context.active().getValue(this.owner) as CallState | undefined;

      if (!call) return;
      call.polls++;

      if (call.last === state) return;
      call.last = state;

      if (call.transitions++ < 8)
        attempt(() =>
          call.span.addEvent("beachside.state", { "beachside.operation.state": state }),
        );
      else call.dropped++;
    });
  }
  async *iterate(
    name: string,
    source: AsyncIterable<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncIterable<Uint8Array> {
    let complete!: (bytes: number) => void;
    let failed!: (error: unknown) => void;

    const completion = new Promise<number>((resolve, reject) => {
      complete = resolve;
      failed = reject;
    });

    const span = this.run(name, () => completion, { signal });
    const cancelled = () => failed(new BeachsideError("WAIT_ABORTED", "File stream cancelled"));

    signal?.addEventListener("abort", cancelled, { once: true });

    if (signal?.aborted) cancelled();
    // The iterator owns the error; observing the promise here prevents unhandled rejections while paused.
    void span.catch(() => undefined);
    let bytes = 0;
    let ended = false;

    try {
      for await (const chunk of source) {
        bytes += chunk.length;
        yield chunk;
      }

      ended = true;
      complete(bytes);
      await span;
    } catch (error) {
      ended = true;
      failed(error);
      await span;
      throw error;
    } finally {
      signal?.removeEventListener("abort", cancelled);

      if (!ended) {
        failed(new BeachsideError("WAIT_ABORTED", "File stream consumption ended"));
        await span.catch(() => undefined);
      }
    }
  }
  async run<T>(
    name: string,
    work: () => Promise<T>,
    options: {
      phase?: boolean;
      effect?: "none" | "possible" | "applied";
      origin?: unknown;
      parent?: Context;
      kind?: SpanKind;
      identity?: unknown;
      operationType?: string;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (!this.enabled) return work();
    const parent = options.parent ?? attempt(() => context.active()) ?? ROOT_CONTEXT;

    // SAFETY: Only this instance writes the owner key with a CallState.
    const enclosing = attempt(() => parent.getValue(this.owner)) as CallState | undefined;

    const operationType =
      operationKind(options.operationType) ??
      identityKind(options.identity) ??
      callType(name) ??
      enclosing?.operationType;

    const provider = this.options.tracing && this.options.tracing.tracerProvider;
    const scope = "beachside";

    const span = attempt(() => {
      const tracer = provider
        ? provider.getTracer(scope, packageMetadata.version)
        : trace.getTracer(scope, packageMetadata.version);

      const origin = parseTraceParent(options.origin);

      const attributes: Attributes = {
        "beachside.mode": this.mode,
        "beachside.provider": ["daytona", "e2b", "modal", "fake"].includes(this.provider)
          ? this.provider
          : "custom",
        "beachside.operation.type": operationType ?? name.replace(/^beachside\./, ""),
      };

      if (options.phase) attributes["beachside.phase"] = name.slice(8);

      if (options.identity) Object.assign(attributes, diagnosticAttributes(options.identity));

      return tracer.startSpan(
        name,
        {
          kind: options.kind ?? SpanKind.INTERNAL,
          attributes,
          links: origin ? [{ context: origin }] : [],
        },
        parent,
      );
    });

    if (!span) return work();
    const recording = attempt(() => span.isRecording()) ?? false;

    const state: CallState = {
      name,
      operationType,
      polls: 0,
      transitions: 0,
      effect: options.identity ? "possible" : "none",
      dropped: 0,
      span,
    };

    let active = attempt(() => trace.setSpan(parent, span)) ?? parent;

    if (!options.phase || name === "beachside.wait")
      active = attempt(() => active.setValue(this.owner, state)) ?? parent;
    // Call work once even if a custom context manager throws before/after invoking it.
    let promise: Promise<T> | undefined;
    let invoked = false;

    const invoke = () => {
      if (!invoked) {
        invoked = true;

        try {
          promise = Promise.resolve(work());
        } catch (error) {
          promise = Promise.reject(error);
        }
      }

      return promise!;
    };

    try {
      attempt(() => context.with(active, invoke));
      const result = await (promise ?? invoke());

      if (recording)
        attempt(() => {
          span.setAttributes({
            "beachside.call.outcome": "success",
            "beachside.effect": options.effect ?? "none",
            ...diagnosticAttributes(result),
          });

          if (
            name.startsWith("beachside.file.") &&
            typeof result === "number" &&
            Number.isSafeInteger(result)
          )
            span.setAttribute("beachside.file.bytes", result);

          if (name === "beachside.wait" || name === "beachside.operation.wait")
            span.setAttributes({
              ...diagnosticAttributes(options.identity),
              "beachside.operation.state": "completed",
            });

          if (name === "beachside.operation.observe")
            span.setAttributes({
              ...diagnosticAttributes(options.identity),
              "beachside.operation.state": result === null ? "pending" : "completed",
              "beachside.effect": result === null ? "possible" : "applied",
            });

          if (
            result &&
            typeof result === "object" &&
            "reference" in result &&
            name.includes("submit")
          ) {
            const facts = diagnosticContext(result);

            if (!facts.operationState) span.setAttribute("beachside.effect", "possible");
          }

          if (
            result &&
            typeof result === "object" &&
            "exitCode" in result &&
            Number.isSafeInteger(result.exitCode)
          )
            span.setAttribute("beachside.exec.exit_code", Number(result.exitCode));

          if (result && typeof result === "object" && "kind" in result) {
            if (result.kind === "unknown")
              span.setAttributes({
                "beachside.operation.state": "unknown",
                "beachside.effect": "possible",
              });

            if (result.kind === "pending")
              span.setAttributes({
                "beachside.operation.state": "pending",
                "beachside.effect": "possible",
              });

            if (result.kind === "rejected")
              span.setAttributes({
                "beachside.effect": "none",
                "beachside.operation.state": "rejected",
              });

            if (result.kind === "completed") {
              span.setAttributes({
                "beachside.operation.state": "completed",
                "beachside.effect": "applied",
              });

              if (
                "value" in result &&
                result.value &&
                typeof result.value === "object" &&
                "retainedResources" in result.value &&
                Array.isArray(result.value.retainedResources)
              )
                span.setAttribute(
                  "beachside.retained_resource.count",
                  Math.min(result.value.retainedResources.length, 100),
                );
            }
          }
        });

      return result;
    } catch (error) {
      if (recording)
        attempt(() => {
          const attrs = diagnosticAttributes(error);

          const cancelled =
            options.signal?.aborted || attrs["beachside.error.code"] === "WAIT_ABORTED";

          const identityAttrs: Attributes =
            name === "beachside.wait" ||
            name === "beachside.operation.wait" ||
            name === "beachside.operation.observe"
              ? diagnosticAttributes(options.identity)
              : {};

          span.setAttributes({
            ...identityAttrs,
            "beachside.call.outcome": cancelled ? "cancelled" : "error",
            "beachside.effect": state.effect,
            ...attrs,
          });

          if (identityAttrs["beachside.recovery.available"])
            span.setAttribute("beachside.recovery.available", true);

          if (!cancelled)
            span.setStatus({ code: SpanStatusCode.ERROR, message: "Beachside call failed" });

          if (!options.phase)
            span.recordException({
              name: "BeachsideError",
              message: String(attrs["beachside.error.code"] ?? "INTERNAL"),
            });

          if (error instanceof NonzeroExitError || error instanceof NoExitCodeError) {
            if (error.result.exitCode !== null)
              span.setAttribute("beachside.exec.exit_code", error.result.exitCode);
          }
        });
      throw error;
    } finally {
      if (recording && (name === "beachside.wait" || name === "beachside.operation.wait"))
        attempt(() =>
          span.setAttributes({
            "beachside.wait.poll_count": state.polls,
            "beachside.events.dropped": state.dropped,
          }),
        );
      attempt(() => span.end());
    }
  }
}

/** Wrap an instance method; the original receiver, arguments and results are preserved. */
export function instrument<T extends object, K extends keyof T>(
  target: T,
  key: K,
  telemetry: Telemetry,
  name: string,
  options: {
    phase?: boolean;
    effect?: "none" | "possible" | "applied";
    identity?: unknown;
    origin?: string;
  } = {},
): void {
  // SAFETY: Call sites select an existing async instance method; arguments and result types are preserved by T[K].
  const original = target[key] as (...args: unknown[]) => Promise<unknown>;

  const invoke = async (...args: unknown[]) => {
    try {
      const result = await original.apply(target, args);

      if (name === "beachside.operation.observe" || name === "beachside.operation.wait") {
        noteOperation(
          target,
          result === null ? "pending" : "completed",
          result === null ? "possible" : "applied",
        );
      }

      return result;
    } catch (error) {
      if (
        (name === "beachside.operation.observe" || name === "beachside.operation.wait") &&
        error instanceof BeachsideError
      ) {
        if (error.code === "OUTCOME_UNKNOWN") noteOperation(target, "unknown", "possible");

        if (error.effect === "applied") noteOperation(target, "completed", "applied");
      }

      throw error;
    }
  };

  const wrapped = (...args: unknown[]) => {
    const identity =
      name === "beachside.operation.recover" || name === "beachside.observe"
        ? { reference: args[0] }
        : options.identity;

    const operationType = name === "beachside.prepare" ? operationKind(args[0]) : undefined;

    // SAFETY: The operation.wait wrapper retains its typed first options argument.
    const signal =
      name === "beachside.operation.wait"
        ? attempt(() => (args[0] as { signal?: AbortSignal } | undefined)?.signal)
        : undefined;

    return telemetry.run(name, () => invoke(...args), {
      ...options,
      identity,
      operationType,
      signal,
    });
  };

  methodBodies.set(wrapped, invoke);
  // SAFETY: Both wrappers preserve the receiver, arguments and original Promise result type.
  target[key] = wrapped as T[K];
}

const methodBodies = new WeakMap<object, object>();

/** Only explicit library delegation bypasses public tracing; user calls always get a span. */
export function internalMethod<F extends (...args: never[]) => Promise<unknown>>(method: F): F {
  // SAFETY: instrument stores a bound implementation with the exact same method signature.
  return (methodBodies.get(method) ?? method) as F;
}

export function waitFor<T>(
  telemetry: Telemetry,
  operation: { wait(options?: { signal?: AbortSignal; pollMs?: number }): Promise<T> },
  options: { signal?: AbortSignal; pollMs?: number } = {},
): Promise<T> {
  return telemetry.run("beachside.wait", () => internalMethod(operation.wait)(options), {
    phase: true,
    identity: operation,
    effect: "applied",
    signal: options.signal,
  });
}
