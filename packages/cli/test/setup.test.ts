import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Json } from "@beachside/adapter";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";

const token = "local-test-token-setup";

const main = join(import.meta.dir, "..", "src", "main.ts");

const fixture = join(import.meta.dir, "fake-adapter.ts");

let root: string;

let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

let dir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "beachside-cli-setup-"));
  server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(root, "fake.json"),
    token,
    testMode: true,
  });
});

afterAll(async () => {
  await server.stop(true);
  await rm(root, { recursive: true, force: true });
});

const setups = {
  base: { setup: ["echo base >> log"], env: { GREETING: "hi" } },
  tools: {
    extends: ["base"],
    setup: ['echo "tools $GREETING" >> log', "./tools.sh"],
    startup: ["echo up >> started"],
  },
  broken: { setup: ["echo one >> log", "test -f fixed || { echo nope >&2; exit 4; }"] },
};

beforeEach(async () => {
  await fetch(new URL("/_test/reset", server.url), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: "{}",
  });
  dir = await mkdtemp(join(root, "case-"));
  await writeFile(join(dir, "tools.sh"), "echo script >> log\n");
  await writeConfig({});
});

async function writeConfig(extra: Record<string, Json>) {
  await writeFile(
    join(dir, "beachside.json"),
    JSON.stringify({
      default: "fake",
      profiles: { fake: { module: fixture, export: "localShell" } },
      setups,
      ...extra,
    }),
  );
}

type Result = { code: number; stdout: string; stderr: string };

