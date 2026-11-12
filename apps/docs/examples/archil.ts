import { Beachside } from "beachside";
import { archilAdapter } from "@beachside/archil";

export async function archilExample(apiKey: string) {
  const client = await Beachside.connect({
    adapter: archilAdapter,
    credentials: { apiKey },
    config: { region: "aws-us-east-1" },
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
