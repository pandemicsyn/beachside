import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import { Beachside, secret, type AdapterRecoveryReference } from "beachside";
import { createE2BAdapter } from "./index";
import type { E2BRecord, E2BTransport } from "./transport";

const KEY = "CANARY-e2b-brokered-key";

const PAT = "CANARY-e2b-brokered-pat";

const original = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = original;
});

function fixtureTransport(creates: Parameters<E2BTransport["create"]>[0][]): E2BTransport {
  const record: E2BRecord = { id: "sandbox_secret", templateId: "base", metadata: {}, state: "running" };

  return {
    async verifyAuth() {},
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async buildImage() {
      throw new Error("No build expected");
    },
    async findBuild() {
      return null;
    },
    async create(input) {
      creates.push(input);
      record.metadata = input.metadata;
      record.allowPublicTraffic = input.allowPublicTraffic;

      return record.id;
    },
    async get(id) {
      return id === record.id ? record : null;
    },
    async list() {
      return { items: [record] };
    },
    async kill() {
      return true;
    },
    async run() {
      return "";
    },
    async read() {
      return { bytes: new Uint8Array(), truncated: false };
    },
    async write() {},
    async remove() {},
    close() {},
  };
}

test("E2B brokers secrets as egress header rules with placeholders in env", async () => {
  const creates: Parameters<E2BTransport["create"]>[0][] = [];
  const saved: AdapterRecoveryReference[] = [];

  const client = await Beachside.connect({
    adapter: createE2BAdapter(() => fixtureTransport(creates)),
    config: {},
    credentials: { apiKey: "private-key" },
    onReference(reference) {
      saved.push(structuredClone(reference));
    },
  });

  try {
    expect((await client.capabilities()).secrets).toMatchObject({
      delivery: "header",
      basicAuth: true,
    });
    const operation = await client.sandboxes.submitCreate({
      env: {
        MODE: "agent",
        ANTHROPIC_API_KEY: secret(KEY, { for: "anthropic" }),
        GH_TOKEN: secret(PAT, { for: "github" }),
      },
    });

    await operation.wait();
    expect(creates[0]?.env).toEqual({
      MODE: "agent",
      ANTHROPIC_API_KEY: "beachside:ANTHROPIC_API_KEY",
      GH_TOKEN: "beachside:GH_TOKEN",
    });
    expect(Object.fromEntries(creates[0]?.headerRules ?? [])).toEqual({
      "api.anthropic.com": { "x-api-key": KEY },
      "api.github.com": { authorization: `Bearer ${PAT}` },
      "github.com": { authorization: `Basic ${btoa(`x-access-token:${PAT}`)}` },
    });
    expect(JSON.stringify([operation.reference, saved])).not.toContain(KEY);
    expect(JSON.stringify([operation.reference, saved])).not.toContain(PAT);
  } finally {
    await client.close();
  }
});

test("E2B native create sends network rules and redacts brokered values from rejections", async () => {
  const bodies: { network?: { rules?: Record<string, unknown> }; envVars?: Record<string, string> }[] =
    [];

  // SAFETY: This deterministic fetch boundary matches Bun's fetch/preconnect shape and receives only fixture credentials.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      const url = new URL(request.url);

      if (url.pathname === "/v2/templates") return Response.json([]);

      if (url.pathname === "/v2/sandboxes" && request.method === "POST") {
        const body = z
          .object({
            envVars: z.record(z.string(), z.string()).optional(),
            network: z.object({ rules: z.record(z.string(), z.unknown()).optional() }).optional(),
          })
          .parse(await request.json());

        bodies.push(body);

        return Response.json(
          { code: 400, message: `bad rules ${JSON.stringify(body.network)}` },
          { status: 400 },
        );
      }

      throw new Error(`Unexpected fixture request ${url.pathname}`);
    },
    { preconnect() {} },
  ) as typeof fetch;

  const client = await Beachside.connect({
    adapter: createE2BAdapter(),
    config: {},
    credentials: { apiKey: "fixture-key" },
  });

  try {
    const error = await client.sandboxes
      .create({ env: { NPM_TOKEN: secret(KEY, { for: "npm" }) } })
      .then(
        () => undefined,
        (cause: Error) => cause,
      );

    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.envVars).toEqual({ NPM_TOKEN: "beachside:NPM_TOKEN" });
    expect(bodies[0]?.network?.rules).toEqual({
      "registry.npmjs.org": [{ transform: { headers: { authorization: `Bearer ${KEY}` } } }],
    });
    expect(String(error?.message)).not.toContain(KEY);
    expect(String(error?.message)).toContain("[redacted]");
  } finally {
    await client.close();
  }
});
