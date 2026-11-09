import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Preserve } from "@beachside/adapter";
import { setup } from "./fixture.test-support";

const suitePath = () => join(mkdtempSync(join(tmpdir(), "archil-snap-")), "suite.bin");

for (const preserve of [Preserve.FILESYSTEM_AND_MEMORY, Preserve.FILESYSTEM]) {
  test(`${preserve} snapshots restore the captured bytes into a new sandbox`, async () => {
    const { fixture, connect } = setup();
    const client = await connect({ snapshots: { preserve } });
    const path = suitePath();

    try {
      const source = await client.sandboxes.create();
      await source.writeFile(path, Uint8Array.of(0, 255, 10), { overwrite: true });

      const plan = await source.checkSnapshot();
      expect(plan).toMatchObject({ status: "supported", value: { profile: { preserve } } });
      const other = preserve === Preserve.FILESYSTEM ? "filesystem+memory" : "filesystem";
      expect((await source.checkSnapshot({ requirements: { preserve: other } })).status).not.toBe(
        "supported",
      );

      const captured = await source.snapshot();
      expect(captured.capture.preserve).toBe(preserve);
      expect(fixture.sandboxes.get(captured.snapshot.reference.nativeId)?.status).toBe(
        preserve === Preserve.FILESYSTEM ? "stopped" : "paused",
      );

      const saved = JSON.parse(JSON.stringify(captured.snapshot.reference));
      const reopened = await client.snapshots.get(saved);
      expect(await reopened.inspect()).toMatchObject({
        state: "ready",
        preserve,
        restoreExecution: preserve === Preserve.FILESYSTEM ? "fresh" : "resume",
        restore: { independentLifecycle: false },
      });

      // Restores are forks of the holder, so a caller opts out of independent lifecycle.
      await expect(reopened.restore()).rejects.toThrow(/Independent lifecycle/);
      const restored = await reopened.restore({ requireIndependentLifecycle: false });
      expect(restored.id).not.toBe(source.id);
      expect([...(await restored.readFile(path))]).toEqual([0, 255, 10]);
    } finally {
      await client.close();
    }
  });
}

test("capture pauses the source, forks its checkpoint into a parked holder and resumes it", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const captured = await source.snapshot();
    const holder = fixture.sandboxes.get(captured.snapshot.reference.nativeId);

    expect(holder?.name).toMatch(/^bs-snap-[0-9a-f]{24}$/);
    expect(holder?.status).toBe("paused");
    expect(holder?.parent).toBe(source.id);
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect(captured.source.state).toBe("running");

    // Holders are snapshots, not sandboxes.
    const listed = await client.sandboxes.list();
    expect(listed.items.map((item) => item.id)).toEqual([source.id]);
    expect((await client.snapshots.list()).items).toHaveLength(1);

    const restored = await captured.snapshot.restore({ requireIndependentLifecycle: false });
    expect(fixture.sandboxes.get(restored.id)?.parent).toBe(holder?.id);
    expect(
      fixture.calls.filter((call) => call.path === `/api/sandboxes/${holder?.id}/fork`).at(-1)
        ?.body,
    ).toMatchObject({ checkpoint: holder?.checkpoint });

    // The restore still forks from the holder, so Archil refuses the delete before any stop.
    await expect(captured.snapshot.delete()).rejects.toMatchObject({ code: "CONFLICT" });
    expect(holder?.status).toBe("paused");

    // A source with a holder stops but stays until the holder is deleted.
    const destroyed = await source.destroy();
    expect(destroyed.retainedResources).toContain(source.id);
    expect(fixture.sandboxes.get(source.id)?.status).toBe("stopped");

    await restored.destroy();
    await captured.snapshot.delete();
    expect(fixture.sandboxes.has(captured.snapshot.reference.nativeId)).toBe(false);
  } finally {
    await client.close();
  }
});

test("a refused fork resumes the source and rejects without a holder", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.failNextFork();

    await expect(source.snapshot()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect(fixture.sandboxes.size).toBe(1);
  } finally {
    await client.close();
  }
});

test("restores keep the snapshot's network policy", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const captured = await (await client.sandboxes.create()).snapshot();

    await expect(
      captured.snapshot.restore({ network: "internet", requireIndependentLifecycle: false }),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await client.close();
  }
});
