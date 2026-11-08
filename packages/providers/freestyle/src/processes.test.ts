import { afterEach, expect, test } from "bun:test";
import { Beachside } from "beachside";
import type { PtySessionEvents, PtySessionInfo } from "freestyle";
import { createFreestyleAdapter } from "./adapter";
import { freestyleFixture } from "./fixture.test-support";
import type { PtyDriver } from "./terminal";

const fixtures: ReturnType<typeof freestyleFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

/** A terminal stand-in: the command runs through the local sh with pipes instead of a TTY. */
function fakePty() {
  type Session = {
    info: PtySessionInfo;
    events: PtySessionEvents;
    child: Bun.Subprocess<"pipe", "pipe", "inherit">;
  };

  const sessions = new Map<string, Session>();
  const resized: { cols: number; rows: number }[] = [];
  const opened: string[] = [];
  const reconnect: (PtySessionEvents["reconnect"] | undefined)[] = [];

  const handle = (slug: string) => ({
    write(data: Uint8Array) {
      const session = sessions.get(slug);

      session?.child.stdin.write(data);
      void session?.child.stdin.flush();
    },
    resize(options: { cols: number; rows: number }) {
      resized.push(options);
    },
    signal(signal: "sigint" | "sigkill") {
      sessions.get(slug)?.child.kill(signal === "sigkill" ? 9 : 2);
    },
    detach() {
      const session = sessions.get(slug);

      if (session) session.events = {};
    },
  });

  const driver: PtyDriver = {
    async open(_vmId, options) {
      opened.push(options.exec);
      reconnect.push(options.reconnect);

      const child = Bun.spawn(["sh", "-c", options.exec], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "inherit",
      });

      const info: PtySessionInfo = {
        sessionId: sessions.size + 1,
        state: "running",
        createdUnix: 0,
        cols: options.cols,
        rows: options.rows,
        slug: options.slug,
      };

      const session: Session = { info, events: options, child };
      sessions.set(options.slug, session);

      void (async () => {
        const reader = child.stdout.getReader();

        for (let part = await reader.read(); !part.done; part = await reader.read())
          session.events.onData?.(part.value);
        const code = await child.exited;
        info.state = "exited";
        info.exitCode = code;
        session.events.onExit?.(code);
      })();

      return handle(options.slug);
    },
    async attach(_vmId, options) {
      const session = sessions.get(options.session);

      if (!session) throw new Error("no session");
      session.events = options;

      return handle(options.session);
    },
    async list() {
      return [...sessions.values()].map((session) => session.info);
    },
  };

  return { driver, resized, opened, reconnect };
}

async function setup() {
  const fixture = freestyleFixture();
  fixtures.push(fixture);
  const pty = fakePty();

  const adapter = createFreestyleAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
    processPollMs: 5,
    pty: pty.driver,
  });

  const client = await Beachside.connect({
    adapter,
    config: {},
    credentials: { apiKey: "fixture-main" },
  });

  const box = await client.sandboxes.create();

  return { fixture, client, box, pty };
}

