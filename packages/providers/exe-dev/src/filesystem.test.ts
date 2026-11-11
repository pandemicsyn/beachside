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
