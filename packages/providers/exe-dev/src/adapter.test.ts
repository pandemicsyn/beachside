import { afterEach, expect, test } from "bun:test";
import { adapterSuite } from "@beachside/adapter/testing";
import { Beachside, NonzeroExitError, OutcomeUnknownError } from "beachside";
import type { z } from "zod";
import { createExeDevAdapter } from "./adapter";
import { exeDevFixture, linuxGuest } from "./fixture.test-support";
import { openSshKey } from "./keys.test-support";

const fixtures: ReturnType<typeof exeDevFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = exeDevFixture();
  fixtures.push(fixture);

  const adapter = createExeDevAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
    processPollMs: 5,
  });

  const connect = (
    config: Partial<z.input<typeof adapter.config>> = {},
    credentials: z.input<typeof adapter.credentials> = { token: "exe1.fixture-main" },
  ) => Beachside.connect({ adapter, config: { network: "internet", ...config }, credentials });

  return { fixture, adapter, connect };
}

const created = (fixture: ReturnType<typeof exeDevFixture>) => fixture.commands("new");

test("exe.dev conformance: one native attempt, distinct accounts, lost and late responses", async () => {
  const { fixture, adapter } = setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { network: "internet" },
      credentials: { token: "exe1.fixture-main" },
      alternate: { config: { network: "internet" }, credentials: { token: "exe1.fixture-alt" } },
      createInput: { image: { kind: "oci", value: "exeuntu" }, networkPolicy: "internet" },
      counters: () => ({
        create: fixture.effects.create,
        destroy: fixture.effects.destroy,
        release: fixture.effects.release,
      }),
      expectedReleasesPerConnection: 0,
      loseNextCreateResponse: fixture.loseNextCreateResponse,
      holdNextCreateResponse: fixture.holdNextCreateResponse,
      releaseHeldCreateResponse: fixture.releaseHeldCreateResponse,
      assertNativeRetriesDisabled() {
        expect(created(fixture)).toHaveLength(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
  expect(created(fixture)).toHaveLength(3);
});

test("network defaults to internet, and blocked rejects before any exe.dev call", async () => {
  const { fixture, adapter } = setup();

  await expect(
    Beachside.connect({
      adapter,
      // Untyped on purpose: JavaScript callers can pass any value.
      config: JSON.parse('{"network":"blocked"}'),
      credentials: { token: "exe1.fixture-main" },
    }),
  ).rejects.toThrow();
  expect(fixture.calls).toHaveLength(0);

  const client = await Beachside.connect({
    adapter,
    config: {},
    credentials: { token: "exe1.fixture-main" },
  });

  try {
    expect((await client.capabilities()).network).toEqual(["internet"]);
  } finally {
    await client.close();
  }
});

test("credentials need a token or an SSH key", async () => {
  const { fixture, connect } = setup();

  await expect(connect({}, {})).rejects.toThrow(/credentials/);
  await expect(connect({}, { token: "nope" })).rejects.toThrow(/credentials/);
  await expect(connect({}, { sshKey: "not a key" })).rejects.toThrow(/OpenSSH Ed25519/);
  expect(fixture.calls).toHaveLength(0);
});

test("an SSH key alone signs short-lived account tokens limited to the adapter's commands", async () => {
  const { fixture, connect } = setup();
  const client = await connect({}, { sshKey: openSshKey() });

  try {
    await client.sandboxes.create();
    const token = fixture.calls[0]?.token ?? "";
    expect(token.startsWith("exe0.")).toBe(true);
    const permissions = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString());
    expect(permissions.cmds).toContain("new");
    expect(permissions.cmds).not.toContain("ssh-key add");
    expect(permissions.exp * 1000).toBeGreaterThan(Date.now());
    expect(new Set(fixture.calls.map((call) => call.token)).size).toBe(1);
  } finally {
    await client.close();
  }
});

test("create sends one tagged, quiet `new` with image, size, placement and labels", async () => {
  const { fixture, connect } = setup();

  const client = await connect({
    image: "ubuntu:24.04",
    resources: { vcpus: 3, memoryMiB: 4096 },
    placement: "standalone",
  });

  try {
    const box = await client.sandboxes.create({ labels: { team: "core" } });
    const [call] = created(fixture);
    expect(call?.words).toEqual(
      expect.arrayContaining([
        "--tag=beachside",
        "--no-email",
        "--standalone",
        "--image=ubuntu:24.04",
        "--cpu=4",
        "--memory=8GB",
        "--comment=beachside: team=core",
      ]),
    );
    expect(call?.words.find((word) => word.startsWith("--name="))).toMatch(
      /^--name=bs-[0-9a-f]{24}$/,
    );
    expect(box.id).toMatch(/^bs-/);
    expect(fixture.vms.get(box.id)?.placement).toBe("standalone");
    expect(await box.inspect()).toMatchObject({
      state: "running",
      expires: { status: "none" },
      resources: { status: "known", value: { vcpus: 4, memoryMiB: 8192 } },
    });
  } finally {
    await client.close();
  }
});

test("the default image and placement send no image or placement flags; pools are named", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await client.sandboxes.create();
    expect(created(fixture)[0]?.words.some((word) => /^--(image|standalone|pool)/.test(word))).toBe(
      false,
    );
  } finally {
    await client.close();
  }

  const pooled = await connect({ placement: { pool: "build" } });

  try {
    await pooled.sandboxes.create();
    expect(created(fixture)[1]?.words).toContain("--pool=build");
  } finally {
    await pooled.close();
  }
});

