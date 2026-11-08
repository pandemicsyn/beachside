import { afterEach, expect, test } from "bun:test";
import { Preserve } from "@beachside/adapter";
import { snapshotSuite } from "@beachside/adapter/testing";
import { Beachside } from "beachside";
import type { z } from "zod";
import { createFreestyleAdapter } from "./adapter";
import { freestyleFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof freestyleFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = freestyleFixture();
  fixtures.push(fixture);

  const adapter = createFreestyleAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
  });

  const connect = (config: z.input<typeof adapter.config> = {}, apiKey = "fixture-main") =>
    Beachside.connect({ adapter, config, credentials: { apiKey } });

  return { fixture, adapter, connect };
}

test("snapshots capture memory and disk, and a restore boots a new VM from the snapshot id", async () => {
  const { fixture, connect } = setup();
  const client = await connect({ snapshots: { retentionSeconds: 3600 } });

  try {
    const source = await client.sandboxes.create();
    await source.writeFile("/home/user/state.bin", Uint8Array.of(1, 2, 3), { overwrite: true });

    const captured = await source.snapshot();
    expect(captured.capture).toMatchObject({
      preserve: "filesystem+memory",
      restoreExecution: "resume",
    });
    expect(captured.snapshot.reference).toMatchObject({
      provider: "freestyle",
      ownership: "verified-created",
    });

    const native = fixture.snapshots.get(captured.snapshot.reference.nativeId);
    expect(native?.slug).toMatch(/^beachside-snapshot-[0-9a-f]{24}$/);
    expect(native?.ttlSeconds).toBe(3600);

    const restored = await captured.snapshot.restore({ network: "internet" });

    try {
      const create = fixture.calls
        .filter((call) => call.method === "POST" && call.path === "/v5/vms")
        .at(-1);

      expect(create?.body).toMatchObject({
        snapshotId: captured.snapshot.reference.nativeId,
        firewall: { rules: [{ action: "allow", destination: { public: true } }] },
      });
      expect(await restored.readFile("/home/user/state.bin")).toEqual(Uint8Array.of(1, 2, 3));
    } finally {
      await restored.destroy();
    }

    const listed = await client.snapshots.list();
    expect(listed.items.map((item) => item.reference.nativeId)).toContain(
      captured.snapshot.reference.nativeId,
    );

    const images = await client.images.list();
    expect(images.items.map((item) => item.reference.nativeId)).toContain(
      captured.snapshot.reference.nativeId,
    );

    await captured.snapshot.delete();
    expect(fixture.snapshots.size).toBe(0);
    await source.destroy();
  } finally {
    await client.close();
  }
});

test("a paused VM can be captured and stays paused", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    await source.suspend();

    const captured = await source.snapshot();
    expect(captured.source.state).toBe("suspended");
    expect(fixture.vms.get(source.id)?.state).toBe("paused");
    await captured.snapshot.delete();
    await source.destroy();
  } finally {
    await client.close();
  }
});

test("a lost capture response completes by its attempt slug without a second capture", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    fixture.loseNextSnapshotResponse();

    const { snapshot } = await source.snapshot();
    expect(fixture.effects.snapshot).toBe(1);
    expect(snapshot.reference).toMatchObject({ ownership: "verified-created" });
    await source.destroy();
  } finally {
    await client.close();
  }
});

test("filesystem-only snapshots reject at connect before any Freestyle call", async () => {
  const { fixture, connect } = setup();

  await expect(connect({ snapshots: { preserve: Preserve.FILESYSTEM } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(fixture.calls).toHaveLength(0);
});

test("restores that ask for a new size reject before any Freestyle effect", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const source = await client.sandboxes.create();
    const { snapshot } = await source.snapshot();
    const before = fixture.effects.create;

    await expect(
      snapshot.restore({ network: "blocked", resources: { vcpu: 8 } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(fixture.effects.create).toBe(before);
    await source.destroy();
  } finally {
    await client.close();
  }
});

test("snapshot references are bound to the verified API key", async () => {
  const { connect } = setup();
  const main = await connect();
  const alt = await connect({}, "fixture-alt");

  try {
    const source = await main.sandboxes.create();
    const { snapshot } = await source.snapshot();
    const saved = JSON.parse(JSON.stringify(snapshot.reference));

    await expect(alt.snapshots.get(saved)).rejects.toMatchObject({ code: "CONFLICT" });
    await source.destroy();
  } finally {
    await main.close();
    await alt.close();
  }
});

test("Freestyle passes the shared snapshot suite", async () => {
  const { connect } = setup();
  const client = await connect({ snapshots: { preserve: Preserve.FILESYSTEM_AND_MEMORY } });

  try {
    await snapshotSuite({
      client,
      path: "/home/user/beachside-suite.bin",
      preserve: Preserve.FILESYSTEM_AND_MEMORY,
    });
  } finally {
    await client.close();
  }
});
