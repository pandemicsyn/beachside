import { expect, test, spyOn } from "bun:test";
import { Sandbox } from "e2b";
import { Beachside, Image } from "beachside";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BTransport, type E2BRecord } from "./transport";

async function fixture(access?: "protected" | "public") {
  let lookups = 0;
  const tokenReads: string[] = [];
  let token: string | undefined = "private-token";
  const creates: boolean[] = [];

  const record: E2BRecord = {
    id: "box",
    templateId: "base",
    metadata: {},
    state: "running",
    domain: "e2b.app",
    lifecycle: { autoResume: false },
    allowPublicTraffic: access !== "protected",
    attachmentReady: false,
  };

  const transport: E2BTransport = {
    verifyAuth: async () => {},
    verifyTeam: async () => {},
    verifyTemplate: async () => "base",
    buildImage: async () => {
      throw Error("unexpected build");
    },
    findBuild: async () => null,
    create: async (input) => {
      creates.push(input.allowPublicTraffic!);
      record.metadata = input.metadata;

      return "box";
    },
    get: async () => {
      lookups++;

      return record;
    },
    list: async () => ({ items: [] }),
    trafficAccessToken: async (id) => {
      tokenReads.push(id);

      return { sandboxId: id, token, resumed: false };
    },
    kill: async () => {
      throw Error("unexpected kill");
    },
    run: async () => {
      throw Error("unexpected exec");
    },
    read: async () => {
      throw Error("unexpected file IO");
    },
    write: async () => {},
    remove: async () => {},
    close() {},
  };

  const client = await Beachside.connect({
    adapter: createE2BAdapter(() => transport),
    config: access ? { preview: { access } } : {},
    credentials: { apiKey: "key" },
  });

  const box = await client.sandboxes.create({ environment: Image.prepared("base") });

  return {
    client,
    box,
    record,
    creates,
    tokenReads,
    lookups: () => lookups,
    setToken: (value: string | undefined) => {
      token = value;
    },
  };
}

test("E2B defaults to public previews that work without setup", async () => {
  const f = await fixture();

  try {
    expect(f.creates).toEqual([true]);
    expect(await f.box.preview(3000)).toEqual({
      access: "public",
      url: "https://3000-box.e2b.app",
    });
  } finally {
    await f.client.close();
  }
});

test("E2B protected setup creates private compute and returns the traffic token header", async () => {
  const f = await fixture("protected");

  try {
    expect(f.creates).toEqual([false]);
    const ref = JSON.stringify(f.box.reference);
    expect(await f.box.preview(3000)).toEqual({
      access: "protected",
      url: "https://3000-box.e2b.app",
      headers: { "e2b-traffic-access-token": "private-token" },
    });
    expect(f.tokenReads).toEqual(["box"]);
    expect(ref).not.toContain("private-token");
    expect(JSON.stringify(f.box.reference)).toBe(ref);
  } finally {
    await f.client.close();
  }
});

test("E2B protected preview checks visibility and state before reading a token", async () => {
  const f = await fixture("protected");

  try {
    f.record.allowPublicTraffic = true;
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.allowPublicTraffic = false;
    f.record.state = "paused";
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.state = "running";
    f.record.lifecycle = { autoResume: true };
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(f.tokenReads).toEqual([]);
    f.record.lifecycle = { autoResume: false };
    f.setToken(undefined);
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  } finally {
    await f.client.close();
  }
});

test("E2B public verifies current visibility and auto-resume, and needs no guest attachment", async () => {
  const f = await fixture("public");

  try {
    expect(f.creates).toEqual([true]);
    const ref = JSON.stringify(f.box.reference);
    expect(await f.box.preview(3000)).toEqual({
      access: "public",
      url: "https://3000-box.e2b.app",
    });
    expect(JSON.stringify(f.box.reference)).toBe(ref);
    f.record.allowPublicTraffic = false;
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.allowPublicTraffic = true;
    f.record.lifecycle = { autoResume: true };
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.lifecycle = { autoResume: false };
    f.record.state = "paused";
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    f.record.state = "running";
    f.record.metadata.beachside_operation = "foreign";
    await expect(f.box.preview(3000)).rejects.toMatchObject({ code: "CONFLICT" });
  } finally {
    await f.client.close();
  }
});

test("E2B pinned create receives inbound choice independently of blocked outbound policy", async () => {
  // SAFETY: This boundary consumes only sandboxId from the pinned creation response.
  const mock = spyOn(Sandbox, "create").mockResolvedValue({ sandboxId: "box" } as Sandbox);

  try {
    const transport = createSdkTransport("key");
    await transport.create({
      templateId: "base",
      metadata: {},
      timeoutMs: 300000,
      allowInternetAccess: false,
    });
    await transport.create({
      templateId: "base",
      metadata: {},
      timeoutMs: 300000,
      allowInternetAccess: false,
      allowPublicTraffic: true,
    });
    expect(mock.mock.calls.map((call) => call[1])).toMatchObject([
      {
        network: { allowPublicTraffic: false },
        allowInternetAccess: false,
        lifecycle: { autoResume: false },
        retries: 0,
      },
      { network: { allowPublicTraffic: true }, allowInternetAccess: false },
    ]);
  } finally {
    mock.mockRestore();
  }
});

test("E2B detail reads expose observed visibility without traffic credentials or lifecycle mutation", async () => {
  const calls: string[] = [];

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${new URL(String(input)).pathname}`);

      return Response.json({
        sandboxID: "box",
        templateID: "base",
        metadata: {},
        state: "running",
        domain: "e2b.app",
        network: { allowPublicTraffic: true },
        lifecycle: { autoResume: false },
        trafficAccessToken: "private-token",
      });
    },
    { preconnect() {} },
  );

  const transport = createSdkTransport("key", fetcher);
  const record = await transport.get("box");
  expect(record).toMatchObject({
    id: "box",
    domain: "e2b.app",
    allowPublicTraffic: true,
    lifecycle: { autoResume: false },
  });
  expect(JSON.stringify(record)).not.toContain("private-token");
  expect(calls).toEqual(["GET /sandboxes/box"]);
});

test("E2B traffic token read connects without extending the lifetime and keeps the token out of errors", async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  let status = 200;

  const fetcher: typeof fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        path: new URL(String(input)).pathname,
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)),
      });

      return Response.json(
        { sandboxID: "box", trafficAccessToken: "private-token", envdVersion: "0.5.7" },
        { status },
      );
    },
    { preconnect() {} },
  );

  const transport = createSdkTransport("key", fetcher);
  expect(await transport.trafficAccessToken!("box", AbortSignal.timeout(1000))).toEqual({
    sandboxId: "box",
    token: "private-token",
    resumed: false,
  });
  status = 201;
  expect(await transport.trafficAccessToken!("box", AbortSignal.timeout(1000))).toMatchObject({
    resumed: true,
  });
  status = 404;
  await expect(
    transport.trafficAccessToken!("box", AbortSignal.timeout(1000)),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(calls[0]).toEqual({
    path: "/v2/sandboxes/box/connect",
    method: "POST",
    body: { timeout: 1 },
  });
});
