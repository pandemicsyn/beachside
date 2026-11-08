import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// A stand-in npm: `install --prefix <dir>` writes a beachside bin that logs its arguments.
const fakeNpm = `#!/bin/sh
echo "npm $*" >> "$FAKE_LOG"
prefix=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; fi
  shift
done
mkdir -p "$prefix/bin"
cat > "$prefix/bin/beachside" <<'BIN'
#!/bin/sh
echo "beachside $* state=$BEACHSIDE_STATE_DIR" >> "$FAKE_LOG"
if [ "$1" = "--version" ]; then echo "0.7.0"; fi
if [ "$1" = "rm" ] && [ -n "$FAKE_RM_FAIL" ]; then exit 8; fi
exit 0
BIN
chmod +x "$prefix/bin/beachside"
`;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "setup-beachside-"));
  await mkdir(join(root, "stub"));
  await writeFile(join(root, "stub", "npm"), fakeNpm);
  await chmod(join(root, "stub", "npm"), 0o755);

  for (const file of ["env", "path", "output", "state", "log"])
    await writeFile(join(root, file), "");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

type Step = { code: number; stdout: string };

async function step(script: string, env: Record<string, string>): Promise<Step> {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, script)], {
    env: {
      PATH: `${join(root, "stub")}:${process.env.PATH ?? ""}`,
      RUNNER_TEMP: join(root, "temp"),
      GITHUB_ENV: join(root, "env"),
      GITHUB_PATH: join(root, "path"),
      GITHUB_OUTPUT: join(root, "output"),
      GITHUB_STATE: join(root, "state"),
      FAKE_LOG: join(root, "log"),
      ...env,
    },
    stdout: "pipe",
    stderr: "inherit",
  });

  const stdout = await new Response(child.stdout).text();

  return { code: await child.exited, stdout };
}

const read = (file: string) => readFile(join(root, file), "utf8");

/** The post step sees saved state as STATE_<name> variables, as GitHub passes it. */
async function savedState(): Promise<Record<string, string>> {
  const lines = (await read("state")).trim().split("\n");

  return Object.fromEntries(
    lines.map((line) => [
      `STATE_${line.slice(0, line.indexOf("="))}`,
      line.slice(line.indexOf("=") + 1),
    ]),
  );
}

describe("setup-beachside", () => {
  test("installs the pinned CLI and adapters and exports the job's state folder", async () => {
    const result = await step("main.mjs", {
      INPUT_VERSION: "0.7.0",
      INPUT_ADAPTERS: "e2b, daytona",
      INPUT_PROVIDER: "e2b",
    });

    expect(result.code).toBe(0);
    const stateDir = join(root, "temp", "beachside", "state");
    const log = (await read("log")).trim().split("\n");

    expect(log[0]).toContain("install --global --prefix");
    expect(log[0]).toContain("@beachside/cli@0.7.0");
    expect(log[1]).toBe(`beachside adapter add e2b daytona state=${stateDir}`);
    expect(await read("path")).toBe(`${join(root, "temp", "beachside-cli", "bin")}\n`);
    expect(await read("env")).toBe(`BEACHSIDE_STATE_DIR=${stateDir}\nBEACHSIDE_PROVIDER=e2b\n`);
    expect(await read("output")).toBe(`version=0.7.0\nstate-dir=${stateDir}\n`);
    expect(await savedState()).toMatchObject({ STATE_stateDir: stateDir, STATE_cleanup: "true" });
  });

  test("refuses an input that is not a provider id before installing anything", async () => {
    const result = await step("main.mjs", { INPUT_ADAPTERS: "e2b; rm -rf /" });

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("::error::");
    expect(await read("log")).toBe("");
  });

  test("the post step removes this job's sandboxes from its own store", async () => {
    await step("main.mjs", { INPUT_ADAPTERS: "e2b" });
    const state = await savedState();
    await mkdir(join(state.STATE_stateDir!, "sandboxes"), { recursive: true });

    const result = await step("post.mjs", state);

    expect(result.code).toBe(0);
    expect(await read("log")).toContain(`beachside rm --all state=${state.STATE_stateDir}`);
  });

  test("a failed cleanup warns without failing the job", async () => {
    await step("main.mjs", {});
    const state = await savedState();
    await mkdir(join(state.STATE_stateDir!, "sandboxes"), { recursive: true });

    const result = await step("post.mjs", { ...state, FAKE_RM_FAIL: "1" });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("::warning::Beachside cleanup did not finish");
  });

  test("cleanup: false and an empty store skip the post step's rm", async () => {
    await step("main.mjs", { INPUT_CLEANUP: "false" });
    const skipped = await step("post.mjs", await savedState());

    expect(skipped.stdout).toContain("cleanup skipped");

    await writeFile(join(root, "state"), "");
    await step("main.mjs", {});
    const empty = await step("post.mjs", await savedState());

    expect(empty.stdout).toContain("No Beachside sandboxes recorded");
    expect(await read("log")).not.toContain("beachside rm");
  });
});
