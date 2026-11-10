import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { archil, archilAdapter } from "./index";

test("archil() binds the same definition the split form uses", () => {
  const bound = archil({ apiKey: "key", region: "aws-us-east-1" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(archilAdapter.name);
});

test("archil() validates credentials and region at connect, before any provider call", async () => {
  await expect(
    Beachside.connect(archil({ apiKey: "", region: "aws-us-east-1" })),
  ).rejects.toThrow();
  await expect(
    // @ts-expect-error -- a storage-only region has no sandboxes.
    Beachside.connect(archil({ apiKey: "key", region: "gcp-us-central1" })),
  ).rejects.toThrow();
});