async function cli(args: string[], extraEnv: Record<string, string> = {}): Promise<Result> {
  // The fake has no default image, so new sandboxes start from its prepared starter.
  const [command, ...rest] = args;
  const image = command === "create" || command === "run" ? ["--prepared", "fake-starter"] : [];

  const child = Bun.spawn(["bun", main, command!, ...image, ...rest], {
    cwd: dir,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      BEACHSIDE_CONFIG: join(dir, "beachside.json"),
      BEACHSIDE_STATE_DIR: join(dir, "state"),
      BEACHSIDE_FAKE_URL: server.url.origin,
      BEACHSIDE_FAKE_TOKEN: token,
      BEACHSIDE_FAKE_HOMES: join(dir, "homes"),
      ...extraEnv,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { code, stdout, stderr };
}

function envelope(result: Result) {
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
}

/** The local folder standing in for the only sandbox's home. */
async function home(): Promise<string> {
  const homes = await readdir(join(dir, "homes"));

  expect(homes).toHaveLength(1);

  return join(dir, "homes", homes[0]!);
}

async function homeFile(name: string): Promise<string> {
  return readFile(join(await home(), name), "utf8");
}

async function record(name: string) {
  return JSON.parse(await readFile(join(dir, "state", "sandboxes", `${name}.json`), "utf8"));
}

async function storeNames(): Promise<string[]> {
  try {
    return (await readdir(join(dir, "state", "sandboxes"))).sort();
  } catch {
    return [];
  }
}

describe("setup on create", () => {
  test("named setups with extends, env and scripts run in order, then --setup-cmd", async () => {
    const created = await cli([
      "create",
      "--name",
      "web",
      "--setup",
      "tools",
      "--setup-cmd",
      "echo cmd >> log",
      "--json",
    ]);

    expect(created.code).toBe(0);
    expect(await homeFile("log")).toBe("base\ntools hi\nscript\ncmd\n");
    // Startup runs once at create too.
    expect(await homeFile("started")).toBe("up\n");

    const data = envelope(created).data;

    expect(data.setup).toMatchObject({ state: "ready", sources: ["tools", "cmd"] });
    expect(data.setup.steps.map((step: { status: string }) => step.status)).toEqual([
      "ran",
      "ran",
      "ran",
      "ran",
      "ran",
    ]);

    // The record keeps what was asked for, never the script bodies.
    const saved = await record("web");

    expect(saved.setup.request.setups).toEqual(["tools"]);
    expect(JSON.stringify(saved)).not.toContain("echo script");
  });

  test("human output shows each step on stderr and a summary line", async () => {
    const created = await cli(["create", "--name", "web", "--setup", "base"]);

    expect(created.code).toBe(0);
    expect(created.stderr).toContain("setup [1/1] echo base >> log");
    expect(created.stdout).toContain("setup     ready (base; 1 ran, 0 skipped)");
  });

  test("an unknown setup fails before anything is created", async () => {
    const result = await cli(["create", "--setup", "missing", "--json"]);

    expect(result.code).toBe(2);
    expect(envelope(result).error.message).toBe("Unknown setup missing");
    expect(await storeNames()).toEqual([]);
  });

  test("a setup's network must agree with --network", async () => {
    await writeConfig({ setups: { ...setups, web: { setup: ["true"], network: "internet" } } });

    const result = await cli(["create", "--setup", "web", "--network", "blocked", "--json"]);

    expect(result.code).toBe(2);
    expect(envelope(result).error.message).toBe("Setup web needs --network internet, not blocked");
    expect(await storeNames()).toEqual([]);
  });

  test("a failed step exits 9 and keeps the sandbox; setup reruns only what is missing", async () => {
    const failed = await cli(["create", "--name", "web", "--setup", "broken", "--json"]);

    expect(failed.code).toBe(9);
    expect(envelope(failed).error).toMatchObject({
      code: "SETUP_FAILED",
      known: { sandbox: "web" },
    });
    expect(envelope(failed).error.message).toContain("exit 4");
    expect((await record("web")).setup).toMatchObject({ state: "failed" });

    await writeFile(join(await home(), "fixed"), "");

    const rerun = await cli(["setup", "web", "--json"]);

    expect(rerun.code).toBe(0);
    // The first step already ran, so only the failed one runs again.
    expect(await homeFile("log")).toBe("one\n");
    expect(envelope(rerun).data.setup.steps.map((step: { status: string }) => step.status)).toEqual(
      ["skipped", "ran"],
    );

    const forced = await cli(["setup", "web", "--force", "--json"]);

    expect(forced.code).toBe(0);
    expect(await homeFile("log")).toBe("one\none\n");
  });

  test("--rm-on-failure removes the sandbox", async () => {
    const failed = await cli(["create", "--name", "web", "--setup", "broken", "--rm-on-failure"]);

    expect(failed.code).toBe(9);
    expect(failed.stderr).toContain("the sandbox was removed");
    expect(await storeNames()).toEqual([]);
  });

  test("profile defaults run first unless --no-default-setup", async () => {
    await writeConfig({
      profiles: { fake: { module: fixture, export: "localShell", setup: ["base"] } },
    });

    expect((await cli(["create", "--name", "one", "--setup-cmd", "echo cmd >> log"])).code).toBe(0);
    expect(await homeFile("log")).toBe("base\ncmd\n");

    await rm(join(dir, "homes"), { recursive: true });
    expect(
      (await cli(["create", "--name", "two", "--no-default-setup", "--setup-cmd", "echo x >> log"]))
        .code,
    ).toBe(0);
    expect(await homeFile("log")).toBe("x\n");
  });
});

describe("beachside setup", () => {
  test("adds to a sandbox's setup, skipping what it already has", async () => {
    expect((await cli(["create", "--name", "web", "--setup", "base"])).code).toBe(0);

    const added = await cli(["setup", "web", "--setup-cmd", "echo more >> log", "--json"]);

    expect(added.code).toBe(0);
    expect(await homeFile("log")).toBe("base\nmore\n");
    expect(envelope(added).data.setup).toMatchObject({ state: "ready", sources: ["base", "cmd"] });
  });

  test("a sandbox without setup needs flags", async () => {
    expect((await cli(["create", "--name", "web"])).code).toBe(0);

    const result = await cli(["setup", "web", "--json"]);

    expect(result.code).toBe(2);
    expect(envelope(result).error.message).toBe("web has no recorded setup");
  });

  test("ls lists the named setups", async () => {
    const listed = await cli(["setup", "ls", "--json"]);

    expect(listed.code).toBe(0);
    expect(envelope(listed).data.setups.map((entry: { name: string }) => entry.name)).toEqual([
      "base",
      "tools",
      "broken",
    ]);
    expect(envelope(listed).data.setups[1]).toMatchObject({
      extends: ["base"],
      setupSteps: 2,
      startupSteps: 1,
      env: [],
    });
  });
});

describe("setup on run", () => {
  test("setup runs before the command; a failure exits 125 and removes the sandbox", async () => {
    const ran = await cli(["run", "--setup-cmd", "echo made > made", "--", "cat", "made"]);

    expect(ran).toMatchObject({ code: 0, stdout: "made\n" });
    expect(await storeNames()).toEqual([]);

    const failed = await cli(["run", "--setup", "broken", "--", "true"]);

    expect(failed.code).toBe(125);
    expect(failed.stderr).toContain("the sandbox was removed");
    expect(await storeNames()).toEqual([]);
  });
});

describe("setup caches", () => {
  const deps = {
    setup: ["echo deps >> log", { run: "echo pull >> log", cache: false }],
    startup: ["echo up >> started"],
    cache: true,
  };

  async function useDeps(extra: Record<string, Json> = {}) {
    await writeConfig({ setups: { ...setups, deps, ...extra } });
  }

  async function homeOf(name: string): Promise<string> {
    return join(dir, "homes", (await record(name)).reference.nativeId);
  }

  async function caches() {
    return envelope(await cli(["setup", "cache", "ls", "--json"])).data.caches;
  }

  test("capture judged only on a sandbox is checked after setup", async () => {
    await useDeps();
    const env = { BEACHSIDE_FAKE_CAPTURE_NEEDS_SANDBOX: "1" };

    const built = await cli(["create", "--name", "one", "--setup", "deps", "--json"], env);

    expect(built.code).toBe(0);
    expect(envelope(built).data.setup.cache).toMatchObject({ status: "built" });

    const hit = await cli(["create", "--name", "two", "--setup", "deps", "--json"], env);

    expect(hit.code).toBe(0);
    expect(envelope(hit).data.setup.cache).toMatchObject({ status: "hit" });
  });

  test("a miss builds the cache after setup and before startup; a hit restores it", async () => {
    await useDeps();

    const built = await cli(["create", "--name", "one", "--setup", "deps", "--json"]);

    expect(built.code).toBe(0);
    expect(built.stderr).toContain("setup deps: building the cache");
    expect(envelope(built).data.setup.cache).toMatchObject({ status: "built" });
    expect(await readFile(join(await homeOf("one"), "started"), "utf8")).toBe("up\n");

    const [cache] = await caches();

    expect(cache).toMatchObject({ setup: "deps", status: "captured", stale: false });

    const hit = await cli(["create", "--name", "two", "--setup", "deps", "--json"]);

    expect(hit.code).toBe(0);
    expect(hit.stderr).toMatch(/setup deps: cache hit \(restored in \d+s; built \d+s ago/);
    expect(envelope(hit).data).toMatchObject({
      image: `snapshot:${cache.name}`,
      setup: { cache: { status: "hit", snapshot: cache.name } },
    });

    const two = await homeOf("two");

    // The cached step is skipped, the cache:false step runs again, and so does startup.
    expect(await readFile(join(two, "log"), "utf8")).toBe("deps\npull\npull\n");
    expect(await readFile(join(two, "started"), "utf8")).toBe("up\n");
  });

  test("--no-cache builds nothing; --refresh-cache replaces the cache", async () => {
    await useDeps();

    expect((await cli(["create", "--name", "plain", "--setup", "deps", "--no-cache"])).code).toBe(
      0,
    );
    expect(await caches()).toEqual([]);

    expect((await cli(["create", "--name", "one", "--setup", "deps"])).code).toBe(0);
    const [first] = await caches();

    const refreshed = await cli(["create", "--name", "two", "--setup", "deps", "--refresh-cache"]);

    expect(refreshed.code).toBe(0);
    expect(refreshed.stderr).toContain("setup deps: rebuilding the cache");

    const [second] = await caches();

    expect(second.name).toBe(first.name);
    expect(second.id).not.toBe(first.id);
    // The replaced snapshot is gone from the provider.
    expect((await cli(["snapshot", "ls", "--remote", "--json"])).stdout).not.toContain(first.id);
  });

  test("a stale cache is rebuilt by the next create; prune and rm delete caches", async () => {
    await useDeps({ quick: { setup: ["echo q >> log"], cache: { maxAge: "1s" } } });

    expect((await cli(["create", "--name", "one", "--setup", "quick"])).code).toBe(0);
    await Bun.sleep(1100);
    expect((await caches())[0]).toMatchObject({ stale: true });

    const dry = await cli(["setup", "cache", "prune", "--dry-run", "--json"]);

    expect(envelope(dry).data.caches).toMatchObject([{ setup: "quick", result: "would-delete" }]);

    const rebuilt = await cli(["create", "--name", "two", "--setup", "quick"]);

    expect(rebuilt.stderr).toContain("setup quick: rebuilding the cache");
    expect((await caches())[0]).toMatchObject({ stale: false });

    const removed = await cli(["setup", "cache", "rm", "quick", "--json"]);

    expect(envelope(removed).data.caches).toMatchObject([{ setup: "quick", result: "deleted" }]);
    expect(await caches()).toEqual([]);
  });

  test("a runner with an empty store finds the cache by its provider label", async () => {
    // The fake dates its snapshots from a counter, so keep them fresh for this test.
    await writeConfig({ setups: { deps: { ...deps, cache: { maxAge: "36500d" } } } });
    expect((await cli(["create", "--name", "one", "--setup", "deps"])).code).toBe(0);
    await rm(join(dir, "state", "snapshots"), { recursive: true });

    const hit = await cli(["create", "--name", "two", "--setup", "deps", "--json"]);

    expect(hit.code).toBe(0);
    expect(hit.stderr).toContain("setup cache: found");
    expect(envelope(hit).data.setup.cache).toMatchObject({ status: "hit" });
  });

  test("cache.files are part of the key", async () => {
    await writeFile(join(dir, "lock"), "v1");
    await useDeps({ locked: { setup: ["echo l >> log"], cache: { files: ["./lock"] } } });

    expect((await cli(["create", "--name", "one", "--setup", "locked"])).code).toBe(0);
    await writeFile(join(dir, "lock"), "v2");

    const changed = await cli(["create", "--name", "two", "--setup", "locked"]);

    expect(changed.stderr).toContain("setup locked: building the cache");
    expect(await caches()).toHaveLength(2);
  });

  test("refusals come before anything is created", async () => {
    await useDeps({
      secretive: { setup: ["true"], env: { TOKEN: "env:TOKEN" }, cache: true },
    });

    const secret = await cli(["create", "--setup", "secretive", "--json"], { TOKEN: "t" });

    expect(secret.code).toBe(2);
    expect(envelope(secret).error.message).toContain("would be cached with TOKEN from env");
    expect(await storeNames()).toEqual([]);

    await useDeps({
      secretive: { setup: ["true"], env: { TOKEN: "env:TOKEN" }, cache: { secrets: "allow" } },
    });
    expect((await cli(["create", "--setup", "secretive"], { TOKEN: "t" })).code).toBe(0);
    await rm(join(dir, "state"), { recursive: true });

    const empty = await cli(["create", "--cache", "--json"]);

    expect(envelope(empty).error.message).toBe("A setup cache needs setup steps");

    // The plain fake cannot snapshot.
    await writeConfig({
      profiles: { fake: { module: fixture, export: "fake" } },
      setups: { deps },
    });

    const unsupported = await cli(["create", "--setup", "deps", "--json"]);

    expect(unsupported.code).toBe(4);
    expect(envelope(unsupported).error.hint).toContain("--no-cache");
    expect(await storeNames()).toEqual([]);
  });
});

describe("project setups and parallel steps", () => {
  async function projectFile(content: Json) {
    await mkdir(join(dir, ".git"), { recursive: true });
    await mkdir(join(dir, ".beachside"), { recursive: true });
    await writeFile(join(dir, ".beachside", "setup.json"), JSON.stringify(content));
  }

  test("a project file is read only when project setups are on", async () => {
    await projectFile({
      setups: { app: { setup: ["./tools.sh", "echo app >> log"] } },
      default: ["app"],
    });

    const off = await cli(["create", "--name", "off", "--setup", "app", "--json"]);

    expect(off.code).toBe(2);
    expect(envelope(off).error.hint).toContain("projectSetups");

    await writeConfig({ projectSetups: true });

    // The project's default runs without --setup; its script path is relative to the checkout.
    expect((await cli(["create", "--name", "on"])).code).toBe(0);
    expect(await homeFile("log")).toBe("script\napp\n");

    const listed = envelope(await cli(["setup", "ls", "--json"])).data.setups;

    expect(listed.find((entry: { name: string }) => entry.name === "app")).toMatchObject({
      default: true,
      origin: join(dir, ".beachside", "setup.json"),
    });
  });

  test("a project setup cannot shadow one from beachside.json", async () => {
    await projectFile({ setups: { base: { setup: ["true"] } } });
    await writeConfig({ projectSetups: true });

    const clash = await cli(["create", "--setup", "base", "--json"]);

    expect(clash.code).toBe(2);
    expect(envelope(clash).error.message).toContain("is defined in both");
  });

  test("parallel steps in beachside.json run as one recorded step", async () => {
    await writeConfig({
      setups: {
        ...setups,
        both: {
          setup: [{ parallel: ["echo a > a", "./tools.sh"], name: "fetch" }, "cat a >> log"],
        },
      },
    });

    const created = await cli(["create", "--name", "web", "--setup", "both", "--json"]);

    expect(created.code).toBe(0);
    expect(await homeFile("log")).toBe("script\na\n");
    expect(envelope(created).data.setup.steps.map((step: { name: string }) => step.name)).toEqual([
      "fetch",
      "cat a >> log",
    ]);
  });
});
