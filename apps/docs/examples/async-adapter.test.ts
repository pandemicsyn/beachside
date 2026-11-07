import { expect, test } from "bun:test";
import { Image, Beachside } from "beachside";
import { asyncAcme, metrics } from "./async-adapter";

test("a saved pending reference reopens for observation without another create", async () => {
  const before = metrics.submits;
  let saved: unknown;

  const first = await Beachside.connect({
    adapter: asyncAcme,
    config: { region: "us" },
    credentials: { token: "fixture-token" },
    onReference(reference) {
      saved = reference;
    },
  });

  const operation = await first.sandboxes.submitCreate({
    environment: Image.prepared("image-123"),
  });

  expect(await operation.observe()).toBeNull();
  saved = structuredClone(operation.reference); // Persist the accepted token update.
  await first.close();

  const reopened = await Beachside.connect({
    adapter: asyncAcme,
    config: { region: "us" },
    credentials: { token: "fixture-token" },
  });

  try {
    // SAFETY: The test fixture controls the adapter response shape.
    const recovered = await reopened.recover(saved as never);
    const box = await recovered.observe();
    expect(box).toMatchObject({
      id: operation.reference.submissionId && `box-${operation.reference.submissionId}`,
    });
    expect(metrics.submits).toBe(before + 1);
    expect(metrics.observes).toBeGreaterThan(0);
  } finally {
    await reopened.close();
  }
});