test("process output streams from the guest job before exit, stdout and stderr apart", async () => {
  const { client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: {
        kind: "shell",
        script: "printf 'héllo '; printf warn >&2; sleep 0.2; printf world; exit 3",
      },
      output: { mode: "stream" },
    });

    const chunks = { stdout: "", stderr: "" };

    for await (const chunk of process.output()) chunks[chunk.stream] += chunk.text;

    expect(chunks).toEqual({ stdout: "héllo world", stderr: "warn" });
    expect((await process.wait()).exitCode).toBe(3);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("byte output survives exactly, and piped stdin reaches the process until EOF", async () => {
  const { client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: { kind: "argv", argv: ["cat"] },
      stdin: "pipe",
      output: { mode: "stream", format: "bytes" },
    });

    const sent = Uint8Array.of(0, 255, 10, 200, 1);
    await process.write(sent);
    await process.closeStdin();

    const received: number[] = [];

    for await (const chunk of process.output()) received.push(...chunk.bytes);

    expect(Uint8Array.from(received)).toEqual(sent);
    expect((await process.wait()).exitCode).toBe(0);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("a burst larger than the SDK output queue reaches an active reader intact", async () => {
  const { client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: { kind: "shell", script: "head -c 300000 /dev/zero | tr '\\0' a" },
      output: { mode: "stream" },
    });

    let length = 0;

    for await (const chunk of process.output()) if ("text" in chunk) length += chunk.text.length;

    expect(length).toBe(300_000);
    expect((await process.wait()).exitCode).toBe(0);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("SIGTERM reaches the job's process group, and status reports the exit", async () => {
  const { client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: { kind: "argv", argv: ["sleep", "30"] },
      output: { mode: "stream" },
    });

    expect((await process.status()).state).toBe("running");
    expect((await process.signal("SIGTERM")).status).toBe("requested");
    expect((await process.wait()).exitCode).toBe(143);
    expect((await process.status()).state).toBe("exited");
    await process.detach();
  } finally {
    await client.close();
  }
});

test("a reopened process reports only output written after it reattached", async () => {
  const { client, box } = await setup();

  try {
    const first = await box.processes.start({
      command: { kind: "shell", script: "printf early; sleep 0.5; printf late" },
      output: { mode: "stream" },
    });

    const reference = JSON.parse(JSON.stringify(first.reference()));
    await new Promise((resolve) => setTimeout(resolve, 150));
    await first.disconnect();

    const again = await box.processes.reopen(reference);
    let text = "";

    for await (const chunk of again.output()) if ("text" in chunk) text += chunk.text;

    expect(text).toBe("late");
    expect((await again.wait()).exitCode).toBe(0);
    await again.detach();
  } finally {
    await client.close();
  }
});

test("terminals run on a named Freestyle PTY session and resize", async () => {
  const { client, box, pty } = await setup();

  try {
    const terminal = await box.terminals.start({
      command: { kind: "argv", argv: ["sh", "-c", "read line; printf 'got %s' \"$line\""] },
      columns: 100,
      rows: 30,
    });

    expect(pty.opened.at(-1)).toContain("TERM=xterm-256color");
    // Automatic reconnects would replay scrollback as new output.
    expect(pty.reconnect).toEqual([false]);
    await terminal.resize({ columns: 120, rows: 40 });
    expect(pty.resized).toEqual([{ cols: 120, rows: 40 }]);
    await terminal.write("hi\n");

    const received: number[] = [];

    for await (const chunk of terminal.output()) received.push(...chunk);

    expect(new TextDecoder().decode(Uint8Array.from(received))).toBe("got hi");
    expect((await terminal.wait()).exitCode).toBe(0);
    await terminal.detach();
  } finally {
    await client.close();
  }
});

test("terminate kills the job, and callback exec streams while capturing exact bytes", async () => {
  const { client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: { kind: "argv", argv: ["sleep", "30"] },
      output: { mode: "stream" },
    });

    expect((await process.terminate()).status).toBe("requested");
    expect((await process.wait()).exitCode).toBe(137);
    await process.detach();

    const seen: string[] = [];

    const result = await box.exec(["/bin/sh", "-c", "printf 'a\\377b'"], {
      onOutput: (chunk) => {
        seen.push(chunk.stream);
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(Uint8Array.of(97, 255, 98));
    expect(seen).toContain("stdout");
  } finally {
    await client.close();
  }
});

test("a suspend holds process polling, so the job's guest commands never wake the VM", async () => {
  const { fixture, client, box } = await setup();

  try {
    const process = await box.processes.start({
      command: { kind: "shell", script: "sleep 0.4; printf after" },
      output: { mode: "stream" },
    });

    await box.suspend();
    const execs = fixture.effects.exec;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fixture.effects.exec).toBe(execs);
    expect(fixture.effects.wake).toBe(0);
    expect(fixture.vms.get(box.id)?.state).toBe("paused");

    await box.resume();
    let text = "";

    for await (const chunk of process.output()) if ("text" in chunk) text += chunk.text;

    expect(text).toBe("after");
    expect((await process.wait()).exitCode).toBe(0);
    await process.detach();
  } finally {
    await client.close();
  }
});

test("an acknowledged pause that leaves the VM running ends as unknown, not a hang", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.ignoreNextPause();
    await expect(box.suspend()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(fixture.vms.get(box.id)?.state).toBe("running");
  } finally {
    await client.close();
  }
});
