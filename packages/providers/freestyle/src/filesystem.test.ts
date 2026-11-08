import { afterEach, expect, test } from "bun:test";
import {
  chownSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { Beachside } from "beachside";
import { createFreestyleAdapter, MAX_FILE_BYTES } from "./adapter";
import { freestyleFixture, linuxGuest } from "./fixture.test-support";

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
    expect(fixture.vms.get(box.id)?.owners.get(path)).toBe("1000:1000");

    await box.writeFile(path, new TextEncoder().encode("two"), { overwrite: true });
    expect(fixture.vms.get(box.id)?.owners.get(path)).toBe("1000:1000");
    expect(new TextDecoder().decode(await box.readFile(path))).toBe("two");
  } finally {
    await client.close();
  }
});

test("without Python 3, new and root-owned files still write; replacing another user's refuses first", async () => {
  const { fixture, client, box } = await setup();

  try {
    fixture.withoutPython();
    const path = "/home/ubuntu/plain.txt";
    await box.writeFile(path, new TextEncoder().encode("one"), { overwrite: true });
    expect(new TextDecoder().decode(await box.readFile(path))).toBe("one");
    const writes = fixture.effects.write;

    await expect(
      box.writeFile(path, new TextEncoder().encode("two"), { overwrite: true }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.effects.write).toBe(writes);

    fixture.vms.get(box.id)?.owners.set(path, "0:0");
    await box.writeFile(path, new TextEncoder().encode("three"), { overwrite: true });
    expect(new TextDecoder().decode(await box.readFile(path))).toBe("three");
    expect(fixture.commands.some((command) => command.startsWith("python3"))).toBe(false);
  } finally {
    await client.close();
  }
});

linuxGuest(
  "a root owner repair changes only the verified written file, never a swapped-in target",
  async () => {
    const { fixture, client, box, dir } = await setup();

    try {
      // As root the file can belong to another user; otherwise this process stands in for both.
      const root = process.getuid?.() === 0;
      const uid = root ? 1000 : (process.getuid?.() ?? 0);
      const path = join(dir, "owned.txt");
      writeFileSync(path, "one");

      if (root) chownSync(path, 1000, 1000);

      await box.writeFile(path, new TextEncoder().encode("two"), { overwrite: true });
      expect(statSync(path).uid).toBe(uid);
      expect(readFileSync(path, "utf8")).toBe("two");

      // A guest process swaps the path for a symlink to a root-owned file between the PUT and
      // the repair; the repair must not follow it.
      const victim = join(dir, "victim.txt");
      writeFileSync(victim, "secret");
      fixture.afterNextPut((written) => {
        rmSync(written);
        symlinkSync(victim, written);
      });

      await expect(
        box.writeFile(path, new TextEncoder().encode("three"), { overwrite: true }),
      ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(statSync(victim).uid).toBe(process.getuid?.() ?? 0);
      expect(readFileSync(victim, "utf8")).toBe("secret");
    } finally {
      await client.close();
    }
  },
);

test("a plain-text error from a range read surfaces as UNAVAILABLE", async () => {
  const { fixture, client, box, dir } = await setup();

  try {
    const path = join(dir, "proxy.bin");
    writeFileSync(path, "x");
    fixture.failNextRead(new Response("Internal proxy error", { status: 500 }));

    await expect(
      (async () => {
        for await (const _ of box.readFileStream(path));
      })(),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  } finally {
    await client.close();
  }
});

linuxGuest("no-clobber writes and copies refuse an existing target; moves keep bytes", async () => {
  const { client, box, dir } = await setup();

  try {
    const source = join(dir, "a.bin");
    await box.writeFile(source, Uint8Array.of(0, 255, 10), { overwrite: false });

    // A confirmed collision leaves the target untouched, for writes and copies alike.
    await expect(
      box.writeFile(source, Uint8Array.of(1), { overwrite: false }),
    ).rejects.toMatchObject({ code: "CONFLICT", effect: "none" });

    await box.copyFile(source, join(dir, "b.bin"));
    await expect(box.copyFile(source, join(dir, "b.bin"))).rejects.toMatchObject({
      code: "CONFLICT",
      effect: "none",
    });
    expect(readdirSync(dir).filter((name) => name.startsWith("."))).toEqual([]);

    await box.moveFile(join(dir, "b.bin"), join(dir, "c.bin"));
    expect(new Uint8Array(readFileSync(join(dir, "c.bin")))).toEqual(Uint8Array.of(0, 255, 10));
    expect(await box.fileExists(join(dir, "b.bin"))).toBe(false);
  } finally {
    await client.close();
  }
});

test("a paused VM serves reads through the file API without waking, and refuses writes", async () => {
  const { fixture, client, box } = await setup();

  try {
    const path = "/home/ubuntu/data/notes.txt";
    await box.writeFile(path, new TextEncoder().encode("kept"), { overwrite: true });
    await box.suspend();
    const execs = fixture.effects.exec;

    expect(new TextDecoder().decode(await box.readFile(path))).toBe("kept");
    const streamed: Uint8Array[] = [];

    for await (const part of box.readFileStream(path)) streamed.push(part);
    expect(Buffer.concat(streamed).toString()).toBe("kept");
    expect((await box.readDirectory("/home/ubuntu/data")).entries).toEqual([
      { name: "notes.txt", type: "file" },
    ]);
    expect(await box.statFile(path, { followSymlinks: true })).toMatchObject({
      type: "file",
      sizeBytes: 4,
      mode: 0o644,
    });
    // A paused VM reports no modification time.
    expect((await box.statFile(path, { followSymlinks: true })).modifiedAt).toBeUndefined();
    expect(await box.fileExists(path)).toBe(true);
    expect(await box.fileExists("/home/ubuntu/data/missing")).toBe(false);
    await expect(box.statFile(path)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      box.writeFile(path, new TextEncoder().encode("x"), { overwrite: true }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(fixture.effects.exec).toBe(execs);
    expect(fixture.effects.wake).toBe(0);
    expect(fixture.vms.get(box.id)?.state).toBe("paused");
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