test("labels that overflow the 200-byte comment reject before any create", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await expect(client.sandboxes.create({ labels: { long: "x".repeat(220) } })).rejects.toThrow(
      /200 bytes/,
    );
    expect(created(fixture)).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("a slow boot finishes through observation", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.setBootPolls(1_000_000);
    const submitted = await client.sandboxes.submitCreate();
    expect(await submitted.observe()).toBeNull();

    for (const vm of fixture.vms.values()) vm.status = "running";
    const box = await submitted.observe();
    expect(box?.id).toMatch(/^bs-/);
    expect(created(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a lost create is found again by its name without a second `new`", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate();
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);

    const recovered = await (await client.recover(lost.reference)).observe();
    expect(recovered).toMatchObject({ reference: { nativeId: [...fixture.vms.keys()][0] } });
    expect(created(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("create refusals reject cleanly; 5xx stays unknown and is never resent", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.failNextCreate(fixture.error(400, "image not found"));
    await expect(client.sandboxes.create()).rejects.toThrow(/image not found/);

    // exe.dev answers 422 for a command that ran and failed, so it proves no absence of effect.
    fixture.failNextCreate(fixture.error(422, "command failed"));
    await expect(client.sandboxes.create()).rejects.toBeInstanceOf(OutcomeUnknownError);

    fixture.failNextCreate(fixture.error(502, "bad gateway"));
    const submitted = await client.sandboxes.submitCreate();
    await expect(submitted.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(created(fixture)).toHaveLength(3);
  } finally {
    await client.close();
  }
});

test("a VM that runs but never accepts a command is handed back as unknown, not left pending", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    // A token without the `ssh` permission: exe.dev runs the VM but refuses every command.
    fixture.overrideCommands(() => ({ exit: 255 }));

    const failed = await client.sandboxes.create().then(
      () => undefined,
      (error: Error) => error,
    );

    if (!(failed instanceof OutcomeUnknownError)) throw failed ?? Error("Expected unknown");
    expect(failed.message).toMatch(/allows `ssh`/);
    expect(created(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("destroy confirms only a VM exe.dev lists as deleted; not_found may be a hidden VM", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.hideNextRm();
    await expect(box.destroy()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.effects.destroy).toBe(0);
  } finally {
    await client.close();
  }
});

linuxGuest("exec keeps argv, cwd, env, stdin and non-UTF-8 output bytes", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { GREETING: "hi", SHARED: "box" } });
    await box.makeDirectory("/tmp/exe dev", { recursive: true });

    const result = await box.exec({
      command: {
        kind: "argv",
        argv: [
          "/bin/sh",
          "-c",
          'printf "%s|%s|%s|" "$GREETING" "$SHARED" "$1"; pwd; cat; printf "\\377" >&2',
          "sh",
          "it's $x",
        ],
      },
      cwd: "/tmp/exe dev",
      env: { SHARED: "call" },
      stdin: new TextEncoder().encode("from stdin"),
    });

    expect(new TextDecoder().decode(result.stdout)).toBe(
      "hi|call|it's $x|/tmp/exe dev\nfrom stdin",
    );
    expect([...result.stderr]).toEqual([255]);

    const failed = await box.exec({ command: { kind: "shell", script: "exit 7" } }).then(
      () => undefined,
      (error: Error) => error,
    );

    if (!(failed instanceof NonzeroExitError)) throw failed ?? Error("Expected exit 7");
    expect(failed.result.exitCode).toBe(7);
  } finally {
    await client.close();
  }
});

linuxGuest("exec output is bounded across both streams, stdout first", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const result = await box.exec({
      command: { kind: "shell", script: "head -c 3000 /dev/zero; head -c 3000 /dev/zero >&2" },
      maxOutputBytes: 4096,
    });

    expect(result.stdout.byteLength).toBe(3000);
    expect(result.stderr.byteLength).toBe(1096);
    expect(result.truncated).toBe(true);
  } finally {
    await client.close();
  }
});

