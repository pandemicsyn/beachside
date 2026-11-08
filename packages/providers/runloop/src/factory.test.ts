import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { runloop, runloopAdapter } from "./index";

test("runloop() binds the same definition the split form uses", () => {
  const bound = runloop({ apiKey: "key" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(runloopAdapter.name);
});

test("runloop() validates credentials at connect, before any provider call", async () => {
  await expect(Beachside.connect(runloop({ apiKey: "" }))).rejects.toThrow();
});
