import { randomUUID } from "node:crypto";
import {
  AdapterError,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessSignal,
  type ProcessStartContext,
  type ReadContext,
} from "@beachside/adapter";
import type { Sandbox as NativeSandbox, SandboxProcess, SandboxProcessResult } from "disk";
import { z } from "zod";
import { quote } from "./shell";

/** Bytes a stdin write may leave queued on the socket before the next chunk waits. */
const STDIN_HIGH_WATER = 4 * 1024 * 1024;

/** Reattach attempts after a dropped process connection before observation fails. */
const REATTACH_ATTEMPTS = 3;

/** Where each Beachside process records its shell PID, so signals reach the program. */
export const PID_DIRECTORY = "/tmp/.beachside-pids";

/**
 * A process reference: the Archil process id, the PID file its launcher wrote, and the output
 * cursor when the reference was taken, so reopening continues instead of replaying.
 */
export const ProcessReference = z.strictObject({
  version: z.literal(1),
  kind: z.literal("archil-process"),
  sandbox: z.string().min(1).max(128),
  process: z.string().min(1).max(256),
  pidFile: z
    .string()
    .regex(/^\/tmp\/\.beachside-pids\/[0-9a-f-]{36}$/)
    .optional(),
  terminal: z.boolean(),
  stdin: z.enum(["closed", "pipe"]),
  offset: z.number().int().nonnegative().safe(),
});

export type ProcessReference = z.infer<typeof ProcessReference>;

/**
 * Wrap a command line so its shell PID lands in a private file: a later signal reaches the
 * program's process group. The file is removed when the command ends or is signalled.
 */
export function launcher(commandLine: string) {
  const pidFile = `${PID_DIRECTORY}/${randomUUID()}`;

  return {
    pidFile,
    script: `mkdir -p ${PID_DIRECTORY} && echo $$ > ${quote(pidFile)} && { ${commandLine}; }; s=$?; rm -f ${quote(pidFile)}; exit $s`,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });

  // Rejections are observed by whoever awaits; unobserved ones must not crash the host.
  promise.catch(() => undefined);

  return { promise, resolve, reject };
}

/** Shell-convention exit codes for the signals this adapter sends: 128 plus the number. */
const SIGNALLED = { SIGTERM: 143, SIGKILL: 137 } as const;

/**
 * Exit code from a native result. Archil reports a process a signal ended as exit code -1,
 * so a negative code becomes the shell convention only for a signal this handle sent;
 * cancelled, timed-out and other signalled exits have none.
 */
export function exitCode(
  result: SandboxProcessResult,
  sent?: keyof typeof SIGNALLED,
): number | null {
  if (result.exitCode === undefined || !Number.isInteger(result.exitCode)) return null;

  if (result.exitCode >= 0) return result.exitCode;

  return sent ? SIGNALLED[sent] : null;
}

const QueuedSocket = z.object({
  _socket: z.object({ bufferedAmount: z.number() }).optional(),
});

