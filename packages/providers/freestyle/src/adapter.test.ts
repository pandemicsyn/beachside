import { afterEach, expect, test } from "bun:test";
import { adapterSuite } from "@beachside/adapter/testing";
import { Beachside, Image, NonzeroExitError, OutcomeUnknownError } from "beachside";
import type { z } from "zod";
import { createFreestyleAdapter } from "./adapter";
import { freestyleFixture } from "./fixture.test-support";

const fixtures: ReturnType<typeof freestyleFixture>[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.close();
});

function setup() {
  const fixture = freestyleFixture();
  fixtures.push(fixture);

  const adapter = createFreestyleAdapter({
    fetch: fixture.fetch,
    pollIntervalMs: 1,
    settleSeconds: 1,
  });

  const connect = (config: z.input<typeof adapter.config> = {}) =>
    Beachside.connect({ adapter, config, credentials: { apiKey: "fixture-main" } });

  return { fixture, adapter, connect };
}

test("a background poll that loses the create result stays unknown and recovers by slug", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.backgroundNextCreate();
    fixture.forgetNextBackgroundResult();
    const lost = await client.sandboxes.submitCreate();
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.vms.size).toBe(1);

    const recovered = await (await client.recover(lost.reference)).observe();
    expect(recovered).toMatchObject({ reference: { nativeId: [...fixture.vms.keys()].at(-1) } });
    expect(creates(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a lost create with env recovers in the same process by writing the env file", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate({ env: { GREETING: "hi" } });
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);

    const recovered = await (await client.recover(lost.reference)).observe();

    if (!recovered || !("reference" in recovered) || !recovered.reference)
      throw new Error("expected the recovered sandbox");
    const box = await client.sandboxes.get(JSON.parse(JSON.stringify(recovered.reference)));
    expect((await box.exec(["/bin/sh", "-c", 'printf "%s" "$GREETING"'])).stdoutText()).toBe("hi");
    expect(fixture.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("a lost create with env stays unknown in a fresh process, which never has the values", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate({ env: { GREETING: "hi" } });
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);

    const fresh = createFreestyleAdapter({
      fetch: fixture.fetch,
      pollIntervalMs: 1,
      settleSeconds: 1,
    });

    const other = await Beachside.connect({
      adapter: fresh,
      config: {},
      credentials: { apiKey: "fixture-main" },
    });

    try {
      await expect((await other.recover(lost.reference)).observe()).rejects.toBeInstanceOf(
        OutcomeUnknownError,
      );
    } finally {
      await other.close();
    }

    expect(fixture.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("a slow boot with env finishes setup through observation", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.setBootPolls(1_000_000);
    const submitted = await client.sandboxes.submitCreate({ env: { GREETING: "late" } });
    expect(await submitted.observe()).toBeNull();
    fixture.setBootPolls(0);

    for (const vm of fixture.vms.values()) vm.state = "running";
    const box = await submitted.observe();

    if (!box) throw new Error("expected the created sandbox");
    expect((await box.exec(["/bin/sh", "-c", 'printf "%s" "$GREETING"'])).stdoutText()).toBe(
      "late",
    );
  } finally {
    await client.close();
  }
});

test("the create-time env file is private to the command user (mode 0600)", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await client.sandboxes.create({ env: { SECRET: "s" } });

    const write = fixture.calls.find(
      (call) => call.method === "PUT" && call.query.get("path") === "/etc/beachside.env",
    );

    expect(write?.query.get("mode")).toBe(String(0o600));
  } finally {
    await client.close();
  }
});

const creates = (fixture: ReturnType<typeof freestyleFixture>) =>
  fixture.calls.filter((call) => call.method === "POST" && call.path === "/v5/vms");

test("Freestyle conformance: one native attempt, distinct keys, lost and late responses", async () => {
  const { fixture, adapter } = setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: {},
      credentials: { apiKey: "fixture-main" },
      alternate: { config: {}, credentials: { apiKey: "fixture-alt" } },
      createInput: {
        image: { kind: "prepared", value: "freestyle/ubuntu" },
        networkPolicy: "blocked",
      },
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
        expect(creates(fixture)).toHaveLength(0);
      },
    },
  });

  expect(report.counters).toEqual({ create: 3, destroy: 1, release: 0 });
  // Each create effect came from exactly one outbound request.
  expect(creates(fixture)).toHaveLength(3);
});

