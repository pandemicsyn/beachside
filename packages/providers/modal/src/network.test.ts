import { expect, test } from "bun:test";
import { Beachside, Image } from "beachside";
import { createModalAdapter, modalNetwork, modalNetworkTag } from "./adapter";
import type { ModalTransport } from "./transport";

type CreateInput = Parameters<ModalTransport["create"]>[0];

function fixture(options: { dropNetworkTag?: boolean } = {}) {
  const creates: CreateInput[] = [];
  const records = new Map<string, { id: string; tags: Record<string, string>; running: boolean }>();

  const transport: ModalTransport = {
    async lookupApp() {
      return "ap-main";
    },
    async imageExists(id) {
      return id === "im-fixture";
    },
    async create(input) {
      creates.push(input);
      const tags = { ...input.tags };

      if (options.dropNetworkTag) delete tags.beachside_network;
      const record = { id: `sb-${creates.length}`, tags, running: true };
      records.set(input.name, record);

      return record.id;
    },
    async findByName(_app, _environment, name) {
      return records.get(name) ?? null;
    },
    async *list() {
      for (const record of records.values()) yield record;
    },
    async terminate() {
      return true;
    },
    async poll() {
      return "running";
    },
    async readBytes() {
      return new Uint8Array();
    },
    async fileExists() {
      return false;
    },
    async start() {},
    async stdin() {},
    async result() {
      return { exitCode: 0, stdout: new Uint8Array(), stderr: new Uint8Array(), truncated: false };
    },
    async snapshotFilesystem() {
      throw new Error("unused");
    },
    async deleteImage() {
      return "missing";
    },
    async tunnelUrl(_id, port) {
      return creates.at(-1)?.encryptedPorts?.includes(port)
        ? `https://t${port}.r5.modal.host`
        : null;
    },
    async connectToken(id, port) {
      return { url: `https://${id}-${port}.connect.modal.host`, token: "connect-token" };
    },
    close() {},
  };

  return { adapter: createModalAdapter(() => transport), creates };
}

const credentials = { tokenId: "ak-fixture", tokenSecret: "as-fixture" };

const base = { appName: "existing", environment: "main" };

const environment = Image.prepared("im-fixture");

test("Modal creates blocked by default and opens internet on request", async () => {
  const native = fixture();
  const client = await Beachside.connect({ adapter: native.adapter, config: base, credentials });

  try {
    expect((await client.capabilities()).network).toEqual(["blocked", "internet"]);
    await client.sandboxes.create({ environment });
    await client.sandboxes.create({ environment, network: "internet" });
    expect(native.creates.map((input) => input.network)).toEqual([
      { kind: "blocked" },
      { kind: "open" },
    ]);
    expect(native.creates.map((input) => input.tags.beachside_network)).toEqual([
      "blocked",
      "internet",
    ]);
  } finally {
    await client.close();
  }
});

test("network internet in setup makes internet the default", async () => {
  const native = fixture();

  const client = await Beachside.connect({
    adapter: native.adapter,
    config: { ...base, network: "internet" },
    credentials,
  });

  try {
    await client.sandboxes.create({ environment });
    expect(native.creates[0]!.network).toEqual({ kind: "open" });
  } finally {
    await client.close();
  }
});

test("a Modal allowlist sends domain and IP allowlists and refuses other policies", async () => {
  const native = fixture();

  const client = await Beachside.connect({
    adapter: native.adapter,
    config: { ...base, network: { allow: ["PyPI.org", "*.githubusercontent.com", "10.2.3.4/16"] } },
    credentials,
  });

  try {
    expect((await client.capabilities()).network).toEqual(["allow"]);
    await client.sandboxes.create({ environment });
    expect(native.creates[0]!.network).toEqual({
      kind: "allowlist",
      domains: ["*.githubusercontent.com", "pypi.org"],
      cidrs: ["10.2.0.0/16"],
    });
    expect(native.creates[0]!.tags.beachside_network).toStartWith("allow-");
    await expect(
      client.sandboxes.create({ environment, network: "internet" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }
});

test("a create whose network tag is missing is unknown, not replayed", async () => {
  const native = fixture({ dropNetworkTag: true });
  const client = await Beachside.connect({ adapter: native.adapter, config: base, credentials });

  try {
    await expect(client.sandboxes.create({ environment })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(native.creates).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("invalid Modal allowlists fail at connect with their reason", async () => {
  await expect(
    Beachside.connect({
      adapter: fixture().adapter,
      config: { ...base, network: { allow: ["0.0.0.0/0"] } },
      credentials,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("internet"),
  });
});

test("network helpers map portable policies", () => {
  expect(modalNetwork("blocked", undefined)).toEqual({ kind: "blocked" });
  expect(modalNetworkTag("internet", undefined)).toBe("internet");
  expect(modalNetworkTag("allow", "a.com")).not.toBe(modalNetworkTag("allow", "b.com"));
});

test("protected Modal previews mint a connect token for the port, sent as a bearer header", async () => {
  const native = fixture();
  const client = await Beachside.connect({ adapter: native.adapter, config: base, credentials });

  try {
    const box = await client.sandboxes.create({ environment });
    expect(native.creates[0]!.encryptedPorts).toBeUndefined();
    expect(await box.preview(3000)).toEqual({
      access: "protected",
      url: "https://sb-1-3000.connect.modal.host",
      headers: { Authorization: "Bearer connect-token" },
    });
  } finally {
    await client.close();
  }
});

test("public Modal previews publish the configured ports as tunnels at create", async () => {
  const native = fixture();

  const client = await Beachside.connect({
    adapter: native.adapter,
    config: { ...base, network: "internet", preview: { access: "public", ports: [3000] } },
    credentials,
  });

  try {
    expect((await client.capabilities()).network).toEqual(["internet"]);
    const box = await client.sandboxes.create({ environment });
    expect(native.creates[0]!.encryptedPorts).toEqual([3000]);
    expect(native.creates[0]!.network).toEqual({ kind: "open" });
    expect(await box.preview(3000)).toEqual({
      access: "public",
      url: "https://t3000.r5.modal.host",
    });
    await expect(box.preview(8080)).rejects.toMatchObject({ code: "UNSUPPORTED" });
  } finally {
    await client.close();
  }

  await expect(
    Beachside.connect({
      adapter: native.adapter,
      config: { ...base, preview: { access: "public" } },
      credentials,
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", message: expect.stringContaining("ports") });
});

test("public Modal previews refuse a blocked network, which Modal forbids with open ports", async () => {
  const native = fixture();

  // The default network is blocked, so public tunnels need an explicit network in setup.
  await expect(
    Beachside.connect({
      adapter: native.adapter,
      config: { ...base, preview: { access: "public", ports: [3000] } },
      credentials,
    }),
  ).rejects.toMatchObject({
    code: "INVALID_ARGUMENT",
    message: expect.stringContaining("tunnels"),
  });

  const client = await Beachside.connect({
    adapter: native.adapter,
    config: { ...base, network: "internet", preview: { access: "public", ports: [3000] } },
    credentials,
  });

  try {
    await expect(
      client.sandboxes.create({ environment, network: "blocked" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(native.creates).toHaveLength(0);
  } finally {
    await client.close();
  }
});
