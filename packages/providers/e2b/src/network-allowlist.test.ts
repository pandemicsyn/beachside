import { expect, spyOn, test } from "bun:test";
import { Sandbox } from "e2b";
import { Beachside, Image } from "beachside";
import { createE2BAdapter } from "./index";
import { e2b } from "./factory";
import { createSdkTransport, type E2BRecord, type E2BTransport } from "./transport";

function fixture(echo?: (allowOut: readonly string[] | undefined) => Partial<E2BRecord>) {
  const creates: Parameters<E2BTransport["create"]>[0][] = [];

  const record: E2BRecord = {
    id: "box",
    templateId: "base",
    metadata: {},
    state: "running",
    domain: "e2b.app",
    lifecycle: { autoResume: false },
    allowPublicTraffic: true,
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
      creates.push(input);
      record.metadata = input.metadata;
      Object.assign(
        record,
        echo?.(input.allowOut) ??
          (input.allowOut ? { allowOut: [...input.allowOut], denyOut: ["0.0.0.0/0"] } : {}),
      );

      return "box";
    },
    get: async () => record,
    list: async () => ({ items: [] }),
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

  const connect = (allow: string[]) =>
    Beachside.connect({
      adapter: createE2BAdapter(() => transport),
      config: { network: { allow } },
      credentials: { apiKey: "key" },
    });

  return { connect, creates };
}

test("E2B sends an allowlist as allowOut over deny-all and confirms it", async () => {
  const f = fixture();
  const client = await f.connect(["api.openai.com", "*.github.com", "10.0.0.1"]);

  try {
    expect((await client.capabilities()).network).toEqual(["allow"]);
    await client.sandboxes.create({ environment: Image.prepared("base") });
    expect(f.creates[0]).toMatchObject({
      allowInternetAccess: false,
      allowOut: ["*.github.com", "api.openai.com", "10.0.0.1/32"],
    });
    await expect(
      client.sandboxes.create({ environment: Image.prepared("base"), network: "internet" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }
});

test("E2B does not report an allowlist sandbox ready when native rules differ", async () => {
  const f = fixture(() => ({ allowOut: ["api.openai.com"], denyOut: [] }));
  const client = await f.connect(["api.openai.com"]);

  try {
    await expect(
      client.sandboxes.create({ environment: Image.prepared("base") }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally {
    await client.close();
  }
});

test("E2B rejects malformed allowlists at connect with the reason", async () => {
  await expect(fixture().connect(["github.com:443"])).rejects.toThrow(/not a host name/);
});

test("E2B SDK create receives allowOut and a deny-all denyOut", async () => {
  // SAFETY: This boundary consumes only sandboxId from the pinned creation response.
  const mock = spyOn(Sandbox, "create").mockResolvedValue({ sandboxId: "box" } as Sandbox);

  try {
    await createSdkTransport("key").create({
      templateId: "base",
      metadata: {},
      timeoutMs: 300000,
      allowInternetAccess: false,
      allowOut: ["github.com"],
    });
    expect(mock.mock.calls[0]?.[1]).toMatchObject({
      allowInternetAccess: false,
      network: { allowPublicTraffic: false, allowOut: ["github.com"], denyOut: ["0.0.0.0/0"] },
    });
  } finally {
    mock.mockRestore();
  }
});

test("the e2b() factory takes an allowlist as its network", () => {
  // Type-checked by the package check: the factory accepts the same network setting as the adapter.
  expect(e2b({ apiKey: "key", network: { allow: ["github.com", "10.1.0.0/16"] } }).bound).toBe(
    true,
  );
});
