import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defineAdapter,
  sandboxReference,
  type ExecInput as NativeExecInput,
} from "@beachside/adapter";
import { Beachside, BeachsideError, Setup, SetupFailedError, type SetupEvent } from "./index";
import {
  planSetup,
  readSetupState,
  resolveSetup,
  runSetupPlan,
  type SetupOutput,
  type SetupTarget,
} from "./setup";
import { execOutput } from "./resource";

const root = mkdtempSync(join(tmpdir(), "beachside-setup-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

const scope = { authority: { kind: "account", id: "one" }, partition: {} };

const Token = z.strictObject({ submissionId: z.string() });

/** Run one command in a local folder that stands in for the sandbox user's home. */
function shell(
  home: string,
  command: { kind: "argv"; argv: string[] } | { kind: "shell"; script: string },
  cwd?: string,
  env?: Record<string, string>,
  stdin?: Uint8Array,
) {
  mkdirSync(home, { recursive: true });

  const [file, ...args] = command.kind === "shell" ? ["sh", "-c", command.script] : command.argv;

  const result = spawnSync(file!, args, {
    cwd: cwd ?? home,
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, ...env },
    input: stdin,
  });

  return {
    exitCode: result.status ?? 127,
    stdout: new Uint8Array(result.stdout ?? []),
    stderr: new Uint8Array(result.stderr ?? new TextEncoder().encode(String(result.error ?? ""))),
    truncated: false,
  };
}

/** A provider model whose sandboxes are local folders and whose exec runs a real `sh`. */
function fixture() {
  const homes = new Map<string, string>();
  const destroyed: string[] = [];
  const creates: unknown[] = [];

  const adapter = defineAdapter({
    name: "fixture.setup",
    config: z.strictObject({}),
    credentials: z.strictObject({}),
    async connect() {
      return {
        scope,
        defaultImage: { kind: "prepared" as const, value: "base" },
        supports: {
          images: ["prepared" as const],
          network: ["blocked"],
          exec: { commands: ["argv" as const, "shell" as const], maxOutputBytes: 1_048_576 },
        },
        create: {
          recovery: { version: 1, token: Token },
          async submit(input, ctx) {
            creates.push(structuredClone(input));
            const id = `box-${creates.length}`;
            homes.set(id, join(root, `${Date.now()}-${id}`));

            return {
              id,
              reference: sandboxReference("fixture.setup", scope, id, {
                operation: ctx.operationId,
                submission: ctx.submissionId,
              }),
              state: "running" as const,
            };
          },
          async observe() {
            return null;
          },
        },
        async reopen(reference) {
          return {
            reference,
            state: "running" as const,
            nativeState: "running",
            observedAt: new Date(0).toISOString(),
            expires: { status: "unknown" as const, reason: "fixture" },
            idleStop: { status: "unknown" as const, reason: "fixture" },
            retention: { status: "unknown" as const, reason: "fixture" },
            execution: { status: "unknown" as const, reason: "fixture" },
          };
        },
        exec: Object.assign(
          async (input: NativeExecInput) =>
            shell(homes.get(input.sandbox.id)!, input.command, input.cwd, input.env, input.stdin),
          { finiteStdin: "bytes" as const },
        ),
        destroy: {
          recovery: { version: 1, token: Token },
          async observe() {
            return null;
          },
          async submit(input) {
            destroyed.push(input.id);

            return { computeStopped: true as const, retainedResources: [] };
          },
        },
      };
    },
  });

  const connect = () => Beachside.connect({ adapter, config: {}, credentials: {} });

  return { connect, homes, destroyed, creates };
}

function events() {
  const seen: SetupEvent[] = [];
  const output: SetupOutput[] = [];

  return {
    seen,
    output,
    callbacks: {
      onSetupStep: (event: SetupEvent) => {
        seen.push(event);
      },
      onSetupOutput: (chunk: SetupOutput) => {
        output.push(chunk);
      },
    },
  };
}

test("create runs shell lines, argv, inline scripts and files in order, then startup", async () => {
  const f = fixture();
  const client = await f.connect();
  const script = join(root, "bootstrap.sh");

  writeFileSync(script, '#!/bin/sh\necho from-file >> "$HOME/log"\n');

  const progress = events();

  try {
    const box = await client.sandboxes.create({
      setup: [
        "echo one >> log",
        ["sh", "-c", 'echo "two $1" >> log', "sh", "argv ok"],
        { script: 'echo three >> "$HOME/log"\necho to-stderr >&2', name: "inline" },
        Setup.file(script),
        { run: 'pwd >> "$HOME/log"', cwd: "work", name: "in work" },
        { run: 'echo "$STEP_VALUE" >> "$HOME/log"', env: { STEP_VALUE: "step env" } },
      ],
      startup: ["echo started >> log"],
      ...progress.callbacks,
    });

    const home = f.homes.get(box.id)!;

    expect(readFileSync(join(home, "log"), "utf8").split("\n")).toEqual([
      "one",
      "two argv ok",
      "three",
      "from-file",
      join(home, "work"),
      "step env",
      "started",
      "",
    ]);

    const report = box.setupReport!;

    expect(report.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(report.setup.map((step) => [step.name, step.status])).toEqual([
      ["echo one >> log", "ran"],
      ['sh -c echo "two $1" >> log sh argv ok', "ran"],
      ["inline", "ran"],
      ["bootstrap.sh", "ran"],
      ["in work", "ran"],
      ['echo "$STEP_VALUE" >> "$HOME/log"', "ran"],
    ]);
    expect(report.startup).toHaveLength(1);
    expect(progress.seen.filter((event) => event.type === "start")).toHaveLength(7);
    // Without streaming, each step's output arrives once it ends.
    expect(progress.output).toContainEqual({
      phase: "setup",
      step: { index: 2, total: 6, name: "inline" },
      stream: "stderr",
      text: "to-stderr\n",
    });

    const state = JSON.parse(readFileSync(join(home, ".beachside/setup/state.json"), "utf8"));

    expect(state.setup.complete).toBe(true);
    expect(state.setup.digest).toBe(report.digest);
    expect(state.setup.steps).toHaveLength(6);
    expect(state.startup).toHaveLength(1);
  } finally {
    await client.close();
  }
});

test("a failed step destroys the new sandbox and reports the step, exit code and tail", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const failure = await client.sandboxes
      .create({ setup: ["true", { run: "echo nope >&2; exit 7", name: "broken" }, "touch never"] })
      .catch((error: Error) => error);

    expect(failure).toBeInstanceOf(SetupFailedError);

    // SAFETY: Checked with toBeInstanceOf just above.
    const error = failure as SetupFailedError;

    expect(error.code).toBe("SETUP_FAILED");
    expect(error.phase).toBe("setup");
    expect(error.step).toEqual({ index: 1, total: 3, name: "broken" });
    expect(error.exitCode).toBe(7);
    expect(error.stderrTail).toBe("nope");
    expect(error.message).toContain('setup step 2/3 "broken" failed (exit 7)');
    expect(error.sandbox).toBeUndefined();
    expect(f.destroyed).toEqual(["box-1"]);
  } finally {
    await client.close();
  }
});

