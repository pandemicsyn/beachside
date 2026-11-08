import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { boat, boatAdapter } from "./index";

test("boat() binds the same definition the split form uses", () => {
  const bound = boat({ apiKey: "key", network: "internet" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(boatAdapter.name);
});

test("boat() validates credentials at connect, before any provider call", async () => {
  await expect(Beachside.connect(boat({ apiKey: "", network: "internet" }))).rejects.toThrow();
});
