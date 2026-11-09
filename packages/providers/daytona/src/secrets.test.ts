import { expect, test } from "bun:test";
import { Image, Beachside, UnsupportedFeatureError, secret } from "beachside";
import { createDaytonaAdapter } from "./adapter";

const KEY = "CANARY-daytona-brokered-key";

function fixture(options: { rejectSandbox?: boolean } = {}) {
  const secrets = new Map<string, { id: string; name: string; value: string; hosts: string[] }>();

  const sandboxBodies: {
    name: string;
    env?: Record<string, string>;
    secrets?: Record<string, string>[];
  }[] = [];

  const deleted: string[] = [];

  const fetchImpl: typeof fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));
      const method = init?.method ?? "GET";

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({ id: "org-1", sandboxLimitedNetworkEgress: false });

      if (url.pathname === "/api/snapshots/snap-1")
        return Response.json({
          id: "snap-1",
          name: "snap-1",
          imageName: "alpine:3.21",
          organizationId: "org-1",
          state: "active",
          regionIds: ["us"],
          sandboxClass: "container",
        });

      if (url.pathname === "/api/secret" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const id = `sec-${secrets.size + 1}`;
        secrets.set(id, { id, ...body });

        return Response.json({ id, name: body.name, hosts: body.hosts });
      }

      if (url.pathname === "/api/secret/paginated") {
        const name = url.searchParams.get("name") ?? "";

        return Response.json({
          items: [...secrets.values()].flatMap((item) =>
            item.name.includes(name) ? [{ id: item.id, name: item.name }] : [],
          ),
          total: secrets.size,
          nextCursor: null,
        });
      }

      if (url.pathname.startsWith("/api/secret/") && method === "DELETE") {
        const id = decodeURIComponent(url.pathname.split("/").at(-1)!);
        deleted.push(id);
        secrets.delete(id);

        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/sandbox" && method === "POST") {
        const body = JSON.parse(String(init?.body));
        sandboxBodies.push(body);

        if (options.rejectSandbox)
          return Response.json({ message: `quota exceeded ${KEY}` }, { status: 403 });

        return Response.json({
          id: "native-1",
          name: body.name,
          organizationId: "org-1",
          target: "us",
          state: "started",
          networkBlockAll: false,
          public: false,
          labels: body.labels,
        });
      }

      throw new Error(`Unexpected fixture request ${method} ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = () =>
    Beachside.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us", network: "internet", environment: Image.prepared("snap-1") },
      credentials: { apiKey: "fixture-key" },
    });

  return { connect, secrets, sandboxBodies, deleted };
}

test("brokered secrets become per-sandbox Daytona secrets mounted as placeholders", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    expect((await client.capabilities()).secrets?.brokered).toMatchObject({
      delivery: "placeholder",
      basicAuth: true,
    });

    const box = await client.sandboxes.create({
      env: { MODE: "agent", GH_TOKEN: secret(KEY, { for: "github" }) },
    });

    expect(box.id).toBe("native-1");
    const [stored] = [...f.secrets.values()];
    const body = f.sandboxBodies[0]!;
    expect(stored).toMatchObject({
      value: KEY,
      hosts: ["api.github.com", "github.com"],
      name: `${String(body.name)}-GH_TOKEN`,
    });
    expect(body.env).toEqual({ MODE: "agent" });
    expect(body.secrets).toEqual([{ GH_TOKEN: stored!.name }]);
    expect(JSON.stringify(body)).not.toContain(KEY);
    expect(JSON.stringify(box.reference)).not.toContain(KEY);
  } finally {
    await client.close();
  }
});

test("a refused sandbox create deletes its secrets and never echoes the value", async () => {
  const f = fixture({ rejectSandbox: true });
  const client = await f.connect();

  try {
    let error: unknown;

    try {
      await client.sandboxes.create({ env: { K: secret(KEY, { for: "anthropic" }) } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(KEY);
    expect(f.secrets.size).toBe(0);
    expect(f.deleted).toEqual(["sec-1"]);
  } finally {
    await client.close();
  }
});

test("Daytona refuses more secrets than it brokers before any effect", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const env = Object.fromEntries(
      Array.from({ length: 17 }, (_, index) => [`K${index}`, secret(KEY, { for: "npm" })]),
    );

    await expect(client.sandboxes.create({ env })).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(f.secrets.size).toBe(0);
  } finally {
    await client.close();
  }
});
