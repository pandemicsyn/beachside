import { expect, test } from "bun:test";
import { Beachside } from "beachside";
import { modal, modalAdapter } from "./index";

test("modal() binds the same definition the split form uses", () => {
  const bound = modal({
    tokenId: "id",
    tokenSecret: "secret",
    appName: "app",
    environment: "main",
  });

  expect(bound.bound).toBe(true);
  expect(bound.name).toBe(modalAdapter.name);
});

test("modal() validates credentials at connect, before any provider call", async () => {
  await expect(
    Beachside.connect(
      modal({ tokenId: "id", tokenSecret: "", appName: "app", environment: "main" }),
    ),
  ).rejects.toThrow();
});
