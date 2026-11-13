import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { main } from "../src/cli";
import { meter, notification, programStatus, sequence } from "../src/program-status";

const token = "local-test-token-12345";

const esc = String.fromCharCode(27);

const report = new RegExp(
  `${esc}\\]7501;state=([a-z]+):id=beachside:app=beachside(?::progress=(\\d+))?:msg=([^${esc}]*)${esc}\\\\`,
  "g",
);

const notice = new RegExp(`${esc}\\]777;notify;([^;${esc}]*);([^${esc}]*)${esc}\\\\`, "g");

/** Each desktop notification as title and body. */
function notices(stderr: string): { title: string; body: string }[] {
  return Array.from(stderr.matchAll(notice), ([, title, body]) => ({ title: title!, body: body! }));
}

type Report = { state: string; msg: string; progress?: number };

/** Each report as `state` plus its decoded message. */
function reports(stderr: string): Report[] {
  const matches = stderr.matchAll(report);

  return Array.from(matches, ([, state, progress, msg]) => {
    const parsed: Report = {
      state: state!,
      msg: Buffer.from(msg!, "base64").toString("utf8"),
    };

    if (progress !== undefined) parsed.progress = Number(progress);

    return parsed;
  });
}

describe("program status sequences", () => {
  test("encode one base64 line with the beachside record id", () => {
    expect(sequence("working", "beachside exec web")).toBe(
      `\x1b]7501;state=working:id=beachside:app=beachside:msg=${Buffer.from("beachside exec web").toString("base64")}\x1b\\`,
    );
  });

  test("replace control characters, which would make a terminal drop the report", () => {
    expect(reports(sequence("error", "bad\nthing\x1b[31m\u0085"))).toEqual([
      { state: "error", msg: "bad thing [31m" },
    ]);
  });

  test("cut long messages on a code point boundary", () => {
    const [report] = reports(sequence("done", "é".repeat(400)));

    expect(Buffer.byteLength(report!.msg)).toBe(512);
    expect(report!.msg).toBe("é".repeat(256));
  });

  test("add a whole percentage to working reports only", () => {
    expect(reports(sequence("working", "copy", 42.7))).toEqual([
      { state: "working", msg: "copy", progress: 42 },
    ]);
    expect(reports(sequence("working", "copy", 250))[0]!.progress).toBe(100);
    expect(reports(sequence("done", "copy", 50))[0]!.progress).toBeUndefined();
  });

  test("notifications drop separators and control characters", () => {
    expect(notices(notification("beachside: done", "run;web\nok"))).toEqual([
      { title: "beachside: done", body: "run web ok" },
    ]);
  });

  test("the meter reports each new percentage and stops short of 100", () => {
    const seen: (number | undefined)[] = [];

    const status = {
      report: (_s: string, _m: string, p?: number) => seen.push(p),
      notify: () => {},
    };

    const tick = meter(status, "copy", 200);

    tick(1);
    tick(1);
    tick(98);
    tick(500);
    expect(seen).toEqual([0, 1, 50, 99]);
  });

  test("report inside Rex or when forced, and only to a terminal", () => {
    const written: string[] = [];
    const write = (text: string) => written.push(text);

    programStatus({}, true, write).report("working", "a");
    programStatus({ REX_SESSION: "s1", BEACHSIDE_PROGRAM_STATUS: "off" }, true, write).report(
      "working",
      "b",
    );
    programStatus({ REX_SESSION: "s1" }, false, write).report("working", "c");
    programStatus({ BEACHSIDE_PROGRAM_STATUS: "on" }, false, write).report("working", "d");
    expect(written).toEqual([]);

    programStatus({ REX_SESSION: "s1" }, true, write).report("working", "e");
    programStatus({ BEACHSIDE_PROGRAM_STATUS: "ON" }, true, write).report("done", "f");
    expect(written.map((text) => reports(text)[0]!.msg)).toEqual(["e", "f"]);
  });
});

