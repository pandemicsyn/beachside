import { expect, test } from "bun:test";
import { setup } from "./fixture.test-support";

async function running() {
  const { fixture, connect } = setup();
  const client = await connect();
  const box = await client.sandboxes.create();

  return { fixture, client, box };
}

test("process output streams before exit, stdout and stderr apart", async () => {
  const { client, box } = await running();

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
  const { client, box } = await running();

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

test("SIGTERM reaches the program through its PID file, and status reports the exit", async () => {
  const { client, box } = await running();

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

test("a reopened process reattaches by id and reads to the exit", async () => {
  const { client, box } = await running();

  try {
    const first = await box.processes.start({
      command: { kind: "shell", script: "printf early; sleep 0.5; printf late" },
      output: { mode: "stream" },
    });

    let early = "";

    for await (const chunk of first.output()) {
      if ("text" in chunk) early += chunk.text;

      if (early === "early") break;
    }

    const reference = JSON.parse(JSON.stringify(first.reference()));
    await first.disconnect();

    const again = await box.processes.reopen(reference);
    let text = "";

    // Archil replays its buffer from the reference's cursor; the rest arrives live.
    for await (const chunk of again.output()) if ("text" in chunk) text += chunk.text;
    expect(text.endsWith("late")).toBe(true);
    expect((await again.wait()).exitCode).toBe(0);
    await again.detach();
  } finally {
    await client.close();
  }
});

test("terminals take input on the native PTY connection and resize", async () => {
  const { client, box } = await running();

  try {
    const terminal = await box.terminals.start({
      command: { kind: "argv", argv: ["sh", "-c", 'read line; printf "got %s $TERM" "$line"'] },
      columns: 100,
      rows: 30,
    });

    await terminal.resize({ columns: 120, rows: 40 });
    await terminal.write("hi\n");
    const received: number[] = [];

    for await (const chunk of terminal.output()) received.push(...chunk);
    expect(new TextDecoder().decode(Uint8Array.from(received))).toBe("got hi xterm-256color");
    expect((await terminal.wait()).exitCode).toBe(0);
    await terminal.detach();
  } finally {
    await client.close();
  }
});

test("terminate kills the program, and callback exec streams while capturing exact bytes", async () => {
  const { client, box } = await running();

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
