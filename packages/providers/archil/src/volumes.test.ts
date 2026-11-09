import { expect, test } from "bun:test";
import { setup } from "./fixture.test-support";

test("disks mount at create, survive destroy and can be explicitly deleted", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const volume = await client.volumes.create({ name: "workspace" });
    expect(await volume.inspect()).toMatchObject({ state: "ready", filesystem: "object-backed" });
    expect(JSON.stringify(volume.reference)).not.toContain("disk-secret-token");

    const box = await client.sandboxes.create({
      mounts: [volume.at("/workspace", { subpath: "app", access: "read-only" })],
    });

    expect(
      fixture.calls.find((call) => call.method === "POST" && call.path === "/api/sandboxes")?.body,
    ).toMatchObject({
      mounts: [
        {
          disk_id: volume.reference.nativeId,
          path: "/workspace",
          read_only: true,
          subdirectory: "app",
        },
      ],
    });

    await expect(box.snapshot()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(box.destroy()).rejects.toMatchObject({ code: "UNSUPPORTED" });

    const cleanup = await box.destroy({ storage: "allow-unconfirmed" });
    expect(cleanup.retainedResources).toContain(volume.reference.nativeId);

    expect((await client.volumes.list()).items).toHaveLength(1);
    await volume.delete();
    expect(fixture.disks.size).toBe(0);
  } finally {
    await client.close();
  }
});
