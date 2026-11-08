import { Beachside } from "beachside";
import { boxdAdapter } from "@beachside/boxd";

export async function boxdExample(apiKey: string, org: string) {
  const client = await Beachside.connect({
    adapter: boxdAdapter,
    credentials: { apiKey },
    config: { org, network: "internet" },
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