test("onSetupFailure keep leaves the sandbox on the error", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    // SAFETY: The test reads only `sandbox`, which a non-setup error would leave undefined and fail.
    const error = (await client.sandboxes
      .create({ setup: ["exit 3"], onSetupFailure: "keep" })
      .catch((cause: Error) => cause)) as SetupFailedError;

    expect(error.sandbox?.id).toBe("box-1");
    expect(f.destroyed).toEqual([]);
  } finally {
    await client.close();
  }
});

test("bad steps and unreadable files reject before anything is created", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    await expect(client.sandboxes.create({ setup: [{ run: "a", script: "b" }] })).rejects.toThrow(
      "exactly one of run, script or file",
    );
    await expect(
      client.sandboxes.create({ setup: [Setup.file(join(root, "missing.sh"))] }),
    ).rejects.toThrow("Cannot read setup file");
    await expect(client.sandboxes.submitCreate({ setup: ["true"] })).rejects.toThrow(
      "box.runSetup()",
    );
    expect(f.creates).toHaveLength(0);
    // Setup keys never reach the provider's create plan.
    expect((await client.sandboxes.checkCreate({ setup: ["true"] })).status).toBe("supported");
  } finally {
    await client.close();
  }
});

test("named setups compose, extend once and reject cycles", async () => {
  const base = Setup.define({ name: "base", setup: ["echo base >> log"] });
  const tools = Setup.define({ name: "tools", extends: [base], setup: ["echo tools >> log"] });

  const app = Setup.define({
    name: "app",
    extends: [base],
    setup: [tools, "echo app >> log"],
    startup: ["echo app-start >> log"],
  });

  const resolved = await resolveSetup({ setup: app, startup: ["echo extra >> log"] });

  expect(resolved.names).toEqual(["app", "base", "tools"]);
  expect(resolved.setup.map((step) => step.text)).toEqual([
    "echo base >> log",
    "echo tools >> log",
    "echo app >> log",
  ]);
  expect(resolved.startup.map((step) => step.text)).toEqual([
    "echo app-start >> log",
    "echo extra >> log",
  ]);
  expect(() => Setup.define({ name: "Bad Name" })).toThrow(BeachsideError);

  // Order is part of the digest.
  const ab = await resolveSetup({ setup: ["echo a", "echo b"] });
  const ba = await resolveSetup({ setup: ["echo b", "echo a"] });

  expect(ab.digest).not.toBe(ba.digest);
  // Env names are part of a step's digest; values are not.
  const one = await resolveSetup({ setup: [{ run: "x", env: { K: "1" } }] });
  const two = await resolveSetup({ setup: [{ run: "x", env: { K: "2" } }] });

  expect(one.digest).toBe(two.digest);
});

