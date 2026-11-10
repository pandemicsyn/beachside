import { expect, test } from "bun:test";
import { Image, Beachside } from "beachside";
import type { Json } from "@beachside/adapter";
import { createDaytonaAdapter } from "./adapter";
import { daytona } from "./factory";

type Body = Record<string, Json> & { name: string; labels: Record<string, string> };

function fixture(options: { limited?: boolean; echo?: (body: Body) => Record<string, Json> }) {
  const bodies: Body[] = [];

  const fetchImpl: typeof fetch = Object.assign(
    async (request: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(request));

      if (url.pathname === "/api/api-keys/current")
        return Response.json({ organizationId: "org-1" });

      if (url.pathname === "/api/regions")
        return Response.json([{ id: "us", name: "US", regionType: "shared" }]);

      if (url.pathname === "/api/organizations/org-1")
        return Response.json({
          id: "org-1",
          sandboxLimitedNetworkEgress: options.limited ?? false,
        });

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

      if (url.pathname === "/api/sandbox" && init?.method === "POST") {
        // SAFETY: the fixture only reads fields the adapter sends in its JSON create body.
        const body = JSON.parse(String(init.body)) as Body;
        bodies.push(body);

        return Response.json({
          id: "native-1",
          name: body.name,
          organizationId: "org-1",
          target: "us",
          state: "started",
          networkBlockAll: false,
          public: false,
          labels: body.labels,
          ...(options.echo
            ? options.echo(body)
            : { domainAllowList: body.domainAllowList, networkAllowList: body.networkAllowList }),
        });
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect: fetch.preconnect },
  );

  const connect = (allow: string[]) =>
    Beachside.connect({
      adapter: createDaytonaAdapter(fetchImpl),
      config: { target: "us", network: { allow }, environment: Image.prepared("snap-1") },
      credentials: { apiKey: "fixture-key" },
    });

  return { connect, bodies };
}

test("Daytona sends host allowlists as its native domain list and confirms them", async () => {
  const f = fixture({});
  const client = await f.connect(["GitHub.com", "*.npmjs.org"]);

  try {
    expect((await client.capabilities()).network).toEqual(["allow"]);
    const box = await client.sandboxes.create();
    expect(box.id).toBe("native-1");
    expect(f.bodies[0]).toMatchObject({ domainAllowList: "*.npmjs.org,github.com" });
    expect(f.bodies[0]).not.toHaveProperty("networkAllowList");
    expect(f.bodies[0]).not.toHaveProperty("networkBlockAll");
  } finally {
    await client.close();
  }
});

test("Daytona sends range allowlists as its native network list and confirms them", async () => {
  const f = fixture({});
  const client = await f.connect(["10.1.0.0/16"]);

  try {
    await client.sandboxes.create();
    expect(f.bodies[0]).toMatchObject({ networkAllowList: "10.1.0.0/16" });
    expect(f.bodies[0]).not.toHaveProperty("domainAllowList");
  } finally {
    await client.close();
  }
});

test("Daytona refuses an allowlist mixing hosts and ranges, which its API does not accept", async () => {
  const f = fixture({});
  await expect(f.connect(["github.com", "10.1.0.0/16"])).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("not both"),
  });
  expect(f.bodies).toHaveLength(0);
});

test("Daytona refuses allowlists its native limits or tier cannot hold", async () => {
  await expect(
    fixture({}).connect(Array.from({ length: 11 }, (_, i) => `10.0.${i}.0/24`)),
  ).rejects.toThrow(/at most 10 IP ranges/);
  await expect(fixture({}).connect(["https://github.com"])).rejects.toThrow(/not a host name/);

  const limited = fixture({ limited: true });
  const client = await limited.connect(["github.com"]);

  try {
    expect((await client.capabilities()).network).toEqual([]);
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(limited.bodies).toEqual([]);
  } finally {
    await client.close();
  }
});

test("Daytona does not report a sandbox ready when the native allowlist differs", async () => {
  const f = fixture({ echo: () => ({ domainAllowList: "github.com,evil.example" }) });
  const client = await f.connect(["github.com"]);

  try {
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  } finally {
    await client.close();
  }
});

test("the daytona() factory takes an allowlist as its network", () => {
  // Type-checked by the package check: the factory accepts the same network setting as the adapter.
  expect(daytona({ apiKey: "key", target: "us", network: { allow: ["github.com"] } }).bound).toBe(
    true,
  );
});