test("commands that cannot fit one 64 KB request reject before any command runs", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const before = fixture.effects.ssh;

    const env = Object.fromEntries(
      Array.from({ length: 10 }, (_, i) => [`BIG_${i}`, "x".repeat(8000)]),
    );

    await expect(box.exec({ command: { kind: "argv", argv: ["true"] }, env })).rejects.toThrow(
      /64 KB/,
    );
    expect(fixture.effects.ssh).toBe(before);
  } finally {
    await client.close();
  }
});

test("a lost command response is unknown and never replayed", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const before = fixture.effects.ssh;
    fixture.failNextSsh("lost");
    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(fixture.effects.ssh).toBe(before + 1);
  } finally {
    await client.close();
  }
});

linuxGuest("files round-trip bytes and list directories", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const bytes = new Uint8Array(100_000).map((_, i) => (i * 7) % 256);
    const dir = `/tmp/beachside-exe-files-${box.id}`;
    await box.makeDirectory(dir, { recursive: true });
    await box.writeFile(`${dir}/data.bin`, bytes);
    expect(await box.readFile(`${dir}/data.bin`)).toEqual(bytes);
    expect(await box.fileExists(`${dir}/data.bin`)).toBe(true);
    expect(await box.statFile(`${dir}/data.bin`)).toMatchObject({
      type: "file",
      sizeBytes: 100_000,
    });
    await expect(box.writeFile(`${dir}/data.bin`, bytes, { overwrite: false })).rejects.toThrow();
    expect((await box.readDirectory(dir)).entries).toEqual([{ name: "data.bin", type: "file" }]);
    await box.removeFile(dir, { recursive: true });
    expect(await box.fileExists(dir)).toBe(false);
  } finally {
    await client.close();
  }
});

test("suspend pauses with memory and resume restores it", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const paused = await box.suspend();
    expect(paused).toMatchObject({ preserve: "filesystem+memory", processes: "preserved" });
    expect(fixture.vms.get(box.id)?.status).toBe("paused");
    await box.resume();
    expect(fixture.vms.get(box.id)?.status).toBe("running");
    expect(fixture.effects).toMatchObject({ pause: 1, resume: 1 });
  } finally {
    await client.close();
  }
});

test("fork copies the VM under its own name and replaces the labels", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ labels: { role: "source" } });
    const fork = await box.fork({ labels: { role: "fork" } });
    expect(fork.id).not.toBe(box.id);
    expect(fixture.effects.copy).toBe(1);
    expect(fixture.vms.get(fork.id)?.tags).toContain("beachside");
    expect(fixture.vms.get(fork.id)?.comment).toBe("beachside: role=fork");
  } finally {
    await client.close();
  }
});

linuxGuest("a fork keeps the create-time env and boots from the copied disk", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { GREETING: "copied" } });
    const fork = await box.fork();

    const result = await fork.exec({
      command: { kind: "shell", script: 'printf "%s" "$GREETING"' },
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("copied");
  } finally {
    await client.close();
  }
});

test("an unlabelled fork sends no comment; one of a labelled source clears its labels", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const plain = await client.sandboxes.create();
    await plain.fork();
    expect(fixture.commands("comment")).toHaveLength(0);

    const labelled = await client.sandboxes.create({ labels: { role: "source" } });
    const fork = await labelled.fork();
    expect(fixture.vms.get(fork.id)?.comment).toBe("beachside:");
    const listed = await client.sandboxes.list();
    expect(listed.items.find((item) => item.id === fork.id)?.labels).toEqual({});
  } finally {
    await client.close();
  }
});

test("a fork whose labels fail is unknown but returns the copy for cleanup", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    fixture.failNextComment(fixture.error(502, "bad gateway"));

    const error = await box.fork({ labels: { role: "fork" } }).then(
      () => undefined,
      (failure: Error) => failure,
    );

    if (!(error instanceof OutcomeUnknownError)) throw error ?? Error("expected an unknown fork");
    const copies = [...fixture.vms.keys()].filter((name) => name !== box.id);
    expect(copies).toHaveLength(1);
    expect(JSON.stringify(error)).toContain(copies[0] ?? "missing");
  } finally {
    await client.close();
  }
});