test("an IP allowlist becomes one outbound firewall rule per range", async () => {
  const { fixture, connect } = setup();
  const client = await connect({ network: { allow: ["10.1.2.3/16", "192.0.2.7"] } });

  try {
    expect((await client.capabilities()).network).toEqual(["allow"]);
    await client.sandboxes.create();
    expect(creates(fixture)[0]?.body).toMatchObject({
      firewall: {
        rules: [
          { action: "allow", source: {}, destination: { cidr: "10.1.0.0/16" } },
          { action: "allow", source: {}, destination: { cidr: "192.0.2.7/32" } },
        ],
      },
    });
    await expect(client.sandboxes.create({ network: "blocked" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
  } finally {
    await client.close();
  }
});

test("Freestyle allowlists refuse host names at connect", async () => {
  const { connect } = setup();

  await expect(connect({ network: { allow: ["github.com"] } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("IPv4 ranges only"),
  });
});

test("create boots the default base with a blocked firewall, a slug, the lifetime and labels", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    expect((await client.capabilities()).network).toEqual(["blocked", "internet"]);
    const box = await client.sandboxes.create({ labels: { job: "ci-7" } });
    const body = creates(fixture)[0]?.body;

    expect(body).toEqual({
      snapshotId: "freestyle/ubuntu",
      slug: expect.stringMatching(/^beachside-[0-9a-f]{24}$/),
      ttlSeconds: 900,
      firewall: { rules: [] },
      metadata: { job: "ci-7" },
    });

    const info = await box.inspect();
    expect(info.state).toBe("running");
    expect(info.expires).toMatchObject({ status: "known", action: "destroy", scope: "sandbox" });
    expect(info.resources).toEqual({ status: "known", value: { vcpus: 4, memoryMiB: 8192 } });

    const listed = await client.sandboxes.list();
    expect(listed.items.map((item) => item.labels)).toEqual([{ job: "ci-7" }]);
    await box.destroy();

    const open = await client.sandboxes.create({ networkPolicy: "internet" });
    expect(creates(fixture)[1]?.body).toMatchObject({
      firewall: { rules: [{ action: "allow", source: {}, destination: { public: true } }] },
    });
    await open.destroy();
  } finally {
    await client.close();
  }
});

test("unsupported inputs reject before any create request", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await expect(
      client.sandboxes.create({ environment: Image.oci("ubuntu:24.04") }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.sandboxes.create({ region: "us" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await expect(
      client.sandboxes.create({ labels: { ["k".repeat(64)]: "v" } }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    await expect(
      client.sandboxes.create({ lifecycle: { lifetimeSeconds: 30 } }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(creates(fixture)).toHaveLength(0);
  } finally {
    await client.close();
  }
});

test("resources pick the smallest Ubuntu base and reject sizes no base meets", async () => {
  const { fixture, adapter, connect } = setup();
  const client = await connect({ resources: { vcpus: 5 } });

  try {
    await (await client.sandboxes.create()).destroy();
    expect(creates(fixture)[0]?.body).toMatchObject({ snapshotId: "freestyle/ubuntu-lg" });
    // An image override that may be smaller than the minimums is refused before dispatch.
    await expect(
      client.sandboxes.create({ environment: Image.prepared("my-snapshot") }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(creates(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }

  const before = fixture.calls.length;
  await expect(connect({ resources: { vcpus: 64 } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
    message: expect.stringContaining("largest is 32 vCPU / 65536 MiB"),
  });
  await expect(
    Beachside.connect({
      adapter,
      config: { image: "my-snapshot", resources: { vcpus: 2 } },
      credentials: { apiKey: "fixture-main" },
    }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  await expect(connect({ preview: { access: "protected" } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
  expect(fixture.calls).toHaveLength(before);
});

test("create waits for a starting VM and follows a backgrounded create", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.setBootPolls(2);
    const box = await client.sandboxes.create();
    expect((await box.inspect()).state).toBe("running");
    await box.destroy();

    fixture.setBootPolls(0);
    fixture.backgroundNextCreate();
    const slow = await client.sandboxes.create();
    expect(fixture.count("GET", /^\/v5\/background-requests\//)).toBe(1);
    expect(creates(fixture)).toHaveLength(2);
    await slow.destroy();
  } finally {
    await client.close();
  }
});

test("create refusals are clean rejections; 5xx stays unknown and is never resent", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.failNextCreate(fixture.error(402, "QUOTA_EXCEEDED"));
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "CAPACITY" });

    fixture.failNextCreate(fixture.error(502, "BAD_GATEWAY"));
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    expect(creates(fixture)).toHaveLength(2);
  } finally {
    await client.close();
  }
});

test("a lost create is found again by its slug without a second create", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate();
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);
    expect(fixture.effects.create).toBe(1);

    const recovered = await (await client.recover(lost.reference)).observe();
    expect(recovered).toMatchObject({ reference: { nativeId: [...fixture.vms.keys()].at(-1) } });
    expect(fixture.calls.some((call) => call.query.get("slug")?.startsWith("beachside-"))).toBe(
      true,
    );
    expect(fixture.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("exec keeps argv, cwd, env, stdin and non-UTF-8 output bytes", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const result = await box.exec({
      command: { kind: "argv", argv: ["printf", "%s|%s", "it's $(x)", "two words"] },
    });

    expect(new TextDecoder().decode(result.stdout)).toBe("it's $(x)|two words");

    const failed = await box
      .exec({
        command: { kind: "shell", script: "printf '\\377\\000\\200'; printf err >&2; exit 3" },
        maxOutputBytes: 1024,
      })
      .then(
        () => undefined,
        (error: Error) => error,
      );

    if (!(failed instanceof NonzeroExitError)) throw failed ?? Error("Expected exit 3");
    expect(failed.result.exitCode).toBe(3);
    expect([...failed.result.stdout]).toEqual([255, 0, 128]);

    const piped = await box.exec({
      command: { kind: "argv", argv: ["sh", "-c", 'cd "$D" && pwd && printf "%s" "$V" && cat'] },
      env: { V: "value", D: fixture.workdir },
      stdin: Uint8Array.of(1, 2, 3),
    });

    expect([...piped.stdout].slice(-6)).toEqual([...new TextEncoder().encode("lue"), 1, 2, 3]);

    // Native stdin travels base64-encoded in the request, not through a staged file.
    const execs = fixture.calls.filter((call) => call.path.endsWith("/exec-await"));
    expect(execs.at(-1)?.body).toMatchObject({ stdin: "AQID" });
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("large exec output is downloaded as raw bytes and bounded", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const result = await box.exec({
      command: { kind: "shell", script: "head -c 100000 /dev/zero" },
      maxOutputBytes: 50_000,
    });

    expect(result.stdout.byteLength).toBe(50_000);
    expect(result.truncated).toBe(true);
    expect(fixture.count("GET", /\/fs\/read$/)).toBe(2);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("exec timeouts and lost responses are unknown and never replayed", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    fixture.overrideCommands(() => ({ statusCode: null, stdout: "", stderr: "" }));
    await expect(
      box.exec({ command: { kind: "argv", argv: ["sleep", "100"] } }),
    ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
    fixture.overrideCommands(undefined);

    const before = fixture.effects.exec;
    fixture.failNextCommand("lost");
    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });
    expect(fixture.effects.exec).toBe(before + 1);

    fixture.failNextCommand(fixture.error(409, "VM_NON_RESPONSIVE"));
    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
    });

    fixture.failNextCommand(fixture.error(400, "AGENT_UNSUPPORTED"));
    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("files round-trip bytes, verify sha256 and list directories", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const bytes = Uint8Array.of(0, 255, 10, 13);

    await box.writeFile("/work/data.bin", bytes, { overwrite: true });
    expect([...(await box.readFile("/work/data.bin"))]).toEqual([0, 255, 10, 13]);
    expect(fixture.effects.write).toBe(1);

    const write = fixture.calls.find((call) => call.path.endsWith("/fs/write"));
    expect(write?.query.get("sha256")).toMatch(/^[0-9a-f]{64}$/);

    expect(await box.listFiles("/work")).toEqual([{ name: "data.bin", type: "file" }]);
    await expect(box.readFile("/missing")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("suspend pauses with memory, resume starts it again, renew extends the deadline", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const paused = await box.suspend();
    expect(paused).toMatchObject({ preserve: "filesystem+memory", processes: "preserved" });
    expect((await box.inspect()).state).toBe("suspended");
    await expect(box.exec({ command: { kind: "argv", argv: ["true"] } })).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const resumed = await box.resume();
    expect(resumed).toMatchObject({ execution: "resumed" });
    expect((await box.inspect()).state).toBe("running");
    expect(fixture.effects).toMatchObject({ pause: 1, start: 1 });

    await box.renew({ forSeconds: 600 });
    // The VM was created 60 s ago, and ttlSeconds counts from creation.
    expect(fixture.vms.get(box.id)?.ttlSeconds).toBeGreaterThanOrEqual(660);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("configured preview ports are published at create, others on first use", async () => {
  const { fixture, connect } = setup();
  const client = await connect({ preview: { ports: [3000] } });

  try {
    const box = await client.sandboxes.create();
    const slug = [...fixture.vms.values()][0]?.slug;

    expect(creates(fixture)[0]?.body).toMatchObject({
      tls: {
        rules: [
          {
            action: "allow",
            domain: `${slug}-3000.style.dev`,
            source: { public: true },
            destination: { port: 3000 },
          },
        ],
      },
    });
    expect(await box.preview(3000)).toEqual({
      access: "public",
      url: `https://${slug}-3000.style.dev`,
    });
    // Any other port is published on first use, once.
    expect(await box.preview(8080)).toEqual({
      access: "public",
      url: `https://${slug}-8080.style.dev`,
    });
    expect(await box.preview(8080)).toMatchObject({ url: `https://${slug}-8080.style.dev` });
    expect(fixture.count("POST", /^\/v5\/tls$/)).toBe(1);

    // A paused VM gets no route: inbound traffic could wake it.
    await box.suspend();
    await expect(box.preview(9090)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(fixture.count("POST", /^\/v5\/tls$/)).toBe(1);
    await box.destroy();
  } finally {
    await client.close();
  }
});

test("destroy confirms the VM is gone and references never carry the API key", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const reference = box.reference;

    if (!reference) throw Error("Expected a reopenable reference");
    expect(JSON.stringify(reference)).not.toContain("fixture-main");

    const reopened = await client.sandboxes.get(reference);
    expect(reopened.id).toBe(box.id);

    expect(await box.destroy()).toMatchObject({ computeStopped: true });
    expect(fixture.vms.size).toBe(0);

    const other = await Beachside.connect({
      adapter: createFreestyleAdapter({ fetch: fixture.fetch, pollIntervalMs: 1 }),
      config: {},
      credentials: { apiKey: "fixture-alt" },
    });

    try {
      await expect(other.sandboxes.get(reference)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      await other.close();
    }
  } finally {
    await client.close();
  }
});

test("create-time env applies to every command, a per-call env overrides it, and values are never saved", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { GREETING: "it's here", SHARED: "box" } });

    try {
      const printed = await box.exec({
        command: { kind: "argv", argv: ["/bin/sh", "-c", 'printf "%s|%s" "$GREETING" "$SHARED"'] },
        env: { SHARED: "call" },
      });

      expect(printed.stdoutText()).toBe("it's here|call");
      expect(fixture.vms.get(box.id)?.files.get("/etc/beachside.env")).toBeDefined();
      expect(JSON.stringify(box.reference)).not.toContain("it's here");

      const reopened = await client.sandboxes.get(JSON.parse(JSON.stringify(box.reference)));
      expect((await reopened.exec(["/bin/sh", "-c", 'printf "%s" "$GREETING"'])).stdoutText()).toBe(
        "it's here",
      );
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
});

test("create-time env rejects invalid names before any Freestyle effect", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await expect(client.sandboxes.create({ env: { "BAD-NAME": "x" } })).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    });
    expect(fixture.effects.create).toBe(0);
  } finally {
    await client.close();
  }
});
