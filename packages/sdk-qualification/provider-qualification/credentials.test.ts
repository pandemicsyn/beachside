import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials } from "./credentials";

test("credential file imports only keys and preserves injected environment", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-credential-fixture-"));

  try {
    const file = join(directory, "beachside.env");
    await writeFile(
      file,
      [
        "DAYTONA_API_KEY=fixture-daytona",
        "BEACHSIDE_DAYTONA_API_KEY=fixture-old",
        "E2B_API_KEY='fixture-e2b'",
        "BEACHSIDE_QUAL_LIVE_AUTHORIZED=yes",
        "BEACHSIDE_DAYTONA_LIVE=1",
      ].join("\n"),
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = { E2B_API_KEY: "injected-fixture" };
    await loadCredentials(file, environment);
    expect(environment.BEACHSIDE_DAYTONA_API_KEY).toBe("fixture-daytona");
    expect(environment.E2B_API_KEY).toBe("injected-fixture");
    expect(environment.BEACHSIDE_QUAL_LIVE_AUTHORIZED).toBeUndefined();
    expect(environment.BEACHSIDE_DAYTONA_LIVE).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("missing credential file leaves environment untouched", async () => {
  const environment: NodeJS.ProcessEnv = {};
  await loadCredentials(
    join(tmpdir(), `missing-beachside-${crypto.randomUUID()}.env`),
    environment,
  );
  expect(environment).toEqual({});
});

test("oversized credential file is rejected without importing partial keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-credential-size-fixture-"));

  try {
    const file = join(directory, "beachside.env");
    await writeFile(file, "E2B_API_KEY=fixture\n" + "#".repeat(65_537), { mode: 0o600 });
    const environment: NodeJS.ProcessEnv = {};
    await expect(loadCredentials(file, environment)).rejects.toThrow(
      "Unable to read Beachside credential file",
    );
    expect(environment).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("credential file rejects group-readable secrets before importing keys", async () => {
  const directory = await mkdtemp(join(tmpdir(), "beachside-credential-mode-fixture-"));

  try {
    const file = join(directory, "beachside.env");
    await writeFile(file, "E2B_API_KEY=fixture\n", { mode: 0o640 });
    const environment: NodeJS.ProcessEnv = {};
    await expect(loadCredentials(file, environment)).rejects.toThrow(
      "Unable to read Beachside credential file",
    );
    expect(environment).toEqual({});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