test("protected previews sign a VM token; public previews share the web port", async () => {
  const { fixture, connect } = setup();
  const client = await connect({}, { token: "exe1.fixture-main", sshKey: openSshKey() });

  try {
    const box = await client.sandboxes.create();
    const shares = () => fixture.commands("share").length;
    const before = shares();
    const main = await box.preview(80);
    expect(main.url).toBe(`https://${box.id}.exe.xyz/`);

    if (main.access !== "protected") throw new Error("expected a protected preview");
    expect(main.headers["X-Exedev-Authorization"]).toMatch(/^Bearer exe0\./);
    expect(shares()).toBe(before + 1);
    // Ports 3000-9999 have their own URL, so no share call (or share permission) is needed.
    expect((await box.preview(3000)).url).toBe(`https://${box.id}.exe.xyz:3000/`);
    expect(shares()).toBe(before + 1);
    await expect(box.preview(22)).rejects.toThrow(/3000-9999/);
  } finally {
    await client.close();
  }

  const open = await connect({ preview: { access: "public" } });

  try {
    const box = await open.sandboxes.create();
    expect((await box.preview(5173)).url).toBe(`https://${box.id}.exe.xyz/`);
    expect(fixture.vms.get(box.id)?.share).toEqual({ port: 5173, status: "public" });
  } finally {
    await open.close();
  }
});

test("protected previews without an SSH key explain the choice", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    await expect(box.preview(8000)).rejects.toThrow(/sshKey/);
  } finally {
    await client.close();
  }
});

test("list reads labels back from the VM comment; destroy confirms deletion", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({
      labels: { team: "core", "app.kind": `it's <a&b> "x" = y` },
    });

    const listed = await client.sandboxes.list();
    expect(listed.items.find((item) => item.id === box.id)?.labels).toEqual({
      team: "core",
      "app.kind": `it's <a&b> "x" = y`,
    });
    await box.destroy();
    expect(fixture.vms.has(box.id)).toBe(false);
    expect(JSON.stringify(box.reference)).not.toContain("fixture-main");
  } finally {
    await client.close();
  }
});

test("capabilities name what exe.dev supports and what it does not", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const capabilities = await client.capabilities();
    expect(capabilities.network).toEqual(["internet"]);
    expect(capabilities.images).toEqual(["oci"]);
  } finally {
    await client.close();
  }
});

function jobSetup() {
  const fixture = exeDevFixture();
  fixtures.push(fixture);

  // Every command with a deadline over one second runs as a detached guest job.
  const adapter = createExeDevAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
    directExecSeconds: 1,
  });

  const connect = () =>
    Beachside.connect({
      adapter,
      config: { network: "internet" },
      credentials: { token: "exe1.fixture-main" },
    });

  return { fixture, connect };
}

linuxGuest("a long command runs as a guest job and returns the same exact result", async () => {
  const { fixture, connect } = jobSetup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { GREETING: "hi" } });

    const failed = await box
      .exec({
        command: {
          kind: "shell",
          script: 'sleep 1; printf "%s|" "$GREETING"; cat; printf "\\377" >&2; exit 4',
        },
        stdin: new TextEncoder().encode("in"),
        deadlineSeconds: 60,
      })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    if (!(failed instanceof NonzeroExitError)) throw failed ?? Error("Expected exit 4");
    expect(failed.result.exitCode).toBe(4);
    expect(new TextDecoder().decode(failed.result.stdout)).toBe("hi|in");
    expect([...failed.result.stderr]).toEqual([255]);
    // One start, then reads of the record file; never the command itself again.
    expect(
      fixture.commands("ssh").filter((call) => call.command.includes("beachside-run.XXXXXXXX")),
    ).toHaveLength(1);
  } finally {
    await client.close();
  }
});

linuxGuest("a guest job past its deadline is stopped and reported unknown", async () => {
  const { connect } = jobSetup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const marker = `/tmp/beachside-job-${box.id}`;

    await expect(
      box.exec({
        command: { kind: "shell", script: `sleep 3; touch ${marker}` },
        deadlineSeconds: 2,
      }),
    ).rejects.toBeInstanceOf(OutcomeUnknownError);
    await Bun.sleep(2000);
    expect(await Bun.file(marker).exists()).toBe(false);
  } finally {
    await client.close();
  }
});
