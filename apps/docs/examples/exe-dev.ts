import { Beachside } from "beachside";
import { exeDevAdapter } from "@beachside/exe-dev";

export async function exeDevExample(token: string) {
  const client = await Beachside.connect({
    adapter: exeDevAdapter,
    credentials: { token },
    config: { network: "internet" },
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
