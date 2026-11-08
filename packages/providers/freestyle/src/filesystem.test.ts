import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Beachside } from "beachside";
import { createFreestyleAdapter, MAX_FILE_BYTES } from "./adapter";
import { freestyleFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof freestyleFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

async function setup() {
  const fixture = freestyleFixture();
  fixtures.push(fixture);

  const adapter = createFreestyleAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
  });

  const client = await Beachside.connect({
    adapter,
    config: {},
    credentials: { apiKey: "fixture-main" },
  });

  const box = await client.sandboxes.create();
  // Guest commands run through the local sh, so test paths live in the fixture's directory.
  const dir = join(fixture.workdir, "files");
  mkdirSync(dir);

  return { fixture, client, box, dir };
}

function pattern(size: number): Uint8Array {
  const bytes = new Uint8Array(size);

  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 256;

  return bytes;
}

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

test("files over 8 MiB stream in and out without one large request", async () => {
  const { fixture, client, box, dir } = await setup();

  try {
    const big = pattern(MAX_FILE_BYTES + 3 * 1024 * 1024 + 17);
    const path = join(dir, "big.bin");

    expect(await box.writeFileStream(path, chunks(big, 3 * 1024 * 1024))).toBe(big.length);
    expect(Buffer.from(readFileSync(path)).equals(Buffer.from(big))).toBe(true);

    const received: Uint8Array[] = [];

    for await (const part of box.readFileStream(path)) {
      expect(part.length).toBeLessThanOrEqual(1024 * 1024);
      received.push(part);
    }

    expect(Buffer.concat(received).equals(Buffer.from(big))).toBe(true);

    // Buffered writes above 1 MiB go through the stream too.
    const mid = pattern(2 * 1024 * 1024 + 5);
    await box.writeFile(join(dir, "mid.bin"), mid, { overwrite: true });
    expect(readFileSync(join(dir, "mid.bin")).equals(Buffer.from(mid))).toBe(true);
    expect(
      fixture.calls.some(
        (call) => call.method === "PUT" && call.query.get("path") === join(dir, "mid.bin"),
      ),
    ).toBe(true);
  } finally {
    await client.close();
  }
}, 60_000);

test("streamed reads end cleanly at exact chunk multiples and on empty files", async () => {
  const { client, box, dir } = await setup();

  try {
    for (const size of [0, 1024 * 1024, 2 * 1024 * 1024, 1024 * 1024 + 1]) {
      const bytes = pattern(size);
      const path = join(dir, `exact-${size}.bin`);
      writeFileSync(path, bytes);

      const received: Uint8Array[] = [];

      for await (const part of box.readFileStream(path)) received.push(part);

      expect(Buffer.concat(received).equals(Buffer.from(bytes))).toBe(true);
    }
  } finally {
    await client.close();
  }
});

test("an overwrite keeps the file's owner, so commands keep the access they had", async () => {
  const { fixture, client, box } = await setup();

  try {
    const path = "/home/ubuntu/notes.txt";
    await box.writeFile(path, new TextEncoder().encode("one"), { overwrite: true });
    expect(fixture.vms.get(box.id)?.owners.get(path)).toBe("ubuntu:ubuntu");

    await box.writeFile(path, new TextEncoder().encode("two"), { overwrite: true });
    expect(fixture.vms.get(box.id)?.owners.get(path)).toBe("ubuntu:ubuntu");
    expect(new TextDecoder().decode(await box.readFile(path))).toBe("two");
  } finally {
    await client.close();
  }
});

test("no-clobber writes and copies refuse an existing target; moves keep bytes", async () => {
  const { client, box, dir } = await setup();

  try {
    const source = join(dir, "a.bin");
    await box.writeFile(source, Uint8Array.of(0, 255, 10), { overwrite: false });

    await expect(
      box.writeFile(source, Uint8Array.of(1), { overwrite: false }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await box.copyFile(source, join(dir, "b.bin"));
    await expect(box.copyFile(source, join(dir, "b.bin"))).rejects.toMatchObject({
      code: "CONFLICT",
    });

    await box.moveFile(join(dir, "b.bin"), join(dir, "c.bin"));
    expect(new Uint8Array(readFileSync(join(dir, "c.bin")))).toEqual(Uint8Array.of(0, 255, 10));
    expect(await box.fileExists(join(dir, "b.bin"))).toBe(false);
  } finally {
    await client.close();
  }
});

test("directories, metadata, symlinks and removal run in the guest", async () => {
  const { client, box, dir } = await setup();

  try {
    await box.makeDirectory(join(dir, "x/y"), { recursive: true });
    await box.writeFile(join(dir, "x/y/f.txt"), new TextEncoder().encode("hi"), {
      overwrite: true,
    });
    symlinkSync(join(dir, "x/y/f.txt"), join(dir, "link"));
    symlinkSync(join(dir, "missing"), join(dir, "dangling"));

    const listing = await box.readDirectory(dir);
    expect(listing.completeness).toBe("complete");
    expect(listing.entries).toEqual([
      { name: "dangling", type: "symlink" },
      { name: "link", type: "symlink" },
      { name: "x", type: "directory" },
    ]);

    expect(await box.statFile(join(dir, "link"))).toMatchObject({ type: "symlink" });
    expect(await box.statFile(join(dir, "link"), { followSymlinks: true })).toMatchObject({
      type: "file",
      sizeBytes: 2,
    });
    expect(await box.fileExists(join(dir, "dangling"))).toBe(true);

    await expect(box.removeFile(join(dir, "x"))).rejects.toMatchObject({ code: "CONFLICT" });
    await box.removeFile(join(dir, "x"), { recursive: true });
    expect(await box.fileExists(join(dir, "x"))).toBe(false);
  } finally {
    await client.close();
  }
});
