import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bindAdapter } from "@beachside/adapter";
import { createFakeAdapter } from "@beachside-internal/provider-fake";
import { startFakeProviderServer } from "@beachside-internal/provider-fake/server";
import { Beachside, Image } from "beachside";
import { bashOperations, createBeachsideTools } from "../src/tools";

test("Pi's seven tools use one sandbox and preserve Pi results", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beachside-pi-tools-"));
  const token = "fake-pi-tools-token";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(dir, "state.json"),
    token,
    testMode: true,
  });

  const url = `http://127.0.0.1:${server.port}`;

  const client = await Beachside.connect(
    bindAdapter(createFakeAdapter({ url, token, processes: {} }), {}, {}),
  );

  const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
  const tools = createBeachsideTools(box, "/work");
  // SAFETY: These factory operations do not need extension context fields.
  const context = { cwd: "/host/project" } as Parameters<typeof tools.read.execute>[4];

  async function seed(script: string, stdout = "", exitCode = 0, cwd?: string) {
    const response = await fetch(`${url}/_test/seed`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        submissionId: "*",
        action: "exec",
        command: {
          command: { kind: "shell", script },
          exitCode,
          cwd,
          stdoutBase64: Buffer.from(stdout).toString("base64"),
        },
      }),
    });

    expect(response.ok).toBe(true);
  }

  try {
    await seed("mkdir -p -- '/work'");
    await tools.write.execute(
      "write",
      { path: "main.ts", content: "export const value = 1;\n" },
      undefined,
      undefined,
      context,
    );

    await seed("test -e '/work/main.ts' || test -L '/work/main.ts'");

    const read = await tools.read.execute(
      "read",
      { path: "main.ts" },
      undefined,
      undefined,
      context,
    );

    expect(read.content).toEqual([{ type: "text", text: "export const value = 1;\n" }]);

    await seed("test -e '/work/main.ts' || test -L '/work/main.ts'");

    const edit = await tools.edit.execute(
      "edit",
      { path: "main.ts", edits: [{ oldText: "value = 1", newText: "value = 2" }] },
      undefined,
      undefined,
      context,
    );

    expect(edit.details?.diff).toContain("value = 2");
    expect(await box.readTextFile("/work/main.ts")).toBe("export const value = 2;\n");

    await seed("test -e '/work' || test -L '/work'");
    await seed("if test -d '/work'; then printf yes; fi", "yes");
    await seed("find . -mindepth 1 -maxdepth 1 -print0", "./main.ts\0", 0, "/work");
    await seed("if test -d '/work/main.ts'; then printf yes; fi");

    const ls = await tools.ls.execute("ls", {}, undefined, undefined, context);
    expect(ls.content).toEqual([{ type: "text", text: "main.ts" }]);

    await seed("test -e '/work' || test -L '/work'");
    await seed(
      "find . \\( -name .git -o -name node_modules \\) -prune -o -type f -print0",
      "./main.ts\0./hello.js\0",
      0,
      "/work",
    );

    const find = await tools.find.execute(
      "find",
      { pattern: "*.ts" },
      undefined,
      undefined,
      context,
    );

    expect(find.content).toEqual([{ type: "text", text: "main.ts" }]);

    await seed(
      [
        "if command -v rg >/dev/null 2>&1; then",
        "'rg' '--no-config' '--hidden' '--color=never' '-nH' '--' 'value' '/work'",
        "else",
        "'grep' '-rEnH' '--' 'value' '/work'",
        "fi",
      ].join("\n"),
      "/work/main.ts:1:export const value = 2;\n",
      0,
      "/work",
    );

    const grep = await tools.grep.execute(
      "grep",
      { pattern: "value" },
      undefined,
      undefined,
      context,
    );

    expect(grep.content).toEqual([{ type: "text", text: "main.ts:1:export const value = 2;" }]);

    await seed("exec bash -c 'echo guest'", "guest\n", 0, "/work");

    const bash = await tools.bash.execute(
      "bash",
      { command: "echo guest" },
      undefined,
      undefined,
      context,
    );

    expect(bash.content).toEqual([{ type: "text", text: "guest\n" }]);
  } finally {
    await client.close();
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});

test("an ambiguous finite Bash submission reports the sandbox ID without replaying", async () => {
  const dir = await mkdtemp(join(tmpdir(), "beachside-pi-unknown-"));
  const token = "fake-pi-unknown-token";

  const server = await startFakeProviderServer({
    hostname: "127.0.0.1",
    port: 0,
    statePath: join(dir, "state.json"),
    token,
    testMode: true,
  });

  const url = `http://127.0.0.1:${server.port}`;
  const client = await Beachside.connect(bindAdapter(createFakeAdapter({ url, token }), {}, {}));

  try {
    const box = await client.sandboxes.create({ environment: Image.prepared("fake-starter") });
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

    const seeded = await fetch(`${url}/_test/seed`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        submissionId: "*",
        action: "exec",
        behavior: "ambiguous_before_effect",
      }),
    });

    expect(seeded.ok).toBe(true);
    await expect(
      bashOperations(box, "/work").exec("echo once", "/work", { onData: () => {} }),
    ).rejects.toThrow(box.id);
    const response = await fetch(`${url}/_test/state`, { headers });
    // SAFETY: The local fixture endpoint supplies the invocation ledger.
    const state = (await response.json()) as { invocations: { action: string }[] };
    expect(state.invocations.filter((item) => item.action === "exec")).toHaveLength(1);
  } finally {
    await client.close();
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
  }
});
