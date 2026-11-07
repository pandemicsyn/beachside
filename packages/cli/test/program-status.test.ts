import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { main } from "../src/cli";
import { programStatus, sequence } from "../src/program-status";

const token = "local-test-token-12345";

const esc = String.fromCharCode(27);

const report = new RegExp(
  `${esc}\\]7501;state=([a-z]+):id=beachside:app=beachside:msg=([^${esc}]*)${esc}\\\\`,
  "g",
);

/** Each report as `state` plus its decoded message. */
function reports(stderr: string): { state: string; msg: string }[] {
  const matches = stderr.matchAll(report);

  return Array.from(matches, ([, state, msg]) => ({
    state: state!,
    msg: Buffer.from(msg!, "base64").toString("utf8"),
  }));
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
        HOME: root,
        BEACHSIDE_CONFIG: join(root, "beachside.json"),
        BEACHSIDE_STATE_DIR: join(root, "state"),
        REX_SESSION: "session:1",
        ...extra,
      },
      cwd: root,
      signal: new AbortController().signal,
      readStdin: async () => new Uint8Array(),
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

  test("quick reads, piped stderr and the off switch stay silent", async () => {
    expect((await run(["ls"], true)).stderr).not.toContain("\x1b]7501");
    expect((await run(["rm", "web"], false)).stderr).not.toContain("\x1b]7501");
    expect(
      (await run(["gc", "--label", "a=b", "--dry-run"], true, { BEACHSIDE_PROGRAM_STATUS: "off" }))
        .stderr,
    ).not.toContain("\x1b]7501");
  });
});
