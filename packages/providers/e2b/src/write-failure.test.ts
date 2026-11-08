import { expect, test } from "bun:test";
import {
  connectAdapter,
  observeOperation,
  prepareOperation,
  submitOperation,
} from "@beachside/adapter";
import { Image, Beachside } from "beachside";
import { createE2BAdapter } from "./index";
import { createSdkTransport, type E2BRecord } from "./transport";
import { classifyWriteFailure, E2BWriteFailure } from "./write-failure";

const submitted = Uint8Array.of(2, 254, 0);

const original = Uint8Array.of(0, 255, 1, 128);

const privateMessage = "secret-key sandbox_private https://private.invalid/?token=private";

test("native SDK write failures preserve per-call connection/upload HTTP classification without secrets", async () => {
  const previous = globalThis.fetch;
  let connectStatus = 200;
  let uploadStatus = 500;
  let uploads = 0;
  // SAFETY: All native SDK requests terminate in this offline fixture; unexpected routes throw.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.pathname === "/sandboxes/sandbox_private") {
        if (connectStatus !== 200)
          return Response.json({ message: privateMessage }, { status: connectStatus });

        return Response.json({
          sandboxID: "sandbox_private",
          templateID: "base",
          metadata: {},
          state: "running",
          envdVersion: "0.6.10",
          envdAccessToken: "guest-token",
          domain: "e2b.app",
          lifecycle: { autoResume: false },
        });
      }

      if (url.pathname === "/files") {
        uploads++;

        return Response.json({ message: privateMessage }, { status: uploadStatus });
      }

      throw new Error("Unexpected offline native request");
    },
    { preconnect: previous.preconnect },
  );

  try {
    const transport = createSdkTransport("secret-key");

    for (const [stage, status, name] of [
      ["connect", 401, "UnknownError"],
      ["upload", 500, "SandboxError"],
      ["upload", 507, "NotEnoughSpaceError"],
    ] as const) {
      connectStatus = stage === "connect" ? status : 200;
      uploadStatus = status;

      try {
        await transport.write("sandbox_private", "/tmp/private", submitted);
        throw new Error("Expected native write failure");
      } catch (error) {
        expect(classifyWriteFailure(error, "unknown")).toEqual({
          stage,
          errorName: name,
          httpStatus: status,
        });
        expect(String(error)).not.toContain("secret-key");
        expect(String(error)).not.toContain("sandbox_private");
        expect(JSON.stringify(error)).not.toContain(privateMessage);
      }
    }

    expect(uploads).toBe(2);
    // Parallel calls must each keep their own response status.
    connectStatus = 200;
    let status = 400;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(input instanceof Request ? input.url : String(input));

        if (url.pathname === "/sandboxes/sandbox_private")
          return Response.json({
            sandboxID: "sandbox_private",
            templateID: "base",
            metadata: {},
            state: "running",
            envdVersion: "0.6.10",
            envdAccessToken: "guest-token",
            domain: "e2b.app",
            lifecycle: { autoResume: false },
          });

        if (url.pathname === "/files")
          return Response.json({ message: privateMessage }, { status: status++ });
        throw new Error("Unexpected offline native request");
      },
      { preconnect: previous.preconnect },
    );

    const errors = await Promise.all(
      [0, 1].map(async () => {
        try {
          await transport.write("sandbox_private", "/tmp/private", submitted);
        } catch (error) {
          return classifyWriteFailure(error, "unknown");
        }

        throw new Error("Expected failure");
      }),
    );

    expect(errors.map((error) => error.httpStatus).sort()).toEqual([400, 401]);
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError(privateMessage);
      },
      { preconnect: previous.preconnect },
    );
    await expect(
      createSdkTransport("secret-key").write("sandbox_private", "/tmp/private", submitted),
    ).rejects.toMatchObject({ failure: { stage: "connect", errorName: "TypeError" } });
  } finally {
    globalThis.fetch = previous;
  }
});

