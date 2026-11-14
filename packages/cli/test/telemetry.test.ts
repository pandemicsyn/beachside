import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import type { Env } from "../src/config";
import {
  CommandEvent,
  deliver,
  eventProperties,
  project,
  record,
  telemetryStatus,
  type CommandEvent as Event,
} from "../src/telemetry";

const root = await mkdtemp(join(tmpdir(), "beachside-telemetry-"));

let home: string;

let env: Env;

beforeEach(async () => {
  home = await mkdtemp(join(root, "home-"));
  env = { HOME: home, XDG_CONFIG_HOME: home, PATH: process.env.PATH ?? "" };
});

afterAll(() => rm(root, { recursive: true, force: true }));

function event(overrides: Partial<Parameters<typeof eventProperties>[0]> = {}): Event {
  return eventProperties({
    command: "exec",
    providers: ["boxd"],
    code: 0,
    remote: true,
    interrupted: false,
    duration: 200,
    env,
    terminal: false,
    ...overrides,
  })!;
}

async function invoke(
  args: string[],
  overrides: Readonly<Record<string, string | undefined>> = {},
  terminal = false,
) {
  const events: { id: string; event: Event }[] = [];
  let stdout = "";
  let stderr = "";

  const code = await main(args, {
    env: { ...env, ...overrides },
    cwd: home,
    signal: new AbortController().signal,
    stderrTerminal: terminal,
    stdin: async function* () {},
    streams: {
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
    telemetryDelivery: async (id, event) => {
      events.push({ id, event });
    },
  });

  return { code, stdout, stderr, events };
}

test("default on locally; CI needs explicit enablement; off switches win", async () => {
  expect((await telemetryStatus(env)).enabled).toBe(true);

  for (const setting of [
    { CI: "true" },
    { GITHUB_ACTIONS: "true" },
    { BEACHSIDE_TELEMETRY: "0" },
    { DO_NOT_TRACK: "1", BEACHSIDE_TELEMETRY: "1" },
  ]) {
    expect((await telemetryStatus({ ...env, ...setting })).enabled).toBe(false);
  }

  expect((await telemetryStatus({ ...env, CI: "true", BEACHSIDE_TELEMETRY: "1" })).enabled).toBe(
    true,
  );
  expect((await telemetryStatus({ ...env, CI: "false" })).enabled).toBe(true);
});

test("persistent controls work without sending analytics or creating an ID", async () => {
  expect((await invoke(["telemetry", "disable", "--json"])).events).toEqual([]);
  expect((await telemetryStatus(env)).enabled).toBe(false);
  expect(await readdir(join(home, "beachside"))).toEqual(["telemetry.json"]);
  expect((await invoke(["ls", "--offline", "--json"])).events).toEqual([]);
  const status = await invoke(["telemetry", "status", "--json"]);
  expect(JSON.parse(status.stdout).data.enabled).toBe(false);
  expect((await invoke(["telemetry", "enable"], {}, true)).events).toEqual([]);
  expect((await telemetryStatus(env)).enabled).toBe(true);
  expect((await telemetryStatus({ ...env, BEACHSIDE_TELEMETRY: "0" })).enabled).toBe(false);
});

test("unreadable or malformed preferences fail closed", async () => {
  await invoke(["telemetry", "disable"]);
  await writeFile(join(home, "beachside", "telemetry.json"), "broken");
  expect((await telemetryStatus(env)).enabled).toBe(false);
});

test("disabled and CI runs do not send, create IDs, or print notices", async () => {
  for (const disabled of [{ BEACHSIDE_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }, { CI: "true" }]) {
    const result = await invoke(["ls", "--offline", "--json"], disabled, true);
    expect(result.code).toBe(0);
    expect(result.events).toEqual([]);
    expect(result.stderr).toBe("");
  }

  expect((await readdir(home)).includes("beachside")).toBe(false);
});

test("dispatcher emits one event and a one-time terminal notice; JSON stays clean", async () => {
  const first = await invoke(["ls", "--offline", "--json"], {}, true);
  const second = await invoke(["ls", "--offline", "--json"], {}, true);
  expect(first.code).toBe(0);
  expect(first.events).toHaveLength(1);
  expect(first.events[0]!.event.command).toBe("ls");
  expect(first.events[0]!.event.result).toBe("success");
  expect(first.events[0]!.id).toBe(second.events[0]!.id);
  expect(first.stderr).toContain("telemetry disable");
  expect(second.stderr).toBe("");
  expect(JSON.parse(first.stdout).ok).toBe(true);
});

test("help, version, schema, completion and telemetry commands are never tracked", async () => {
  for (const args of [
    ["--help"],
    ["--version"],
    ["schema"],
    ["help", "exec"],
    ["exec", "--help"],
    ["completion", "zsh"],
    ["__complete", "--", ""],
    ["telemetry", "status"],
  ]) {
    expect((await invoke(args)).events).toEqual([]);
  }

  expect(await readdir(home)).toEqual([]);
});

test("failures contain only fixed codes, never credential or argument content", async () => {
  const result = await invoke([
    "exec",
    "sensitive-sandbox",
    "--provider",
    "sensitive-provider",
    "--",
    "echo",
    "super-secret",
  ]);

  expect(result.code).toBe(125);
  expect(result.events).toHaveLength(1);
  expect(result.events[0]!.event.error_code).toBe("NOT_FOUND");
  expect(result.events[0]!.event.failure_kind).toBe("cli");
  expect(JSON.stringify(result.events)).not.toContain("sensitive");
  expect(JSON.stringify(result.events)).not.toContain("super-secret");
});

test("schema rejects extra data, masks unknown codes/providers, and separates remote exits", () => {
  expect(CommandEvent.safeParse({ ...event(), argv: ["secret"] }).success).toBe(false);
  expect(event({ providers: ["/private/adapter"] }).provider).toBeUndefined();
  expect(event({ providers: ["boxd", "e2b"] }).provider).toBeUndefined();
  expect(event({ error: "secret-error", code: 125 }).error_code).toBe("INTERNAL");
  expect(event({ code: 1 }).failure_kind).toBe("remote_program");
  expect(event({ code: 1, interrupted: true }).result).toBe("interrupted");
  expect(event({ duration: 4000 }).duration_bucket).toBe("1–5s");
});

test("transport failure does not affect command behavior", async () => {
  await expect(
    record(
      env,
      false,
      () => {},
      event(),
      async () => {
        throw new Error("offline");
      },
    ),
  ).resolves.toBeUndefined();
});

test("PostHog capture request uses only the intended event and disables GeoIP/person profiles", async () => {
  const batches: unknown[] = [];
  const original = { ...project };

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      batches.push(await request.json());

      return Response.json({ status: 1 });
    },
  });

  try {
    project.key = "phc_local_test";
    project.host = server.url.origin;
    await deliver("a40f28fe-1e34-42ec-9207-b95be0548062", event());
    const text = JSON.stringify(batches);
    expect(text).toContain("cli_command_completed");
    expect(text).toContain('"$process_person_profile":false');
    expect(text).toContain('"$geoip_disable":true');
    expect(text).not.toContain(home);
    expect(batches).toHaveLength(1);
  } finally {
    Object.assign(project, original);
    server.stop(true);
  }
});

