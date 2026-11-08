#!/usr/bin/env node
import { main } from "./cli";

const controller = new AbortController();

let interrupted = false;

// The first signal cancels local waits so run can still clean up; a second one exits now.
// Harness timeouts usually send SIGTERM (or SIGHUP when the terminal goes away), not SIGINT.
const signalExitCodes = { SIGINT: 130, SIGHUP: 129, SIGTERM: 143 } as const;

let exitCode = 130;

for (const [name, code] of Object.entries(signalExitCodes))
  process.on(name, () => {
    if (interrupted) process.exit(code);
    interrupted = true;
    exitCode = code;
    controller.abort(new Error(`Interrupted by ${name}`));
  });

/** Wait for a full output buffer to drain, or for the stream to close (a closed pipe). */
function ready(name: "stdout" | "stderr"): Promise<void> {
  const stream = process[name];

  if (!stream.writableNeedDrain) return Promise.resolve();

  return new Promise((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      stream.off("error", done);
      resolve();
    };

    stream.on("drain", done);
    stream.on("close", done);
    stream.on("error", done);
  });
}

async function* stdin(): AsyncIterable<Uint8Array> {
  for await (const chunk of process.stdin) yield new Uint8Array(chunk);
}

const code = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  signal: controller.signal,
  stdin,
  streams: {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    ready,
  },
});

// A command can exit while stdin is still open (a tunnel, a terminal); stop reading it so the
// CLI exits too.
process.stdin.destroy();

// An interrupted run reports 128 + signal like other CLIs, whatever happened before it.
process.exitCode = interrupted ? exitCode : code;
