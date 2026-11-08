import {
  AdapterError,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessStartContext,
  type ReadContext,
  type TerminalDimensions,
} from "@beachside/adapter";
import type { PtySessionEvents, PtySessionInfo } from "freestyle";
import { randomBytes } from "node:crypto";
import { z } from "zod";

/** The part of the SDK's `PtySession` a terminal uses. */
export type PtyHandle = {
  write(data: Uint8Array): void;
  resize(options: { cols: number; rows: number }): void;
  signal(signal: "sigint" | "sigkill"): void;
  detach(): void;
};

/** Freestyle terminal sessions (`vm.pty`); tests inject a deterministic stand-in. */
export type PtyDriver = {
  open(
    vmId: string,
    options: { exec: string; cols: number; rows: number; slug: string } & PtySessionEvents,
  ): Promise<PtyHandle>;
  attach(vmId: string, options: { session: string } & PtySessionEvents): Promise<PtyHandle>;
  list(vmId: string, ctx: ReadContext): Promise<PtySessionInfo[]>;
};

const TerminalSize = z.strictObject({
  columns: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

const SessionSlug = z.string().regex(/^beachside-term-[0-9a-f]{24}$/);

export const TerminalReference = z.strictObject({
  version: z.literal(1),
  kind: z.literal("freestyle-pty"),
  sandbox: z.string().min(1).max(128),
  session: SessionSlug,
});

export type TerminalReference = z.infer<typeof TerminalReference>;

export function terminalSlug(): string {
  return `beachside-term-${randomBytes(12).toString("hex")}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;

  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });

  void promise.catch(() => undefined);

  return { promise, resolve, reject };
}

/**
 * A Beachside terminal on a named Freestyle PTY session. Output is the TTY's byte stream on
 * stdout; a reattach skips the scrollback Freestyle replays first, so only new output is
 * reported.
 */
export async function openTerminal(
  driver: PtyDriver,
  input: {
    vmId: string;
    /** A new session's shell command line; absent to reattach to `reference`. */
    command?: string;
    terminal?: TerminalDimensions;
    reference: TerminalReference;
    format: "text" | "bytes";
    capture?: { maxBytes: number };
  },
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  if (input.terminal && !TerminalSize.safeParse(input.terminal).success)
    throw new AdapterError("INVALID_ARGUMENT", "Freestyle terminal dimensions are invalid");

  if (input.format === "bytes" && !ctx.onOutputBytes)
    throw new AdapterError("UNSUPPORTED", "Freestyle binary output requires a byte consumer hook");

  const exited = deferred<NativeProcessExit>();
  const output = deferred<void>();
  const capture = input.capture ? deferred<ExecValue>() : undefined;
  const captureLimit = input.capture?.maxBytes ?? 0;
  const captured: Uint8Array[] = [];
  let capturedBytes = 0;
  let truncated = false;
  const decoder = new TextDecoder();
  let confirmedExit: NativeProcessExit | undefined;
  let outputDetached = false;
  let detached = false;
  let replaying = false;
  const fail = () => new AdapterError("UNAVAILABLE", "Freestyle terminal observation failed");

  const lost = () => {
    if (confirmedExit) return;
    const error = fail();
    exited.reject(error);
    output.reject(error);
    capture?.reject(error);
  };

  const events: PtySessionEvents = {
    reconnect: true,
    onReplayStart: () => {
      replaying = input.command === undefined;
    },
    onReplayEnd: () => {
      replaying = false;
    },
    onData(data) {
      if (replaying || confirmedExit) return;

      if (capture) {
        const take = Math.min(data.length, captureLimit - capturedBytes);

        if (take > 0) captured.push(data.slice(0, take));
        capturedBytes += take;

        if (take < data.length) truncated = true;
      }

      if (outputDetached || detached || !data.length) return;

      try {
        if (input.format === "bytes")
          ctx.onOutputBytes!({ stream: "stdout", bytes: new Uint8Array(data) });
        else {
          const text = decoder.decode(data, { stream: true });

          if (text) ctx.onOutput({ stream: "stdout", text });
        }
      } catch (error) {
        outputDetached = true;
        output.reject(error instanceof Error ? error : fail());
      }
    },
    onExit(exitCode) {
      if (confirmedExit) return;
      confirmedExit = { exitCode };

      if (input.format === "text" && !outputDetached && !detached) {
        const text = decoder.decode();

        if (text) ctx.onOutput({ stream: "stdout", text });
      }

      exited.resolve(confirmedExit);

      capture?.resolve({
        exitCode,
        stdout: new Uint8Array(Buffer.concat(captured)),
        stderr: new Uint8Array(),
        truncated,
      });
      output.resolve();
    },
    onClose: lost,
    onError: () => undefined,
  };

  let handle: PtyHandle;

  try {
    handle = input.command
      ? await driver.open(input.vmId, {
          exec: input.command,
          cols: input.terminal?.columns ?? 80,
          rows: input.terminal?.rows ?? 24,
          slug: input.reference.session,
          ...events,
        })
      : await driver.attach(input.vmId, { session: input.reference.session, ...events });
  } catch (error) {
    if (error instanceof AdapterError) throw error;
    throw new AdapterError("UNAVAILABLE", "Freestyle terminal session did not open");
  }

  const live = () => {
    if (detached) throw fail();

    if (confirmedExit) throw new AdapterError("NOT_FOUND", "Freestyle terminal has exited");
  };

  const send = (action: () => void) => {
    live();

    try {
      action();
    } catch {
      throw new AdapterError("UNAVAILABLE", "Freestyle terminal is disconnected");
    }
  };

  async function disconnect() {
    if (detached) return;
    detached = true;
    handle.detach();

    if (!confirmedExit) exited.reject(fail());
    output.reject(fail());
    capture?.reject(fail());
  }

  return {
    reference: input.reference,
    async signal(signal) {
      if (confirmedExit) return { status: "not-found" };

      if (signal !== "SIGKILL")
        throw new AdapterError("UNSUPPORTED", "Freestyle terminals accept SIGKILL only");
      send(() => handle.signal("sigkill"));

      return { status: "requested" };
    },
    async terminate() {
      if (confirmedExit) return { status: "not-found" };
      send(() => handle.signal("sigkill"));

      return { status: "requested" };
    },
    async resize(dimensions) {
      if (!TerminalSize.safeParse(dimensions).success)
        throw new AdapterError("INVALID_ARGUMENT", "Freestyle terminal dimensions are invalid");
      send(() => handle.resize({ cols: dimensions.columns, rows: dimensions.rows }));
    },
    async write(bytes) {
      send(() => handle.write(new Uint8Array(bytes)));
    },
    async closeStdin() {
      throw new AdapterError("UNSUPPORTED", "Freestyle terminals do not have pipe EOF");
    },
    async status(context) {
      const observedAt = new Date().toISOString();

      if (confirmedExit) return { state: "exited", exit: confirmedExit, observedAt };

      const session = (await driver.list(input.vmId, context)).find(
        (item) => item.slug === input.reference.session,
      );

      if (session?.state === "exited" && Number.isInteger(session.exitCode))
        return { state: "exited", exit: { exitCode: Number(session.exitCode) }, observedAt };

      return { state: session?.state === "running" ? "running" : "unknown", observedAt };
    },
    get confirmedExit() {
      return confirmedExit;
    },
    outputDone: output.promise,
    capture: capture?.promise,
    wait: () => exited.promise,
    async detachOutput() {
      outputDetached = true;
      output.reject(fail());
    },
    disconnect,
    detach: disconnect,
  };
}
