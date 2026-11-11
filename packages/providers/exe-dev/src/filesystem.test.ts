import { afterEach, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { Beachside } from "beachside";
import { createExeDevAdapter } from "./adapter";
import { exeDevFixture, linuxGuest } from "./fixture.test-support";
import { STAGE_CHUNK_BYTES, UPLOAD_CONCURRENCY } from "./filesystem";

const fixtures: ReturnType<typeof exeDevFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

const pattern = (length: number) => new Uint8Array(length).map((_, i) => (i * 31 + 7) % 256);

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

async function setup() {
  const fixture = exeDevFixture();
  fixtures.push(fixture);

  const client = await Beachside.connect({
    adapter: createExeDevAdapter({ fetch: fixture.fetch, pollIntervalMs: 1, settleSeconds: 1 }),
    config: { network: "internet" },
    credentials: { token: "exe1.fixture-main" },
  });

  const box = await client.sandboxes.create();
  const dir = `${fixture.workdir}/files-${box.id}`;
  await box.makeDirectory(dir, { recursive: true });

  return { fixture, client, box, dir };
}

linuxGuest("streamed writes send parallel chunks that each fit one 64 KB request", async () => {
  const { fixture, client, box, dir } = await setup();

  try {
    const big = pattern(STAGE_CHUNK_BYTES * UPLOAD_CONCURRENCY * 3 + 123);
    const path = `${dir}/big.bin`;
    expect(await box.writeFileStream(path, chunks(big, 100_000))).toBe(big.length);
    expect(Buffer.from(readFileSync(path)).equals(Buffer.from(big))).toBe(true);

    // The fixture refuses bodies over 64 KB with 413, so every chunk fit.
    expect(Math.max(...fixture.calls.map((call) => Buffer.byteLength(call.command)))).toBeLessThan(
      64 * 1024,
    );

    const received: Uint8Array[] = [];

    for await (const part of box.readFileStream(path)) received.push(part);
    expect(Buffer.concat(received).equals(Buffer.from(big))).toBe(true);
  } finally {
    await client.close();
  }
});

linuxGuest("a rate-limited chunk is sent again; it was refused, not applied", async () => {
  const { fixture, client, box, dir } = await setup();

  try {
    const bytes = pattern(STAGE_CHUNK_BYTES * 2);
    fixture.failNextSsh(fixture.error(429, "rate limited"), / 'pwrite' /);
    await box.writeFile(`${dir}/limited.bin`, bytes);
    expect(Buffer.from(readFileSync(`${dir}/limited.bin`)).equals(Buffer.from(bytes))).toBe(true);
    // Two chunks, one of them sent twice.
    expect(
      fixture.calls.filter((call) => / 'pwrite' /.test(call.words.slice(2).join(" "))),
    ).toHaveLength(3);
  } finally {
    await client.close();
  }
});

linuxGuest(
  "an upload that outlasts the transfer's setup window still verifies and publishes",
  async () => {
    const { client, box, dir } = await setup();

    try {
      const bytes = pattern(STAGE_CHUNK_BYTES * 3);

      // A 1 s setup window: the chunks alone take longer than that through the fixture.
      const written = await box.writeFileStream(
        `${dir}/slow.bin`,
        (async function* () {
          for (let i = 0; i < 3; i++) {
            await new Promise((resolve) => setTimeout(resolve, 600));
            yield bytes.subarray(i * STAGE_CHUNK_BYTES, (i + 1) * STAGE_CHUNK_BYTES);
          }
        })(),
        { setupTimeoutMs: 1000 },
      );

      expect(written).toBe(bytes.length);
      expect(Buffer.from(readFileSync(`${dir}/slow.bin`)).equals(Buffer.from(bytes))).toBe(true);
    } finally {
      await client.close();
    }
  },
);

linuxGuest("making a directory over a file is an invalid argument with no effect", async () => {
  const { client, box, dir } = await setup();

  try {
    const file = `${dir}/sentinel.bin`;
    await box.writeFile(file, new Uint8Array([1, 2, 3]));

    for (const [path, recursive] of [
      [file, true],
      [file, false],
      [`${file}/child`, true],
    ] as const)
      await expect(box.makeDirectory(path, { recursive })).rejects.toMatchObject({
        code: "INVALID_ARGUMENT",
      });

    expect([...(await box.readFile(file))]).toEqual([1, 2, 3]);
  } finally {
    await client.close();
  }
});

linuxGuest("a rate-limited command is sent again, because exe.dev refused it unrun", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.failNextSsh(fixture.error(429, "rate limited"), /BEACHSIDE-EXEC/);
    const result = await box.exec({ command: { kind: "shell", script: "printf once" } });
    expect(new TextDecoder().decode(result.stdout)).toBe("once");
  } finally {
    await client.close();
  }
});
