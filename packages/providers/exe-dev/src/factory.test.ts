import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { exeDev, exeDevAdapter } from "./index";

test("exeDev() binds the same definition the split form uses", () => {
  const bound = exeDev({ token: "exe1.token", network: "internet" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(exeDevAdapter.name);
});

test("exeDev() validates credentials at connect, before any provider call", async () => {
  await expect(Beachside.connect(exeDev({ network: "internet" }))).rejects.toThrow();
});
