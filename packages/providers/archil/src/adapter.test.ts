import { expect, test } from "bun:test";
import { adapterSuite } from "@beachside/adapter/testing";
import { Image, NonzeroExitError, OutcomeUnknownError } from "beachside";
import { z } from "zod";
import { setup, type ArchilFixture } from "./fixture.test-support";

const creates = (fixture: ArchilFixture) =>
  fixture.calls.filter((call) => call.method === "POST" && call.path === "/api/sandboxes");

test("Archil conformance: one native attempt, distinct keys, lost and late responses", async () => {
  const { fixture, adapter } = setup();

  const report = await adapterSuite({
    adapter,
    fixture: {
      config: { region: "aws-us-east-1", baseUrl: fixture.baseUrl },
      credentials: { apiKey: "fixture-main" },
      alternate: {
        config: { region: "aws-us-east-1", baseUrl: fixture.baseUrl },
        credentials: { apiKey: "fixture-alt" },
      },
      createInput: { image: { kind: "oci", value: "node:24-bookworm" }, networkPolicy: "blocked" },
      counters: () => ({
        create: fixture.effects.create,
        destroy: fixture.effects.destroy,
        release: 0,
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

test("create sends an explicit image, exact size, session budget, blocked egress and a name", async () => {
  const { fixture, connect } = setup();
  const client = await connect({ resources: { vcpus: 1.5, memoryMiB: 3000 } });

  try {
    expect((await client.capabilities()).network).toEqual(["blocked", "internet"]);
    const box = await client.sandboxes.create({ env: { GREETING: "hi" } });

    expect(creates(fixture)[0]?.body).toMatchObject({
      base_image: "node:24-bookworm",
      vcpu_count: 2,
      mem_size_mib: 3000,
      max_ttl_seconds: 900,
      idle_ttl_seconds: 0,
      env: { GREETING: "hi" },
      network: { egress: { default: "deny" } },
    });
    expect(z.object({ name: z.string() }).parse(creates(fixture)[0]?.body).name).toMatch(
      /^bs-[0-9a-f]{24}$/,
    );

    const info = await box.inspect();
    expect(info).toMatchObject({
      state: "running",
      resources: { status: "known", value: { vcpus: 2, memoryMiB: 3000 } },
      idleStop: { status: "known", value: null },
    });

    await box.destroy();
    expect(fixture.sandboxes.size).toBe(0);
  } finally {
    await client.close();
  }
});

test("labels, other regions and oversized resources are refused before any create", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    await expect(client.sandboxes.create({ labels: { job: "x" } })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(creates(fixture)).toHaveLength(0);
  } finally {
    await client.close();
  }

  await expect(connect({ resources: { vcpus: 64 } })).rejects.toMatchObject({
    code: "UNSUPPORTED",
  });
});

test("a Free-plan policy refusal is UNSUPPORTED, and a managed allowlist never passes as internet", async () => {
  const { fixture, connect } = setup({ plan: "free" });
  const client = await connect();

  try {
    await expect(client.sandboxes.create()).rejects.toMatchObject({ code: "UNSUPPORTED" });
    await expect(client.sandboxes.create({ network: "internet" })).rejects.toBeInstanceOf(
      OutcomeUnknownError,
    );
    expect(fixture.effects.create).toBe(1);
  } finally {
    await client.close();
  }
});

test("a lost create response is found again by its name, never sent twice", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    fixture.loseNextCreateResponse();
    const lost = await client.sandboxes.submitCreate();
    await expect(lost.observe()).rejects.toBeInstanceOf(OutcomeUnknownError);

    const recovered = await (await client.recover(lost.reference)).wait();
    expect(recovered).toMatchObject({ reference: { nativeId: [...fixture.sandboxes.keys()][0] } });
    expect(creates(fixture)).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("exec keeps argv bytes, raw output, exit codes, stdin, env overrides and cwd", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create({ env: { WHO: "sandbox" } });
    const tricky = 'it\'s "quoted"\n$HOME `x`';

    expect((await box.exec(["printf", "%s", tricky])).stdoutText()).toBe(tricky);

    const failed = await box
      .exec(["/bin/sh", "-c", "printf '\\377\\000A'; printf err >&2; exit 3"])
      .then(
        () => undefined,
        (error: Error) => error,
      );

    if (!(failed instanceof NonzeroExitError)) throw failed ?? Error("Expected exit 3");
    expect(failed.result.exitCode).toBe(3);
    expect([...failed.result.stdout]).toEqual([0xff, 0x00, 0x41]);

    expect(
      (
        await box.exec({
          command: { kind: "argv", argv: ["cat"] },
          stdin: new TextEncoder().encode("piped"),
        })
      ).stdoutText(),
    ).toBe("piped");
    expect((await box.exec(["/bin/sh", "-c", 'printf "%s" "$WHO"'])).stdoutText()).toBe("sandbox");
    expect(
      (
        await box.exec({
          command: { kind: "shell", script: 'printf "%s" "$WHO"' },
          env: { WHO: "call" },
        })
      ).stdoutText(),
    ).toBe("call");
    expect(
      (await box.exec({ command: { kind: "argv", argv: ["pwd"] }, cwd: "/tmp" }))
        .stdoutText()
        .trim(),
    ).toBe("/tmp");
  } finally {
    await client.close();
  }
});

test("exec output past the bound is drained, truncated, and the exit code still arrives", async () => {
  const { connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();

    const result = await box.exec({
      command: { kind: "shell", script: "head -c 4096 /dev/zero; exit 0" },
      maxOutputBytes: 1000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.stdout).toHaveLength(1000);
  } finally {
    await client.close();
  }
});

test("previews expose a public hostname or mint a protected token header", async () => {
  const { connect } = setup();
  const protectedClient = await connect();
  const publicClient = await connect({ preview: { access: "public" } });

  try {
    const box = await protectedClient.sandboxes.create();
    const preview = await box.preview(3000);

    expect(preview).toMatchObject({ access: "protected" });
    expect(preview.url).toStartWith("https://3000-");
    expect("headers" in preview && preview.headers["X-Archil-Token"]).toStartWith("porttok-");

    const other = await publicClient.sandboxes.create();
    expect(await other.preview(8080)).toMatchObject({ access: "public" });
  } finally {
    await protectedClient.close();
    await publicClient.close();
  }
});

test("suspend pauses with memory, resume resumes it, and renew sends a session timeout", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const box = await client.sandboxes.create();
    const suspended = await box.suspend();

    expect(suspended).toMatchObject({ preserve: "filesystem+memory", processes: "preserved" });
    expect(fixture.sandboxes.get(box.id)?.status).toBe("paused");

    const resumed = await box.resume();
    expect(resumed).toMatchObject({ execution: "resumed" });
    expect(fixture.sandboxes.get(box.id)?.status).toBe("running");

    await box.renew({ forSeconds: 600 });
    expect(fixture.calls.find((call) => call.path.endsWith("/timeout"))?.body).toEqual({
      timeout: 600,
    });
  } finally {
    await client.close();
  }
});

test("filesystem suspension stops the sandbox and resume cold-starts it", async () => {
  const { fixture, connect } = setup();

  const client = await connect({
    lifecycle: { suspension: { preserve: "filesystem" } },
  });

  try {
    const box = await client.sandboxes.create();

    expect(await box.suspend()).toMatchObject({ preserve: "filesystem", processes: "terminated" });
    expect(fixture.sandboxes.get(box.id)?.status).toBe("stopped");
    expect(await box.resume()).toMatchObject({ execution: "fresh" });
  } finally {
    await client.close();
  }
});

test("image builds poll the native image until ready and boot by image id", async () => {
  const { fixture, connect } = setup();
  const client = await connect();

  try {
    const built = await client.images.build({ source: Image.oci("ghcr.io/acme/tool:1") });
    expect(built.prepared.value).toMatch(/^[0-9a-f]{64}$/);

    await client.sandboxes.create({ environment: Image.prepared(built.prepared.value) });
    expect(creates(fixture)[0]?.body).toMatchObject({ image_id: built.prepared.value });
  } finally {
    await client.close();
  }
});

test("errors never carry the API key", async () => {
  const { connect } = setup();

  await expect(connect({}, { apiKey: "key-supersecret" })).rejects.not.toThrow(/supersecret/);
});
