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
    expect(fixture.sandboxes.get(restored.id)?.name).toEndWith(
      `-${holder?.id.replaceAll("-", "").slice(0, 12)}`,
    );
    expect(
      fixture.calls.filter((call) => call.path === `/api/sandboxes/${holder?.id}/fork`).at(-1)
        ?.body,
    ).toMatchObject({ checkpoint: holder?.checkpoint });

    // The restore still forks from the holder, so the delete is refused before any stop.
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

test("a restore whose fork response was lost is recovered by its name, never forked twice", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const { snapshot } = await source.snapshot();
    const forks = () => fixture.calls.filter((call) => call.path.endsWith("/fork")).length;
    const before = forks();

    fixture.loseNextCreateResponse();
    const lost = await snapshot.submitRestore({ requireIndependentLifecycle: false });
    const saved = JSON.parse(JSON.stringify(lost.reference));

    const recovered = await (await client.recover(saved)).wait();

    const restoredId =
      recovered && "reference" in recovered ? (recovered.reference?.nativeId ?? "") : "";

    expect(fixture.sandboxes.get(restoredId)?.parent).toBe(snapshot.reference.nativeId);
    expect(forks() - before).toBe(1);
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

test("fork pauses the source, forks its checkpoint into a running sandbox and resumes the source", async () => {
  const { fixture, connect } = setup();
  const client = await connect();
  const path = suitePath();

  try {
    const source = await client.sandboxes.create();
    await source.writeFile(path, Uint8Array.of(1, 2, 3), { overwrite: true });

    expect((await source.capabilities()).fork).toMatchObject({
      status: "supported",
      value: { preserve: "filesystem+memory", execution: "resume", independentLifecycle: false },
    });

    const forked = await source.fork();
    expect(forked.id).not.toBe(source.id);
    expect(fixture.sandboxes.get(forked.id)?.parent).toBe(source.id);
    expect(fixture.sandboxes.get(forked.id)?.status).toBe("running");
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect([...(await forked.readFile(path))]).toEqual([1, 2, 3]);

    // Archil applies no labels or lifetime to a fork, so those reject first.
    const calls = fixture.calls.length;
    await expect(source.fork({ labels: { a: "b" } })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(source.fork({ lifetimeSeconds: 60 })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(fixture.calls.slice(calls).some((call) => call.method === "POST")).toBe(false);

    // A source with forks stops but stays until they are gone.
    const destroyed = await source.destroy();
    expect(destroyed.retainedResources).toContain(source.id);
    await forked.destroy();
  } finally {
    await client.close();
  }
});

test("a refused fork resumes the source and rejects", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.failNextFork();

    await expect(source.fork()).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect(fixture.sandboxes.size).toBe(1);
  } finally {
    await client.close();
  }
});

test("a fork whose response was lost is recovered by its name, never forked twice", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const forks = () => fixture.calls.filter((call) => call.path.endsWith("/fork")).length;

    fixture.loseNextCreateResponse();
    const lost = await source.submitFork();
    const saved = JSON.parse(JSON.stringify(lost.reference));
    const recovered = await (await client.recover(saved)).wait();

    const forkedId =
      recovered && "reference" in recovered ? (recovered.reference?.nativeId ?? "") : "";

    expect(fixture.sandboxes.get(forkedId)?.parent).toBe(source.id);
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect(forks()).toBe(1);
  } finally {
    await client.close();
  }
});

test("checkFork() reports the source's own refusals before fork() is sent", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const forks = () => fixture.calls.filter((call) => call.path.endsWith("/fork")).length;
    const source = await client.sandboxes.create();
    expect((await source.checkFork()).status).toBe("supported");

    await source.suspend();
    expect(await source.checkFork()).toMatchObject({ status: "unavailable" });
    await expect(source.fork()).rejects.toMatchObject({ code: "CONFLICT" });
    await source.resume();

    // Archil's native fork needs mounted disks stopped, and box.fork() forks running sandboxes.
    const volume = await client.volumes.create({ name: "fork-disk" });
    const mounted = await client.sandboxes.create({ mounts: [volume.at("/workspace")] });
    expect(await mounted.checkFork()).toMatchObject({ status: "unsupported" });
    await expect(mounted.fork()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(forks()).toBe(0);
  } finally {
    await client.close();
  }
});

test("an aborted fork still resumes its source, and recovery returns the fork", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const controller = new AbortController();
    fixture.holdNextCreateResponse();

    const pending = source.fork({}, { signal: controller.signal }).catch((error: Error) => error);

    // Abort once the fork request is on its way, then let Archil answer.
    for (let i = 0; i < 200 && !fixture.calls.some((call) => call.path.endsWith("/fork")); i++)
      await Bun.sleep(5);
    controller.abort();
    fixture.releaseHeldCreateResponse();
    const error = await pending;
    expect(error).toBeInstanceOf(Error);

    // Resuming the source is cleanup, so it finishes after the caller's abort.
    for (let i = 0; i < 400 && fixture.sandboxes.get(source.id)?.status !== "running"; i++)
      await Bun.sleep(5);
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
    expect(fixture.sandboxes.size).toBe(2);
  } finally {
    await client.close();
  }
});

test("recovering a fork resumes a source the fork left paused", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.loseNextCreateResponse();
    const lost = await source.submitFork();
    const saved = JSON.parse(JSON.stringify(lost.reference));

    // As if the process stopped between the fork and the source's resume.
    fixture.sandboxes.get(source.id)!.status = "paused";
    const recovered = await (await client.recover(saved)).wait();
    expect(recovered && "reference" in recovered).toBe(true);
    expect(fixture.sandboxes.get(source.id)?.status).toBe("running");
  } finally {
    await client.close();
  }
});
