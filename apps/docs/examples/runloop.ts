import { Beachside } from "beachside";
import { runloopAdapter } from "@beachside/runloop";

export async function runloopExample(apiKey: string) {
  const client = await Beachside.connect({
    adapter: runloopAdapter,
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
