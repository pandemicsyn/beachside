import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setup } from "./fixture.test-support";

async function running() {
  const { connect } = setup();
  const client = await connect();
  const box = await client.sandboxes.create();
  const dir = mkdtempSync(join(tmpdir(), "archil-files-"));

  return { client, box, dir };
}

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size)
    yield bytes.subarray(offset, offset + size);
}

test("writes publish through a private stage; reads come back byte for byte", async () => {
  const { client, box, dir } = await running();

  try {
    const path = join(dir, "nested", "data.bin");
    const bytes = Uint8Array.of(0, 255, 10, 13, 128);

    await box.writeFile(path, bytes, { overwrite: true });
    expect([...readFileSync(path)]).toEqual([...bytes]);
    expect(statSync(path).mode & 0o777).toBe(0o644);
    expect([...(await box.readFile(path))]).toEqual([...bytes]);

    await expect(box.writeFile(path, Uint8Array.of(1))).rejects.toMatchObject({ code: "CONFLICT" });
    expect([...readFileSync(path)]).toEqual([...bytes]);
  } finally {
    await client.close();
  }
});

test("streams move large files in both directions without buffering them whole", async () => {
  const { client, box, dir } = await running();

  try {
    const big = new Uint8Array(3 * 1024 * 1024 + 7).map((_, index) => index % 251);
    const path = join(dir, "big.bin");

    expect(await box.writeFileStream(path, chunks(big, 1024 * 1024))).toBe(big.length);
    expect(Buffer.from(readFileSync(path)).equals(Buffer.from(big))).toBe(true);

    const received: Uint8Array[] = [];

    for await (const part of box.readFileStream(path)) received.push(part);
    expect(Buffer.concat(received).equals(Buffer.from(big))).toBe(true);
  } finally {
    await client.close();
  }
});

test("metadata, listings, copies, moves and removal run through the guest helper", async () => {
  const { client, box, dir } = await running();

  try {
    writeFileSync(join(dir, "a.txt"), "alpha");
    await box.makeDirectory(join(dir, "sub"));

    expect(await box.statFile(join(dir, "a.txt"))).toMatchObject({ type: "file", sizeBytes: 5 });
    expect(await box.fileExists(join(dir, "missing"))).toBe(false);

    await box.copyFile(join(dir, "a.txt"), join(dir, "sub", "b.txt"));
    await box.moveFile(join(dir, "sub", "b.txt"), join(dir, "c.txt"));
    expect(readFileSync(join(dir, "c.txt"), "utf8")).toBe("alpha");

    const listing = await box.readDirectory(dir);
    expect(listing.entries.map((entry) => entry.name)).toEqual(["a.txt", "c.txt", "sub"]);

    await box.removeFile(join(dir, "sub"), { recursive: true });
    expect(await box.fileExists(join(dir, "sub"))).toBe(false);
  } finally {
    await client.close();
  }
});

test("reading a missing file is NOT_FOUND, and the read bound is enforced", async () => {
  const { client, box, dir } = await running();

  try {
    await expect(box.readFile(join(dir, "nope"))).rejects.toMatchObject({ code: "NOT_FOUND" });

    writeFileSync(join(dir, "ten.bin"), new Uint8Array(10));
    await expect(box.readFile(join(dir, "ten.bin"), { maxBytes: 4 })).rejects.toMatchObject({
      code: "CAPACITY",
    });
  } finally {
    await client.close();
  }
});
