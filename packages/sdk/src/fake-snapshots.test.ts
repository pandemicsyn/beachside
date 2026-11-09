import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@beachside-internal/provider-fake";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { defineAdapter } from "@beachside/adapter";
import { z } from "zod";
import { Image, Beachside, UnsupportedFeatureError } from "./index";

test("fake snapshots capture sandbox files, restore them fresh and delete once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-fake-snapshots-"));
  const token = "long-fake-snapshot-token";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });

  const client = await Beachside.connect({
    adapter: createFakeAdapter({ url: `http://127.0.0.1:${server.port}`, token, snapshots: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    await box.writeFile("/work/state.txt", new TextEncoder().encode("warm"));

    const { snapshot } = await box.snapshot();
    expect(snapshot.reference.ownership).toBe("verified-created");
    expect((await client.snapshots.list()).items.map((info) => info.reference.nativeId)).toEqual([
      snapshot.id,
    ]);
    // Snapshots are not images.
    expect((await client.images.list()).items.map((info) => info.reference.nativeId)).toEqual([
      "fake-starter",
    ]);

    const restored = await snapshot.restore();
    expect(restored.id).not.toBe(box.id);
    expect(new TextDecoder().decode(await restored.readFile("/work/state.txt"))).toBe("warm");

    await restored.destroy();
    await box.destroy();
    await snapshot.delete();
    await expect(client.snapshots.get(snapshot.reference)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await client.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("restore applies env, labels and lifetime where the adapter declares them, else rejects first", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-fake-restore-"));
  const token = "long-fake-restore-token";
  const secret = "CANARY-restore-env-value";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });

  const fake = createFakeAdapter({
    url: `http://127.0.0.1:${server.port}`,
    token,
    snapshots: true,
  });

  /** The fake whose restore applies no create options, like a provider that cannot. */
  const plain = defineAdapter({
    name: "fake",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect(input) {
      const session = await fake.connect(input);
      const { options: _options, ...restore } = session.snapshotRestore!;

      return { ...session, snapshotRestore: restore };
    },
  });

  const FakeState = z.looseObject({
    resources: z.array(
      z.looseObject({
        labels: z.record(z.string(), z.string()),
        env: z.record(z.string(), z.string()).optional(),
        lifetimeSeconds: z.number().optional(),
      }),
    ),
  });

  const state = async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/_test/state`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    return FakeState.parse(await response.json()).resources;
  };

  const client = await Beachside.connect({ adapter: fake, config: {}, credentials: {} });
  const limited = await Beachside.connect({ adapter: plain, config: {}, credentials: {} });

  try {
    expect((await client.capabilities()).snapshots.restore).toMatchObject({
      status: "supported",
      value: {
        options: { env: true, labels: true, lifetime: { minSeconds: 1, maxSeconds: 86_400 } },
      },
    });

    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    const { snapshot } = await box.snapshot();

    const restored = await snapshot.restore({
      env: { TOKEN: secret },
      labels: { team: "ci" },
      lifecycle: { lifetimeSeconds: 600 },
    });

    expect((await state()).at(-1)).toMatchObject({
      env: { TOKEN: secret },
      labels: { team: "ci" },
      lifetimeSeconds: 600,
    });
    await restored.destroy();

    const outside = await snapshot
      .restore({ lifecycle: { lifetimeSeconds: 86_401 } })
      .catch((cause) => cause);

    expect(outside).toBeInstanceOf(UnsupportedFeatureError);

    const invalid = await snapshot.restore({ env: { "1BAD": secret } }).catch((cause) => cause);
    expect(invalid).toMatchObject({ code: "INVALID_ARGUMENT" });
    expect(String(invalid.message)).not.toContain(secret);

    const count = (await state()).length;
    const other = await limited.snapshots.get(snapshot.reference);

    for (const request of [
      { env: { TOKEN: secret } },
      { labels: { team: "ci" } },
      { lifecycle: { lifetimeSeconds: 600 } },
    ]) {
      const error = await other.restore(request).catch((cause) => cause);
      expect(error).toBeInstanceOf(UnsupportedFeatureError);
      expect(error).toMatchObject({ code: "UNSUPPORTED", effect: "none" });
      expect(String(error.message)).not.toContain(secret);
    }

    // Empty env and labels ask for nothing and stay portable.
    await (await other.restore({ env: {}, labels: {} })).destroy();
    expect((await state()).length).toBe(count + 1);
    await box.destroy();
  } finally {
    await client.close();
    await limited.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});

test("capture sets labels where the adapter keeps them, and list filters by them", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-fake-snapshot-labels-"));
  const token = "long-fake-snapshot-labels-token";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });

  const fake = createFakeAdapter({
    url: `http://127.0.0.1:${server.port}`,
    token,
    snapshots: true,
  });

  /** The fake without native snapshot labels. */
  const unlabelled = defineAdapter({
    name: "fake",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect(input) {
      const session = await fake.connect(input);
      const { labels: _labels, ...capture } = session.snapshotCapture!;

      return { ...session, snapshotCapture: capture };
    },
  });

  const client = await Beachside.connect({ adapter: fake, config: {}, credentials: {} });
  const plain = await Beachside.connect({ adapter: unlabelled, config: {}, credentials: {} });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    const { snapshot } = await box.snapshot({ labels: { "beachside.setup-cache": "k1" } });

    await box.snapshot();
    expect((await client.snapshots.list()).items).toHaveLength(2);

    const found = await client.snapshots.list({ labels: { "beachside.setup-cache": "k1" } });

    expect(found.items.map((info) => [info.reference.nativeId, info.labels])).toEqual([
      [snapshot.id, { "beachside.setup-cache": "k1" }],
    ]);
    expect(
      (await client.snapshots.list({ labels: { "beachside.setup-cache": "k2" } })).items,
    ).toEqual([]);
    expect((await client.capabilities()).snapshots.capture).toMatchObject({
      value: { labels: true },
    });

    // Without native labels, a labelled capture is refused before anything is captured.
    const other = await plain.sandboxes.get(box.reference!);

    await expect(other.snapshot({ labels: { a: "b" } })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect((await client.snapshots.list()).items).toHaveLength(2);
    await box.destroy();
  } finally {
    await client.close();
    await plain.close();
    await server.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
});