test("runSetup skips recorded steps, runs new ones, and force reruns all", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({ setup: ["echo a >> log"] });
    const home = f.homes.get(box.id)!;

    const report = await box.runSetup({ setup: ["echo a >> log", "echo b >> log"] });

    expect(report.setup.map((step) => step.status)).toEqual(["skipped", "ran"]);
    expect(readFileSync(join(home, "log"), "utf8")).toBe("a\nb\n");

    const forced = await box.runSetup({ setup: ["echo a >> log", "echo b >> log"], force: true });

    expect(forced.setup.map((step) => step.status)).toEqual(["ran", "ran"]);

    // SAFETY: The assertions below check the rejection's class before relying on its fields.
    const failure = (await box
      .runSetup({ setup: ["exit 1"] })
      .catch((error: Error) => error)) as SetupFailedError;

    // An existing sandbox is never destroyed by runSetup.
    expect(failure.sandbox).toBe(box);
    expect(f.destroyed).toEqual([]);
  } finally {
    await client.close();
  }
});

/** A target over a local folder, standing in for a sandbox restored from a snapshot. */
function folderTarget(home: string, streams: boolean): SetupTarget & { calls: number } {
  const target = {
    calls: 0,
    async exec(
      input: Parameters<SetupTarget["exec"]>[0],
      options?: Parameters<SetupTarget["exec"]>[1],
    ) {
      target.calls++;

      // SAFETY: The runner always passes the object form.
      const request = input as Exclude<typeof input, readonly string[]>;
      const result = shell(home, request.command, request.cwd, request.env);

      if (streams && options?.onOutput) {
        const text = new TextDecoder().decode(result.stdout);

        if (text) await options.onOutput({ stream: "stdout", text });
      }

      const output = execOutput(result.exitCode, result.stdout, result.stderr, false);

      if (result.exitCode !== 0) {
        const { NonzeroExitError } = await import("./resource");

        throw new NonzeroExitError(output);
      }

      return output;
    },
  };

  return target;
}

