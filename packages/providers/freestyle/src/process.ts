import {
  AdapterError,
  type ExecValue,
  type NativeProcess,
  type NativeProcessExit,
  type ProcessSignal,
  type ProcessStartContext,
  type ProcessStartInput,
  type ReadContext,
} from "@beachside/adapter";
import { setImmediate as yieldOutput } from "node:timers/promises";
import { z } from "zod";
import { commandLine, quote } from "./exec";

/**
 * Freestyle's `exec-await` returns only after a command ends, and its terminal sessions merge
 * stdout and stderr through a TTY. A Beachside process therefore runs as a detached job in
 * the guest: stdout and stderr go to private files, the exit status is written last, and the
 * adapter reads new bytes from both files (base64, so they survive the lossy UTF-8 text
 * channel) until the exit status appears and both files are drained. Pipe stdin is a FIFO
 * kept open by a holder process; closing stdin stops the holder.
 */
export const PROCESS_RECORD = "BEACHSIDE-PROC-1";

const POLL_RECORD = "BEACHSIDE-POLL-1";

/** Bytes read from each stream per poll. */
export const POLL_BYTES = 256 * 1024;

/** Bytes per output callback, well inside the SDK's pending output queue. */
const DELIVERY_BYTES = 16_384;

/** Largest stdin chunk written per request (Freestyle's native stdin bound). */
export const MAX_WRITE_BYTES = 1_048_576;

/** Consecutive failed polls before observation is reported as failed. */
const POLL_FAILURES = 5;

const Directory = z.string().regex(/^\/tmp\/beachside-proc\.[A-Za-z0-9]{8}$/);

export const ProcessReference = z.strictObject({
  version: z.literal(1),
  kind: z.literal("freestyle-job"),
  sandbox: z.string().min(1).max(128),
  directory: Directory,
  stdin: z.enum(["closed", "pipe"]),
});

export type ProcessReference = z.infer<typeof ProcessReference>;

/** Runs one guest command and returns its stdout text; throws an AdapterError otherwise. */
export type GuestRunner = (
  command: string,
  ctx: ReadContext,
  stdin?: Uint8Array,
) => Promise<string>;

export type JobOptions = {
  run: GuestRunner;
  /** Delay between polls while the job is quiet. */
  pollMs: number;
  /** Bound for one poll or control request. */
  requestSeconds: number;
};

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

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();

      return;
    }

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);

    const stop = () => {
      clearTimeout(timer);
      resolve();
    };

    signal.addEventListener("abort", stop, { once: true });
  });
}

/** The guest launcher: a private directory, the detached job, then one record line. */
export function launcherScript(input: ProcessStartInput): string {
  const piped = input.stdin === "pipe";

  // `$1` is the job directory. The command runs as its own process group and session, whose
  // leader records its pid first; signals go to that group, so the job shell outside it
  // survives to write the exit status last. A present `exit` file means both output files
  // are complete.
  const command = [
    'echo $$ >"$1/pid"',
    `exec <${piped ? '"$1/in"' : "/dev/null"} >"$1/out" 2>"$1/err"`,
    commandLine(input),
  ].join("; ");

  const job = [
    `setsid -w sh -c ${quote(command)} sh "$1"`,
    'echo $? >"$1/exit.tmp"',
    'mv "$1/exit.tmp" "$1/exit"',
  ].join("; ");

  const lines = [
    "beachside_d=$(mktemp -d /tmp/beachside-proc.XXXXXXXX) || exit 97",
    ': >"$beachside_d/out"; : >"$beachside_d/err"',
  ];

  if (piped)
    lines.push(
      'mkfifo "$beachside_d/in" || exit 97',
      // The holder keeps the FIFO's write end open, so stdin stays open between writes.
      `setsid -f sh -c ${quote('echo $$ >"$1/holder"; exec sleep 2147483647 >"$1/in"')} sh "$beachside_d" </dev/null >/dev/null 2>&1`,
    );

  lines.push(
    `setsid -f sh -c ${quote(job)} sh "$beachside_d" </dev/null >/dev/null 2>&1`,
    "beachside_i=0",
    'while [ ! -s "$beachside_d/pid" ] && [ "$beachside_i" -lt 200 ]; do sleep 0.05; beachside_i=$((beachside_i + 1)); done',
    '[ -s "$beachside_d/pid" ] || exit 98',
    `printf '${PROCESS_RECORD} %s\\n' "$beachside_d"`,
  );

  return lines.join("\n");
}

/** One poll: exit status (or `-`), both sizes, then new bytes of each stream as base64. */
export function pollScript(directory: string, offsets: { stdout: number; stderr: number }): string {
  const dir = quote(directory);

  return [
    `cd ${dir} 2>/dev/null || { printf '${POLL_RECORD} gone\\n'; exit 0; }`,
    "beachside_x=-; if [ -f exit ]; then beachside_x=$(cat exit); fi",
    "beachside_o=$(($(wc -c <out))); beachside_e=$(($(wc -c <err)))",
    `printf '${POLL_RECORD} %s %s %s\\n' "$beachside_x" "$beachside_o" "$beachside_e"`,
    `tail -c +${offsets.stdout + 1} out | head -c ${POLL_BYTES} | base64 | tr -d '\\n'; printf '\\n'`,
    `tail -c +${offsets.stderr + 1} err | head -c ${POLL_BYTES} | base64 | tr -d '\\n'; printf '\\n'`,
  ].join("\n");
}

