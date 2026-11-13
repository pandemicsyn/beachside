import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import {
  adapterSetup,
  descriptor,
  loadAdapter,
  missingEnv,
  missingSettings,
  officialLocation,
  resolveProfile,
} from "../src/providers";
import { SecretReader } from "../src/secrets";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "beachside-providers-"));
  const scope = join(home, ".config", "beachside", "adapters", "node_modules", "@beachside");
  await mkdir(scope, { recursive: true });
  await symlink(join(import.meta.dir, "..", "..", "providers", "boxd"), join(scope, "boxd"));
  await symlink(join(import.meta.dir, "..", "..", "providers", "boat"), join(scope, "boat"));
  await symlink(join(import.meta.dir, "..", "..", "providers", "runloop"), join(scope, "runloop"));
  await symlink(
    join(import.meta.dir, "..", "..", "providers", "freestyle"),
    join(scope, "freestyle"),
  );
  await symlink(join(import.meta.dir, "..", "..", "providers", "archil"), join(scope, "archil"));
  await symlink(join(import.meta.dir, "..", "..", "providers", "exe-dev"), join(scope, "exe-dev"));
});

/** An official adapter's own setup, read through the installed package like the CLI does. */
async function setupOf(id: string) {
  const env = { HOME: home };
  const location = officialLocation(descriptor(id)!, await loadConfig(undefined, env), env);
  const setup = await adapterSetup(location, home, env);

  if (!setup) throw new Error(`${id} declares no setup`);

  return setup;
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

test("environment-only boxd setup needs only an org and binds optional network and region", async () => {
  const env = { HOME: home, BOXD_API_KEY: "key", BOXD_ORG: "team" };

  expect(missingEnv(await setupOf("boxd"), env)).toEqual([]);

  const ready = { ...env, BOXD_NETWORK: "blocked", BOXD_REGION: "nyc" };

  const profile = await resolveProfile(
    { provider: "boxd" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({ org: "team", network: "blocked", region: "nyc" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("boxd");
});

test("environment-only Boat setup needs only a key", async () => {
  const ready = { HOME: home, BOAT_API_KEY: "key" };

  expect(missingEnv(await setupOf("boat"), ready)).toEqual([]);

  const profile = await resolveProfile(
    { provider: "boat" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({});

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("boat");
});

test("environment-only Runloop setup needs only a key and can opt into blocked egress", async () => {
  const env = { HOME: home, RUNLOOP_API_KEY: "key" };

  expect(missingEnv(await setupOf("runloop"), env)).toEqual([]);
  expect(
    (await resolveProfile({ provider: "runloop" }, await loadConfig(undefined, env), env, home))
      .config,
  ).toEqual({});

  const ready = { ...env, RUNLOOP_NETWORK: "blocked" };

  const profile = await resolveProfile(
    { provider: "runloop" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({ network: "blocked" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("runloop");
});

test("environment-only Freestyle setup needs only a key and can opt into blocked egress", async () => {
  const env = { HOME: home, FREESTYLE_API_KEY: "key" };

  expect(missingEnv(await setupOf("freestyle"), env)).toEqual([]);
  expect(
    (await resolveProfile({ provider: "freestyle" }, await loadConfig(undefined, env), env, home))
      .config,
  ).toEqual({});

  const ready = { ...env, FREESTYLE_NETWORK: "blocked" };

  const profile = await resolveProfile(
    { provider: "freestyle" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({ network: "blocked" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("freestyle");
});

test("environment-only Archil setup names its region and can opt into blocked egress", async () => {
  const env = { HOME: home, ARCHIL_API_KEY: "key" };

  expect(missingEnv(await setupOf("archil"), env)).toEqual(["ARCHIL_REGION"]);

  const ready = { ...env, ARCHIL_REGION: "aws-eu-west-1", ARCHIL_NETWORK: "blocked" };

  const profile = await resolveProfile(
    { provider: "archil" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({ region: "aws-eu-west-1", network: "blocked" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("archil");
});

test("environment-only exe.dev setup needs only an API key", async () => {
  const env = { HOME: home, EXE_API_KEY: "exe1.key" };

  expect(missingEnv(await setupOf("exe-dev"), env)).toEqual([]);

  const ready = { ...env, EXE_NETWORK: "internet" };

  const profile = await resolveProfile(
    { provider: "exe-dev" },
    await loadConfig(undefined, ready),
    ready,
    home,
  );

  expect(profile.config).toEqual({ network: "internet" });

  const bound = await loadAdapter(
    profile,
    home,
    ready,
    new SecretReader(ready, new AbortController().signal),
  );

  expect(bound.name).toBe("exe-dev");
});

test("exe.dev takes an SSH key in place of an API key", async () => {
  const env = { HOME: home, EXE_NETWORK: "internet" };
  const configPath = join(home, "beachside.json");
  await Bun.write(
    configPath,
    JSON.stringify({ profiles: { ssh: { provider: "exe-dev", credentials: { sshKey: "key" } } } }),
  );

  const profile = await resolveProfile(
    { profile: "ssh" },
    await loadConfig(configPath, env),
    env,
    home,
  );

  expect(profile.credentials).toEqual({ sshKey: "key" });
  expect(missingEnv(await setupOf("exe-dev"), { HOME: home })).toEqual([
    "EXE_API_KEY or credentials.sshKey",
  ]);
});

test("a third-party adapter's own setup fills its settings from the environment", async () => {
  const dir = join(home, "acme");
  await mkdir(dir, { recursive: true });
  await Bun.write(
    join(dir, "adapter.mjs"),
    `import { defineAdapter } from ${JSON.stringify(import.meta.resolve("@beachside/adapter"))};
import { z } from ${JSON.stringify(import.meta.resolve("zod"))};
export const acmeAdapter = defineAdapter({
  name: "acme",
  setup: {
    credentials: { apiKey: { env: "ACME_API_KEY", url: "https://acme.example/keys" } },
    config: { region: { env: "ACME_REGION", required: true }, zone: { env: "ACME_ZONE" } },
  },
  config: z.object({ region: z.string(), zone: z.string().optional() }),
  credentials: z.object({ apiKey: z.string() }),
  async connect() { throw new Error("not used"); },
});
`,
  );
  const configPath = join(home, "beachside.json");
  await Bun.write(
    configPath,
    JSON.stringify({ profiles: { acme: { module: "./acme/adapter.mjs", export: "acmeAdapter" } } }),
  );

  const env = { HOME: home, ACME_API_KEY: "k", ACME_REGION: "north" };
  const loaded = await loadConfig(configPath, env);
  const profile = await resolveProfile({ profile: "acme" }, loaded, env, home);

  expect(profile.credentials).toEqual({ apiKey: "k" });
  expect(profile.config).toEqual({ region: "north" });

  const missing = resolveProfile({ profile: "acme" }, loaded, { HOME: home }, home);

  await expect(missing).rejects.toMatchObject({
    message: "profile acme is missing ACME_API_KEY, ACME_REGION",
    hint: expect.stringContaining("ACME_API_KEY: https://acme.example/keys"),
  });
});

test("official setups list where to get each required value", async () => {
  const needs = missingSettings(await setupOf("boxd"), { HOME: home });

  expect(needs.map((need) => need.env)).toEqual(["BOXD_API_KEY", "BOXD_ORG"]);
  expect(needs[0]!.url).toBe("https://docs.boxd.sh/cli/authentication");
});

test("an adapter that is not installed has no setup yet", async () => {
  const env = { HOME: home };
  const location = officialLocation(descriptor("e2b")!, await loadConfig(undefined, env), env);

  expect(
    await adapterSetup({ ...location, module: "@beachside/not-a-real-adapter" }, home, env),
  ).toBe(null);
});