test("restore skips what the snapshot holds, reruns cache:false steps and runs recorded startup", async () => {
  const original = join(root, "restore-original");
  const steps = ["echo deps >> log", { run: "echo pull >> log", cache: false }];
  const resolved = await resolveSetup({ setup: steps, startup: ["echo serve >> log"] });

  await runSetupPlan(folderTarget(original, false), planSetup(resolved, null), { streams: false });
  expect(readFileSync(join(original, "log"), "utf8")).toBe("deps\npull\nserve\n");

  // "Snapshot" the folder and restore it elsewhere.
  const restored = join(root, "restore-copy");

  cpSync(original, restored, { recursive: true });

  const target = folderTarget(restored, false);
  const recorded = await readSetupState(target);

  expect(recorded?.setup.complete).toBe(true);

  // Same setup requested: deps skipped, the cache:false step reruns, recorded startup runs.
  const plan = planSetup({ ...resolved, startup: [] }, recorded, { startupFromRecord: true });

  expect(plan.setup.map((entry) => entry.run)).toEqual([false, true]);
  await runSetupPlan(target, plan, { streams: false });
  expect(readFileSync(join(restored, "log"), "utf8")).toBe("deps\npull\nserve\npull\nserve\n");

  // A different setup than the snapshot holds runs every requested step, with a note.
  const other = await resolveSetup({ setup: ["echo other >> log"] });
  const otherPlan = planSetup(other, recorded, { startupFromRecord: true });

  expect(otherPlan.notes).toHaveLength(1);
  expect(otherPlan.setup.map((entry) => entry.run)).toEqual([true]);

  // A longer setup whose start matches runs only the new steps.
  const longer = await resolveSetup({ setup: [...steps, "echo new >> log"] });

  expect(planSetup(longer, recorded).setup.map((entry) => entry.run)).toEqual([false, true, true]);
});

test("streaming targets deliver output live, tagged with phase and step", async () => {
  const home = join(root, "streaming");
  const resolved = await resolveSetup({ setup: ["echo live"], startup: ["echo up"] });
  const progress = events();

  await runSetupPlan(folderTarget(home, true), planSetup(resolved, null), {
    streams: true,
    ...progress.callbacks,
  });

  expect(progress.output).toEqual([
    {
      phase: "setup",
      step: { index: 0, total: 1, name: "echo live" },
      stream: "stdout",
      text: "live\n",
    },
    {
      phase: "startup",
      step: { index: 0, total: 1, name: "echo up" },
      stream: "stdout",
      text: "up\n",
    },
  ]);
});

test("a step over its timeout fails as possibly still running", async () => {
  const home = join(root, "timeout");
  const resolved = await resolveSetup({ setup: [{ run: "sleep 5", timeoutSeconds: 1 }] });

  const slow: SetupTarget = {
    exec: (input, options) =>
      new Promise((resolve, reject) => {
        const signal = options?.signal;

        // Answer the home lookup at once; hang the step until its signal fires.
        if (
          !Array.isArray(input) &&
          "command" in input &&
          input.command.kind === "shell" &&
          input.command.script.includes('"$HOME"') &&
          !input.command.script.includes("sleep")
        )
          return resolve(execOutput(0, new TextEncoder().encode(home), new Uint8Array(), false));
        signal?.addEventListener("abort", () => reject(signal.reason));
      }),
  };

  // SAFETY: The next assertion checks the rejection's class.
  const error = (await runSetupPlan(slow, planSetup(resolved, null), { streams: false }).catch(
    (cause: Error) => cause,
  )) as SetupFailedError;

  expect(error).toBeInstanceOf(SetupFailedError);
  expect(error.exitCode).toBeNull();
  expect(error.message).toContain("timed out after 1s");
});

