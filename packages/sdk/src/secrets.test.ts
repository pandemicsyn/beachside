import { expect, test } from "bun:test";
import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  secretHeaderValue,
  secretValues,
  type CreateInput as NativeCreateInput,
  type SecretSupport,
} from "@beachside/adapter";
import {
  Beachside,
  BeachsideError,
  Secret,
  UnsupportedFeatureError,
  secret,
  type RecoveryReference,
} from "./index";

const KEY = "CANARY-secret-model-key";

const PAT = "CANARY-secret-github-pat";

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const Token = z.strictObject({ submissionId: z.string() });

function fixture(secrets?: SecretSupport) {
  const creates: NativeCreateInput[] = [];

  const adapter = defineAdapter({
    name: "fixture.secrets",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultImage: { kind: "prepared" as const, value: "base" },
        supports: {
          images: ["prepared" as const],
          network: ["blocked"],
          exec: { commands: ["argv" as const], maxOutputBytes: 1_048_576 },
          createEnv: true,
          secrets,
        },
        create: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            creates.push(structuredClone(input));
            const id = `box-${creates.length}`;

            return {
              id,
              reference: sandboxReference("fixture.secrets", scope, id, {
                operation: ctx.operationId,
                submission: ctx.submissionId,
              }),
              state: "running" as const,
            };
          },
        },
        async destroy() {
          return { computeStopped: true, retainedResources: [] };
        },
      };
    },
  });

  const saved: RecoveryReference[] = [];

  const connect = () =>
    Beachside.connect({
      adapter,
      config: {},
      credentials: {},
      onReference(reference) {
        saved.push(structuredClone(reference));
      },
    });

  return { connect, creates, saved };
}

const header: SecretSupport = {
  delivery: "header",
  basicAuth: true,
  wildcardHosts: true,
  maxSecrets: 16,
};

const placeholder: SecretSupport = {
  delivery: "placeholder",
  basicAuth: false,
  wildcardHosts: true,
  maxSecrets: 16,
};

test("secret() values never print, serialize or reach recovery references", async () => {
  const value = secret(KEY, { for: "anthropic" });
  expect(value).toBeInstanceOf(Secret);
  expect(String(value)).toBe("[secret]");
  expect(JSON.stringify({ value })).toBe('{"value":"[secret]"}');
  expect(Bun.inspect(value)).not.toContain(KEY);
  expect(value.rules).toEqual([
    { host: "api.anthropic.com", header: { name: "x-api-key", format: "raw" } },
  ]);

  const f = fixture(header);
  const client = await f.connect();

  try {
    expect((await client.capabilities()).secrets).toEqual(header);

    const operation = await client.sandboxes.submitCreate({
      env: { MODE: "agent", ANTHROPIC_API_KEY: value, GH: secret.exposed(PAT) },
    });

    await operation.wait();
    expect(f.creates[0]?.env).toEqual({ MODE: "agent", GH: PAT });
    expect(f.creates[0]?.secrets).toEqual([
      {
        env: "ANTHROPIC_API_KEY",
        value: KEY,
        rules: [{ host: "api.anthropic.com", header: { name: "x-api-key", format: "raw" } }],
      },
    ]);
    expect(JSON.stringify(operation.reference)).not.toContain(KEY);
  } finally {
    await client.close();
  }

  expect(JSON.stringify(f.saved)).not.toContain(KEY);
  expect(JSON.stringify(f.saved)).not.toContain(PAT);
});

test("presets and raw hosts expand to header rules", () => {
  expect(secret(PAT, { for: "github" }).rules).toEqual([
    { host: "api.github.com", header: { name: "authorization", format: "bearer" } },
    {
      host: "github.com",
      header: { name: "authorization", format: "basic", username: "x-access-token" },
    },
  ]);
  expect(
    secret(PAT, { hosts: ["Registry.Example.com", "*.internal.example"], header: "x-token" }).rules,
  ).toEqual([
    { host: "registry.example.com", header: { name: "x-token", format: "bearer" } },
    { host: "*.internal.example", header: { name: "x-token", format: "bearer" } },
  ]);

  expect(secretHeaderValue("t", { name: "authorization", format: "bearer" })).toBe("Bearer t");
  expect(
    secretHeaderValue("t", { name: "authorization", format: "basic", username: "x-access-token" }),
  ).toBe(`Basic ${btoa("x-access-token:t")}`);
  expect(
    secretValues([
      {
        env: "GH_TOKEN",
        value: "t",
        rules: [{ host: "api.github.com", header: { name: "authorization", format: "bearer" } }],
      },
    ]),
  ).toEqual(["t", "Bearer t"]);
});

test("invalid secrets fail without echoing values", () => {
  for (const make of [
    () => secret(KEY, {}),
    () => secret(KEY, { hosts: ["not a host"] }),
    // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Exercise an unknown preset from JavaScript.
    () => secret(KEY, { for: "nope" as "npm" }),
    () => secret("", { for: "npm" }),
    () => secret(`${KEY}\n`, { for: "npm" }),
  ]) {
    let error: unknown;

    try {
      make();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(BeachsideError);
    expect(String(error)).not.toContain(KEY);
  }
});

test("adapters without brokering refuse before any effect, never falling back to env", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    expect((await client.capabilities()).secrets).toBeNull();

    const check = await client.sandboxes.checkCreate({
      env: { ANTHROPIC_API_KEY: secret(KEY, { for: "anthropic" }) },
    });

    expect(check.status).toBe("unsupported");
    await expect(
      client.sandboxes.create({ env: { ANTHROPIC_API_KEY: secret(KEY, { for: "anthropic" }) } }),
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
    expect(f.creates).toHaveLength(0);

    // Exposed secrets are ordinary env and work wherever create env does.
    await client.sandboxes.create({ env: { GH_TOKEN: secret.exposed(PAT) } });
    expect(f.creates[0]?.env).toEqual({ GH_TOKEN: PAT });
    expect(f.creates[0]?.secrets).toBeUndefined();
  } finally {
    await client.close();
  }
});

test("placeholder adapters refuse Basic-auth hosts and name the way out", async () => {
  const f = fixture(placeholder);
  const client = await f.connect();

  try {
    let error: unknown;

    try {
      await client.sandboxes.create({ env: { GH_TOKEN: secret(PAT, { for: "github" }) } });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UnsupportedFeatureError);
    // SAFETY: the line above checked the error is an UnsupportedFeatureError.
    expect(JSON.stringify((error as UnsupportedFeatureError).unmetRequirements)).toContain(
      "github-api",
    );
    expect(String(error)).not.toContain(PAT);
    expect(f.creates).toHaveLength(0);

    await client.sandboxes.create({ env: { GH_TOKEN: secret(PAT, { for: "github-api" }) } });
    expect(f.creates[0]?.secrets?.[0]?.rules.map((rule) => rule.host)).toEqual(["api.github.com"]);
  } finally {
    await client.close();
  }
});
