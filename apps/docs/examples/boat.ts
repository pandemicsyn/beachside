import { Beachside } from "beachside";
import { boatAdapter } from "@beachside/boat";

export async function boatExample(apiKey: string) {
  const client = await Beachside.connect({
    adapter: boatAdapter,
    credentials: { apiKey },
    config: {},
  });

  try {
    const box = await client.sandboxes.create();

    try {
      return (await box.exec(["/bin/sh", "-c", "printf ready"])).stdoutText();
    } finally {
      await box.destroy();
    }
  } finally {
    await client.close();
  }
}