test("write recovery retains sanitized failure across restart and distinguishes readback checks without replay", async () => {
  let observed = original;
  let truncated = false;
  let readFails = false;
  let afterEffect = false;
  let writes = 0;

  const nativeError = Object.assign(new Error(privateMessage), {
    name: "SandboxError",
    statusCode: 500,
  });

  let metadata: E2BRecord["metadata"] = {
    beachside_scope: "team_one:template_1",
    beachside_submission: "sub_seed",
    beachside_operation: "op_seed",
    beachside_template: "template_1",
  };

  const adapter = createE2BAdapter(() => ({
    ...createSdkTransport("offline-unused"),
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async create(input) {
      metadata = input.metadata;

      return "sandbox_1";
    },
    async get() {
      return {
        id: "sandbox_1",
        templateId: "template_1",
        state: "running" as const,
        allowPublicTraffic: false,
        metadata,
      };
    },
    async write() {
      writes++;

      if (afterEffect) observed = submitted;
      throw new E2BWriteFailure(classifyWriteFailure(nativeError, "upload"));
    },
    async read() {
      if (readFails) throw new Error(privateMessage);

      return { bytes: observed, truncated };
    },
    close() {},
  }));

  const config = {
    teamId: "team_one",
    templateId: "template_1",
    preview: { access: "protected" as const },
  };

  const credentials = { apiKey: "offline-unused" };
  const connect = () => connectAdapter(adapter, { config, credentials });
  let connection = await connect();
  const signal = new AbortController().signal;

  const identity = {
    operationId: "op_write",
    submissionId: "sub_write",
    invocationKey: "inv_write",
    sandbox: { id: "sandbox_1" },
  };

  try {
    const prepared = await prepareOperation(
      connection.session,
      "file_write",
      { sandbox: identity.sandbox, path: "/tmp/file", bytes: submitted, overwrite: true },
      signal,
    );

    const pending = await submitOperation(prepared, identity, signal);
    expect(pending.kind).toBe("pending");

    if (pending.kind !== "pending") throw new Error("Missing recovery token");
    expect(JSON.stringify(pending.token)).not.toContain(privateMessage);
    await connection.close();
    connection = await connect();

    const observe = (token = pending.token) =>
      observeOperation(
        connection.session,
        "file_write",
        { ...identity, token, version: pending.version },
        signal,
      );

    for (const fixture of [
      {
        bytes: original,
        truncated: false,
        expected: "actualLength=4, truncated=false, digestMatches=false",
      },
      {
        bytes: Uint8Array.of(9, 9, 9),
        truncated: false,
        expected: "actualLength=3, truncated=false, digestMatches=false",
      },
      {
        bytes: submitted,
        truncated: true,
        expected: "actualLength=3, truncated=true, digestMatches=true",
      },
    ]) {
      observed = fixture.bytes;
      truncated = fixture.truncated;
      const result = await observe();
      expect(result?.kind).toBe("unknown");

      if (!result || result.kind !== "unknown") throw new Error("Expected unknown outcome");
      expect(result.reason).toContain(fixture.expected);
      expect(result.reason).toContain("expectedLength=3");
      expect(result.reason).toContain("stage=upload, error=SandboxError, httpStatus=500");
      expect(result.reason).not.toContain(privateMessage);
    }

    readFails = true;
    const unreadable = await observe();
    expect(unreadable).toMatchObject({
      kind: "unknown",
      reason: expect.stringContaining("error=SandboxError, httpStatus=500"),
    });
    readFails = false;
    truncated = false;
    observed = submitted;
    expect(await observe()).toEqual({ kind: "completed", value: { bytesWritten: 3 } });
    // Version-one tokens from before this fix remain recoverable.
    const legacy = JSON.parse(JSON.stringify(pending.token));
    delete legacy.failure;
    expect(await observe(legacy)).toEqual({ kind: "completed", value: { bytesWritten: 3 } });
    afterEffect = true;

    const lateIdentity = {
      ...identity,
      operationId: "op_late",
      submissionId: "sub_late",
      invocationKey: "inv_late",
    };

    const latePrepared = await prepareOperation(
      connection.session,
      "file_write",
      { sandbox: lateIdentity.sandbox, path: "/tmp/late", bytes: submitted, overwrite: true },
      signal,
    );

    const writesBefore = writes;
    const acknowledgedLate = await submitOperation(latePrepared, lateIdentity, signal);

    if (acknowledgedLate.kind !== "pending") throw new Error("Expected lost acknowledgement");
    expect(
      await observeOperation(
        connection.session,
        "file_write",
        { ...lateIdentity, token: acknowledgedLate.token, version: acknowledgedLate.version },
        signal,
      ),
    ).toEqual({ kind: "completed", value: { bytesWritten: 3 } });
    expect(writes - writesBefore).toBe(1);

    observed = original;
    const client = await Beachside.connect({ adapter, config, credentials });

    try {
      afterEffect = false;

      const box = await client.sandboxes.create({
        environment: Image.prepared("template_1"),
        networkPolicy: "blocked",
      });

      await expect(
        box.writeFile("/tmp/file", submitted, { overwrite: true }),
      ).rejects.toMatchObject({
        name: "OutcomeUnknownError",
        code: "OUTCOME_UNKNOWN",
        message: expect.stringContaining("error=SandboxError, httpStatus=500"),
      });
    } finally {
      await client.close();
    }
  } finally {
    await connection.close();
  }
});

test("unrecognized native names and invalid HTTP status cannot enter diagnostic recovery", () => {
  const error = Object.assign(new Error(privateMessage), { name: privateMessage, statusCode: 900 });
  expect(classifyWriteFailure(error, "upload")).toEqual({
    stage: "upload",
    errorName: "UnknownError",
  });
});