const Base64 = /^[A-Za-z0-9+/]*={0,2}$/;

const PollLine = new RegExp(`^${POLL_RECORD} (-|\\d{1,3}) (\\d{1,15}) (\\d{1,15})$`);

type Poll =
  | { gone: true }
  | {
      gone: false;
      exit: number | undefined;
      sizes: { stdout: number; stderr: number };
      stdout: Uint8Array;
      stderr: Uint8Array;
    };

export function parsePoll(text: string): Poll | null {
  if (text === `${POLL_RECORD} gone\n`) return { gone: true };
  const [header = "", out = "", err = "", rest] = text.split("\n");
  const match = PollLine.exec(header);

  if (!match || rest !== "" || !Base64.test(out) || !Base64.test(err)) return null;
  const stdout = Buffer.from(out, "base64");
  const stderr = Buffer.from(err, "base64");

  if (stdout.toString("base64") !== out || stderr.toString("base64") !== err) return null;

  return {
    gone: false,
    exit: match[1] === "-" ? undefined : Number(match[1]),
    sizes: { stdout: Number(match[2]), stderr: Number(match[3]) },
    stdout: new Uint8Array(stdout),
    stderr: new Uint8Array(stderr),
  };
}

const signalNames = { SIGTERM: "TERM", SIGKILL: "KILL" } as const;

