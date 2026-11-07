import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { vercel, vercelAdapter } from "./index";

test("vercel() binds the same definition the split form uses", () => {
  const bound = vercel({ token: "token", teamId: "team", projectId: "project" });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(vercelAdapter.name);
});

test("vercel() validates credentials at connect, before any provider call", async () => {
  await expect(
    Beachside.connect(vercel({ token: "", teamId: "team", projectId: "project" })),
  ).rejects.toThrow();
});
