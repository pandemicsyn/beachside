import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { freestyle, freestyleAdapter } from "./index";

test("freestyle() binds the same definition the split form uses", () => {
  const bound = freestyle({ apiKey: "key" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(freestyleAdapter.name);
});

test("freestyle() validates credentials at connect, before any provider call", async () => {
  await expect(Beachside.connect(freestyle({ apiKey: "" }))).rejects.toThrow();
});