describe("program status from CLI commands", () => {
  let root: string;
  let server: Awaited<ReturnType<typeof startFakeProviderServer>>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "beachside-status-"));
    server = await startFakeProviderServer({
      hostname: "127.0.0.1",
      port: 0,
      statePath: join(root, "fake.json"),
      token,
      testMode: true,
    });
    // The fixture adapter reads these when the CLI imports it in this process.
    process.env.BEACHSIDE_FAKE_URL = server.url.origin;
    process.env.BEACHSIDE_FAKE_TOKEN = token;
    await writeFile(
      join(root, "beachside.json"),
      JSON.stringify({
        default: "fake",
        profiles: { fake: { module: join(import.meta.dir, "fake-adapter.ts"), export: "fake" } },
      }),
    );
  });

  afterAll(async () => {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  });

  async function run(args: string[], terminal: boolean, extra: Record<string, string> = {}) {
    let stdout = "";
    let stderr = "";

    const text = (chunk: string | Uint8Array) =>
      chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : chunk;

    const code = await main(args, {
      env: {
        BEACHSIDE_TELEMETRY: "0",
        HOME: root,
        BEACHSIDE_CONFIG: join(root, "beachside.json"),
        BEACHSIDE_STATE_DIR: join(root, "state"),
        REX_SESSION: "session:1",
        ...extra,
      },
      cwd: root,
      signal: new AbortController().signal,
      stdin: async function* () {},
      stderrTerminal: terminal,
      streams: {
        stdout: (chunk) => (stdout += text(chunk)),
        stderr: (chunk) => (stderr += text(chunk)),
      },
    });

    return { code, stdout, stderr };
  }

  test("create reports working then done, and stdout stays clean with --json", async () => {
    const result = await run(
      ["create", "--name", "web", "--prepared", "fake-starter", "--json"],
      true,
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).ok).toBe(true);
    expect(reports(result.stderr)).toEqual([
      { state: "working", msg: "beachside create web" },
      { state: "done", msg: "beachside create web: done" },
    ]);
  });

  test("failures report error with the CLI message", async () => {
    const result = await run(["exec", "missing", "--", "true"], true);

    expect(result.code).toBe(125);
    expect(reports(result.stderr).map((report) => report.state)).toEqual(["working", "error"]);
    expect(reports(result.stderr)[1]!.msg).toStartWith("beachside exec missing: ");
  });

  test("cp of a file reports progress before done", async () => {
    await writeFile(join(root, "data.bin"), new Uint8Array(4096));
    const result = await run(["cp", "data.bin", "web:/tmp/data.bin"], true);

    expect(result.code).toBe(0);
    const states = reports(result.stderr);

    expect(states[0]).toEqual({ state: "working", msg: "beachside cp data.bin" });
    expect(states.some((state) => state.progress !== undefined)).toBe(true);
    expect(states.at(-1)!.state).toBe("done");
  });

  test("a finished exec notifies once it ran longer than BEACHSIDE_NOTIFY_AFTER", async () => {
    const quick = await run(["exec", "web", "--", "true"], true);

    expect(notices(quick.stderr)).toEqual([]);

    const long = await run(["exec", "web", "--", "true"], true, { BEACHSIDE_NOTIFY_AFTER: "0" });

    // The fake provider has no exec, so the command fails; a failure notifies too.
    const [sent, ...more] = notices(long.stderr);

    expect(more).toEqual([]);
    expect(sent!.title).toBe("beachside: failed");
    expect(sent!.body).toStartWith("beachside exec web: ");
    expect(
      notices(
        (await run(["exec", "web", "--", "true"], true, { BEACHSIDE_NOTIFY_AFTER: "off" })).stderr,
      ),
    ).toEqual([]);
  });

  test("quick reads, piped stderr and the off switch stay silent", async () => {
    expect((await run(["ls"], true)).stderr).not.toContain("\x1b]7501");
    expect((await run(["rm", "web"], false)).stderr).not.toContain("\x1b]7501");
    expect(
      (await run(["gc", "--label", "a=b", "--dry-run"], true, { BEACHSIDE_PROGRAM_STATUS: "off" }))
        .stderr,
    ).not.toContain("\x1b]7501");
  });
});
