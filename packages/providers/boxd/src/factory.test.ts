import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { boxd, boxdAdapter } from "./index";

test("boxd() binds the same definition the split form uses", () => {
  const bound = boxd({ apiKey: "key", org: "org", network: "internet" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(boxdAdapter.name);
});

test("boxd() validates credentials at connect, before any provider call", async () => {
  await expect(
    Beachside.connect(boxd({ apiKey: "", org: "org", network: "internet" })),
  ).rejects.toThrow();
});
