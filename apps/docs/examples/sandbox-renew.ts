import { Image, type BeachsideClient, type SandboxReference, type RenewResult } from "beachside";
import { daytona } from "@beachside/daytona";
import { e2b } from "@beachside/e2b";

// Change only setup when choosing a provider for new compute.
export const daytonaSetup = (apiKey: string) =>
  daytona({ apiKey, target: "us", lifecycle: { lifetimeSeconds: 600 } });

export const e2bSetup = (apiKey: string, teamId: string) =>
  e2b({ apiKey, teamId, lifecycle: { lifetimeSeconds: 600 } });

export async function renewWorkspace(client: BeachsideClient, preparedImage: string) {
  try {
    const box = await client.sandboxes.create({ environment: Image.prepared(preparedImage) });

    try {
      await box.exec(["/bin/sh", "-c", "printf ready"]);
      const renewed: RenewResult = await box.renew();
      await box.renew({ forSeconds: 61 });

      return renewed;
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}

export async function reopenAndRenew(client: BeachsideClient, saved: SandboxReference) {
  const box = await client.sandboxes.get(saved); // read-only, no reset

  return box.renew(); // explicitly uses this connection's configured window
}