/** Wait for the socket's queued stdin to drain below the high-water mark. */
async function drained(handle: SandboxProcess, signal: AbortSignal): Promise<void> {
  // The SDK queues input on its WebSocket without backpressure; the socket's own
  // `bufferedAmount` is the only drain signal, read defensively from the pinned SDK handle.
  const buffered = () => {
    const queued = QueuedSocket.safeParse(handle);

    return queued.success ? (queued.data._socket?.bufferedAmount ?? 0) : 0;
  };

  while (buffered() > STDIN_HIGH_WATER) {
    signal.throwIfAborted();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Send bytes in bounded chunks, waiting for the socket to drain between them. */
export async function sendInput(
  handle: SandboxProcess,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    await drained(handle, signal);
    await handle.sendInput(bytes.subarray(offset, offset + 1024 * 1024));
  }

  await drained(handle, signal);
}

export type ProcessOptions = {
  /** The SDK sandbox the process belongs to, built on the adapter's client. */
  sandbox: () => NativeSandbox;
  /** True while this client pauses or snapshots the sandbox, which drops every connection. */
  held: () => boolean | Promise<boolean>;
  /** A short-lived guest command for signals; resolves with its exit code. */
  signalCommand: (script: string, ctx: ReadContext) => Promise<number | null>;
};

/**
 * Observe an Archil process through the official SDK handle: raw output frames go to the
 * Beachside callbacks (bytes or decoded text), finite capture is bounded, and a dropped
 * connection reattaches at the last cursor instead of replaying anything.
 */
export function observeProcess(
  options: ProcessOptions,
  first: SandboxProcess,
  reference: Omit<ProcessReference, "offset">,
  input: { format: "text" | "bytes"; capture?: { maxBytes: number }; offset: number },
  ctx: ProcessStartContext,
  attach: (offset: number, onOutput: (frame: Frame) => void) => Promise<SandboxProcess>,
) {
  if (input.format === "bytes" && !ctx.onOutputBytes)
    throw new AdapterError("UNSUPPORTED", "Archil binary output requires a byte consumer hook");

  const exited = deferred<NativeProcessExit>();
  const output = deferred<void>();
  const capture = input.capture ? deferred<ExecValue>() : undefined;
  const captureLimit = input.capture?.maxBytes ?? 0;
  const captured = { stdout: new Array<Uint8Array>(), stderr: new Array<Uint8Array>() };
  let capturedBytes = 0;
  let truncated = false;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  let handle = first;
  let cursor = input.offset;
  let confirmedExit: NativeProcessExit | undefined;
  let outputDetached = false;
  let detached = false;
  const fail = () => new AdapterError("UNAVAILABLE", "Archil process observation failed");

  const onOutput = (frame: Frame) => {
    // Frames carry absolute offsets; anything at or before the cursor was delivered already.
    const end = frame.offset + frame.data.byteLength;

    if (end <= cursor) return;
    const bytes = frame.data.subarray(Math.max(0, cursor - frame.offset));
    cursor = end;

    if (capture) {
      const take = Math.min(bytes.length, captureLimit - capturedBytes);

      if (take > 0) captured[frame.stream].push(bytes.slice(0, take));
      capturedBytes += Math.max(0, take);

      if (take < bytes.length) truncated = true;
    }

    if (outputDetached || detached || !bytes.length) return;

    try {
      if (input.format === "bytes") ctx.onOutputBytes!({ stream: frame.stream, bytes });
      else {
        const text = decoders[frame.stream].decode(bytes, { stream: true });

        if (text) ctx.onOutput({ stream: frame.stream, text });
      }
    } catch (error) {
      outputDetached = true;
      output.reject(error instanceof Error ? error : fail());
    }
  };

  /** The last signal this handle delivered, which explains a negative native exit code. */
  let sent: keyof typeof SIGNALLED | undefined;

  const finish = (result: SandboxProcessResult) => {
    const code = exitCode(result, sent);

    if (input.format === "text" && !outputDetached && !detached)
      for (const stream of ["stdout", "stderr"] as const) {
        const text = decoders[stream].decode();

        if (text) ctx.onOutput({ stream, text });
      }

    // A process the runtime stopped without an exit code (timeout, cancel, signal) has no
    // Beachside exit evidence; observation fails rather than inventing one.
    if (code === null) {
      const error = new AdapterError(
        "UNAVAILABLE",
        `Archil process ended as ${result.status}${result.exitReason ? ` (${result.exitReason})` : ""} without an exit code`,
      );

      exited.reject(error);
      output.resolve();
      capture?.reject(error);

      return;
    }

    confirmedExit = { exitCode: code };
    exited.resolve(confirmedExit);
    output.resolve();

    capture?.resolve({
      exitCode: code,
      stdout: new Uint8Array(Buffer.concat(captured.stdout)),
      stderr: new Uint8Array(Buffer.concat(captured.stderr)),
      truncated,
    });
  };

  async function observe() {
    for (let attempt = 0; ;) {
      try {
        finish(await handle.wait());

        return;
      } catch (error) {
        if (detached) return;

        // A pause or snapshot of this client's own drops every connection; wait it out.
        while ((await options.held()) && !detached)
          await new Promise((resolve) => setTimeout(resolve, 500));

        if (detached) return;

        if (++attempt > REATTACH_ATTEMPTS) throw error;
      }

      // The connection dropped before exit; attaching at the cursor is a read, never a start.
      try {
        handle = await attach(cursor, onOutput);
        attempt = 0;
      } catch {
        if (detached) return;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
    }
  }

  void observe().catch(() => {
    if (confirmedExit || detached) return;
    const error = fail();
    exited.reject(error);
    output.reject(error);
    capture?.reject(error);
  });

  async function disconnect() {
    if (detached) return;
    detached = true;
    await handle.disconnect().catch(() => undefined);

    if (!confirmedExit) exited.reject(fail());
    output.reject(fail());
    capture?.reject(fail());
  }

  const signal = async (name: ProcessSignal, context: ReadContext) => {
    if (detached) throw fail();

    if (confirmedExit) return { status: "not-found" as const };

    if (!reference.pidFile) {
      // A terminal's only control is the native kill.
      if (name !== "SIGKILL")
        throw new AdapterError("UNSUPPORTED", "Archil terminals accept only SIGKILL");
      await handle.kill();

      return { status: "requested" as const };
    }

    // Set before sending, since the exit can arrive before the signal command returns; a
    // signal that found no process is taken back.
    const previous = sent;
    sent = name === "SIGKILL" ? "SIGKILL" : "SIGTERM";

    const code = await options.signalCommand(
      // The process group first, so the program and its children all get the signal.
      `f=${quote(reference.pidFile)}; p=$(cat "$f" 2>/dev/null) && [ -n "$p" ] && { kill -${name === "SIGKILL" ? "KILL" : "TERM"} -- "-$p" 2>/dev/null || kill -${name === "SIGKILL" ? "KILL" : "TERM"} "$p" 2>/dev/null; }${
        // A killed shell cannot remove its PID file; a terminated program may still be running.
        name === "SIGKILL" ? ' && rm -f "$f"' : ""
      }`,
      context,
    );

    if (code !== 0) sent = previous;

    return { status: code === 0 ? ("requested" as const) : ("not-found" as const) };
  };

  const process: NativeProcess = {
    get reference() {
      return { ...reference, offset: cursor };
    },
    signal,
    // A recorded PID is killed directly, so the exit keeps its code; terminals use native kill.
    terminate: (context: ReadContext) => signal("SIGKILL", context),
    async resize(dimensions) {
      if (!reference.terminal)
        throw new AdapterError("UNSUPPORTED", "Only Archil terminals can be resized");
      await handle.resize({ cols: dimensions.columns, rows: dimensions.rows });
    },
    disconnect,
    detach: disconnect,
    async detachOutput() {
      outputDetached = true;
      output.reject(fail());
    },
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone: output.promise,
    capture: capture?.promise,
    wait: () => exited.promise,
    async status() {
      const observedAt = new Date().toISOString();

      if (confirmedExit) return { state: "exited", exit: confirmedExit, observedAt };

      return { state: handle.connected ? "running" : "unknown", observedAt };
    },
    async write(bytes, context) {
      if (reference.stdin !== "pipe")
        throw new AdapterError("UNSUPPORTED", "This Archil process has closed stdin");

      if (detached || confirmedExit)
        throw new AdapterError("NOT_FOUND", "Archil process stdin is closed or absent");
      await sendInput(handle, bytes, context.signal);
    },
    async closeStdin() {
      if (reference.stdin !== "pipe")
        throw new AdapterError("UNSUPPORTED", "This Archil process has closed stdin");

      if (detached) throw new AdapterError("NOT_FOUND", "Archil process is absent");
      await handle.closeStdin();
    },
  };

  return { process, onOutput };
}

export type Frame = { stream: "stdout" | "stderr"; offset: number; data: Uint8Array };

/**
 * Frames can arrive as soon as the runtime acknowledges a start, before the observer exists;
 * the relay buffers them until a target is attached, then forwards in order.
 */
export function frameRelay() {
  const queued: Frame[] = [];
  let target: ((frame: Frame) => void) | undefined;

  return {
    push(frame: Frame) {
      // The SDK reuses no buffers, but copy anyway: the frame outlives this callback.
      const copy = { stream: frame.stream, offset: frame.offset, data: frame.data.slice() };

      if (target) target(copy);
      else queued.push(copy);
    },
    attach(next: (frame: Frame) => void) {
      target = next;

      for (const frame of queued.splice(0)) next(frame);
    },
  };
}