test("product telemetry dependency is confined to the CLI package", async () => {
  const sdk = JSON.parse(
    await readFile(new URL("../../sdk/package.json", import.meta.url), "utf8"),
  );

  const adapter = JSON.parse(
    await readFile(new URL("../../adapter/package.json", import.meta.url), "utf8"),
  );

  for (const pkg of [sdk, adapter]) {
    expect(
      JSON.stringify({
        dependencies: pkg.dependencies,
        optionalDependencies: pkg.optionalDependencies,
      }),
    ).not.toMatch(/posthog|@beachside\/cli/);
  }

  const sdkBundle = await readFile(new URL("../../sdk/dist/index.js", import.meta.url), "utf8");
  expect(sdkBundle).not.toMatch(/posthog|cli_command_completed|us\.i\.posthog\.com/);
});

test("capture failures and a stalled endpoint remain quiet and bounded", async () => {
  const original = { ...project };
  let stalled = false;

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      if (stalled) return new Promise<Response>(() => {});

      return new Response("rejected", { status: 500 });
    },
  });

  try {
    project.key = "phc_local_test";
    project.host = server.url.origin;
    await expect(deliver("a40f28fe-1e34-42ec-9207-b95be0548062", event())).resolves.toBeUndefined();
    stalled = true;
    const started = Date.now();
    await expect(deliver("a40f28fe-1e34-42ec-9207-b95be0548062", event())).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(1000);
  } finally {
    Object.assign(project, original);
    server.stop(true);
  }
});