/** Start or reattach to a guest job and observe it until exit or detach. */
export async function observeJob(
  options: JobOptions,
  reference: ProcessReference,
  input: {
    format: "text" | "bytes";
    capture?: { maxBytes: number };
    /** Reopened jobs report output written from now on, not output delivered before. */
    fromEnd: boolean;
  },
  ctx: ProcessStartContext,
): Promise<NativeProcess> {
  if (input.format === "bytes" && !ctx.onOutputBytes)
    throw new AdapterError("UNSUPPORTED", "Freestyle binary output requires a byte consumer hook");

  const { run } = options;
  const dir = quote(reference.directory);
  const controller = new AbortController();
  const exited = deferred<NativeProcessExit>();
  const output = deferred<void>();
  const capture = input.capture ? deferred<ExecValue>() : undefined;
  const captureLimit = input.capture?.maxBytes ?? 0;
  const captured = { stdout: new Array<Uint8Array>(), stderr: new Array<Uint8Array>() };
  let capturedBytes = 0;
  let truncated = false;
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const offsets = { stdout: 0, stderr: 0 };
  let confirmedExit: NativeProcessExit | undefined;
  let outputDetached = false;
  let detached = false;
  const fail = () => new AdapterError("UNAVAILABLE", "Freestyle process observation failed");

  const request = (): ReadContext => ({
    signal: controller.signal,
    deadline: Date.now() + options.requestSeconds * 1000,
  });

  const poll = async (context: ReadContext) => {
    const parsed = parsePoll(await run(pollScript(reference.directory, offsets), context));

    if (!parsed) throw fail();

    return parsed;
  };

  if (input.fromEnd) {
    const first = await poll({ signal: ctx.signal, deadline: ctx.deadline });

    if (first.gone) throw new AdapterError("NOT_FOUND", "Freestyle process is absent");
    offsets.stdout = first.sizes.stdout;
    offsets.stderr = first.sizes.stderr;
  }

  /**
   * One poll can return far more than the SDK's pending output queue holds, so each batch is
   * delivered in bounded segments with a yield between them for a ready consumer to drain.
   */
  const deliver = async (stream: "stdout" | "stderr", bytes: Uint8Array) => {
    for (let index = 0; index < bytes.length; index += DELIVERY_BYTES) {
      deliverSegment(stream, bytes.subarray(index, index + DELIVERY_BYTES));
      await yieldOutput();
    }
  };

  const deliverSegment = (stream: "stdout" | "stderr", bytes: Uint8Array) => {
    if (!bytes.length) return;

    if (capture) {
      const take = Math.min(bytes.length, captureLimit - capturedBytes);

      if (take > 0) captured[stream].push(bytes.slice(0, take));
      capturedBytes += take;

      if (take < bytes.length) truncated = true;
    }

    if (outputDetached || detached) return;

    try {
      if (input.format === "bytes") ctx.onOutputBytes!({ stream, bytes });
      else {
        const text = decoders[stream].decode(bytes, { stream: true });

        if (text) ctx.onOutput({ stream, text });
      }
    } catch (error) {
      outputDetached = true;
      output.reject(error instanceof Error ? error : fail());
    }
  };

  async function observe() {
    let failures = 0;

    while (!controller.signal.aborted) {
      let result: Poll;

      try {
        result = await poll(request());
        failures = 0;
      } catch (error) {
        if (controller.signal.aborted) return;

        if (++failures >= POLL_FAILURES) throw error;
        await sleep(options.pollMs, controller.signal);
        continue;
      }

      if (result.gone) throw fail();
      await deliver("stdout", result.stdout);
      await deliver("stderr", result.stderr);
      offsets.stdout += result.stdout.length;
      offsets.stderr += result.stderr.length;

      const drained =
        offsets.stdout >= result.sizes.stdout && offsets.stderr >= result.sizes.stderr;

      if (result.exit !== undefined && drained) {
        confirmedExit = { exitCode: result.exit };

        if (input.format === "text" && !outputDetached && !detached)
          for (const stream of ["stdout", "stderr"] as const) {
            const text = decoders[stream].decode();

            if (text) ctx.onOutput({ stream, text });
          }

        exited.resolve(confirmedExit);

        capture?.resolve({
          exitCode: confirmedExit.exitCode,
          stdout: new Uint8Array(Buffer.concat(captured.stdout)),
          stderr: new Uint8Array(Buffer.concat(captured.stderr)),
          truncated,
        });
        output.resolve();

        return;
      }

      // More bytes are already waiting; read them without a pause.
      if (!drained) continue;
      await sleep(options.pollMs, controller.signal);
    }
  }

  void observe()
    .catch(() => undefined)
    .then(() => {
      if (confirmedExit) return;
      const error = fail();
      exited.reject(error);
      output.reject(error);
      capture?.reject(error);
    });

  const control = async (script: string, context: ReadContext, stdin?: Uint8Array) => {
    if (detached) throw fail();

    return run(`cd ${dir} 2>/dev/null || { echo gone; exit 0; }\n${script}`, context, stdin);
  };

  async function sendSignal(signal: ProcessSignal, context: ReadContext) {
    const name = signalNames[signal];

    // Signal the job's process group (`kill -SIG -PGID` works in dash and bash alike); an
    // exited or vanished job is not found.
    const answer = await control(
      `if [ -f exit ] || [ ! -s pid ]; then echo gone; elif kill -${name} "-$(cat pid)" 2>/dev/null; then echo ok; else echo gone; fi`,
      context,
    );

    return { status: answer.trim() === "ok" ? ("requested" as const) : ("not-found" as const) };
  }

  async function disconnect() {
    if (detached) return;
    detached = true;
    controller.abort();

    if (!confirmedExit) exited.reject(fail());
    output.reject(fail());
    capture?.reject(fail());
  }

  return {
    reference,
    signal: sendSignal,
    terminate: (context) => sendSignal("SIGKILL", context),
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
    async status(context) {
      const observedAt = new Date().toISOString();

      if (confirmedExit) return { state: "exited", exit: confirmedExit, observedAt };

      const answer = (
        await control(
          'if [ -f exit ]; then printf "exit %s\\n" "$(cat exit)"; elif [ -s pid ] && kill -0 "-$(cat pid)" 2>/dev/null; then echo running; else echo unknown; fi',
          context,
        )
      ).trim();

      const code = /^exit (\d{1,3})$/.exec(answer);

      if (code) return { state: "exited", exit: { exitCode: Number(code[1]) }, observedAt };

      return { state: answer === "running" ? "running" : "unknown", observedAt };
    },
    async write(bytes, context) {
      if (reference.stdin !== "pipe")
        throw new AdapterError("UNSUPPORTED", "This Freestyle process has closed stdin");

      for (let index = 0; index < bytes.length; index += MAX_WRITE_BYTES) {
        // Opening the FIFO blocks only when nothing reads it; bound that wait in the guest.
        const answer = await control(
          "if [ -f exit ] || [ ! -s holder ]; then echo gone; elif timeout 10 sh -c 'cat >>in'; then echo ok; else echo gone; fi",
          context,
          bytes.subarray(index, index + MAX_WRITE_BYTES),
        );

        if (answer.trim() !== "ok")
          throw new AdapterError("NOT_FOUND", "Freestyle process stdin is closed or absent");
      }
    },
    async closeStdin(context) {
      if (reference.stdin !== "pipe")
        throw new AdapterError("UNSUPPORTED", "This Freestyle process has closed stdin");

      const answer = await control(
        'if [ -s holder ] && kill "$(cat holder)" 2>/dev/null; then : >holder; echo ok; elif [ -f holder ]; then echo ok; else echo gone; fi',
        context,
      );

      if (answer.trim() !== "ok")
        throw new AdapterError("NOT_FOUND", "Freestyle process is absent");
    },
  };
}

/** Parse the launcher record: the job directory. */
export function parseLauncher(text: string): string | null {
  const match = new RegExp(`^${PROCESS_RECORD} (\\S+)\\n$`).exec(text);
  const directory = Directory.safeParse(match?.[1]);

  return directory.success ? directory.data : null;
}