test("only envd's refused-open answer marks a native write as open-denied", async () => {
  const previous = globalThis.fetch;
  let message = "error opening file: open /tmp/existing: permission denied";
  // SAFETY: All native SDK requests terminate in this offline fixture; unexpected routes throw.
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));

      if (url.pathname === "/sandboxes/sandbox_private")
        return Response.json({
          sandboxID: "sandbox_private",
          templateID: "base",
          metadata: {},
          state: "running",
          envdVersion: "0.6.10",
          envdAccessToken: "guest-token",
          domain: "e2b.app",
          lifecycle: { autoResume: false },
        });

      if (url.pathname === "/files") return Response.json({ message }, { status: 500 });
      throw new Error("Unexpected offline native request");
    },
    { preconnect: previous.preconnect },
  );

  const outcome = async () => {
    try {
      await createSdkTransport("secret-key").write("sandbox_private", "/tmp/existing", submitted);
    } catch (error) {
      if (error instanceof E2BWriteFailure) return error;
    }

    throw new Error("Expected native write failure");
  };

  try {
    const denied = await outcome();
    expect(denied.openDenied).toBe(true);
    expect(denied.failure).toEqual({ stage: "upload", errorName: "SandboxError", httpStatus: 500 });
    expect(JSON.stringify(denied)).not.toContain("/tmp/existing");

    for (const other of [
      "error writing file: input/output error",
      "error changing file ownership: operation not permitted",
    ]) {
      message = other;
      expect((await outcome()).openDenied).toBe(false);
    }
  } finally {
    globalThis.fetch = previous;
  }
});

test("overwrites refused by envd in sticky directories are copied in as the sandbox user", async () => {
  const files = new Map<string, Uint8Array>([["/tmp/existing", original]]);
  const scripts: string[] = [];
  const uploads: string[] = [];
  let copyFails = false;

  let metadata: E2BRecord["metadata"] = {};

  const adapter = createE2BAdapter(() => ({
    ...createSdkTransport("offline-unused"),
    async verifyTeam() {},
    async verifyTemplate(_team, id) {
      return id;
    },
    async create(input) {
      metadata = input.metadata;

      return "sandbox_1";
    },
    async get() {
      return {
        id: "sandbox_1",
        templateId: "template_1",
        state: "running" as const,
        allowPublicTraffic: false,
        metadata,
      };
    },
    async write(_id, path, value) {
      uploads.push(path);

      // Mirrors fs.protected_regular: envd may create new files in /tmp but not reopen old ones.
      if (path.startsWith("/tmp/") && path.indexOf("/", 5) === -1 && files.has(path))
        throw new E2BWriteFailure(
          { stage: "upload", errorName: "SandboxError", httpStatus: 500 },
          true,
        );
      files.set(path, value);
    },
    async run(_id, script) {
      scripts.push(script);
      const [, from, to] = /^if cat -- '([^']+)' > '([^']+)'/.exec(script) ?? [];

      if (!from || !to) throw new Error("unexpected command");
      const staged = files.get(from);
      files.delete(from);

      if (copyFails || !staged) return "FAILED";
      files.set(to, staged);

      return "COPIED";
    },
    async read(_id, path) {
      const value = files.get(path);

      if (!value) throw new Error("file absent");

      return { bytes: value, truncated: false };
    },
    async remove(_id, path) {
      files.delete(path);
    },
    close() {},
  }));

  const config = {
    teamId: "team_one",
    templateId: "template_1",
    preview: { access: "protected" as const },
  };

  const credentials = { apiKey: "offline-unused" };
  const client = await Beachside.connect({ adapter, config, credentials });

  try {
    const box = await client.sandboxes.create({
      environment: Image.prepared("template_1"),
      networkPolicy: "blocked",
    });

    await box.writeFile("/tmp/existing", submitted, { overwrite: true });
    expect(files.get("/tmp/existing")).toEqual(submitted);
    expect(uploads).toHaveLength(2);
    expect(uploads[1]).toMatch(/^\/tmp\/\.beachside-write-/);
    expect(scripts).toHaveLength(1);
    expect([...files.keys()]).toEqual(["/tmp/existing"]);

    // Overwrites envd can open still take the single direct upload.
    await box.writeFile("/tmp/sub/existing", submitted, { overwrite: true });
    expect(uploads).toHaveLength(3);
    expect(scripts).toHaveLength(1);

    copyFails = true;
    files.set("/tmp/existing", original);
    await expect(
      box.writeFile("/tmp/existing", submitted, { overwrite: true }),
    ).rejects.toMatchObject({
      code: "OUTCOME_UNKNOWN",
      message: expect.stringContaining("stage=link, error=Error"),
    });
    expect([...files.keys()].filter((path) => path.includes(".beachside-write-"))).toEqual([]);
  } finally {
    await client.close();
  }
});
