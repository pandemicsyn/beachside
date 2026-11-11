import { afterEach, expect, test } from "bun:test";
import { Beachside } from "beachside";
import { createExeDevAdapter } from "./adapter";
import { exeDevFixture, linuxGuest } from "./fixture.test-support";

const fixtures: ReturnType<typeof exeDevFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = exeDevFixture();
  fixtures.push(fixture);

  const adapter = createExeDevAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
    processPollMs: 5,
  });

  const client = await Beachside.connect({
    adapter,
    config: { network: "internet" },
    credentials: { token: "exe1.fixture-main" },
  });

  const box = await client.sandboxes.create({ env: { FROM_CREATE: "yes" } });

  return { fixture, client, box };
}

linuxGuest(
  "process output streams from the guest job before exit, stdout and stderr apart",
  async () => {
    const { client, box } = await setup();

    try {
      const process = await box.processes.start({
        command: {
          kind: "shell",
          script:
            "printf 'héllo %s ' \"$FROM_CREATE\"; printf warn >&2; sleep 0.2; printf world; exit 3",
        },
        output: { mode: "stream" },
      });

      const chunks = { stdout: "", stderr: "" };

      for await (const chunk of process.output()) chunks[chunk.stream] += chunk.text;

      expect(chunks).toEqual({ stdout: "héllo yes world", stderr: "warn" });
      expect((await process.wait()).exitCode).toBe(3);
      await process.detach();
    } finally {
      await client.close();
    }
  },
);

linuxGuest(
  "byte output survives exactly, and piped stdin reaches the process until EOF",
  async () => {
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
  },
);

linuxGuest("SIGTERM reaches the job's process group, and status reports the exit", async () => {
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

linuxGuest("a reopened process reports only output written after it reattached", async () => {
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

test("terminals are refused: exe.dev's HTTPS API has no PTY", async () => {
  const { client, box } = await setup();

  try {
    await expect(
      box.terminals.start({ command: { kind: "argv", argv: ["bash"] }, columns: 80, rows: 24 }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }
});
