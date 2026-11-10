import { expect, test } from "bun:test";
import { PreviewResult } from "./preview";

test("preview expiresAt accepts ISO timestamps with a Z or a numeric offset", () => {
  const url = "https://3000-box.example.dev";

  for (const expiresAt of [
    "2026-11-10T13:00:00Z",
    "2026-11-10T13:00:00+00:00",
    "2026-11-10T07:00:00-06:00",
  ])
    expect(PreviewResult.safeParse({ access: "public", url, expiresAt }).success).toBe(true);

  expect(PreviewResult.safeParse({ access: "public", url, expiresAt: "tomorrow" }).success).toBe(
    false,
  );

  const headers = { Authorization: "Bearer token" };
  expect(
    PreviewResult.safeParse({
      access: "protected",
      url,
      headers,
      expiresAt: "2026-11-10T13:00:00+00:00",
    }).success,
  ).toBe(true);
  expect(
    PreviewResult.safeParse({ access: "protected", url, headers, expiresAt: "tomorrow" }).success,
  ).toBe(false);
});
