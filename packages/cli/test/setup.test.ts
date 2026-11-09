import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

async function cli(args: string[]): Promise<Result> {
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