test("stdin reaches a step, never the digest, and startup steps refuse it", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({
      setup: [{ run: "cat > key.txt", stdin: "secret-key", name: "key" }],
    });

    expect(readFileSync(join(f.homes.get(box.id)!, "key.txt"), "utf8")).toBe("secret-key");

    const state = readFileSync(join(f.homes.get(box.id)!, ".beachside/setup/state.json"), "utf8");

    expect(state).not.toContain("secret-key");
    expect(await Setup.digest([{ run: "cat > key.txt", stdin: "other" }])).toBe(
      await Setup.digest([{ run: "cat > key.txt" }]),
    );
    await expect(
      client.sandboxes.create({ startup: [{ run: "cat", stdin: "x" }] }),
    ).rejects.toThrow("Startup steps cannot take stdin");
  } finally {
    await client.close();
  }
});

test("record: false runs helper steps without touching the setup record", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({ setup: ["echo a >> log"] });
    const statePath = join(f.homes.get(box.id)!, ".beachside/setup/state.json");
    const before = readFileSync(statePath, "utf8");

    const report = await box.runSetup({ setup: ["echo helper >> log"], record: false });

    expect(report.setup.map((step) => step.status)).toEqual(["ran"]);
    expect(readFileSync(statePath, "utf8")).toBe(before);

    // A request that is a prefix of what the sandbox holds is already satisfied.
    await box.runSetup({ setup: ["echo a >> log", "echo b >> log"] });

    const again = await box.runSetup({ setup: ["echo a >> log"] });

    expect(again.setup.map((step) => step.status)).toEqual(["skipped"]);
    expect(readFileSync(join(f.homes.get(box.id)!, "log"), "utf8")).toBe("a\nhelper\nb\n");
  } finally {
    await client.close();
  }
});

test("runSetup can run the startup a sandbox recorded", async () => {
  const f = fixture();
  const client = await f.connect();

  try {
    const box = await client.sandboxes.create({ setup: ["true"], startup: ["echo up >> log"] });
    const report = await box.runSetup({ setup: ["true"], recordedStartup: "run" });

    expect(report.startup.map((step) => step.name)).toEqual(["echo up >> log"]);
    expect(readFileSync(join(f.homes.get(box.id)!, "log"), "utf8")).toBe("up\nup\n");
  } finally {
    await client.close();
  }
});

test("a parallel group runs every step as one setup step and fails after all finish", async () => {
  const f = fixture();
  const client = await f.connect();
  const progress = events();

  try {
    const box = await client.sandboxes.create({
      setup: [
        "echo first >> log",
        Setup.parallel(["echo a > a", { run: "echo b > b", name: "bee" }], { name: "fetch" }),
      ],
      ...progress.callbacks,
    });

    const home = f.homes.get(box.id)!;

    expect(readFileSync(join(home, "a"), "utf8")).toBe("a\n");
    expect(readFileSync(join(home, "b"), "utf8")).toBe("b\n");
    expect(box.setupReport!.setup.map((step) => [step.name, step.status])).toEqual([
      ["echo first >> log", "ran"],
      ["fetch", "ran"],
    ]);
    // Children report under their group.
    expect(
      progress.seen
        .filter((event) => event.type === "start")
        .map((event) => [event.step?.name, event.step?.group]),
    ).toEqual([
      ["echo first >> log", undefined],
      ["fetch", undefined],
      ["echo a > a", "fetch"],
      ["bee", "fetch"],
    ]);

    // The group is one recorded step: running the same setup again skips it.
    const again = await box.runSetup({
      setup: [
        "echo first >> log",
        Setup.parallel(["echo a > a", { run: "echo b > b", name: "bee" }], { name: "fetch" }),
      ],
    });

    expect(again.setup.map((step) => step.status)).toEqual(["skipped", "skipped"]);

    await expect(
      box.runSetup({ setup: [Setup.parallel(["exit 3", "echo late > late"])] }),
    ).rejects.toMatchObject({ code: "SETUP_FAILED", exitCode: 3 });
    // The other step still finished.
    expect(readFileSync(join(home, "late"), "utf8")).toBe("late\n");

    await expect(
      client.sandboxes.create({ setup: ["true"], startup: [Setup.parallel(["a", "b"])] }),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  } finally {
    await client.close();
  }
});
