import { Beachside } from "beachside";
import { freestyleAdapter } from "@beachside/freestyle";

export async function freestyleExample(apiKey: string) {
  const client = await Beachside.connect({
    adapter: freestyleAdapter,
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
