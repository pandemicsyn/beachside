import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeAdapter } from "@beachside-internal/provider-fake";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { Image, Beachside, OutcomeUnknownError, UnsupportedFeatureError } from "./index";

async function fakeServer(name: string) {
  const directory = await mkdtemp(join(tmpdir(), `beachside-fake-${name}-`));
  const token = `long-fake-${name}-token`;

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(directory, "state.json"),
    token,
    testMode: true,
  });

  const url = `http://127.0.0.1:${server.port}`;

  return {
    url,
    token,
    async seed(body: { submissionId: string; action: string; behavior: string }) {
      const response = await fetch(new URL("/_test/seed", url), {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.ok).toBe(true);
    },
    async stop() {
      await server.stop(true);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("fork copies a running sandbox into a new one and leaves the source running", async () => {
  const fake = await fakeServer("fork");

  const client = await Beachside.connect({
    adapter: createFakeAdapter({ url: fake.url, token: fake.token, fork: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    await box.writeFile("/work/state.txt", new TextEncoder().encode("warm"));

    expect((await box.capabilities()).fork).toMatchObject({
      status: "supported",
      value: { preserve: "filesystem", execution: "fresh" },
    });

    const forked = await box.fork({ labels: { branch: "a" }, lifetimeSeconds: 600 });
    expect(forked.id).not.toBe(box.id);
    expect(forked.reference).toMatchObject({ kind: "sandbox", ownership: "verified-created" });
    expect(new TextDecoder().decode(await forked.readFile("/work/state.txt"))).toBe("warm");

    // The fork and its source change independently.
    await forked.writeTextFile("/work/state.txt", "fork", { overwrite: true });
    expect(new TextDecoder().decode(await box.readFile("/work/state.txt"))).toBe("warm");
    expect((await box.inspect()).state).toBe("running");

    await forked.destroy();
    await box.destroy();
  } finally {
    await client.close();
    await fake.stop();
  }
});

test("fork rejects options the adapter cannot apply before any effect", async () => {
  const fake = await fakeServer("fork-options");

  const client = await Beachside.connect({
    adapter: createFakeAdapter({ url: fake.url, token: fake.token, fork: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });

    expect(await box.checkFork({ lifetimeSeconds: 2 * 86_400 })).toMatchObject({
      status: "unsupported",
    });
    await expect(box.fork({ lifetimeSeconds: 2 * 86_400 })).rejects.toBeInstanceOf(
      UnsupportedFeatureError,
    );
    // SAFETY: a JavaScript caller can pass an option the fork request type does not declare.
    await expect(box.fork({ image: "other" } as never)).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect((await client.sandboxes.list()).items).toHaveLength(1);
  } finally {
    await client.close();
    await fake.stop();
  }
});

test("fork is UNSUPPORTED without a native fork; it is never emulated", async () => {
  const fake = await fakeServer("no-fork");

  const client = await Beachside.connect({
    adapter: createFakeAdapter({ url: fake.url, token: fake.token, snapshots: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });

    expect((await box.capabilities()).fork.status).toBe("unsupported");
    await expect(box.fork()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    // No snapshot was taken behind the caller's back.
    expect((await client.snapshots.list()).items).toEqual([]);
  } finally {
    await client.close();
    await fake.stop();
  }
});

test("a fork whose response was lost recovers the fork without a second one", async () => {
  const fake = await fakeServer("fork-lost");

  const client = await Beachside.connect({
    adapter: createFakeAdapter({ url: fake.url, token: fake.token, fork: true }),
    config: {},
    credentials: {},
  });

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    await fake.seed({ submissionId: "*", action: "create", behavior: "lost_after_effect" });

    const lost = await box.fork().catch((error: Error) => error);
    expect(lost).toBeInstanceOf(OutcomeUnknownError);

    if (!(lost instanceof OutcomeUnknownError)) throw lost;
    expect(lost.reference).toMatchObject({ kind: "sandbox_fork" });

    const recovered = await (await client.recover(lost.reference)).observe();
    expect(recovered).toMatchObject({ reference: { kind: "sandbox" } });
    expect((await client.sandboxes.list()).items).toHaveLength(2);
  } finally {
    await client.close();
    await fake.stop();
  }
});
